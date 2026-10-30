/**
 * World 历史侧：facts 证据通知 → 单一有序队列 → 存储 Worker → durable ACK 回收。
 *
 * 唯一定义来源：docs/proposals/mc/modules/world.md §5.3–§5.6、§13.1。
 * 两段启动：本模块构造即订阅（段1 订阅先行不漏材料），历史侧独立推进
 * opening → ready/unavailable；打开失败是终态（不播种、不再 ACK），但订阅保持、
 * 接收继续运转——durable 停在真实起点，Driver 侧溢出缺口机制兜底，不无限缓冲。
 * durable ACK 发布与待落盘队列移除在同一续体完成（§5.6）。
 */

import { ObservationWatch } from "./watch.js";
import type { ObservationCursor } from "../contracts/values.js";
import { Worker } from "node:worker_threads";
import type { ClientFactNotice, ClientFactsPort, ClientFactsSubscription } from "../contracts/client-facts.js";
import { callFailure } from "../contracts/values.js";
import type { AppendItem, WorkerRequest, WorkerResponse } from "./sqlite-worker.js";
import type {
	RecordReadParams,
	RecordWrite,
	RecordsListParams,
	RecordsListResult,
	StoredRecordRow,
} from "./sqlite-worker.js";
import type { EventQueryParams, EventQueryResult } from "./events.js";
import type { ContainerEvidence, ContainerQueryParams } from "./containers.js";
import type { WorldHistoryPrune, WorldHistoryPruneResult } from "../contracts/world.js";

/** opening 期缓冲上限：超过即显式 unavailable（RAM 接收不是无限缓存承诺，§13.1）。 */
const MAX_OPENING_BUFFER = 8192;

export type HistoryState = { state: "opening" } | { state: "ready" } | { state: "unavailable"; reason: string };

function storeUnavailable(state: { reason: string }): Error {
	return callFailure({
		code: "STORE_UNAVAILABLE",
		source: "world",
		message: `world history is unavailable: ${state.reason}`,
		hint: "current reads keep working; history-backed queries need the storage worker",
		dispatch: "not_sent",
		effects: [],
		recoverable: false,
	});
}

type QueueEntry = AppendItem | { kind: "streamEnd"; stream: string; fence: number };

export class HistoryIngest {
	private readonly worker: Worker;
	private readonly subscription: ClientFactsSubscription;
	private queue: QueueEntry[] = [];
	private flushScheduled = false;
	private closed = false;
	private _state: HistoryState = { state: "opening" };
	private readonly receiver: string;
	private storage = "";
	private version = 0;
	private recordVersion = 0;
	private readonly watches = new Map<ObservationWatch, string>();
	/** places@1 记录观察：按 record_version 失效，与 events 的提交版本分开。 */
	private readonly recordWatches = new Map<ObservationWatch, string>();
	private settle!: (result: "ready" | "unavailable") => void;
	/** 提交屏障与历史读取的往返登记（worker 串行处理，回执即此前消息已提交）。 */
	private barrierSeq = 0;
	private readSeq = 0;
	private readonly barrierWaiters = new Map<number, () => void>();
	private readonly readWaiters = new Map<
		number,
		{ resolve: (result: EventQueryResult) => void; reject: (err: Error) => void }
	>();
	private readonly containerWaiters = new Map<
		number,
		{ resolve: (result: ContainerEvidence | null) => void; reject: (err: Error) => void }
	>();
	private readonly mutationWaiters = new Map<
		number,
		{
			resolve: (result: WorldHistoryPruneResult | null) => void;
			reject: (err: Error) => void;
		}
	>();
	private readonly recordWaiters = new Map<
		number,
		{
			resolve: (result: StoredRecordRow | null | boolean | RecordsListResult) => void;
			reject: (err: Error) => void;
		}
	>();
	/** 历史侧就绪信号：ready 或明确 unavailable 都结算（§13.1，不进公开查询面）。 */
	readonly historyReady: Promise<"ready" | "unavailable">;

