/**
 * World 历史存储接口：内存实现与 node:sqlite 实现。
 *
 * 语义（world.md §5.6/§11/§13）：
 * - append 批量在同一事务语义内提交并递增存储版本 v；失败返回 false（上层不推进 D）。
 * - 去重以稳定 evidence ref 为准：恢复后源重放（新接收代次）不重复入库。
 * - 恢复快照提供"已持久事实 seq / gap ref"集合，使新接收代次的 durable 从真实持久状态起步；
 *   receivedThrough 不继承（由源重放重建），不把 RAM 接收冒充持久。
 * - listEvidence 按持久化接收序号 recv 稳定排序；分页固定版本 v。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

/** 分页视图：storeSeq 是存储在 append 时分配的单调顺序键（与接收 R 独立）。 */
export interface StoredEntryView {
	storeSeq: number;
	entry: StoredEntry;
}

export interface EvidenceFilter {
	stream?: string;
	schema?: string;
	limit: number;
	/** 分页起始：上一页最后一条的 storeSeq。 */
	afterStoreSeq?: number;
}

export interface EvidencePage {
	version: number;
	items: StoredEntryView[];
	/** 下一页起点；null 表示没有更多。 */
	nextStoreSeq: number | null;
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

export interface StoreRecoveryStream {
	stream: string;
	persistedFactSeqs: number[];
	persistedGapRefs: string[];
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
	/** 恢复快照：已持久事实 seq 与 gap ref（按流）；内存实现返回 null。 */
	recoverySnapshot(): StoreRecoveryStream[] | null;
	/** 领域记录：CAS 写入。 */
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

/** 内存实现：语义与 SQL 版一致，用于测试与降级路径；进程退出不保留。 */
export class MemoryWorldStore implements WorldStore {
	readonly state = "ready" as const;
	readonly description = "内存存储：进程退出不保留（测试/降级路径）";
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
			const ref = entry.kind === "fact" ? entry.record.ref : entry.gap.ref;
			if (this.evidence.has(ref)) continue; // 恢复后源重放：按 ref 去重，不重复入库
			this.evidence.set(ref, entry);
			this.evidenceOrder.push(entry);
		}
		this._version += 1;
		return true;
	}

	listEvidence(filter: EvidenceFilter): EvidencePage | null {
		const all: StoredEntryView[] = this.evidenceOrder.map((entry, index) => ({ storeSeq: index + 1, entry }));
		const items = all
			.filter(({ entry, storeSeq }) => {
				const stream = entry.kind === "fact" ? entry.record.mark.stream : entry.gap.stream;
				if (filter.stream && stream !== filter.stream) return false;
				if (filter.schema && (entry.kind === "gap" || entry.record.schema !== filter.schema)) return false;
				if (filter.afterStoreSeq !== undefined && storeSeq <= filter.afterStoreSeq) return false;
				return true;
			})
			.slice(0, filter.limit);
		const last = items.at(-1);
		return {
			version: this._version,
			items,
			nextStoreSeq: items.length === filter.limit && last ? last.storeSeq : null,
		};
	}

