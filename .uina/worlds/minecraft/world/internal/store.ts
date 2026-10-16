/**
 * World 历史存储接口与内存实现。
 *
 * S-W1 以内存存储打底；接口按可替换设计，S-W3 提供 node:sqlite 实现。
 * 语义（world.md §5.6/§11）：append 批量在同一事务语义内提交并返回存储版本 v；
 * 失败时上层不得推进 D、不得发布 durable ACK。
 */

import type { CapturedClientFact } from "../../contracts/client-facts.js";
import type { GapRecord } from "./reception.js";

export interface StoredFact {
	kind: "fact";
	receiveSeq: number;
	record: CapturedClientFact;
}

export interface StoredGap {
	kind: "gap";
	receiveSeq: number;
	gap: GapRecord;
}

export type StoredEntry = StoredFact | StoredGap;

export interface EvidenceFilter {
	stream?: string;
	schema?: string;
	/** 源序号下界（含）。 */
	fromSeq?: number;
	limit: number;
	/** 分页 token 中的存储版本；与当前版本不符报 SNAPSHOT_EXPIRED。 */
	version?: number;
	/** 分页起始键：上一页最后一条的 (stream, seq)。 */
	after?: { stream: string; seq: number };
}

export interface EvidencePage {
	version: number;
	items: StoredEntry[];
	/** 下一页 token；null 表示没有更多。 */
	next: { stream: string; seq: number; version: number } | null;
}

export interface DomainRecordRow {
	ref: string;
	revision: number;
	schema: string;
	world: string;
	worldRevision: string;
	value: unknown;
	evidence: string[];
	createdAt: string;
}

export interface WorldStore {
	/** ready = 可读写；unavailable = 历史/持久写不可用（当前读不受影响）。 */
	readonly state: "ready" | "unavailable";
	readonly unavailableReason?: string;
	/** 存储形态说明（status 如实呈现，不冒充持久性）。 */
	readonly description: string;
	/** 当前存储版本 v；每次成功提交递增。 */
	readonly version: number;
	/** 批量提交证据/缺口条目。失败返回 false（不推进 D）。 */
	appendEvidence(entries: StoredEntry[]): boolean;
	/** 读取已持久证据（含 gap 记录）。存储不可用返回 null。 */
	listEvidence(filter: EvidenceFilter): EvidencePage | null;
	/** 领域记录：CAS 写入。返回 null 表示冲突/失败（reason 说明）。 */
	writeRecord(change: {
		ref: string;
		schema: string;
		world: string;
		worldRevision: string;
		expectedRevision: number | null;
		value: unknown;
		evidence: string[];
	}):
		| { ok: true; record: DomainRecordRow }
		| { ok: false; reason: "conflict" | "not_found" | "store_failed" | "immutable_fields" };
	readRecord(ref: string): DomainRecordRow | null;
	/** 保留关系：幂等追加。失败返回 false。 */
	retain(owner: string, evidence: string[]): boolean;
	release(owner: string): boolean;
	retainedBy(owner: string): string[] | null;
	/** 所有保留关系（GC 复核用）。 */
	allRetentions(): { owner: string; evidence: string[] }[];
	/** 关闭（flush 语义由实现决定；内存实现无操作）。 */
	close(): void;
}

/** 内存实现：语义与 SQL 版一致，用于测试与 S-W1 打底；进程退出不保留。 */
export class MemoryWorldStore implements WorldStore {
	readonly state = "ready" as const;
	readonly description = "内存存储：进程退出不保留（S-W1 打底，S-W3 换 SQLite）";
	private _version = 0;
	private evidence = new Map<string, StoredEntry>();
	private evidenceOrder: StoredEntry[] = [];
	private records = new Map<string, DomainRecordRow>();
	private retentions = new Map<string, Set<string>>();

	get version(): number {
		return this._version;
	}

	get unavailableReason(): string | undefined {
		return undefined;
	}