	constructor(facts: ClientFactsPort, opts: { dbPath: string; receiverNamespace: string }) {
		this.receiver = `hist:${opts.receiverNamespace}:1`;
		this.historyReady = new Promise<"ready" | "unavailable">((resolve) => {
			this.settle = resolve;
		});
		// 段1：订阅先行，不漏 Driver 材料（§13.1）；历史存储是证据消费者，
		// 只有它的 ack 才能推进释放水线（只读 watch 不参与）。
		this.subscription = facts.subscribe((notice) => this.onNotice(notice), { consumesEvidence: true });
		// 源码用 .ts（tsx 装载），构建产物用同目录 .js；不按"文件存在就挑"猜版本。
		const workerFile = import.meta.url.endsWith(".js") ? "./sqlite-worker.js" : "./sqlite-worker.ts";
		this.worker = new Worker(new URL(workerFile, import.meta.url));
		this.worker.on("message", (msg: WorkerResponse) => this.onWorkerMessage(msg));
		this.worker.on("error", (err: Error) => this.fail(`storage worker error: ${err.message}`));
		this.worker.on("exit", (code: number) => {
			if (!this.closed && this._state.state !== "unavailable") {
				this.fail(`storage worker exited unexpectedly (code ${code})`);
			}
		});
		this.post({ type: "open", dbPath: opts.dbPath });
	}

	get state(): HistoryState {
		return this._state;
	}

	// ---- facts 通知入口 ----

	private onNotice(notice: ClientFactNotice): void {
		if (this.closed || this._state.state === "unavailable") return;
		if (notice.kind === "evidence") {
			for (const record of notice.records) this.enqueue({ kind: "evidence", record });
			return;
		}
		if (notice.kind === "evidence_gap") {
			this.enqueue({
				kind: "gap",
				ref: notice.ref,
				stream: notice.stream,
				after: notice.after,
				through: notice.through,
				reason: notice.reason,
			});
			return;
		}
		if (notice.kind === "evidence_end") {
			// 流封口：fence = 末端已发证据序号，未知尾后缀解析为有限区间（§5.5/§5.6）。
			this.enqueue({ kind: "streamEnd", stream: notice.through.stream, fence: notice.through.sequence });
			return;
		}
		// changed/reset 属当前侧失效，不入库。
	}

