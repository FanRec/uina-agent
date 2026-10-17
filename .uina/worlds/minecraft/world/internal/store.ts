/**
 * World 历史存储：异步接口 + 内存实现 + 专用 Worker 持久实现。
 *
 * 语义（World 重构终态）：
 * - 存储在专用 Worker 中持有 SQLite 连接，脱离 World/Driver 事件循环；
 *   每条消息是一个原子边界：append 批量在一个事务内提交，读取不看到半个事务。
 * - append 失败返回 false（上层不推进 durable）；异常经 Promise reject 表达
 *   （Worker 崩溃/退出），门面转为显式 unavailable，不静默吞掉。
 * - 去重以稳定 evidence ref 为准：恢复后源重放（新接收代次）不重复入库。
 * - 恢复快照提供"已持久事实 seq / gap ref"集合，使新接收代次的 durable 从真实持久状态起步。
 * - listEvidence 按持久化顺序 store_seq 稳定排序；分页固定提交版本 v（page.version）。
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
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

/** 分页视图：storeSeq 是存储在 append 时分配的单调顺序键（与接收序独立）。 */
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
	/** 提交版本：本页读取边界的存储版本（分页 token 固定它）。 */
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

export type WriteRecordOutcome =
	| { ok: true; record: DomainRecordRow }
	| { ok: false; reason: "conflict" | "not_found" | "store_failed" | "immutable_fields" };

export interface StoreRecoveryStream {
	stream: string;
	persistedFactSeqs: number[];
	persistedGapRefs: string[];
}

export interface WorldStoreAvailability {
	state: "ready" | "unavailable";
	reason?: string;
}

/**
 * 异步存储接口：所有方法不阻塞调用方事件循环。
 * append/listEvidence/readRecord 等在实现内部原子执行（Worker 单线程顺序处理）。
 */
export interface WorldStore {
	readonly availability: WorldStoreAvailability;
	/** 存储形态说明（status 如实呈现，不冒充持久性）。 */
	readonly description: string;
	/** 批量提交证据/缺口条目。失败返回 false（不推进 durable）。 */
	append(entries: StoredEntry[]): Promise<boolean>;
	/** 读取已持久证据（含 gap 记录）；页携带提交版本。存储不可用返回 null。 */
	listEvidence(filter: EvidenceFilter): Promise<EvidencePage | null>;
	/** 证据/gap 引用是否已持久存在（retain/记录写入的存在性校验）。 */
	hasEvidence(ref: string): Promise<boolean>;
	/** 恢复快照：已持久事实 seq 与 gap ref（按流）；内存实现返回 null。 */
	recoverySnapshot(): Promise<StoreRecoveryStream[] | null>;
	/** 领域记录：CAS 写入。 */
	writeRecord(change: {
		ref: string;
		schema: string;
		world: string;
		worldRevision: string;
		expectedRevision: number | null;
		value: unknown;
		evidence: string[];
	}): Promise<WriteRecordOutcome>;
	readRecord(ref: string): Promise<DomainRecordRow | null>;
	/** 保留关系：幂等追加。失败返回 false。 */
	retain(owner: string, evidence: string[]): Promise<boolean>;
	release(owner: string): Promise<boolean>;
	/** 关闭结算：冲刷语义由实现决定；此后所有方法拒绝。 */
	close(): Promise<void>;
}

/** 内存实现：语义与 Worker 版一致，用于测试与降级路径；进程退出不保留。 */
export class MemoryWorldStore implements WorldStore {
	readonly availability: WorldStoreAvailability = { state: "ready" };
	readonly description = "内存存储：进程退出不保留（测试/降级路径）";
	private evidence = new Map<string, StoredEntry>();
	private evidenceOrder: StoredEntry[] = [];
	private records = new Map<string, DomainRecordRow>();
	private retentions = new Map<string, Set<string>>();
	private version = 0;

