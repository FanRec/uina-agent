/**
 * World 历史侧：facts 证据通知 → 单一有序队列 → 存储 Worker → durable ACK 回收。
 *
 * 唯一定义来源：docs/proposals/mc/modules/world.md §5.3–§5.6、§13.1。
 * 两段启动：本模块构造即订阅（段1 订阅先行不漏材料），历史侧独立推进
 * opening → ready/unavailable；打开失败是终态（不播种、不再 ACK），但订阅保持、
 * 接收继续运转——durable 停在真实起点，Driver 侧溢出缺口机制兜底，不无限缓冲。
 * durable ACK 发布与待落盘队列移除在同一续体完成（§5.6）。
 */

import { Worker } from "node:worker_threads";
import type { ClientFactNotice, ClientFactsPort, ClientFactsSubscription } from "../contracts/client-facts.js";
import type { AppendItem, WorkerRequest, WorkerResponse } from "./sqlite-worker.js";

/** opening 期缓冲上限：超过即显式 unavailable（RAM 接收不是无限缓存承诺，§13.1）。 */
const MAX_OPENING_BUFFER = 8192;

export type HistoryState = { state: "opening" } | { state: "ready" } | { state: "unavailable"; reason: string };

type QueueEntry = AppendItem | { kind: "streamEnd"; stream: string; fence: number };

export class HistoryIngest {
	private readonly worker: Worker;
	private readonly subscription: ClientFactsSubscription;
	private queue: QueueEntry[] = [];
	private flushScheduled = false;
	private closed = false;
	private _state: HistoryState = { state: "opening" };
	private readonly receiver: string;
	private settle!: (result: "ready" | "unavailable") => void;
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
		this.worker = new Worker(new URL("./sqlite-worker.ts", import.meta.url));
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
			this._state = { state: "ready" };
			this.settle("ready");
			this.scheduleFlush();
			return;
		}
		if (msg.type === "durable") {
			for (const ack of msg.acks) {
				this.subscription.acknowledge({
					receiver: this.receiver,
					stream: ack.stream,
					durableThrough: ack.durableThrough,
				});
			}
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
		// 终态：不播种、不再 ACK，但订阅保持——接收继续运转（§13.1）。
		this._state = { state: "unavailable", reason };
		this.queue = [];
		this.settle("unavailable");
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
		this.closed = true;
		this.subscription.close();
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