	private enqueue(entry: QueueEntry): void {
		if (this._state.state === "unavailable") return;
		if (this._state.state === "opening" && this.queue.length >= MAX_OPENING_BUFFER) {
			this.fail(`opening ingest buffer overflow (${MAX_OPENING_BUFFER})`);
			return;
		}
		this.queue.push(entry);
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.flushScheduled) return;
		this.flushScheduled = true;
		queueMicrotask(() => {
			this.flushScheduled = false;
			this.flush();
		});
	}

	/** ready 才发车；opening 期按到达序缓冲（§13.1），unavailable 弃置（durable 停在真实起点）。 */
	private flush(): void {
		if (this._state.state !== "ready" || this.queue.length === 0) return;
		const batch = this.queue;
		this.queue = [];
		let pending: AppendItem[] = [];
		const drain = () => {
			if (pending.length === 0) return;
			this.post({ type: "append", items: pending });
			pending = [];
		};
		for (const entry of batch) {
			if (entry.kind === "streamEnd") {
				drain();
				this.post({ type: "streamEnd", stream: entry.stream, fence: entry.fence });
			} else {
				pending.push(entry);
			}
		}
		drain();
	}

	// ---- worker 消息 ----

	private onWorkerMessage(msg: WorkerResponse): void {
		if (this.closed) return;
		if (msg.type === "opened") {
			this.storage = msg.storage;
			this.version = msg.version;
			this.recordVersion = msg.recordVersion;
			this._state = { state: "ready" };
			this.settle("ready");
			this.scheduleFlush();
			return;
		}
		if (msg.type === "durable") {
			this.version = Math.max(this.version, msg.version);
			for (const [watch, stream] of this.watches) watch.update(this.eventCursor(stream, this.version));
			for (const ack of msg.acks) {
				this.subscription.acknowledge({
					receiver: this.receiver,
					stream: ack.stream,
					durableThrough: ack.durableThrough,
				});
			}
			return;
		}
		if (msg.type === "barrierReached") {
			this.barrierWaiters.get(msg.id)?.();
			this.barrierWaiters.delete(msg.id);
			return;
		}
		if (msg.type === "eventsPage") {
			const waiter = this.readWaiters.get(msg.id);
			this.readWaiters.delete(msg.id);
			waiter?.resolve(msg.result);
			return;
		}
		if (msg.type === "queryFailed") {
			const waiter =
				this.readWaiters.get(msg.id) ??
				this.mutationWaiters.get(msg.id) ??
				this.recordWaiters.get(msg.id) ??
				this.containerWaiters.get(msg.id);
			this.readWaiters.delete(msg.id);
			this.mutationWaiters.delete(msg.id);
			this.recordWaiters.delete(msg.id);
			waiter?.reject(
				callFailure({
					code: msg.code,
					message: msg.message,
					source: "world",
					dispatch: "not_sent",
					effects: [],
					recoverable: true,
				}),
			);
			return;
		}
		if (msg.type === "retained" || msg.type === "pruned") {
			if (msg.type === "pruned") {
				this.version = Math.max(this.version, msg.result.version);
				for (const [watch, stream] of this.watches) watch.update(this.eventCursor(stream, this.version));
			}
			const waiter = this.mutationWaiters.get(msg.id);
			this.mutationWaiters.delete(msg.id);
			waiter?.resolve(msg.type === "pruned" ? msg.result : null);
			return;
		}
		if (msg.type === "containerLast") {
			const waiter = this.containerWaiters.get(msg.id);
			this.containerWaiters.delete(msg.id);
			waiter?.resolve(msg.result);
			return;
		}
		if (msg.type === "recordWritten" || msg.type === "recordRemoved") {
			this.recordVersion = Math.max(this.recordVersion, msg.recordVersion);
			for (const [watch, stream] of this.recordWatches) watch.update(this.placesCursor(stream));
			const waiter = this.recordWaiters.get(msg.id);
			this.recordWaiters.delete(msg.id);
			if (msg.type === "recordWritten") waiter?.resolve(msg.record);
			else waiter?.resolve(msg.removed);
			return;
		}
		if (msg.type === "recordResult" || msg.type === "recordsPage") {
			const waiter = this.recordWaiters.get(msg.id);
			this.recordWaiters.delete(msg.id);
			waiter?.resolve(msg.type === "recordResult" ? msg.record : msg.result);
			return;
		}
		if (msg.type === "conflict") {
			this.fail(`source protocol conflict: ${msg.message}`);
			return;
		}
		if (msg.type === "fatal") {
			this.fail(`storage unavailable: ${msg.message}`);
			return;
		}
	}

	private fail(reason: string): void {
		if (this.closed || this._state.state === "unavailable") return;
		this.rejectPending(`history store unavailable: ${reason}`);
		// 终态：不播种、不再 ACK，但订阅保持——接收继续运转（§13.1）。
		this._state = { state: "unavailable", reason };
		this.queue = [];
		for (const watch of this.watches.keys()) void watch.close();
		for (const watch of this.recordWatches.keys()) void watch.close();
		this.settle("unavailable");
	}

	private rejectPending(reason: string): void {
		for (const resolve of this.barrierWaiters.values()) resolve();
		this.barrierWaiters.clear();
		for (const waiter of this.readWaiters.values()) waiter.reject(new Error(reason));
		this.readWaiters.clear();
		for (const waiter of this.containerWaiters.values()) waiter.reject(storeUnavailable({ reason }));
		this.containerWaiters.clear();
		for (const waiter of this.mutationWaiters.values()) waiter.reject(storeUnavailable({ reason }));
		this.mutationWaiters.clear();
		for (const waiter of this.recordWaiters.values()) waiter.reject(storeUnavailable({ reason }));
		this.recordWaiters.clear();
	}

	/** 提交屏障：先把已接收材料发车，再等 worker 处理到这条消息为止（§6.2）。 */
	async barrier(): Promise<void> {
		if (this.closed) throw storeUnavailable({ reason: "history store closed" });
		if (this._state.state === "opening") await this.historyReady;
		if (this._state.state === "unavailable") throw storeUnavailable(this._state);
		this.flush();
		const id = ++this.barrierSeq;
		await new Promise<void>((resolve) => {
			this.barrierWaiters.set(id, resolve);
			this.post({ type: "barrier", id });
		});
	}

	/** 历史读取：屏障之后发一条读取消息，页内一致由 worker 单消息保证。 */
	async readEvents(params: EventQueryParams): Promise<EventQueryResult> {
		await this.barrier();
		if (this._state.state === "unavailable") throw storeUnavailable(this._state);
		const id = ++this.readSeq;
		return await new Promise<EventQueryResult>((resolve, reject) => {
			this.readWaiters.set(id, { resolve, reject });
			this.post({ type: "readEvents", id, params });
		});
	}

	eventCursor(stream: string, version: number): ObservationCursor {
		return { stream: JSON.stringify([this.storage, stream]), epoch: this.receiver, sequence: version };
	}
	watchEvents(stream: string): ObservationWatch {
		if (this.closed || this._state.state !== "ready") throw storeUnavailable({ reason: "history watch unavailable" });
		const watch = new ObservationWatch(this.eventCursor(stream, this.version), () => {
			this.watches.delete(watch);
		});
		this.watches.set(watch, stream);
		return watch;
	}

	async readContainer(params: ContainerQueryParams): Promise<ContainerEvidence | null> {
		await this.barrier();
		if (this._state.state === "unavailable") throw storeUnavailable(this._state);
		const id = ++this.readSeq;
		return await new Promise<ContainerEvidence | null>((resolve, reject) => {
			this.containerWaiters.set(id, { resolve, reject });
			this.post({ type: "readContainer", id, params });
		});
	}

	// ---- 领域记录（public-api §5；屏障后单消息，CAS 在 worker 单事务内） ----

	private async recordMessage(
		request:
			| { type: "writeRecord"; change: RecordWrite }
			| { type: "readRecord"; params: RecordReadParams }
			| { type: "readRecords"; params: RecordsListParams }
			| { type: "removeRecord"; params: RecordReadParams },
	): Promise<StoredRecordRow | null | boolean | RecordsListResult> {
		await this.barrier();
		if (this._state.state === "unavailable") throw storeUnavailable(this._state);
		const id = ++this.readSeq;
		return await new Promise((resolve, reject) => {
			this.recordWaiters.set(id, { resolve, reject });
			this.post({ ...request, id });
		});
	}

	writeRecord(change: RecordWrite): Promise<StoredRecordRow> {
		return this.recordMessage({ type: "writeRecord", change }) as Promise<StoredRecordRow>;
	}

	readRecord(params: RecordReadParams): Promise<StoredRecordRow | null> {
		return this.recordMessage({ type: "readRecord", params }) as Promise<StoredRecordRow | null>;
	}

	readRecords(params: RecordsListParams): Promise<RecordsListResult> {
		return this.recordMessage({ type: "readRecords", params }) as Promise<RecordsListResult>;
	}

	removeRecord(params: RecordReadParams): Promise<boolean> {
		return this.recordMessage({ type: "removeRecord", params }) as Promise<boolean>;
	}

	placesCursor(stream: string): ObservationCursor {
		return { stream: JSON.stringify([this.storage, stream]), epoch: this.receiver, sequence: this.recordVersion };
	}

	watchRecords(stream: string): ObservationWatch {
		if (this.closed || this._state.state !== "ready") throw storeUnavailable({ reason: "record watch unavailable" });
		const watch = new ObservationWatch(this.placesCursor(stream), () => {
			this.recordWatches.delete(watch);
		});
		this.recordWatches.set(watch, stream);
		return watch;
	}

	async retain(owner: string, evidence: string[]): Promise<void> {
		await this.mutate({ type: "retain", owner, evidence: [...evidence] });
	}

	async release(owner: string): Promise<void> {
		await this.mutate({ type: "release", owner });
	}

	async prune(options: WorldHistoryPrune): Promise<WorldHistoryPruneResult> {
		const result = await this.mutate({ type: "prune", options: structuredClone(options) });
		if (result === null) throw new Error("missing history prune result");
		return result;
	}

	private async mutate(
		request:
			| { type: "retain"; owner: string; evidence: string[] }
			| { type: "release"; owner: string }
			| { type: "prune"; options: WorldHistoryPrune },
	): Promise<WorldHistoryPruneResult | null> {
		await this.barrier();
		if (this._state.state === "unavailable") throw storeUnavailable(this._state);
		const id = ++this.readSeq;
		return await new Promise((resolve, reject) => {
			this.mutationWaiters.set(id, { resolve, reject });
			this.post({ ...request, id });
		});
	}

	private post(request: WorkerRequest): void {
		try {
			this.worker.postMessage(request);
		} catch (err) {
			this.fail(`storage worker post failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		// Close follows all already captured evidence, even before its flush microtask.
		try {
			await this.barrier();
		} catch {
			/* Unavailable is already an explicit terminal state. */
		}
		this.closed = true;
		this.subscription.close();
		await Promise.all([...this.watches.keys()].map((w) => w.close()));
		this.rejectPending("history store closed");
		if (this._state.state === "ready") this.post({ type: "close" });
		const worker = this.worker;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				void worker.terminate().then(
					() => resolve(),
					() => resolve(),
				);
			}, 2000);
			worker.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}