	appendEvidence(entries: StoredEntry[]): boolean {
		for (const entry of entries) {
			const ref = entry.kind === "fact" ? entry.record.ref : entry.gap.ref;
			if (this.evidence.has(ref)) continue; // 恢复后源重放：按 ref 去重，不重复入库
			this.evidence.set(ref, entry);
			this.evidenceOrder.push(entry);
		}
		this.version += 1;
		return true;
	}

	listEvidenceSync(filter: EvidenceFilter): EvidencePage | null {
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
			version: this.version,
			items,
			nextStoreSeq: items.length === filter.limit && last ? last.storeSeq : null,
		};
	}

	async append(entries: StoredEntry[]): Promise<boolean> {
		return this.appendEvidence(entries);
	}

	async listEvidence(filter: EvidenceFilter): Promise<EvidencePage | null> {
		return this.listEvidenceSync(filter);
	}

	async recoverySnapshot(): Promise<null> {
		return null; // 内存存储无持久恢复
	}

	async hasEvidence(ref: string): Promise<boolean> {
		return this.evidence.has(ref);
	}

	async writeRecord(change: {
		ref: string;
		schema: string;
		world: string;
		worldRevision: string;
		expectedRevision: number | null;
		value: unknown;
		evidence: string[];
	}): Promise<WriteRecordOutcome> {
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
			this.version += 1;
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
		this.version += 1;
		return { ok: true, record: row };
	}

	async readRecord(ref: string): Promise<DomainRecordRow | null> {
		return this.records.get(ref) ?? null;
	}

	async retain(owner: string, evidence: string[]): Promise<boolean> {
		let set = this.retentions.get(owner);
		if (!set) {
			set = new Set();
			this.retentions.set(owner, set);
		}
		for (const ref of evidence) set.add(ref);
		this.version += 1;
		return true;
	}

	async release(owner: string): Promise<boolean> {
		const deleted = this.retentions.delete(owner);
		if (deleted) this.version += 1;
		return deleted;
	}

	async close(): Promise<void> {
		// 内存存储无持久资源。
	}
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/**
 * 专用 Worker 持久实现：SQLite 连接生活在 worker 线程。
 * 崩溃/退出 → 门面转显式 unavailable，在途请求拒绝；World 业务逻辑据此如实降级。
 */
export class SqliteWorkerStore implements WorldStore {
	readonly description = "SQLite 持久存储（专用 Worker，WAL）";
	private readonly worker: Worker;
	private readonly pending = new Map<number, PendingRequest>();
	private nextId = 1;
	private failure: string | null = null;
	private closing = false;
	private readonly readyPromise: Promise<void>;

	constructor(dataDir: string, fileName = "world-history.db") {
		// 不用 `new Worker(new URL(...))` 字面量：避免打包器把它当作可打包资源改写。
		const workerDir = fileURLToPath(new URL(".", import.meta.url));
		this.worker = new Worker(join(workerDir, "sqlite-worker.mjs"), { name: "mc-world-sqlite" });
		this.worker.on("message", (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
			const entry = this.pending.get(msg.id);
			if (!entry) return;
			this.pending.delete(msg.id);
			if (msg.ok) entry.resolve(msg.result);
			else entry.reject(new Error(msg.error ?? "存储操作失败"));
		});
		this.worker.on("error", (error: Error) => {
			this.failAll(`存储 Worker 故障：${String(error?.message ?? error)}`);
		});
		this.worker.on("exit", (code: number) => {
			if (!this.closing) this.failAll(`存储 Worker 退出（code=${code}）`);
		});
		this.readyPromise = this.request("open", { dataDir, fileName }).then(() => undefined);
	}

	/** 打开握手完成（schema 校验通过）；失败则该实例不可用。 */
	get ready(): Promise<void> {
		return this.readyPromise;
	}

	/** Worker 线程标识（诊断/测试：证明存储脱离主事件循环）。 */
	get workerThreadId(): number {
		return this.worker.threadId;
	}

	get availability(): WorldStoreAvailability {
		return this.failure === null ? { state: "ready" } : { state: "unavailable", reason: this.failure };
	}

