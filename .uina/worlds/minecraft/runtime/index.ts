/**
 * Minecraft Runtime 组合根：node:sqlite worker + 记录队列 + 执行引擎的装配端口。
 *
 * 唯一定义来源：docs/proposals/mc/modules/runtime.md §5.3、public-api.md §7.1；plan §8。
 * open 完成两段启动：worker 打开握手（WAL/FULL 实值 + 全量恢复行）→ 引擎恢复结算
 * （未终结 Run 按 §4.4 表落终态）→ 冲刷恢复截面后才 ready。装配接缝：Driver 消费
 * sink（DriverExecutionSink）与 barrier（RuntimeRecordBarrier）；能力层经 chat/navigate
 * 使用引擎归属作用域。close 先冲刷队列再关库；数据库故障不阻止关闭，最终冲刷失败
 * 如实抛出（不假称持久）。
 */

import { Worker } from "node:worker_threads";
import type { ControlOwner, PlayerPort } from "../contracts/body.js";
import type { NativeCallable } from "../contracts/capabilities.js";
import type {
	Acceptance,
	DriverExecutionSink,
	Origin,
	RunRequest,
	RunSummary,
	RunWaitReply,
	RuntimeRecordBarrier,
	StopCommand,
	StopReceipt,
	SubmissionLookup,
} from "../contracts/runtime.js";
import type { WorldPort } from "../contracts/world.js";
import type { EffectReceipt, JsonValue, Ref } from "../contracts/values.js";
import { RuntimeEngine } from "./engine.js";
import { RecordQueue } from "./records.js";
import { RuntimeRefs } from "./refs.js";
import type { RecoveredRows, WorkerRequest, WorkerResponse } from "./runtime-db-worker.js";

export interface MinecraftRuntimeOptions {
	/** runtime.db 绝对路径（<worldDataDir>/runtime.db，runtime.md §5.3）。 */
	dbPath: string;
	/** 存储身份：与库内 meta.storage_id 核对，不符即打开失败。 */
	storageId: string;
	/** per-boot 发号命名空间（与 FactsBinding.streamNamespace 同源约定）。 */
	namespace: string;
	worldOwner: Ref;
	world: WorldPort;
	playerPort: PlayerPort;
	callables: NativeCallable<JsonValue, JsonValue>[];
	environment?: { serverVersion: string; protocol: number };
}

export interface MinecraftRuntimeStart {
	journalMode: string;
	synchronousMode: string;
	recoveredCounts: {
		submissions: number;
		stopIntents: number;
		runs: number;
		segments: number;
		calls: number;
		effects: number;
		records: number;
	};
}

interface OpenedInfo {
	journalMode: string;
	synchronousMode: string;
	writerWatermarks: Record<string, number>;
	recovered: RecoveredRows;
}

/** open/close 共享的关闭标志：worker exit 监听以此区分正常收尾与意外退出。 */
interface LifecycleFlags {
	closed: boolean;
}

const CLOSE_TIMEOUT_MS = 2000;

export class MinecraftRuntime {
	private readonly worker: Worker;
	private readonly queue: RecordQueue;
	private readonly engine: RuntimeEngine;
	private readonly flags: LifecycleFlags;
	private closed = false;

	private constructor(worker: Worker, queue: RecordQueue, engine: RuntimeEngine, flags: LifecycleFlags) {
		this.worker = worker;
		this.queue = queue;
		this.engine = engine;
		this.flags = flags;
	}

