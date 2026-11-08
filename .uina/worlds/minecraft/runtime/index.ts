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
	CallSummary,
	ContinueRequest,
	ControlRetirement,
	DeliveryReceipt,
	DeliveryRef,
	DeliveryState,
	DriverExecutionSink,
	Origin,
	OwnerGate,
	OwnerGateReceipt,
	OwnerState,
	RecordFormat,
	RecordReply,
	RunRequest,
	RunSummary,
	RuntimeRecordBarrier,
	RunWaitReply,
	StopCommand,
	StopReceipt,
	SubmissionLookup,
} from "../contracts/runtime.js";
import type { EffectReceipt, JsonValue, Ref } from "../contracts/values.js";
import type { WorldPort } from "../contracts/world.js";
import { RuntimeEngine } from "./engine.js";
import { RecordQueue } from "./records.js";
import { RuntimeRefs } from "./refs.js";
import type { AdmissionCommand, RecoveredRows, WorkerRequest, WorkerResponse } from "./runtime-db-worker.js";
import type { StorageQuery } from "./storage-queries.js";

export interface MinecraftRuntimeOptions {
	evidence?: import("../contracts/world.js").WorldEvidencePort;
	onSafetyChanged?: (
		record: import("../contracts/runtime.js").SafetyInterventionRecord,
		cause: import("./safety.js").SafetyCause | null,
	) => void;
	/** ctx.verify 注册表（G4）：领域核验器随能力工作包注入。 */
	verifiers?: ReadonlyMap<import("../contracts/values.js").ExactRef, import("../contracts/runtime.js").EffectVerifier>;
	/** runtime.db 绝对路径（<worldDataDir>/runtime.db，runtime.md §5.3）。 */
	dbPath: string;
	/** 存储身份：与库内 meta.storage_id 核对，不符即打开失败。 */
	storageId: string;
	/** per-boot 发号命名空间（与 FactsBinding.streamNamespace 同源约定）。 */
	namespace: string;
	worldOwner: Ref;
	ownerLifetimeMs?: number;
	onChanged?: () => void;
	monotonicNow?: () => number;
	unclean?: boolean;
	oldControlRetired?: boolean;
	requireRetirement?: (notice: ControlRetirement) => void;
	world: WorldPort;
	playerPort: PlayerPort;
	callables: NativeCallable<JsonValue, JsonValue>[];
	program?: import("../contracts/program.js").ProgramPort;
	queryRefs?: string[];
	environment?: { serverVersion: string; protocol: number };
}

export interface MinecraftRuntimeStart {
	ownerGates: OwnerGate[];
	ownerGateRevision: number;
	recoveredControlRetired: boolean;
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
	private closePromise: Promise<void> | null = null;
	private queryId = 0;
	private readonly queries = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