	appendEvidence(entries: StoredEntry[]): boolean {
		for (const entry of entries) {
			if (this.evidence.has(entry.kind === "fact" ? entry.record.ref : entry.gap.ref)) continue; // 去重（重启恢复重放）
			this.evidence.set(entry.kind === "fact" ? entry.record.ref : entry.gap.ref, entry);
			this.evidenceOrder.push(entry);
		}
		this._version += 1;
		return true;
	}

	listEvidence(filter: EvidenceFilter): EvidencePage | null {
		const version = filter.version ?? this._version;
		if (version !== this._version) {
			return {
				version,
				items: [],
				next: null,
			};
		}
		let items = this.evidenceOrder.filter((entry) => {
			const stream = entry.kind === "fact" ? entry.record.mark.stream : entry.gap.stream;
			if (filter.stream && stream !== filter.stream) return false;
			if (filter.schema && entry.kind === "fact" && entry.record.schema !== filter.schema) return false;
			if (filter.schema && entry.kind === "gap") return false;
			const seq = entry.kind === "fact" ? entry.record.mark.sequence : entry.gap.after;
			if (filter.fromSeq !== undefined && seq < filter.fromSeq) return false;
			if (filter.after) {
				const afterKey = `${filter.after.stream}:${filter.after.seq}`;
				const key = `${stream}:${seq}`;
				if (key <= afterKey) return false;
			}
			return true;
		});
		items = items.slice(0, filter.limit);
		const last = items.at(-1);
		const next = last
			? {
					stream: last.kind === "fact" ? last.record.mark.stream : last.gap.stream,
					seq: last.kind === "fact" ? last.record.mark.sequence : last.gap.after,
					version,
				}
			: null;
		return { version, items, next: items.length === filter.limit ? next : null };
	}

	writeRecord(change: {
		ref: string;
		schema: string;
		world: string;
		worldRevision: string;
		expectedRevision: number | null;
		value: unknown;
		evidence: string[];
	}):
		| { ok: true; record: DomainRecordRow }
		| { ok: false; reason: "conflict" | "not_found" | "store_failed" | "immutable_fields" } {
		const existing = this.records.get(change.ref);
		const now = new Date().toISOString();
		if (change.expectedRevision === null) {
			if (existing) return { ok: false, reason: "conflict" };
			const row: DomainRecordRow = {
				ref: change.ref,
				revision: 1,
				schema: change.schema,
				world: change.world,
				worldRevision: change.worldRevision,
				value: change.value,
				evidence: [...change.evidence],
				createdAt: now,
			};
			this.records.set(change.ref, row);
			this._version += 1;
			return { ok: true, record: row };
		}
		if (!existing) return { ok: false, reason: "not_found" };
		if (existing.revision !== change.expectedRevision) return { ok: false, reason: "conflict" };
		if (
			existing.schema !== change.schema ||
			existing.world !== change.world ||
			existing.worldRevision !== change.worldRevision
		) {
			return { ok: false, reason: "immutable_fields" };
		}
		const row: DomainRecordRow = {
			...existing,
			revision: existing.revision + 1,
			value: change.value,
			evidence: [...change.evidence],
		};
		this.records.set(change.ref, row);
		this._version += 1;
		return { ok: true, record: row };
	}

	readRecord(ref: string): DomainRecordRow | null {
		return this.records.get(ref) ?? null;
	}

	retain(owner: string, evidence: string[]): boolean {
		let set = this.retentions.get(owner);
		if (!set) {
			set = new Set();
			this.retentions.set(owner, set);
		}
		for (const ref of evidence) set.add(ref);
		this._version += 1;
		return true;
	}

	release(owner: string): boolean {
		if (!this.retentions.delete(owner)) return false;
		this._version += 1;
		return true;
	}

	retainedBy(owner: string): string[] | null {
		const set = this.retentions.get(owner);
		return set ? [...set] : null;
	}

	allRetentions(): { owner: string; evidence: string[] }[] {
		return [...this.retentions].map(([owner, set]) => ({ owner, evidence: [...set] }));
	}

	close(): void {
		// 内存存储无持久资源。
	}
}