	static async open(
		opts: MinecraftRuntimeOptions,
	): Promise<{ runtime: MinecraftRuntime; start: MinecraftRuntimeStart }> {
		const refs = new RuntimeRefs(opts.namespace);
		// 源码用 .ts（tsx 装载），构建产物用同目录 .js。
		const workerFile = import.meta.url.endsWith(".js") ? "./runtime-db-worker.js" : "./runtime-db-worker.ts";
		const worker = new Worker(new URL(workerFile, import.meta.url));
		const flags: LifecycleFlags = { closed: false };
		// 两段启动段1：打开握手。fatal/conflict/意外退出都终结 open promise。
		const opened = new Promise<OpenedInfo>((resolve, reject) => {
			worker.on("message", (msg: WorkerResponse) => {
				if (msg.type === "opened") {
					resolve({
						journalMode: msg.journalMode,
						synchronousMode: msg.synchronousMode,
						writerWatermarks: msg.writerWatermarks,
						recovered: msg.recovered,
					});
				} else if (msg.type === "fatal" || msg.type === "conflict") {
					reject(new Error(msg.message));
				}
			});
			worker.on("error", (err: Error) => reject(err));
			worker.on("exit", (code: number) => {
				if (!flags.closed) reject(new Error(`runtime storage worker exited during open (code ${code})`));
			});
		});
		try {
			worker.postMessage({ type: "open", dbPath: opts.dbPath, storageId: opts.storageId } satisfies WorkerRequest);
		} catch (err) {
			flags.closed = true;
			void worker.terminate();
			throw err instanceof Error ? err : new Error(String(err));
		}
		let info: OpenedInfo;
		try {
			info = await opened;
		} catch (err) {
			flags.closed = true;
			void worker.terminate();
			throw err instanceof Error ? err : new Error(String(err));
		}
		// 段2：队列/引擎装配 + 恢复结算 + 常驻消息接线
		const queue = new RecordQueue({
			instance: refs.writerInstance(),
			mintRecord: () => refs.record(),
			recoveredWatermarks: info.writerWatermarks,
			apply: (items) => {
				worker.postMessage({ type: "apply", items } satisfies WorkerRequest);
			},
		});
		const engine = new RuntimeEngine({
			refs,
			queue,
			world: opts.world,
			playerPort: opts.playerPort,
			callables: opts.callables,
			worldOwner: opts.worldOwner,
			environment: opts.environment,
		});
		worker.on("message", (msg: WorkerResponse) => {
			if (msg.type === "durable") queue.onDurable(msg.instance, msg.through);
			else if (msg.type === "conflict") queue.onFault(`storage conflict: ${msg.message}`);
			else if (msg.type === "fatal") queue.onFault(`storage fatal: ${msg.message}`);
		});
		worker.on("error", (err: Error) => queue.onFault(`storage worker error: ${err.message}`));
		worker.on("exit", (code: number) => {
			if (!flags.closed) queue.onFault(`storage worker exited unexpectedly (code ${code})`);
		});
		engine.recover(info.recovered);
		await queue.flushThrough(queue.capture());
		const runtime = new MinecraftRuntime(worker, queue, engine, flags);
		return {
			runtime,
			start: {
				journalMode: info.journalMode,
				synchronousMode: info.synchronousMode,
				recoveredCounts: {
					submissions: info.recovered.submissions.length,
					stopIntents: info.recovered.stopIntents.length,
					runs: info.recovered.runs.length,
					segments: info.recovered.segments.length,
					calls: info.recovered.calls.length,
					effects: info.recovered.effects.length,
					records: info.recovered.records.length,
				},
			},
		};
	}

	// ---- Driver 装配接缝（组合根注入 Driver） ----

	/** 效果事实接收口：Driver 构造时的 sink。 */
	get sink(): DriverExecutionSink {
		return this.queue;
	}

	/** 提交屏障：runRun 结算与 stop 持久化使用。 */
	get barrier(): RuntimeRecordBarrier {
		return this.queue;
	}

	// ---- 受理与查询面 ----

	submit(origin: Origin, request: RunRequest): Acceptance {
		return this.engine.submit(origin, request);
	}

	lookup(requestId: Ref): SubmissionLookup {
		return this.engine.lookup(requestId);
	}

	read(run: Ref): RunSummary {
		return this.engine.read(run);
	}

	readRecord(ref: Ref): { kind: string; record: Ref; value: JsonValue } {
		return this.engine.readRecord(ref);
	}

	wait(
		run: Ref,
		options?: { afterRevision?: number; timeoutMs?: number },
		signal?: AbortSignal,
	): Promise<RunWaitReply> {
		return this.engine.wait(run, options, signal);
	}

	async stop(command: StopCommand): Promise<StopReceipt> {
		return this.engine.stop(command);
	}

	// ---- 能力接入接缝（能力实现经此作用域获得归属） ----

	/** chat 旁路（不占 Body）：必须在活动调用 frame 内使用，归属当前调用。 */
	chat(text: string, signal: AbortSignal): Promise<EffectReceipt> {
		return this.engine.chat(text, signal);
	}

	/** 受控独占导航（goto）作用域：独占期内效果事实归属给定 owner。 */
	navigate<T>(owner: ControlOwner, fn: () => Promise<T>): Promise<T> {
		return this.engine.runNavigation(owner, fn);
	}

	// ---- 收尾 ----

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.flags.closed = true;
		let flushError: Error | null = null;
		try {
			await this.queue.flushAll();
		} catch (err) {
			flushError = err instanceof Error ? err : new Error(String(err));
		}
		try {
			this.worker.postMessage({ type: "close" } satisfies WorkerRequest);
		} catch {
			// post 失败（worker 已死）：按退出路径收尾
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				void this.worker.terminate().then(
					() => resolve(),
					() => resolve(),
				);
			}, CLOSE_TIMEOUT_MS);
			this.worker.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		if (flushError != null) throw flushError;
	}
}