	private constructor(worker: Worker, queue: RecordQueue, engine: RuntimeEngine, flags: LifecycleFlags) {
		this.worker = worker;
		this.queue = queue;
		this.engine = engine;
		this.flags = flags;
		worker.on("message", (msg: WorkerResponse) => {
			if (msg.type !== "query_reply") return;
			const pending = this.queries.get(msg.id);
			if (!pending) return;
			this.queries.delete(msg.id);
			if (msg.error)
				pending.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, acknowledged: true }));
			else pending.resolve(msg.value);
		});
		const fail = (error: Error) => {
			for (const q of this.queries.values()) q.reject(error);
			this.queries.clear();
		};
		worker.on("error", fail);
		worker.on("exit", () => fail(new Error("Runtime storage closed")));
	}

	static async open(
		opts: MinecraftRuntimeOptions,
	): Promise<{ runtime: MinecraftRuntime; start: MinecraftRuntimeStart }> {
		if (opts.unclean === true && opts.oldControlRetired !== true) {
			const notice: ControlRetirement = {
				source: "runtime",
				subject: null,
				code: "EXECUTION_DOMAIN_UNRETIRED",
				detail: "unclean recovery requires proof that the old control domain retired",
			};
			opts.requireRetirement?.(notice);
			throw new Error(notice.detail);
		}
		const refs = new RuntimeRefs(opts.namespace);
		// 源码用 .ts（tsx 装载），构建产物用同目录 .js。
		const workerFile = import.meta.url.endsWith(".js") ? "./worker-entry.js" : "./worker-entry.ts";
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
			worker.postMessage({
				type: "open",
				dbPath: opts.dbPath,
				storageId: opts.storageId,
				worldOwner: opts.worldOwner,
			} satisfies WorkerRequest);
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
		let runtime: MinecraftRuntime;
		const engine = new RuntimeEngine({
			evidence: opts.evidence,
			onSafetyChanged: opts.onSafetyChanged,
			verifiers: opts.verifiers,
			refs,
			queue,
			commitAdmission: (command) => runtime.admit(command),
			world: opts.world,
			playerPort: opts.playerPort,
			callables: opts.callables,
			program: opts.program,
			queryRefs: opts.queryRefs,
			worldOwner: opts.worldOwner,
			environment: opts.environment,
			ownerLifetimeMs: opts.ownerLifetimeMs,
			monotonicNow: opts.monotonicNow,
			unclean: opts.unclean,
			oldControlRetired: opts.oldControlRetired,
			requireRetirement: opts.requireRetirement,
		});
		worker.on("message", (msg: WorkerResponse) => {
			if (msg.type === "durable") {
				queue.onDurable(msg.instance, msg.through);
				opts.onChanged?.();
			} else if (msg.type === "conflict") queue.onFault(`storage conflict: ${msg.message}`);
			else if (msg.type === "fatal") queue.onFault(`storage fatal: ${msg.message}`);
		});
		worker.on("error", (err: Error) => queue.onFault(`storage worker error: ${err.message}`));
		worker.on("exit", (code: number) => {
			if (!flags.closed) queue.onFault(`storage worker exited unexpectedly (code ${code})`);
		});
		try {
			engine.recover(info.recovered);
			await queue.flushThrough(queue.capture());
		} catch (err) {
			flags.closed = true;
			await worker.terminate();
			throw err;
		}
		runtime = new MinecraftRuntime(worker, queue, engine, flags);
		return {
			runtime,
			start: {
				ownerGates: engine.owner.state().gates,
				ownerGateRevision: engine.owner.state().gateRevision,
				recoveredControlRetired: opts.oldControlRetired === true,
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

	submit(origin: Origin, request: RunRequest): Promise<Acceptance> {
		return this.engine.submit(origin, request);
	}
	continue(origin: Origin, request: ContinueRequest): Promise<Acceptance> {
		return this.engine.continue(origin, request);
	}
	private async admit(command: AdmissionCommand): Promise<void> {
		await this.queue.flushThrough(this.queue.capture());
		const id = ++this.queryId;
		await new Promise<void>((resolve, reject) => {
			this.queries.set(id, { resolve: () => resolve(), reject });
			try {
				this.worker.postMessage({ type: "admit", id, command } satisfies WorkerRequest);
			} catch (error) {
				this.queries.delete(id);
				reject(error);
			}
		});
	}

	attach(origin: Origin): Promise<OwnerState> {
		return this.engine.owner.attach(origin);
	}
	heartbeat(attachment: Ref): Promise<OwnerState> {
		return this.engine.owner.heartbeat(attachment);
	}
	setOwnerGate(request: {
		requestId: Ref;
		attachment: Ref;
		gate: OwnerGate;
		closed: boolean;
		expectedRevision?: number;
	}): Promise<OwnerGateReceipt> {
		return this.engine.owner.setGate(request);
	}
	availability(): "ready" | "unavailable" {
		return this.closePromise == null && this.queue.faultReason == null ? "ready" : "unavailable";
	}
	inspectOwner(): OwnerState | null {
		const state = this.engine.owner.state();
		return state.attachment === "" ? null : state;
	}
	assertActionAllowed(): void {
		this.engine.assertActionAllowed();
		if (this.queue.faultReason != null) throw new Error(`runtime recorder unavailable: ${this.queue.faultReason}`);
	}
	sealProgramCalls(calls: string[], reason: string): void {
		this.engine.sealProgramCalls(calls, reason);
	}
	programChanged(): void {
		this.engine.programChanged();
	}
	intervene(trigger: import("./safety.js").SafetyTrigger, work: import("./safety.js").SafetyWork) {
		return this.engine.safety.run(trigger, work);
	}
	inspectSafety() {
		return this.engine.safety.inspect();
	}
	invalidateControl() {
		return this.engine.invalidateControl();
	}

	lookup(requestId: Ref): SubmissionLookup {
		return this.engine.lookup(requestId);
	}

	read(run: Ref): Promise<RunSummary> {
		return this.query({ op: "read", run });
	}

	private async query<T>(query: StorageQuery): Promise<T> {
		await this.queue.flushThrough(this.queue.capture());
		if (this.flags.closed) throw new Error("Runtime storage closed");
		const id = ++this.queryId;
		return await new Promise<T>((resolve, reject) => {
			this.queries.set(id, { resolve: (value) => resolve(value as T), reject });
			try {
				this.worker.postMessage({ type: "query", id, query } satisfies WorkerRequest);
			} catch (error) {
				this.queries.delete(id);
				reject(error);
			}
		});
	}
	readRecord(ref: Ref, options: { format?: RecordFormat } = {}): Promise<RecordReply> {
		return this.query({ op: "record", ref, ...options });
	}
	list(filter: { activeOnly?: boolean; cursor?: string } = {}): Promise<{ items: RunSummary[]; next?: string }> {
		return this.query({ op: "list", ...filter });
	}
	listCalls(
		run: Ref,
		filter: { parent?: Ref; cursor?: string } = {},
	): Promise<{ items: CallSummary[]; next?: string }> {
		return this.query({ op: "calls", run, ...filter });
	}
	pendingDeliveries(page: { cursor?: string; limit?: number } = {}): Promise<{ items: DeliveryRef[]; next?: string }> {
		return this.query({ op: "pending", ...page });
	}
	readDelivery(ref: Ref): Promise<DeliveryState> {
		return this.query({ op: "delivery", ref });
	}
	settleDelivery(ref: Ref, receipt: DeliveryReceipt): Promise<void> {
		return this.query({ op: "settle", ref, receipt });
	}

	wait(
		run: Ref,
		options?: { afterRevision?: number; timeoutMs?: number },
		signal?: AbortSignal,
	): Promise<RunWaitReply> {
		return this.engine
			.wait(run, options, signal)
			.then(async (reply) => ({ ...reply, snapshot: await this.read(run) }) as RunWaitReply);
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

	close(): Promise<void> {
		if (this.closePromise != null) return this.closePromise;
		// shutdown synchronously revokes admissions/control before returning its Promise.
		const stopping = this.engine.shutdown();
		this.closePromise = this.finishClose(stopping);
		return this.closePromise;
	}
	private async finishClose(stopping: Promise<void>): Promise<void> {
		let flushError: Error | null = null;
		try {
			await stopping;
		} catch (err) {
			flushError = err instanceof Error ? err : new Error(String(err));
		}
		this.flags.closed = true;
		try {
			await this.queue.flushAll();
		} catch (err) {
			flushError ??= err instanceof Error ? err : new Error(String(err));
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