	recoverySnapshot(): StoreRecoveryStream[] | null {
		return null; // 内存存储无持久恢复
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

const SCHEMA_VERSION = "1";

/**
 * node:sqlite 持久实现（LEAD.md 建议优先 node:sqlite，Node ≥22 内置，避免新增原生依赖）。
 * 单 writer 顺序提交（同线程）；WAL 减少读写互阻；存储版本 v 计入 meta。
 * 打开失败由 createWorld 捕获 → history=unavailable，当前接入不受影响（world.md §13.1）。
 */
export class SqliteWorldStore implements WorldStore {
	readonly state = "ready" as const;
	readonly description = "SQLite 持久存储（node:sqlite，WAL）";
	private readonly db: DatabaseSync;
	private _version = 0;

	constructor(dataDir: string, fileName = "world-history.db") {
		mkdirSync(dataDir, { recursive: true });
		this.db = new DatabaseSync(join(dataDir, fileName));
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS evidence (
				ref TEXT PRIMARY KEY,
				stream TEXT NOT NULL,
				seq INTEGER NOT NULL,
				schema TEXT NOT NULL,
				recv INTEGER NOT NULL,
				payload TEXT NOT NULL,
				UNIQUE (stream, seq)
			);
			CREATE TABLE IF NOT EXISTS evidence_gaps (
				ref TEXT PRIMARY KEY,
				stream TEXT NOT NULL,
				after INTEGER NOT NULL,
				through INTEGER,
				reason TEXT NOT NULL,
				recv INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS records (
				ref TEXT PRIMARY KEY,
				revision INTEGER NOT NULL,
				schema TEXT NOT NULL,
				world TEXT NOT NULL,
				world_revision TEXT NOT NULL,
				value TEXT NOT NULL,
				evidence TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS retention (
				owner TEXT NOT NULL,
				evidence_ref TEXT NOT NULL,
				PRIMARY KEY (owner, evidence_ref)
			);
		`);
		const schemaRow = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
			| { value: string }
			| undefined;
		if (!schemaRow) {
			this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
		} else if (schemaRow.value !== SCHEMA_VERSION) {
			const found = schemaRow.value;
			this.db.close();
			throw new Error(`存储 schema 版本不兼容：${found} vs ${SCHEMA_VERSION}`);
		}
		const versionRow = this.db.prepare("SELECT value FROM meta WHERE key = 'store_version'").get() as
			| { value: string }
			| undefined;
		this._version = versionRow ? Number(versionRow.value) : 0;
	}

	get version(): number {
		return this._version;
	}

	get unavailableReason(): string | undefined {
		return undefined;
	}

	private bumpVersion(): void {
		this._version += 1;
		this.db
			.prepare(
				"INSERT INTO meta (key, value) VALUES ('store_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(String(this._version));
	}

	appendEvidence(entries: StoredEntry[]): boolean {
		const insertFact = this.db.prepare(
			"INSERT OR IGNORE INTO evidence (ref, stream, seq, schema, recv, payload) VALUES (?, ?, ?, ?, ?, ?)",
		);
		const insertGap = this.db.prepare(
			"INSERT OR IGNORE INTO evidence_gaps (ref, stream, after, through, reason, recv) VALUES (?, ?, ?, ?, ?, ?)",
		);
		this.db.exec("BEGIN");
		try {
			for (const entry of entries) {
				if (entry.kind === "fact") {
					insertFact.run(
						entry.record.ref,
						entry.record.mark.stream,
						entry.record.mark.sequence,
						entry.record.schema,
						entry.receiveSeq,
						JSON.stringify(entry.record),
					);
				} else {
					insertGap.run(
						entry.gap.ref,
						entry.gap.stream,
						entry.gap.after,
						entry.gap.through,
						entry.gap.reason,
						entry.receiveSeq,
					);
				}
			}
			this.bumpVersion();
			this.db.exec("COMMIT");
			return true;
		} catch (error) {
			this.db.exec("ROLLBACK");
			console.error("[mc-world] appendEvidence failed:", error);
			return false;
		}
	}

	listEvidence(filter: EvidenceFilter): EvidencePage | null {
		// rowid 是 SQLite 插入顺序的单调键（append-only，永不复用），直接作分页键。
		const factRows = this.db
			.prepare(
				`SELECT rowid AS store_seq, payload FROM evidence
				 WHERE (? IS NULL OR stream = ?) AND (? IS NULL OR schema = ?) AND (? IS NULL OR rowid > ?)
				 ORDER BY rowid LIMIT ?`,
			)
			.all(
				filter.stream ?? null,
				filter.stream ?? null,
				filter.schema ?? null,
				filter.schema ?? null,
				filter.afterStoreSeq ?? null,
				filter.afterStoreSeq ?? null,
				filter.limit,
			) as { store_seq: number; payload: string }[];
		const gapRows =
			filter.schema && filter.schema.length > 0
				? [] // schema 过滤只匹配事实
				: (this.db
						.prepare(
							`SELECT rowid AS store_seq, ref, stream, after, through, reason FROM evidence_gaps
							 WHERE (? IS NULL OR stream = ?) AND (? IS NULL OR rowid > ?)
							 ORDER BY rowid LIMIT ?`,
						)
						.all(
							filter.stream ?? null,
							filter.stream ?? null,
							filter.afterStoreSeq ?? null,
							filter.afterStoreSeq ?? null,
							filter.limit,
						) as {
						store_seq: number;
						ref: string;
						stream: string;
						after: number;
						through: number | null;
						reason: string;
					}[]);
		const items: StoredEntryView[] = [
			...factRows.map((row) => ({
				storeSeq: row.store_seq,
				entry: { kind: "fact" as const, receiveSeq: -1, record: JSON.parse(row.payload) as CapturedClientFact },
			})),
			...gapRows.map((row) => ({
				storeSeq: row.store_seq,
				entry: {
					kind: "gap" as const,
					receiveSeq: -1,
					gap: {
						ref: row.ref,
						stream: row.stream,
						after: row.after,
						through: row.through,
						reason: row.reason,
					} satisfies GapRecord,
				},
			})),
		]
			.sort((a, b) => a.storeSeq - b.storeSeq)
			.slice(0, filter.limit);
		const last = items.at(-1);
		return {
			version: this._version,
			items,
			nextStoreSeq: items.length === filter.limit && last ? last.storeSeq : null,
		};
	}

	recoverySnapshot(): StoreRecoveryStream[] {
		const factRows = this.db.prepare("SELECT stream, seq FROM evidence").all() as { stream: string; seq: number }[];
		const gapRows = this.db.prepare("SELECT DISTINCT stream, ref FROM evidence_gaps").all() as {
			stream: string;
			ref: string;
		}[];
		const byStream = new Map<string, StoreRecoveryStream>();
		const ensure = (stream: string): StoreRecoveryStream => {
			let entry = byStream.get(stream);
			if (!entry) {
				entry = { stream, persistedFactSeqs: [], persistedGapRefs: [] };
				byStream.set(stream, entry);
			}
			return entry;
		};
		for (const row of factRows) ensure(row.stream).persistedFactSeqs.push(row.seq);
		for (const row of gapRows) ensure(row.stream).persistedGapRefs.push(row.ref);
		return [...byStream.values()];
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
		const existingRow = this.db
			.prepare("SELECT revision, schema, world, world_revision, created_at FROM records WHERE ref = ?")
			.get(change.ref) as
			| { revision: number; schema: string; world: string; world_revision: string; created_at: string }
			| undefined;
		this.db.exec("BEGIN");
		try {
			if (change.expectedRevision === null) {
				if (existingRow) {
					this.db.exec("ROLLBACK");
					return { ok: false, reason: "conflict" };
				}
				const now = new Date().toISOString();
				this.db
					.prepare(
						"INSERT INTO records (ref, revision, schema, world, world_revision, value, evidence, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						change.ref,
						change.schema,
						change.world,
						change.worldRevision,
						JSON.stringify(change.value),
						JSON.stringify(change.evidence),
						now,
					);
				this.bumpVersion();
				this.db.exec("COMMIT");
				return {
					ok: true,
					record: {
						ref: change.ref,
						revision: 1,
						schema: change.schema,
						world: change.world,
						worldRevision: change.worldRevision,
						value: change.value,
						evidence: [...change.evidence],
						createdAt: now,
					},
				};
			}
			if (!existingRow) {
				this.db.exec("ROLLBACK");
				return { ok: false, reason: "not_found" };
			}
			if (existingRow.revision !== change.expectedRevision) {
				this.db.exec("ROLLBACK");
				return { ok: false, reason: "conflict" };
			}
			if (
				existingRow.schema !== change.schema ||
				existingRow.world !== change.world ||
				existingRow.world_revision !== change.worldRevision
			) {
				this.db.exec("ROLLBACK");
				return { ok: false, reason: "immutable_fields" };
			}
			this.db
				.prepare("UPDATE records SET revision = revision + 1, value = ?, evidence = ? WHERE ref = ?")
				.run(JSON.stringify(change.value), JSON.stringify(change.evidence), change.ref);
			this.bumpVersion();
			this.db.exec("COMMIT");
			const row = this.db.prepare("SELECT revision, created_at FROM records WHERE ref = ?").get(change.ref) as {
				revision: number;
				created_at: string;
			};
			return {
				ok: true,
				record: {
					ref: change.ref,
					revision: row.revision,
					schema: change.schema,
					world: change.world,
					worldRevision: change.worldRevision,
					value: change.value,
					evidence: [...change.evidence],
					createdAt: row.created_at,
				},
			};
		} catch (error) {
			this.db.exec("ROLLBACK");
			console.error("[mc-world] writeRecord failed:", error);
			return { ok: false, reason: "store_failed" };
		}
	}

	readRecord(ref: string): DomainRecordRow | null {
		const row = this.db.prepare("SELECT * FROM records WHERE ref = ?").get(ref) as
			| {
					ref: string;
					revision: number;
					schema: string;
					world: string;
					world_revision: string;
					value: string;
					evidence: string;
					created_at: string;
			  }
			| undefined;
		if (!row) return null;
		return {
			ref: row.ref,
			revision: row.revision,
			schema: row.schema,
			world: row.world,
			worldRevision: row.world_revision,
			value: JSON.parse(row.value),
			evidence: JSON.parse(row.evidence) as string[],
			createdAt: row.created_at,
		};
	}

	retain(owner: string, evidence: string[]): boolean {
		const insert = this.db.prepare("INSERT OR IGNORE INTO retention (owner, evidence_ref) VALUES (?, ?)");
		this.db.exec("BEGIN");
		try {
			for (const ref of evidence) insert.run(owner, ref);
			this.bumpVersion();
			this.db.exec("COMMIT");
			return true;
		} catch (error) {
			this.db.exec("ROLLBACK");
			console.error("[mc-world] retain failed:", error);
			return false;
		}
	}

	release(owner: string): boolean {
		const result = this.db.prepare("DELETE FROM retention WHERE owner = ?").run(owner);
		this.bumpVersion();
		return Number(result.changes) > 0;
	}

	retainedBy(owner: string): string[] | null {
		const rows = this.db.prepare("SELECT evidence_ref FROM retention WHERE owner = ?").all(owner) as {
			evidence_ref: string;
		}[];
		if (rows.length === 0) return null;
		return rows.map((row) => row.evidence_ref);
	}

	allRetentions(): { owner: string; evidence: string[] }[] {
		const rows = this.db.prepare("SELECT owner, evidence_ref FROM retention").all() as {
			owner: string;
			evidence_ref: string;
		}[];
		const byOwner = new Map<string, string[]>();
		for (const row of rows) {
			const list = byOwner.get(row.owner) ?? [];
			list.push(row.evidence_ref);
			byOwner.set(row.owner, list);
		}
		return [...byOwner].map(([owner, evidence]) => ({ owner, evidence }));
	}

	close(): void {
		this.db.close();
	}
}

/** 不可用存储：SQLite 打开失败/损坏时的显式降级（history=unavailable；不假装空历史）。 */
export class UnavailableWorldStore implements WorldStore {
	readonly state = "unavailable" as const;
	readonly description = "历史存储不可用";
	constructor(readonly unavailableReason: string) {}

	get version(): number {
		return 0;
	}

	appendEvidence(): boolean {
		return false;
	}

	listEvidence(): null {
		return null;
	}

	recoverySnapshot(): null {
		return null;
	}

	writeRecord(): { ok: false; reason: "store_failed" } {
		return { ok: false, reason: "store_failed" };
	}

	readRecord(): null {
		return null;
	}

	retain(): boolean {
		return false;
	}

	release(): boolean {
		return false;
	}

	retainedBy(): null {
		return null;
	}

	allRetentions(): { owner: string; evidence: string[] }[] {
		return [];
	}

	close(): void {}
}