	private request(op: string, args: Record<string, unknown>): Promise<unknown> {
		if (this.failure !== null) return Promise.reject(new Error(this.failure));
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.worker.postMessage({ id, op, args });
		});
	}

	private failAll(reason: string): void {
		if (this.failure !== null) return;
		this.failure = reason;
		const waiting = [...this.pending.values()];
		this.pending.clear();
		for (const entry of waiting) entry.reject(new Error(reason));
	}

	private async call<T>(op: string, args: Record<string, unknown>): Promise<T> {
		return (await this.request(op, args)) as T;
	}

	async append(entries: StoredEntry[]): Promise<boolean> {
		const { ok } = await this.call<{ ok: boolean }>("append", { entries });
		return ok;
	}

	async listEvidence(filter: EvidenceFilter): Promise<EvidencePage | null> {
		const { page } = await this.call<{ page: EvidencePage | null }>("list", { filter });
		return page;
	}

	async hasEvidence(ref: string): Promise<boolean> {
		const { exists } = await this.call<{ exists: boolean }>("has", { ref });
		return exists;
	}

	async recoverySnapshot(): Promise<StoreRecoveryStream[] | null> {
		const { streams } = await this.call<{ streams: StoreRecoveryStream[] }>("recovery", {});
		return streams;
	}

	async writeRecord(change: {
		ref: string;
		schema: string;
		world: string;
		worldRevision: string;
		expectedRevision: number | null;
		value: unknown;
		evidence: string[];
	}): Promise<WriteRecordOutcome> {
		const { outcome } = await this.call<{ outcome: WriteRecordOutcome }>("record_write", { change });
		return outcome;
	}

	async readRecord(ref: string): Promise<DomainRecordRow | null> {
		const { row } = await this.call<{ row: DomainRecordRow | null }>("record_read", { ref });
		return row;
	}

	async retain(owner: string, evidence: string[]): Promise<boolean> {
		const { ok } = await this.call<{ ok: boolean }>("retain", { owner, evidence });
		return ok;
	}

	async release(owner: string): Promise<boolean> {
		const { ok } = await this.call<{ ok: boolean }>("release", { owner });
		return ok;
	}

	async close(): Promise<void> {
		if (this.failure !== null) return;
		this.closing = true;
		try {
			await this.request("close", {});
		} catch {
			// 关闭请求失败（可能已崩溃）：直接终止。
		}
		await this.worker.terminate();
		this.failAll("存储已关闭");
	}
}

/** 打开 Worker 存储：等待打开握手（含 schema 校验）完成；失败抛出，由调用方降级。 */
export async function openSqliteWorkerStore(
	dataDir: string,
	fileName = "world-history.db",
): Promise<SqliteWorkerStore> {
	const store = new SqliteWorkerStore(dataDir, fileName);
	try {
		await store.ready;
	} catch (error) {
		await store.close().catch(() => {});
		throw error;
	}
	return store;
}

/** 不可用存储：SQLite 打开失败/Worker 启动失败时的显式降级（history=unavailable；不假装空历史）。 */
export class UnavailableWorldStore implements WorldStore {
	readonly availability: WorldStoreAvailability;
	readonly description = "历史存储不可用";

	constructor(reason: string) {
		this.availability = { state: "unavailable", reason };
	}

	async append(): Promise<boolean> {
		return false;
	}

	async listEvidence(): Promise<null> {
		return null;
	}

	async hasEvidence(): Promise<boolean> {
		return false;
	}

	async recoverySnapshot(): Promise<null> {
		return null;
	}

	async writeRecord(): Promise<WriteRecordOutcome> {
		return { ok: false, reason: "store_failed" };
	}

	async readRecord(): Promise<null> {
		return null;
	}

	async retain(): Promise<boolean> {
		return false;
	}

	async release(): Promise<boolean> {
		return false;
	}

	async close(): Promise<void> {}
}
