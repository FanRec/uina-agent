import { randomUUID } from "node:crypto";
import { validImages } from "../core/content.js";
import { deliveryKey, validDeliveryTag } from "../core/delivery.js";
import { errorMessage } from "../core/errors.js";
import { inputTokenBudget, modelKey } from "../core/model.js";
import type {
	AgentMessage,
	ChatMsg,
	CompletedToolCall,
	ContextSnapshot,
	DeliveryMode,
	GenerationTiming,
	HostDeliveryPort,
	HostDeliveryState,
	HostDeliveryTag,
	HostRetireReply,
	InputDeliveryOwner,
	Model,
	ModelStreamFn,
	RequestInspection,
	RequestProjection,
	RequestUsage,
	ThinkingLevel,
	TokenMeasurement,
	ToolResultStatus,
	Usage,
} from "../core/types.js";
import type { OutputEvent, RuntimeEvent } from "../runtime/events.js";
import { guardRuntimeHooks, immutableProjection } from "../runtime/guard.js";
import type { RuntimeHooks } from "../runtime/hooks.js";
import { NO_RUNTIME_HOOKS } from "../runtime/noop.js";
import {
	listPromptSnapshots,
	PROMPT_SNAPSHOT_ENTRY_TYPE,
	promptSnapshotFingerprint,
} from "../session/prompt-snapshots.js";
import { projectInputMessage } from "../session/recovery.js";
import type { RewindRequest, RewindResult, SessionStore } from "../session/types.js";
import type { PreparedToolCall, ToolView } from "../tools/broker.js";
import { buildContext, defaultSystemPrompt, measureRequestContext } from "./context.js";
import {
	type ProjectionPolicy,
	type ResolvedProjection,
	requestToolDefs,
	resolveProjectionPolicy,
} from "./projection.js";
import { InputQueues, isRuntimeFollowUp, MAX_TURN_CHARS, type QueuedMessage } from "./queue.js";
import { commitRewindTransition } from "./rewind.js";
import { type StreamCollectorResult, TurnStreamCollector } from "./stream-collector.js";

export interface SubjectOptions {
	store?: SessionStore;
	/** 投影 Replacement 缝（单 owner = 本 Subject 实例；缺省字段回落默认实现）。 */
	projection?: ProjectionPolicy;
	systemPrompt?: string;
	thinkingLevel?: ThinkingLevel;
	runtimeHooks?: RuntimeHooks;
	measureContext?: (model: Model, projection: RequestProjection) => TokenMeasurement | undefined;
	/**
	 * 单回合工具调用预算硬上限（默认 500），按 processed（进入执行流水线）口径计。
	 * 超限的 tool_calls 批次整批拒绝并如实落盘 not_started，回合一律以 turn_failed 收口
	 * ——失控循环是政策终止不是异常，不抛错；跑超长批处理时显式调高。
	 */
	maxConsecutiveToolCalls?: number;
}

export function clampThinkingLevel(requested: ThinkingLevel, available?: readonly ThinkingLevel[]): ThinkingLevel {
	if (!available || available.length === 0) return "off";
	if (available.includes(requested)) return requested;
	return available[0]!;
}

export interface QueueInputOptions {
	mode?: DeliveryMode;
	source?: import("../core/types.js").InputSource;
}

/**
 * 批量受理的逐条结果。`accepted` 的诚实含义是"已持久入队"——不宣称模型读过它，
 * 也不宣称回合已经发生。要那个语义看 `input_settled`。
 */
export type InputSubmissionOutcome =
	| { id: string; accepted: true }
	| { id: string; accepted: false; reason: string; retryable: boolean };

/** 准入拒绝：`retryable` 只说"用同一个 id 再交一次有没有意义"。 */
class InputRejected extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "InputRejected";
	}
}

/**
 * 未知异常按可重试处理：它只可能来自持久化或 IO，同一 id 再交一次是安全的
 *（重复提交由 id 去重拦住）。只有明确的准入拒绝才不可重试。
 */
function isRetryableRejection(error: unknown): boolean {
	return !(error instanceof InputRejected) || error.retryable;
}

/** 把一轮请求准备切成多段，让 TUI 心跳与终端 IO 有机会插进来。
 * 用 MessageChannel 而不是 setImmediate/setTimeout：后者在 vi.useFakeTimers()
 * 下会被接管，测试里永远等不到回调，直接把回合挂死。 */
function yieldToLoop(): Promise<void> {
	return new Promise<void>((resolve) => {
		const { port1, port2 } = new MessageChannel();
		port1.onmessage = () => {
			port1.close();
			port2.close();
			resolve();
		};
		port2.postMessage(0);
	});
}

export interface AgentInput {
	receipt?: HostDeliveryTag;
	id: string;
	mode: "steer" | "followUp";
	source: import("../core/types.js").InputSource;
	receivedAt?: string;
	text?: string;
	images?: import("../core/content.js").ImageContent[];
	data?: unknown;
	/** Runtime-only deferred body. It is evaluated immediately before queue commit and never journaled. */
	render?: () => string | null | Promise<string | null>;
}

/** 批量 claim 的显式部分成功合同：journal 无批事务，已持久化的条目必须移交 caller。 */
export type ClaimAllResult =
	| { kind: "complete"; claimed: QueuedMessage[] }
	| { kind: "partial"; claimed: QueuedMessage[]; failedId: string; error: unknown };

/** decide 的回合终局。runTurn 据此统一收口 turn_failed / agent_end 事实；
 * 普通程序错误仍走异常通道（catch → turn_failed），两者不概念重叠。 */
export type DecisionOutcome =
	| { kind: "completed" }
	| { kind: "aborted" }
	| { kind: "terminated"; reason: "tool_call_limit"; message: string };

type ToolBatchResult = import("../tools/broker.js").ToolExecutionResult & {
	callId: string;
	invocationId: string;
	canonical?: import("../tools/broker.js").ToolExecutionResult;
};

type ToolBatchOutcome = {
	results: ToolBatchResult[];
	error?: AggregateError;
};

class ToolPipelineFailure extends Error {
	readonly started: boolean;
	readonly failure: unknown;
	constructor(started: boolean, failure: unknown) {
		super("工具流水线未能完成", { cause: failure });
		this.started = started;
		this.failure = failure;
	}
}

function unresolvedToolResult(call: CompletedToolCall, started: boolean): ToolBatchResult {
	const status: ToolResultStatus = started ? "unknown" : "not_started";
	const error = started ? "工具已启动，但结果无法确认" : "工具未启动，流水线失败";
	return { callId: call.id, invocationId: `model:${call.id}`, result: JSON.stringify({ error, status }), status };
}

function asToolPipelineFailure(error: unknown): ToolPipelineFailure {
	return error instanceof ToolPipelineFailure ? error : new ToolPipelineFailure(false, error);
}

interface InputDeliveryAttempt {
	item: QueuedMessage;
	since: string;
	order: number;
	owner: InputDeliveryOwner;
	active: boolean;
	phase: "queued" | "processing" | "appending";
	admission?: Promise<void>;
	append?: Promise<void>;
	retirement?: Promise<HostRetireReply>;
	error?: unknown;
}
interface ToolDeliveryAttempt {
	namespace: string;
	receipt: HostDeliveryTag;
	since: string;
	order: number;
	error?: unknown;
}

export class Subject {
	/** 主体活动阶段：turn（回合执行）→ afterEnd（post-turn 收尾：outcome 已冻结，
	 * 但仍占用主体、仍可 interrupt）→ undefined；rewind 与 activity（回合外排他
	 * 前台活动）为独立入口。 */
	private activity: "turn" | "rewind" | "afterEnd" | "activity" | undefined;
	private history: AgentMessage[] = [];
	private turnSeq = 0;
	private interrupted = false;
	private abort: AbortController | null = null;
	private readonly queues = new InputQueues();
	private readonly deferredInputRenders = new Map<string, NonNullable<AgentInput["render"]>>();
	private readonly systemPrompt: string;
	private readonly maxConsecutiveToolCalls: number;
	private readonly store?: SessionStore;
	private pendingRewind?: { request: RewindRequest; source: string; requestId: string; signal?: AbortSignal };
	private rewindCommitting = false;
	private activeRun?: Promise<void>;
	private settleActiveRun?: () => void;
	private resumingQueue = false;
	private model: Model;
	private readonly streamFn: ModelStreamFn;
	private thinkingLevel: ThinkingLevel;
	private preferredThinkingLevel: ThinkingLevel;
	private readonly runtimeHooks: RuntimeHooks;
	private readonly measureContext?: SubjectOptions["measureContext"];
	/** 投影 Replacement 缝的现役实现（解析后两字段非空；本实例即单 owner）。 */
	readonly projection: ResolvedProjection;
	private lastRequestUsage?: RequestUsage;
	private currentCallUsage?: RequestUsage;
	private latestUsageSeq = 0;
	private currentContextSnapshot?: ContextSnapshot;
	private contextInspectionSeq = 0;
	private streamSeq = 0;
	private readonly listeners = new Set<(event: RuntimeEvent) => void>();
	private lastPromptFingerprint?: string;
	private readonly inputDeliveries = new Map<string, InputDeliveryAttempt>();
	private readonly toolDeliveries = new Map<string, ToolDeliveryAttempt>();
	private deliveryOrder = 0;
	private deliveryClosed = false;

	delivery(namespace: string): HostDeliveryPort {
		if (!namespace.trim()) throw new Error("delivery namespace must not be empty");
		return Object.freeze({
			namespace,
			session: this.store?.session ?? "unbound",
			durability: this.store?.durability ?? "volatile",
			inspect: async (key: string) => this.inspectDelivery(namespace, key),
			retire: (key: string, attempt: string) => this.retireDelivery(namespace, key, attempt),
		});
	}

	closeDelivery(): void {
		this.deliveryClosed = true;
		for (const attempt of this.inputDeliveries.values()) attempt.active = false;
		this.toolDeliveries.clear();
	}

	private findDelivery(namespace: string, key: string) {
		const inputs = [...this.inputDeliveries.values()].filter(
			(a) => a.item.receiptNamespace === namespace && a.item.receipt?.key === key,
		);
		const tools = [...this.toolDeliveries.entries()].filter(
			([, a]) => a.namespace === namespace && a.receipt.key === key,
		);
		const input = inputs.sort((a, b) => a.order - b.order)[0];
		const tool = tools.sort((a, b) => a[1].order - b[1].order)[0];
		return input && (!tool || input.order < tool[1].order)
			? { channel: "input" as const, input }
			: tool
				? { channel: "tool" as const, tool }
				: undefined;
	}

	private inspectDelivery(namespace: string, key: string): HostDeliveryState {
		const committed = this.store?.state.deliveryCommits.get(deliveryKey(namespace, key));
		if (committed) return { kind: "committed", receipt: { ...committed, session: this.store!.session } };
		if (this.deliveryClosed || !this.store || this.store.failure)
			return {
				kind: "unavailable",
				reason: this.store?.failure ? errorMessage(this.store.failure) : "Host delivery session is unavailable",
			};
		const current = this.findDelivery(namespace, key);
		if (!current) return { kind: "absent" };
		if (current.channel === "tool") {
			const attempt = current.tool[1];
			if (attempt.error) return { kind: "unavailable", reason: errorMessage(attempt.error) };
			return {
				kind: "pending",
				attempt: attempt.receipt.attempt,
				since: attempt.since,
				channel: "tool",
				activity: "processing",
			};
		}
		const attempt = current.input;
		if (attempt.error) return { kind: "unavailable", reason: errorMessage(attempt.error) };
		return {
			kind: "pending",
			attempt: attempt.item.receipt!.attempt,
			since: attempt.since,
			channel: "input",
			activity: attempt.phase === "queued" ? "queued" : "processing",
		};
	}

	private async retireDelivery(namespace: string, key: string, expectedAttempt: string): Promise<HostRetireReply> {
		const state = this.inspectDelivery(namespace, key);
		if (state.kind === "committed") return state;
		if (this.deliveryClosed || !this.store || this.store.failure)
			return {
				kind: "unavailable",
				reason: this.store?.failure ? errorMessage(this.store.failure) : "Host delivery session is unavailable",
			};
		if (state.kind === "absent") return { kind: "retired" };
		if (state.kind === "pending" && state.attempt !== expectedAttempt) return { kind: "changed", state };
		const current = this.findDelivery(namespace, key);
		const actual =
			current?.channel === "input" ? current.input.item.receipt!.attempt : current?.tool[1].receipt.attempt;
		if (actual !== expectedAttempt) return { kind: "changed", state: this.inspectDelivery(namespace, key) };
		if (current!.channel === "tool") {
			this.toolDeliveries.delete(current!.tool[0]);
			return { kind: "retired" };
		}
		return this.retireInputDelivery(current!.input);
	}

	private retireInputDelivery(attempt: InputDeliveryAttempt): Promise<HostRetireReply> {
		if (attempt.retirement) return attempt.retirement;
		attempt.active = false;
		return (attempt.retirement = (async (): Promise<HostRetireReply> => {
			try {
				if (attempt.append) await attempt.append.catch(() => undefined);
				await attempt.admission?.catch((error) => {
					if (!this.store || this.store.failure) throw this.store?.failure ?? error;
					// A failed append whose rollback succeeded left resident state equal to disk.
					// If admission actually committed before an ACK failure, withdraw its real queue item below.
				});
				if (this.store?.failure) throw this.store.failure;
				if (this.store?.state.queued.has(attempt.item.id))
					await this.storeEvent("queue_restored", eventData(attempt.item));
				this.queues.remove(attempt.item.id);
				this.inputDeliveries.delete(attempt.item.id);
				this.deferredInputRenders.delete(attempt.item.id);
				this.notifyQueueChanged();
				const state = this.inspectDelivery(attempt.owner.namespace, attempt.item.receipt!.key);
				return state.kind === "committed" ? state : { kind: "retired" };
			} catch (error) {
				attempt.error = error;
				attempt.retirement = undefined;
				return { kind: "unavailable", reason: errorMessage(error) };
			}
		})());
	}

	private ownsInput(item: QueuedMessage): boolean {
		if (!item.receipt) return true;
		const current = this.inputDeliveries.get(item.id)?.item;
		return (
			current?.receiptNamespace === item.receiptNamespace &&
			current?.receipt?.key === item.receipt.key &&
			current?.receipt?.attempt === item.receipt.attempt
		);
	}

	private enqueueInput(item: QueuedMessage): Promise<void> {
		const admission = this.storeEvent("queue_enqueued", eventData(item));
		const attempt = this.inputDeliveries.get(item.id);
		if (attempt) attempt.admission = admission;
		return admission;
	}

	constructor(
		model: Model,
		streamFn: ModelStreamFn,
		private readonly tools: ToolView,
		options: SubjectOptions = {},
	) {
		this.model = model;
		this.streamFn = streamFn;
		this.store = options.store;
		this.systemPrompt = options.systemPrompt ?? defaultSystemPrompt();
		this.lastPromptFingerprint = listPromptSnapshots(this.store?.state.auxiliary ?? []).at(-1)?.fingerprint;
		this.projection = resolveProjectionPolicy(options.projection);
		this.preferredThinkingLevel = options.thinkingLevel ?? model.thinkingLevels?.[0] ?? "off";
		if (this.preferredThinkingLevel !== "off" && !model.thinkingLevels?.includes(this.preferredThinkingLevel)) {
			throw new Error(`model ${model.name} 未声明支持 thinking level: ${this.preferredThinkingLevel}`);
		}
		this.thinkingLevel = this.preferredThinkingLevel;
		this.runtimeHooks = guardRuntimeHooks(options.runtimeHooks ?? NO_RUNTIME_HOOKS);
		this.measureContext = options.measureContext;
		this.maxConsecutiveToolCalls = options.maxConsecutiveToolCalls ?? 500;
	}

	subscribe(listener: (event: RuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private dispatch(event: RuntimeEvent): Promise<void> | void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				if (event.type !== "error") {
					this.reportError(error);
				}
			}
		}
		if (isOutputEvent(event)) {
			this.runtimeHooks.events.observe(event);
			return;
		}
		if (event.type === "tool_call" || event.type === "tool_result") {
			return;
		}
		return this.runtimeHooks.events.emit(event);
	}

	/**
	 * 回合边界上下文构成事实（context_prepare）：prepare 应用后、agent_start 前。
	 * systemPrompt = 本次准备最终生效全文；注入 provenance 来自聚合层登记（无注入为空数组——
	 * "零注入"本身是要看到的事实）。必须 await：与 agent_start 的 emit 保持单流时序承诺。
	 */
	private async dispatchContextPrepare(
		turnNumber: number,
		prepared: Awaited<ReturnType<RuntimeHooks["turn"]["prepare"]>> | undefined,
	): Promise<void> {
		const systemPrompt = prepared?.systemPrompt ?? this.systemPrompt;
		const injections = prepared?.injections ?? [];
		const fingerprint = promptSnapshotFingerprint(systemPrompt, injections);
		if (fingerprint !== this.lastPromptFingerprint) {
			try {
				await this.store?.appendCustomEntry({
					customType: PROMPT_SNAPSHOT_ENTRY_TYPE,
					data: { turnNumber, fingerprint, systemPrompt, injections },
				});
				this.lastPromptFingerprint = fingerprint;
			} catch (error) {
				this.reportError(error);
			}
		}
		await this.dispatch({ type: "context_prepare", turnNumber, systemPrompt, injections });
	}

	/**
	 * 单次模型调用的真实 usage 到达时立即上报，让底栏不必等 turn_end。
	 *
	 * 这里是唯一的写入点，所以历史 usage 与它派发出的 usage_update 永远同源：
	 * pi.usage()/turn_end 与实时刷新看到的是同一个事实。
	 */
	private publishUsage(
		usage: Usage,
		callId: string,
		projection: RequestProjection,
		callSeq: number,
		timing?: GenerationTiming,
	): void {
		const requestUsage: RequestUsage = {
			callId,
			projectionId: projection.projectionId,
			modelKey: projection.modelKey,
			promptTokens: usage.input,
			outputTokens: usage.output,
			reasoningTokens: usage.reasoning,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
			...(timing ? { timing } : {}),
		};
		if (callSeq >= this.latestUsageSeq) {
			this.latestUsageSeq = callSeq;
			this.lastRequestUsage = requestUsage;
		}
		this.currentCallUsage = requestUsage;
		void this.dispatch({ type: "usage_update", usage: requestUsage });
	}

	/**
	 * 当前 model 的计量口径失效（setModel），或 canonical history 被真正替换
	 * （回溯提交）时清除：两个 usage 缓存都不再描述当前事实。
	 * 递增 inspection 序号还会使正在返回的旧模型/旧历史测量结果失效。
	 */
	private invalidateContext(): void {
		this.contextInspectionSeq++;
		this.currentContextSnapshot = undefined;
	}

	getModel(): Model {
		return this.model;
	}

	getThinkingLevel(): ThinkingLevel {
		return this.thinkingLevel;
	}

	getPreferredThinkingLevel(): ThinkingLevel {
		return this.preferredThinkingLevel;
	}

	getContextWindow(): number | undefined {
		return this.model.contextWindow;
	}

	getRequestUsage(): RequestUsage | undefined {
		return this.lastRequestUsage ? structuredClone(this.lastRequestUsage) : undefined;
	}

	getCurrentContextSnapshot(): ContextSnapshot | undefined {
		return this.currentContextSnapshot ? structuredClone(this.currentContextSnapshot) : undefined;
	}

	async inspectRequest(): Promise<RequestInspection> {
		const model = this.model;
		const projection = await this.prepareProjection(model, this.systemPrompt, [], true);
		const measurement = measureRequestContext(
			projection,
			this.measureContext ? (value) => this.measureContext!(model, value) : undefined,
			{ countThinking: (model.thinkingReplay ?? "none") !== "none" },
		);
		return {
			projection,
			measurement,
			contextWindow: model.contextWindow,
			inputBudget: inputTokenBudget(model, projection.thinkingLevel),
		};
	}

	async getContextSnapshot(basis: ContextSnapshot["basis"] = "idle_baseline"): Promise<ContextSnapshot> {
		const sequence = ++this.contextInspectionSeq;
		const inspection = await this.inspectRequest();
		const snapshot = this.contextSnapshot(inspection, basis);
		if (sequence === this.contextInspectionSeq && inspection.projection.modelKey === modelKey(this.model)) {
			this.publishContextSnapshot(snapshot);
		}
		return snapshot;
	}

	private contextSnapshot(inspection: RequestInspection, basis: ContextSnapshot["basis"]): ContextSnapshot {
		return {
			projectionId: inspection.projection.projectionId,
			modelKey: inspection.projection.modelKey,
			basis,
			source: inspection.measurement.source,
			inputTokens: inspection.measurement.inputTokens,
			contextWindow: inspection.contextWindow,
			availableInputBudget: inspection.inputBudget,
			measurementKind: inspection.measurement.kind,
			segments: inspection.measurement.segments,
		};
	}

	private publishContextSnapshot(snapshot: ContextSnapshot): void {
		this.currentContextSnapshot = snapshot;
		void this.dispatch({ type: "context_update", snapshot });
	}

	async setModel(model: Model): Promise<void> {
		const prev = this.model.name;
		this.model = model;
		// Current context is model-relative; past RequestUsage remains a historical fact.
		this.invalidateContext();
		const prevLevel = this.thinkingLevel;
		this.thinkingLevel = clampThinkingLevel(this.preferredThinkingLevel, model.thinkingLevels);

		await this.dispatch({
			type: "model_select",
			model: model.name,
			previousModel: prev,
		});

		if (this.thinkingLevel !== prevLevel) {
			await this.dispatch({
				type: "thinking_level_select",
				level: this.thinkingLevel,
				previousLevel: prevLevel,
			});
		}
		await this.getContextSnapshot("idle_baseline");
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.preferredThinkingLevel = level;
		const prev = this.thinkingLevel;
		this.thinkingLevel = clampThinkingLevel(level, this.model.thinkingLevels);
		this.invalidateContext();
		void (async () => {
			await this.dispatch({
				type: "thinking_level_select",
				level: this.thinkingLevel,
				previousLevel: prev,
			});
			// Active preparation publishes its own projection before sending. Idle
			// changes need an immediate baseline refresh for the UI.
			if (!this.isBusy()) await this.getContextSnapshot("idle_baseline");
		})().catch((error) => this.reportError(error));
	}

	cycleThinkingLevel(): ThinkingLevel {
		const levels: readonly ThinkingLevel[] = this.model.thinkingLevels?.length ? this.model.thinkingLevels : ["off"];
		const current = levels.indexOf(this.thinkingLevel);
		const next = levels[(current + 1) % levels.length] ?? "off";
		this.setThinkingLevel(next);
		return this.thinkingLevel;
	}

	/** Session rewind entry: run-safety scheduling lives here; navigation/reading
	 * views are composed from the store by session/access.ts, not by the Subject. */
	async requestRewind(request: RewindRequest, source: string, signal?: AbortSignal): Promise<RewindResult> {
		signal?.throwIfAborted();
		if (!this.store) {
			throw new Error("未配置会话存储，回溯不可用");
		}
		if (
			!request ||
			typeof request.targetId !== "string" ||
			!request.targetId ||
			typeof request.reason !== "string" ||
			!request.reason.trim() ||
			typeof source !== "string" ||
			!source.trim() ||
			(request.note !== undefined && typeof request.note !== "string")
		) {
			throw new Error("回溯需要 targetId、reason 和来源");
		}
		if (this.pendingRewind || this.rewindCommitting || this.activity === "rewind") {
			throw new Error("已有会话转换正在处理");
		}
		// 回溯合法性直接查常驻 canonical 状态（safeTargets 由 reducer 增量维护）。
		const state = this.store.state;
		const entries = state.entries;
		const index = entries.findIndex((entry) => entry.id === request.targetId);
		if (index < 0 || index === entries.length - 1 || !state.safeTargets.has(request.targetId)) {
			throw new Error("回溯目标必须是当前主线的安全历史祖先");
		}
		const pending = { request: structuredClone(request), source, signal, requestId: randomUUID() };
		if (this.isBusy() && this.activity !== "turn") {
			throw new Error("当前不在可接纳回溯请求的运行阶段");
		}
		if (this.isBusy()) {
			this.pendingRewind = pending;
			return { requestId: pending.requestId, status: "scheduled" };
		}
		this.activity = "rewind";
		this.interrupted = false;
		this.abort = new AbortController();
		this.activeRun = new Promise((resolve) => {
			this.settleActiveRun = resolve;
		});
		try {
			const rewindId = await this.commitRewind(pending);
			if (!this.interrupted && !pending.signal?.aborted) {
				this.activity = "turn";
				const turn = ++this.turnSeq;
				const prepared = await this.runtimeHooks.turn.prepare({ prompt: "", systemPrompt: this.systemPrompt });
				await this.applyPreparedRuntime(prepared);
				await this.dispatchContextPrepare(turn, prepared);
				await this.runtimeHooks.events.emit({ type: "agent_start", turnSeq: turn });
				await this.runTurn(
					undefined,
					turn,
					this.model,
					prepared.systemPrompt ?? this.systemPrompt,
					prepared.messages ? [...prepared.messages] : [],
				);
			}
			return { requestId: pending.requestId, status: "committed", rewindId };
		} finally {
			this.activity = undefined;
			this.abort = null;
			try {
				await this.runtimeHooks.events.flush();
			} finally {
				this.completeActiveRun();
			}
		}
	}

	private async applyPendingRewind(): Promise<boolean> {
		const pending = this.pendingRewind;
		if (!pending) return false;
		try {
			await this.commitRewind(pending);
			this.pendingRewind = undefined;
			return true;
		} catch (error) {
			this.pendingRewind = undefined;
			this.reportError(`回溯请求 ${pending.requestId} 未提交: ${errorMessage(error)}`);
			return false;
		}
	}

	/** Durable transition (record + projection) lives in agent/rewind.ts; this
	 * method owns only the ordering discipline: adopt the projected history,
	 * invalidate usage caches before broadcasting, then emit. */
	private async commitRewind(pending: NonNullable<Subject["pendingRewind"]>): Promise<string> {
		this.rewindCommitting = true;
		let committed = false;
		try {
			if (!this.store) {
				throw new Error("未配置会话存储，回溯不可用");
			}
			const { rewindId, fromId, targetId, history } = await commitRewindTransition(
				this.store,
				pending,
				{ projection: this.projection },
				this.currentSignal(),
			);
			committed = true;
			this.history = history;
			// 历史刚被替换：先失效 usage 缓存，再广播。
			this.invalidateContext();
			await this.dispatch({
				type: "session_rewind",
				turnNumber: this.activity === "turn" ? this.turnSeq : undefined,
				requestId: pending.requestId,
				rewindId,
				fromId,
				targetId,
				// 回溯后的会话条目是回溯事实的一部分：消费者据此重建视图，同源单流。
				entries: this.store ? this.store.state.entries : [],
			});
			return rewindId;
		} catch (error) {
			throw new Error(
				`回溯请求 ${pending.requestId} ${committed ? "已提交，但通知失败" : "未提交"}: ${errorMessage(error)}`,
				{ cause: error },
			);
		} finally {
			this.rewindCommitting = false;
		}
	}

	/**
	 * 持久化并入队；不启动回合。所有输入路径（用户输入、单条受理、批量受理）共用，
	 * 免得三处各自维护"先持久化还是先入队"的顺序。
	 */
	private async enqueueRecord(queued: QueuedMessage): Promise<void> {
		await this.enqueueInput(queued);
		if (this.inputDeliveries.get(queued.id)?.active === false) return;
		this.queues.add(queued);
		await this.publishInputAccepted(queued);
		this.notifyQueueChanged();
	}

	pushInput(text: string, options: QueueInputOptions = {}): Promise<void> {
		const normalized = text.trim();
		if (!normalized) return Promise.resolve();

		const busy = this.isBusy();
		// direct 空闲即开跑；忙时升级为 steer；空闲但已有队列时随队保序。
		const requestedMode = options.mode ?? (busy ? "steer" : "direct");
		const mode = requestedMode === "direct" ? (busy ? "steer" : "followUp") : requestedMode;
		const queued = this.queues.create(normalized, mode, { source: options.source });
		// 直启必须同步占住 activeRun：调用方是 `void pushInput(); waitForIdle()`，
		// 中间夹一次 await 会让 waitForIdle 扑空、把这一轮当成已经结束。
		if (requestedMode === "direct" && !busy && this.queues.size === 0)
			return this.startRun(normalized, queued, { needsEnqueueEvent: true });
		return this.enqueueRecord(queued).then(async () => {
			if (!this.isBusy()) await this.resumeQueued();
		});
	}

	/**
	 * 准入 + 登记（同步，不写盘、不启动回合）。返回 null 表示这条已经 committed，
	 * 幂等视作受理成功。单条与批量共用这一条路径，避免两套去重。
	 */
	private admitInput(input: AgentInput, owner?: InputDeliveryOwner): QueuedMessage | null {
		if (
			input.receipt !== undefined &&
			(!validDeliveryTag(input.receipt) || !owner || !owner.isActive() || this.deliveryClosed)
		)
			throw new InputRejected("Invalid receipt or inactive input source", false);
		if (input.receipt && owner) {
			if (
				this.store?.state.deliveryCommits.has(deliveryKey(owner.namespace, input.receipt.key)) ||
				this.findDelivery(owner.namespace, input.receipt.key)
			)
				return null;
		}
		if (!validImages(input.images)) throw new InputRejected("图片内容无效", false);
		if (!input.id || (!input.text?.trim() && !input.render))
			throw new InputRejected("AgentInput 必须包含 id，且 text 或 render 至少一个非空", false);
		if (this.inputDeliveries.has(input.id) || this.queues.has(input.id) || this.store?.state.queued.has(input.id))
			throw new InputRejected(`输入 id 已在队列中: ${input.id}`, false);
		if (this.store?.state.recordIds.has(input.id))
			throw new InputRejected(`输入 id 已存在于会话记录中: ${input.id}`, false);

		const queued: QueuedMessage = {
			...this.queues.create((input.text ?? "").trim(), input.mode, {
				source: input.source,
				...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
				data: input.data,
				images: input.images,
			}),
			id: input.id,
		};
		if (input.receipt && owner) {
			queued.receipt = { ...input.receipt };
			queued.receiptNamespace = owner.namespace;
			this.inputDeliveries.set(input.id, {
				item: queued,
				owner,
				since: new Date().toISOString(),
				order: ++this.deliveryOrder,
				active: true,
				phase: "queued",
			});
		}
		if (input.render) this.deferredInputRenders.set(input.id, input.render);
		return queued;
	}

	/** 已登记的输入在持久化/回合阶段失败：把所有权还给发送方，不留下假的 pending。 */
	private failAdmission(queued: QueuedMessage, error: unknown): void {
		this.deferredInputRenders.delete(queued.id);
		const attempt = this.inputDeliveries.get(queued.id);
		if (attempt?.item === queued) attempt.error = error;
	}

	/** 输入受理的唯一事实出口。调用方必须先完成持久化或明确的直接启动准入。 */
	private async publishInputAccepted(queued: QueuedMessage): Promise<void> {
		const receivedAt = queued.receivedAt ?? new Date().toISOString();
		await this.publishInputFact({
			type: "input_accepted",
			inputId: queued.id,
			...(queued.source ? { source: queued.source } : {}),
			receivedAt,
		});
		if (queued.source?.kind === "runtime" && queued.source.origin === "external") {
			this.dispatch({
				type: "external_input",
				inputId: queued.id,
				source: queued.source,
				receivedAt,
				text: queued.text,
				...(queued.images ? { images: queued.images } : {}),
			});
		}
	}
	/** Fact observers cannot undo committed ownership, even when they reject. */
	private async publishInputFact(
		event: import("../runtime/events.js").InputAcceptedEvent | import("../runtime/events.js").InputSettledEvent,
	): Promise<void> {
		try {
			await this.dispatch(event);
		} catch (error) {
			try {
				await this.dispatch({ type: "error", text: errorMessage(error) });
			} catch (reportError) {
				console.error("[Subject:input-fact]", reportError);
			}
		}
	}

	private async settleInput(
		item: QueuedMessage,
		outcome:
			| { outcome: "committed" }
			| { outcome: "retired"; reason: "empty_render" | "claimed" | "already_recorded" | "missing_render" },
	): Promise<void> {
		const current = this.inputDeliveries.get(item.id);
		if (
			!current ||
			(current.item.receipt?.attempt === item.receipt?.attempt &&
				current.item.receiptNamespace === item.receiptNamespace)
		) {
			this.deferredInputRenders.delete(item.id);
			this.inputDeliveries.delete(item.id);
		}
		await this.publishInputFact({
			type: "input_settled",
			inputId: item.id,
			...(item.source ? { source: item.source } : {}),
			...outcome,
		});
	}

	async accept(input: AgentInput, owner?: InputDeliveryOwner): Promise<void> {
		const queued = this.admitInput(input, owner);
		if (!queued) return;
		// idle 且队列空时同步直启：startRun 首行就占住 activeRun，emitEvent 返回时
		// 这一轮已在处理，waitForIdle() 才能覆盖它。先入队再异步 resumeQueued 会
		// 留下 activeRun 的空窗，把尚未提交的回合误判成已经结束。
		if (!this.isBusy() && this.queues.size === 0)
			return this.startRun(queued.source?.kind === "runtime" ? undefined : queued.text, queued, {
				needsEnqueueEvent: true,
			}).catch((error) => {
				this.failAdmission(queued, error);
				throw error;
			});
		return this.enqueueRecord(queued)
			.then(async () => {
				if (!this.isBusy()) await this.resumeQueued();
			})
			.catch((error) => {
				this.failAdmission(queued, error);
				throw error;
			});
	}

	/**
	 * 批量受理：逐条走与 `accept` 完全相同的准入与持久化，但全程不启动回合。
	 *
	 * 为什么不能直接 `Promise.all(inputs.map(accept))`：idle 时第一条会直启一个
	 * 完整回合，剩下的只能等它跑完——多份 Completion 串行交付正是这么来的。
	 * 这里先全部落队，最后只调度一次消费，由现有 `batchForTurn()` 预算决定
	 * 这一轮带哪些。
	 *
	 * 部分成功是允许的：存储没有跨条原子事务。失败的项留在发送方手里，按同一个
	 * id 重交才安全；已受理的项不回滚。
	 */
	async acceptBatch(inputs: readonly AgentInput[], owner?: InputDeliveryOwner): Promise<InputSubmissionOutcome[]> {
		const outcomes: InputSubmissionOutcome[] = [];
		for (const input of inputs) {
			let queued: QueuedMessage | null = null;
			try {
				queued = this.admitInput(input, owner);
				if (queued) await this.enqueueRecord(queued);
				outcomes.push({ id: input.id, accepted: true });
			} catch (error) {
				if (queued) this.failAdmission(queued, error);
				outcomes.push({
					id: input.id,
					accepted: false,
					reason: errorMessage(error),
					retryable: isRetryableRejection(error),
				});
			}
		}
		// 一条都没进去就不开空回合。调度失败必须有观察者，不能是裸 Promise。
		if (outcomes.some((outcome) => outcome.accepted) && !this.isBusy())
			void this.resumeQueued().catch((error) => this.reportError(error));
		return outcomes;
	}

	/** Queue an input for the next model request while the current run is active. */
	steer(text: string): Promise<void> {
		return this.pushInput(text, { mode: "steer" });
	}

	/** Queue an input until the current run has otherwise completed. */
	followUp(text: string): Promise<void> {
		return this.pushInput(text, { mode: "followUp" });
	}

	interrupt(): void {
		if (!this.activity) return;
		// interrupted 是回合语义标志（决定 outcome 记为 aborted）。post-turn 与
		// 回合外活动只取消执行，不回改已冻结的回合结果。
		if (this.activity === "turn" || this.activity === "rewind") this.interrupted = true;
		try {
			this.abort?.abort();
		} catch {
			// ignore synchronous abort errors
		}
	}

	isBusy(): boolean {
		return this.activeRun !== undefined;
	}

	waitForIdle(): Promise<void> {
		return this.activeRun ?? Promise.resolve();
	}

	/**
	 * 回合外排他前台活动：占用 Subject、阻止新 turn、受 interrupt 控制、被
	 * waitForIdle/dispose 等待。仅 idle 可进入（与 runTurn/rewind/其他活动互斥）；
	 * 不产生 turn 事件；异常不留半占用状态（finally 统一释放）。
	 * 适用"必须独占主体、与用户回合串行"的工作（如空闲压缩）；可与回合并行的
	 * 后台工作不属于这里。
	 */
	async runActivity(fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activity || this.activeRun !== undefined) {
			throw new Error("Subject 忙碌，无法开始回合外活动");
		}
		this.activeRun = new Promise<void>((resolve) => {
			this.settleActiveRun = resolve;
		});
		this.activity = "activity";
		this.interrupted = false;
		const controller = new AbortController();
		this.abort = controller;
		try {
			await fn(controller.signal);
		} finally {
			this.abort = null;
			this.activity = undefined;
			this.completeActiveRun();
		}
	}

	addHistory(messages: readonly (AgentMessage | ChatMsg)[]): void {
		if (this.isBusy()) throw new Error("活动期间不能替换历史");
		// 仅补进程内事件 id。journal 回放使用条目 id，不把这里的随机 id 写成事实。
		this.history.push(
			...messages.map((m) => {
				const hasId = "id" in m && Boolean((m as { id?: string }).id);
				const hasInput = "input" in m && Boolean((m as { input?: unknown }).input);
				// Canonical-boundary capabilities need every in-process message to carry a
				// stable identity, not only user inputs. This identity is process-local and
				// never written to the journal by addHistory; restored journal entries already
				// carry their durable ids.
				if (!hasId && !hasInput) return { ...structuredClone(m as AgentMessage), id: randomUUID() };
				return structuredClone(m as AgentMessage);
			}),
		);
	}

	seedQueue(items: readonly QueuedMessage[]): void {
		this.queues.seed(items);
		for (const item of items)
			if (item.receipt && item.receiptNamespace)
				this.inputDeliveries.set(item.id, {
					item,
					since: item.receivedAt ?? new Date().toISOString(),
					order: ++this.deliveryOrder,
					owner: { namespace: item.receiptNamespace, isActive: () => false },
					active: true,
					phase: "queued",
				});
		this.notifyQueueChanged();
	}

	historySnapshot(): AgentMessage[] {
		return structuredClone(this.history);
	}

	queuedSnapshot(): QueuedMessage[] {
		return this.queues.all().map((item) => ({ ...item }));
	}

	queueOldestAgeMs(): number | undefined {
		return this.queues.oldestAgeMs();
	}

	/** Claims all queued inputs (mailbox claim 原语) and returns them in arrival order.
	 * Ownership is claimed synchronously before any await so concurrent queue consumption cannot see claimed items.
	 * JSONL journal 无批事务：部分持久化失败时，已写入 queue_restored 的条目 ownership
	 * 已经移交 caller，必须随结果返回而不是随异常蒸发；未持久化的条目归还队列。 */
	async claimAllQueued(): Promise<ClaimAllResult> {
		const items = this.queues.takeAll();
		const claimed: QueuedMessage[] = [];
		for (const item of items) {
			try {
				const attempt = this.inputDeliveries.get(item.id);
				if (attempt) {
					const reply = await this.retireInputDelivery(attempt);
					if (reply.kind === "unavailable") throw new Error(reply.reason);
				} else await this.storeEvent("queue_restored", eventData(item));
				claimed.push(item);
				await this.settleInput(item, { outcome: "retired", reason: "claimed" });
			} catch (error) {
				for (const unclaimed of items.slice(claimed.length)) {
					this.queues.add(unclaimed);
				}
				this.notifyQueueChanged();
				return { kind: "partial", claimed: [...claimed], failedId: item.id, error };
			}
		}
		this.notifyQueueChanged();
		return { kind: "complete", claimed };
	}

	/** Claims one queued input by identity；不存在的身份返回 null（幂等领取）。
	 * 持久化失败时条目归还队列后重抛——claim 未提交，所有权仍在 Subject。 */
	async claimQueued(id: string): Promise<QueuedMessage | null> {
		const claimed = this.queues.remove(id);
		if (!claimed) return null;
		try {
			const attempt = this.inputDeliveries.get(claimed.id);
			if (attempt) {
				const reply = await this.retireInputDelivery(attempt);
				if (reply.kind === "unavailable") throw new Error(reply.reason);
			} else await this.storeEvent("queue_restored", { ...claimed });
		} catch (error) {
			this.queues.add(claimed);
			this.notifyQueueChanged();
			throw error;
		}
		await this.settleInput(claimed, { outcome: "retired", reason: "claimed" });
		this.notifyQueueChanged();
		return claimed;
	}

	private async startRun(
		text?: string,
		queuedInput?: QueuedMessage,
		options: { needsEnqueueEvent?: boolean; queuedInputs?: QueuedMessage[] } = {},
	): Promise<void> {
		if (this.activity) return Promise.reject(new Error("已有活动轮次"));
		const isRootRun = this.activeRun === undefined;
		if (isRootRun) {
			this.activeRun = new Promise<void>((resolve) => {
				this.settleActiveRun = resolve;
			});
		}

		const queuedInputs = options.queuedInputs ?? (queuedInput ? [queuedInput] : []);
		const inputState = queuedInput ? { durable: !options.needsEnqueueEvent, committed: false } : undefined;
		try {
			if (queuedInput && options.needsEnqueueEvent) {
				await this.enqueueInput(queuedInput);
				inputState!.durable = true;
				if (this.inputDeliveries.get(queuedInput.id)?.active === false) return;
			}
			this.activity = "turn";
			this.interrupted = false;
			this.abort = new AbortController();
			const turn = ++this.turnSeq;
			if (queuedInputs.length > 0) {
				// Claim ownership synchronously before the first await; the item must leave the
				// queue before prepare/emits so it can neither be restored to the editor nor re-consumed.
				for (const item of queuedInputs) this.queues.remove(item.id);
				this.notifyQueueChanged();
			}
			if (options.needsEnqueueEvent) await this.publishInputAccepted(queuedInput!);

			const prepared = await this.runtimeHooks.turn.prepare({ prompt: text ?? "", systemPrompt: this.systemPrompt });
			await this.applyPreparedRuntime(prepared);
			await this.dispatchContextPrepare(turn, prepared);
			await this.runtimeHooks.events.emit({ type: "agent_start", turnSeq: turn });

			await this.runTurn(
				text,
				turn,
				this.model,
				prepared.systemPrompt ?? this.systemPrompt,
				prepared.messages ? [...prepared.messages] : [],
				queuedInput,
				() => {
					if (inputState) inputState.committed = true;
				},
				queuedInputs,
			);
		} catch (error) {
			const admissionFailed = queuedInput !== undefined && inputState !== undefined && !inputState.durable;
			if (queuedInput && inputState?.durable && !inputState.committed) {
				for (const item of queuedInputs) if (this.ownsInput(item) && !this.queues.has(item.id)) this.queues.add(item);
				this.notifyQueueChanged();
			}
			this.abort = null;
			this.activity = undefined;
			if (admissionFailed) throw error;
			this.reportError(error);
		} finally {
			if (isRootRun) this.completeActiveRun();
		}
	}

	private async runTurn(
		text: string | undefined,
		turn: number,
		model = this.model,
		systemPrompt = this.systemPrompt,
		beforeMessages: readonly (AgentMessage | ChatMsg)[] = [],
		queuedInput?: QueuedMessage,
		onInputCommitted?: () => void,
		queuedInputs: QueuedMessage[] = queuedInput ? [queuedInput] : [],
	): Promise<void> {
		let success = false;
		let runError: string | undefined;
		let currentTurn = turn;
		let turnStarted = false;
		try {
			if (queuedInputs.length > 0) {
				const batch = await this.consumeQueueItems(queuedInputs, onInputCommitted);
				// 延迟渲染的正文此刻才成形：超预算的剩余项已退回队列，本轮只带实际提交的这些。
				queuedInputs = batch.consumed;
				if (!batch.committed && queuedInputs.every(isRuntimeFollowUp)) {
					this.abort = null;
					this.activity = undefined;
					if (this.queues.size > 0) await this.resumeQueued();
					else await this.dispatch({ type: "agent_settled", turnSeq: turn });
					return;
				}
			} else if (text !== undefined)
				await this.appendMessage({ role: "user", content: text, timestamp: new Date().toISOString() });
			await this.dispatch({
				type: "turn_start",
				turnNumber: currentTurn,
				userText: text ?? "",
				inputRefs: queuedInputs.map((item) => item.id),
				images: queuedInput?.images,
			});
			turnStarted = true;
			const outcome = await this.decide(
				model,
				systemPrompt,
				beforeMessages,
				(nextTurn) => {
					currentTurn = nextTurn;
				},
				() => currentTurn,
			);
			if (outcome.kind === "completed") {
				success = true;
			} else if (outcome.kind === "terminated") {
				// 政策终止（如 tool_call_limit）：journal 由这里唯一收口 turn_failed；
				// reason code 单独存放，error 字段与 agent_end 一致用人类可读消息。
				runError = outcome.message;
				await this.storeEvent("turn_failed", { turnId: currentTurn, error: outcome.message, reason: outcome.reason });
				this.reportError(outcome.message);
			}
			// aborted：turn_aborted 已由 emitInterrupted 落盘，这里只让 success=false，不重复收口。
		} catch (error) {
			if (!turnStarted) {
				throw error;
			} else {
				runError = errorMessage(error);
				if (this.interrupted || this.currentSignal().aborted) {
					await this.emitInterrupted();
				} else {
					await this.storeEvent("turn_failed", { turnId: currentTurn, error: runError });
					this.reportError(runError);
				}
			}
		} finally {
			if (turnStarted) await this.finishTurn(currentTurn, success, runError);
		}
	}

	private async finishTurn(turnNumber: number, success: boolean, error?: string): Promise<void> {
		if (this.pendingRewind && (!success || this.interrupted)) {
			const requestId = this.pendingRewind.requestId;
			this.pendingRewind = undefined;
			this.reportError(`回溯请求 ${requestId} 未提交：回合失败或被取消，主线保持不变`);
		}
		try {
			await this.runtimeHooks.events.flush();
			await this.dispatch({
				type: "turn_end",
				turnNumber,
				requestUsage: this.currentCallUsage ? structuredClone(this.currentCallUsage) : undefined,
			});
		} catch (dispatchError) {
			this.reportError(dispatchError);
		}
		await this.dispatch({ type: "agent_end", turnSeq: turnNumber, success, error });
		if (success && !this.interrupted && this.pendingRewind) await this.applyPendingRewind();

		this.activity = "afterEnd";
		this.abort = new AbortController();
		const postTurnSignal = this.currentSignal();
		try {
			await this.runtimeHooks.turn.afterEnd({
				turnNumber,
				success,
				...(error ? { error } : {}),
				signal: postTurnSignal,
			});
		} catch (afterEndError) {
			this.reportError(afterEndError);
		}
		this.abort = null;
		this.activity = undefined;
		try {
			await this.getContextSnapshot("idle_baseline");
		} catch (snapshotError) {
			this.reportError(snapshotError);
		}
		if (success && !this.interrupted && this.queues.size > 0) {
			try {
				await this.resumeQueued();
			} catch (resumeError) {
				this.reportError(resumeError);
			}
			return;
		}
		// 失败或被打断的回合不自动续跑队列：失败续跑会错误循环，打断续跑违背用户停止意图。
		// 队列由 pending 卡片诚实呈现，等待显式投递（Esc+文本 / Ctrl+Enter / Alt+↑ 撤回）。
		await this.dispatch({ type: "agent_settled", turnSeq: turnNumber });
	}

	/** Resume original queued records after interruption, preserving identity, source and attachments. */
	resumePending(): Promise<void> {
		if (this.isBusy()) throw new Error("Agent 正在运行，无法恢复队列");
		return this.resumeQueued();
	}

	private async resumeQueued(): Promise<void> {
		if (this.activity || this.resumingQueue) return;
		this.resumingQueue = true;
		try {
			await this.drainQueuesIntoRun();
		} finally {
			this.resumingQueue = false;
		}
	}

	private async drainQueuesIntoRun(): Promise<void> {
		if (this.activity) return;
		const batch = this.queues.batchForTurn();
		if (!batch) return;
		this.resumingQueue = false;
		const item = batch[0]!;
		await this.startRun(item.source?.kind === "runtime" ? undefined : item.text, item, { queuedInputs: batch });
	}

	/** Applies runtime-provided model/thinking facts at a run-safety point.
	 * Model swaps reuse setModel's full discipline (usage-anchor invalidation +
	 * model_select broadcast); thinking swaps clamp against the current model. */
	private async applyPreparedRuntime(
		prepared: Readonly<{ model?: Model; thinkingLevel?: ThinkingLevel }>,
	): Promise<void> {
		if (
			prepared.model &&
			!(prepared.model.id === this.model.id && prepared.model.providerId === this.model.providerId)
		) {
			await this.setModel(prepared.model);
		}
		if (prepared.thinkingLevel !== undefined && prepared.thinkingLevel !== this.preferredThinkingLevel) {
			this.setThinkingLevel(prepared.thinkingLevel);
		}
	}

	private async decide(
		model: Model = this.model,
		systemPrompt = this.systemPrompt,
		beforeMessages: readonly (AgentMessage | ChatMsg)[] = [],
		onTurnTransition?: (nextTurn: number) => void,
		getCurrentTurn?: () => number,
	): Promise<DecisionOutcome> {
		const applyRewind = async (): Promise<boolean> => {
			if (!(await this.applyPendingRewind())) return false;
			const prepared = await this.runtimeHooks.turn.prepare({ prompt: "", systemPrompt: this.systemPrompt });
			await this.applyPreparedRuntime(prepared);
			await this.dispatchContextPrepare(this.turnSeq, prepared);
			// 换模型/换档即刻生效于本 decide 循环的下一次请求（安全点已过，口径统一）。
			model = this.model;
			systemPrompt = prepared.systemPrompt ?? this.systemPrompt;
			beforeMessages = prepared.messages ? [...prepared.messages] : [];
			return true;
		};
		// A scheduled rewind commits before turn preparation, so each request always sees
		// the mainline that is about to be sent — never a projection the rewind is about to replace.
		// 预算口径 = processed（真正进入执行流水线的调用），防的是失控循环的模型请求预算，
		// 不是"成功副作用"配额——无效/未知工具即便 not_started 也消耗预算，模型无法靠无效调用绕过上限。
		let processedToolCalls = 0;
		for (;;) {
			if (this.interrupted) {
				await this.emitInterrupted();
				return { kind: "aborted" };
			}

			await applyRewind();
			// 回合内暴涨由每请求的 transformContext 裁剪收敛（compaction capability
			// 拥有上下文窗口管理）——这里不再有 between-step 压缩体检。
			const projection = await this.prepareProjectionForSend(model, systemPrompt, beforeMessages, this.currentSignal());
			if (!projection) {
				await this.emitInterrupted();
				return { kind: "aborted" };
			}
			const callId = `stream-${this.turnSeq}-${++this.streamSeq}`;
			const callSeq = this.streamSeq;
			const collector = new TurnStreamCollector(callId, (event) => this.dispatch(event), {
				onUsage: (usage, timing) => void this.publishUsage(usage, callId, projection, callSeq, timing),
				onRetry: (event) =>
					this.dispatch(
						event.kind === "provider_retry"
							? { type: "provider_retry", provider: model.providerId, ...event }
							: { type: "provider_recovered", provider: model.providerId, attempt: event.attempt },
					),
			});
			this.currentCallUsage = undefined;
			const streamSignal = this.currentSignal();

			try {
				await this.streamFn(
					model,
					{
						messages: [...projection.messages],
						tools: [...projection.tools],
						thinkingLevel: projection.thinkingLevel,
						providerHooks: this.runtimeHooks.provider,
					},
					(delta) => {
						if (!streamSignal.aborted) collector.handleDelta(delta);
					},
					streamSignal,
				);
			} catch (error) {
				// handleStreamError 仅在 abort 已由 emitInterrupted 落盘后正常返回；其余错误继续上抛。
				await this.handleStreamError(collector, error);
				return { kind: "aborted" };
			}

			if (this.interrupted || this.currentSignal().aborted) {
				collector.closeOutput("interrupted", "cancelled");
				const partial = collector.getPartialOutput();
				await this.emitInterrupted(partial.reply, partial.thinking, partial.thinkingSignature);
				return { kind: "aborted" };
			}

			const streamResult = collector.validateAndFinalize();

			if (streamResult.finishReason !== "tool_calls") {
				await this.recordTerminalAssistant(streamResult);
				if (await applyRewind()) continue;
				// steer/followUp 续跑不在这里内联消费：decide 的 model 参数是回合开始的快照，
				// 在此 drain 会让切模型/改思考档后的排队输入仍用旧口径（假切换）。
				// 交还 runTurn 收尾的 resumeQueued 链路 —— startRun 会重新取 this.model 快照。
				return { kind: "completed" };
			}

			const proposedToolCalls = streamResult.toolCalls.length;
			const toolCallCap = this.maxConsecutiveToolCalls;
			if (processedToolCalls + proposedToolCalls > toolCallCap) {
				// Provider 已返回的 tool_calls 是事实，不因预算拒绝而蒸发：整批落盘 + not_started 结算。
				await this.recordTerminalAssistant(streamResult, `已达工具调用上限 ${toolCallCap}，本批未执行`);
				const capText = `[回合终止] 已处理 ${processedToolCalls} 次工具调用，本批 ${proposedToolCalls} 个调用将超过上限 ${toolCallCap}，因此未执行。本次任务未正常收敛，已停止执行。`;
				console.warn(`[Subject:decide] 工具调用预算耗尽（已处理 ${processedToolCalls}/${toolCallCap}），终止本回合`);
				await this.appendMessage(this.buildAssistantMessage({ reply: capText }, { status: "error" }));
				return { kind: "terminated", reason: "tool_call_limit", message: capText };
			}

			const { stopped } = await this.settleToolExchange(streamResult);
			processedToolCalls += proposedToolCalls;
			if (processedToolCalls >= 100 && processedToolCalls % 50 === 0) {
				console.warn(
					`[Subject:decide] 提示：本回合已处理工具调用 ${processedToolCalls} 次（上限 ${this.maxConsecutiveToolCalls}）`,
				);
			}
			if (this.interrupted || this.currentSignal().aborted) {
				await this.emitInterrupted("", "", undefined);
				return { kind: "aborted" };
			}
			if (await applyRewind()) continue;
			if (stopped) return { kind: "completed" };
			// 回合间停止决策（对应 Pi shouldStopAfterTurn）：任一扩展要求停止时立即收尾，
			// 不再发起下一次模型调用。仅作用于本运行内的续跑；队列恢复语义不变。
			const stopDecision = await this.runtimeHooks.turn.shouldStop({
				turnNumber: getCurrentTurn?.() ?? this.turnSeq,
				finishReason: streamResult.finishReason,
				reply: streamResult.reply,
				toolCallCount: streamResult.toolCalls.length,
			});
			if (stopDecision.stop) return { kind: "completed" };
			await this.drainSteerInputs(onTurnTransition, getCurrentTurn);
		}
	}

	private async prepareProjectionForSend(
		model: Model,
		systemPrompt: string,
		beforeMessages: readonly (AgentMessage | ChatMsg)[],
		turnSignal: AbortSignal,
	): Promise<RequestProjection | undefined> {
		for (let pass = 0; pass <= 1; pass++) {
			const projection = await this.prepareProjection(model, systemPrompt, beforeMessages, true, turnSignal);
			// 投影与测量是同步 CPU（全量历史构建 + JSON 序列化）。不在这里割断，
			// 事件循环会连同 TUI 心跳、输出流一起被冻住（实测单次 1.4s）。
			await yieldToLoop();
			if (this.interrupted || turnSignal.aborted) return undefined;
			const measurement = measureRequestContext(
				projection,
				this.measureContext ? (p) => this.measureContext!(model, p) : undefined,
				{ countThinking: (model.thinkingReplay ?? "none") !== "none" },
			);
			const decision = await this.runtimeHooks.turn.preflight({ projection, measurement, pass, signal: turnSignal });
			if (decision.action === "fail") throw new Error(decision.reason ?? "请求预检失败");
			if (decision.action === "rebuild") {
				if (pass >= 1) throw new Error(decision.reason ?? "请求重建后仍需要再次重建");
				continue;
			}
			const budget = inputTokenBudget(model, projection.thinkingLevel);
			if (budget !== undefined && measurement.inputTokens > budget) {
				throw new Error("上下文超过可用预算；无法保留完整的最近上下文，请压缩或缩减输入");
			}
			this.projection.validateContext(projection.messages, { model, tools: projection.tools });
			// 下面的 provider 调用要先对 1MB 请求体做守卫克隆与序列化，同样让一次。
			await yieldToLoop();
			if (this.interrupted || turnSignal.aborted) return undefined;
			// An active request supersedes every idle inspection that is still in flight.
			// Otherwise a slower idle measurement can publish after this snapshot and
			// overwrite the context actually sent to the provider.
			this.contextInspectionSeq++;
			this.publishContextSnapshot(
				this.contextSnapshot(
					{ projection, measurement, contextWindow: model.contextWindow, inputBudget: budget },
					"active_request",
				),
			);
			return projection;
		}
		throw new Error("请求准备失败");
	}

	private async prepareProjection(
		model: Model,
		systemPrompt: string,
		beforeMessages: readonly (AgentMessage | ChatMsg)[],
		runTransforms: boolean,
		signal?: AbortSignal,
	): Promise<RequestProjection> {
		const built = [
			...buildContext({
				history: this.history,
				systemPrompt,
				thinkingReplay: model.thinkingReplay,
				convertToLlm: this.projection.convertToLlm,
			}),
			...this.projection.convertToLlm(beforeMessages, { thinkingReplay: model.thinkingReplay }),
		];
		const messages = built;
		const base: RequestProjection = immutableProjection({
			projectionId: randomUUID(),
			modelKey: modelKey(model),
			messages,
			tools: this.declaredTools(),
			thinkingLevel: clampThinkingLevel(this.thinkingLevel, model.thinkingLevels),
		});
		if (!runTransforms) return base;
		await yieldToLoop();
		// 中断发生在让出点之后时，不再执行投影变换；调用方会在下一个检查点收尾。
		if (signal?.aborted) return base;
		const transformed = await this.runtimeHooks.turn.transformContext(base);
		if (transformed.projectionId !== base.projectionId || transformed.modelKey !== base.modelKey) {
			throw new Error("turn.transformContext 不得修改 projectionId 或 modelKey");
		}
		if (
			transformed.thinkingLevel !== undefined &&
			transformed.thinkingLevel !== "off" &&
			!model.thinkingLevels?.includes(transformed.thinkingLevel)
		) {
			throw new Error(`turn.transformContext 返回模型不支持的 thinking level: ${transformed.thinkingLevel}`);
		}
		return immutableProjection(transformed);
	}

	/** 下一次模型请求会声明的工具。压缩预算与请求门共用这一份，不能只数可执行工具。 */
	declaredTools(): import("../core/types.js").ToolDef[] {
		return requestToolDefs(this.tools.defs(), this.projection.contextTools);
	}

	private async handleStreamError(collector: TurnStreamCollector, error: unknown): Promise<void> {
		collector.closeOutput("interrupted", this.interrupted || this.currentSignal().aborted ? "cancelled" : "error");
		if (this.interrupted || this.currentSignal().aborted) {
			const partial = collector.getPartialOutput();
			await this.emitInterrupted(partial.reply, partial.thinking, partial.thinkingSignature);
			return;
		}
		const partial = collector.getPartialOutput();
		if (partial.reply.trim() || partial.thinking.trim() || partial.thinkingSignature) {
			await this.appendMessage(this.buildAssistantMessage(partial, { status: "error" }));
		}
		throw error;
	}

	/** 终态 assistant 消息的共用构造器（P2-F）：统一生成时间戳、思考签名与完成状态。 */
	private buildAssistantMessage(
		result: {
			reply: string;
			thinking?: string;
			thinkingSignature?: string;
			providerReplay?: import("../core/types.js").ProviderReplay;
			toolCalls?: CompletedToolCall[];
			finishReason?: string;
			usage?: Usage;
		},
		options: { status?: "complete" | "length" | "error" | "aborted"; timestamp?: string } = {},
	): AgentMessage {
		return {
			role: "assistant",
			content: result.reply,
			thinking: result.thinking || undefined,
			thinkingSignature: result.thinkingSignature,
			providerReplay: result.providerReplay,
			...(result.toolCalls && result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
			status: options.status ?? (result.finishReason === "length" ? "length" : "complete"),
			usage: result.usage,
			timestamp: options.timestamp ?? new Date().toISOString(),
		};
	}

	private async recordTerminalAssistant(result: StreamCollectorResult, notExecutedReason?: string): Promise<void> {
		if (result.reply.trim() || result.toolCalls.length > 0 || result.thinking.trim()) {
			await this.appendMessage(this.buildAssistantMessage(result));
			for (const call of result.toolCalls) {
				await this.appendMessage({
					role: "tool",
					tool_call_id: call.id,
					content: JSON.stringify({
						error: notExecutedReason ?? "工具调用未执行（模型没有以 tool_calls 终止）",
						status: "not_started",
					}),
					status: "not_started",
					timestamp: new Date().toISOString(),
				});
			}
		}
	}

	private async settleToolExchange(result: StreamCollectorResult): Promise<{ stopped: boolean }> {
		await this.appendMessage(this.buildAssistantMessage(result));
		const attempts = new Set<string>();
		const batch = await this.executeToolCalls(result.toolCalls, attempts);
		try {
			for (const res of batch.results) {
				// 阶段 D/M7：canonical journal 落原始执行正文（未经 transformResult 改写）；
				// 模型可见改写投影经后续请求的投影链生效，不进 canonical 历史。
				const evidence = res.canonical ?? res;
				await this.appendMessage({
					role: "tool",
					tool_call_id: res.callId,
					content: evidence.result,
					images: evidence.images,
					details: evidence.details,
					receipt: evidence.receipt,
					receiptNamespace: evidence.receiptNamespace,
					status: evidence.status,
					timestamp: new Date().toISOString(),
				});
			}
		} catch (error) {
			for (const id of attempts) {
				const attempt = this.toolDeliveries.get(id);
				if (attempt) attempt.error = error;
			}
			throw error;
		}
		for (const id of attempts) this.toolDeliveries.delete(id);
		if (batch.error) throw batch.error;
		// 结果已全部进 canonical 历史，这时才轮到"还要不要再说一轮"：
		// 有 stop 就收口；整批都是可让出的委派结果就省掉一次注定没有新信息的请求。
		const hardStop = batch.results.some((res) => res.continuation === "stop");
		const allDelegated = batch.results.length > 0 && batch.results.every((res) => res.continuation === "yield");
		return { stopped: hardStop || allDelegated };
	}

	private async drainSteerInputs(
		onTurnTransition?: (nextTurn: number) => void,
		getCurrentTurn?: () => number,
	): Promise<boolean> {
		const items = this.queues.peekMany("steer");
		if (items.length === 0) return false;
		// Claim all items synchronously before the first await so none of them can be
		// restored to the editor while a previous item is being persisted.
		for (const item of items) {
			this.queues.remove(item.id);
		}
		this.notifyQueueChanged();
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			try {
				// 用户输入的排队项被消费时开一个可见回合（与首条消费路径的 turn_start 对齐）：
				// 严格保序关闭上一可见回合，再开启新可见回合，彻底消除交错嵌套 bug。
				// runtime 来源项投影为 display:false 的 custom 消息，不开可见回合。
				if (item.source?.kind !== "runtime") await this.runtimeHooks.events.flush();
				await this.commitQueueItem(item);
				if (item.source?.kind !== "runtime") {
					const previousTurn = getCurrentTurn?.() ?? this.turnSeq;
					await this.dispatch({
						type: "turn_end",
						turnNumber: previousTurn,
						requestUsage: this.currentCallUsage ? structuredClone(this.currentCallUsage) : undefined,
					});
					const nextTurn = ++this.turnSeq;
					onTurnTransition?.(nextTurn);
					await this.dispatch({
						type: "turn_start",
						turnNumber: nextTurn,
						userText: item.text,
						inputRefs: [item.id],
						images: item.images,
					});
				}
			} catch (error) {
				// 批量认领路径尚未提交当前项时，当前项和后续项都归还队列。
				for (const pending of items.slice(i)) if (this.ownsInput(pending)) this.queues.add(pending);
				this.notifyQueueChanged();
				throw error;
			}
		}
		return true;
	}

	private async executeToolCalls(calls: CompletedToolCall[], attempts = new Set<string>()): Promise<ToolBatchOutcome> {
		const prepared: Array<{ call: CompletedToolCall; tool: PreparedToolCall }> = [];
		for (const call of calls) {
			const args = isRecord(call.args) ? call.args : {};
			const tool = this.projection.contextTools.some((t) => t.function.name === call.name)
				? {
						name: call.name,
						args,
						error:
							"external_event_frame 回执由运行时在事件就绪后自动投递到上下文，不可主动获取；不要编造 eventId 或猜测事件内容，不要向用户复述此事，直接继续。",
					}
				: call.argsValid === false
					? { name: call.name, args, error: "工具参数 JSON 不完整，调用未执行" }
					: this.tools.prepare(call.name, args);
			prepared.push({ call, tool });
		}
		const sequential = prepared.some(({ call }) => this.tools.getExecutionMode(call.name) === "sequential");
		const runOne = async ({
			call,
			tool,
		}: {
			call: CompletedToolCall;
			tool: PreparedToolCall;
		}): Promise<ToolBatchResult> => {
			let started = false;
			try {
				return await this.executeOne(
					call,
					tool,
					() => {
						started = true;
					},
					attempts,
				);
			} catch (error) {
				throw new ToolPipelineFailure(started, error);
			}
		};
		if (sequential) {
			const results: ToolBatchResult[] = [];
			const failures: unknown[] = [];
			let halted = false;
			for (const item of prepared) {
				if (halted) {
					results.push(unresolvedToolResult(item.call, false));
					continue;
				}
				try {
					results.push(await runOne(item));
				} catch (error) {
					const failure = asToolPipelineFailure(error);
					failures.push(failure.failure);
					results.push(unresolvedToolResult(item.call, failure.started));
					halted = true;
				}
			}
			return {
				results,
				...(failures.length > 0 ? { error: new AggregateError(failures, "串行工具批次未完整成功") } : {}),
			};
		}
		const settled = await Promise.allSettled(prepared.map(runOne));
		const results: ToolBatchResult[] = [];
		const failures: unknown[] = [];
		for (let index = 0; index < settled.length; index++) {
			const item = prepared[index]!;
			const outcome = settled[index]!;
			if (outcome.status === "fulfilled") {
				results.push(outcome.value);
				continue;
			}
			const failure = asToolPipelineFailure(outcome.reason);
			failures.push(failure.failure);
			results.push(unresolvedToolResult(item.call, failure.started));
		}
		return {
			results,
			...(failures.length > 0 ? { error: new AggregateError(failures, "并行工具批次未完整成功") } : {}),
		};
	}

	private async executeOne(
		call: CompletedToolCall,
		prepared: PreparedToolCall,
		onStarted?: () => void,
		attempts = new Set<string>(),
	): Promise<ToolBatchResult> {
		const callArgs = (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>;
		// 在流水线启动前广播 tool_call，确保 UI 必定能收到工具调用声明并建立节点，
		// 消除后续 onDone 产生孤儿 tool_result 的异常
		this.dispatch({
			type: "tool_call",
			toolName: call.name,
			args: callArgs,
			callId: call.id,
			invocationId: `model:${call.id}`,
		});
		return this.tools.executePipeline(
			{ callId: call.id, invocationId: `model:${call.id}`, name: call.name, args: callArgs, prepared },
			{
				signal: this.currentSignal(),
				hooks: this.runtimeHooks.tools,
				onValidated: (outcome) => {
					if (!outcome.receipt || !outcome.receiptNamespace || this.deliveryClosed) return;
					const id = randomUUID();
					attempts.add(id);
					this.toolDeliveries.set(id, {
						namespace: outcome.receiptNamespace,
						receipt: { ...outcome.receipt },
						since: new Date().toISOString(),
						order: ++this.deliveryOrder,
					});
				},
				observers: {
					onStart: async () => {
						await this.storeEvent("tool_started", {
							callId: call.id,
							name: call.name,
							args: call.args,
						});
						onStarted?.();
					},
					onDone: async (outcome) => {
						await this.storeEvent("tool_finished", {
							callId: call.id,
							name: call.name,
							status: outcome.status,
						});
						this.dispatch({
							type: "tool_result",
							toolName: call.name,
							args: callArgs,
							result: outcome.result,
							images: outcome.images,
							details: outcome.details,
							status: outcome.status,
							callId: call.id,
						});
					},
				},
			},
		);
	}

	// Subject 无压缩编排：上下文窗口管理唯一入口 = compaction capability 的
	// turn.transformContext 每请求裁剪；journal 保留全量历史。

	private async appendMessage(message: AgentMessage): Promise<void> {
		const entryId = message.id ?? randomUUID();
		const durable = { ...message, id: entryId } as AgentMessage;
		await this.store?.appendMessage(durable, entryId);
		this.history.push(durable);
	}

	/** Adds trusted extension content to both v2 persistence and the next provider context. */
	async appendCustomMessage(message: {
		customType: string;
		content: string;
		images?: import("../core/content.js").ImageContent[];
		display?: boolean;
		details?: unknown;
	}): Promise<void> {
		if (this.rewindCommitting || this.activity === "rewind") throw new Error("回溯提交期间不能修改模型历史");
		if (!validImages(message.images)) throw new Error("图片内容无效");
		await this.store?.appendCustomMessage(message);
		this.history.push({
			role: "custom",
			customType: message.customType,
			content: message.content,
			images: message.images,
			display: message.display,
			details: message.details,
			timestamp: new Date().toISOString(),
		});
		// Durable fact 已落盘，广播权在 Subject 单流（宿主不得代为编排事实）。
		await this.dispatch({
			type: "custom_message",
			message: {
				customType: message.customType,
				content: message.content,
				...(message.images ? { images: message.images } : {}),
				...(message.display !== undefined ? { display: message.display } : {}),
				...(message.details !== undefined ? { details: message.details } : {}),
			},
		});
	}

	async appendCustomEntry(entry: { customType: string; data?: unknown }): Promise<void> {
		await this.store?.appendCustomEntry(entry);
		await this.dispatch({
			type: "custom_entry",
			entry: {
				customType: entry.customType,
				...(entry.data !== undefined ? { data: entry.data } : {}),
			},
		});
	}

	private async consumeQueueItems(
		items: QueuedMessage[],
		onCommitted?: () => void,
	): Promise<{ committed: boolean; consumed: QueuedMessage[] }> {
		let committedCount = 0;
		let committedAny = false;
		let chars = 0;
		try {
			for (let index = 0; index < items.length; index++) {
				const materialized = await this.commitQueueItem(items[index]);
				committedCount = index + 1;
				committedAny = materialized.committed || committedAny;
				onCommitted?.();
				chars += materialized.chars;
				// 延迟渲染的正文到这一刻才成形：领进来时按空字符串算的预算在这里才有真实数值。
				// 超预算就把剩余项退回队列——它们的 order 不变，下一轮仍然按原顺序领走。
				if (chars > MAX_TURN_CHARS && index + 1 < items.length) {
					for (const rest of items.slice(index + 1)) if (this.ownsInput(rest)) this.queues.add(rest);
					this.notifyQueueChanged();
					return { committed: committedAny, consumed: items.slice(0, index + 1) };
				}
			}
		} catch (error) {
			// Items already committed are canonical; only the uncommitted suffix returns to the mailbox.
			for (const item of items.slice(committedCount)) if (this.ownsInput(item)) this.queues.add(item);
			this.notifyQueueChanged();
			throw error;
		}
		return { committed: committedAny, consumed: items };
	}

	/** `chars` 是这次提交真正进历史的正文长度；延迟渲染只有走到这里才知道。 */
	private async commitQueueItem(item: QueuedMessage): Promise<{ committed: boolean; chars: number }> {
		const retired = { committed: false, chars: 0 } as const;
		if (!this.ownsInput(item)) return retired;
		const attempt = this.inputDeliveries.get(item.id);
		const eligible = () =>
			!item.receipt ||
			(!!attempt &&
				this.inputDeliveries.get(item.id) === attempt &&
				attempt.active &&
				attempt.owner.isActive() &&
				!this.deliveryClosed &&
				!this.store?.state.deliveryCommits.has(deliveryKey(attempt.owner.namespace, item.receipt!.key)));
		const retire = async (): Promise<{ committed: boolean; chars: number }> => {
			if (attempt && this.inputDeliveries.get(item.id) === attempt) {
				const reply = await this.retireInputDelivery(attempt);
				if (reply.kind === "unavailable") throw new Error(reply.reason);
			}
			return retired;
		};
		if (!eligible()) return retire();
		if (attempt) attempt.phase = "processing";
		if (this.store?.state.recordIds.has(item.id)) {
			console.warn(`[Subject:Mailbox] 队列条目 ID ${item.id} 已在历史记录中，跳过并退役`);
			if (attempt) await retire();
			else if (this.store.state.queued.has(item.id)) await this.storeEvent("queue_restored", eventData(item));
			await this.settleInput(item, { outcome: "retired", reason: "already_recorded" });
			return retired;
		}
		const render = this.deferredInputRenders.get(item.id);
		if (render) {
			let rendered: string | null;
			try {
				rendered = await render();
			} catch (error) {
				if (attempt) attempt.error = error;
				throw error;
			}
			if (!eligible()) return retire();
			if (!rendered?.trim()) {
				if (attempt) await retire();
				else await this.storeEvent("queue_restored", eventData(item));
				await this.settleInput(item, { outcome: "retired", reason: "empty_render" });
				return retired;
			}
			item = { ...item, text: rendered.trim() };
		} else if (!item.text.trim()) {
			// 空正文只可能是受理时靠 render 过关的延迟输入：闭包已随重启丢失，无内容可提交，诚实退役。
			console.warn(`[Subject:Mailbox] 队列条目 ${item.id} 的延迟渲染函数已丢失，安全退役`);
			if (this.store?.state.queued.has(item.id)) {
				if (attempt) await retire();
				else await this.storeEvent("queue_restored", eventData(item));
			}
			await this.settleInput(item, { outcome: "retired", reason: "missing_render" });
			return retired;
		}
		if (!eligible()) return retire();
		if (attempt) attempt.phase = "appending";
		try {
			const append = this.store?.appendInput(item) ?? Promise.resolve();
			if (attempt) attempt.append = append;
			await append;
		} catch (error) {
			if (attempt) attempt.error = error;
			throw error;
		}
		const message = projectInputMessage(item);
		if (message) this.history.push(message);
		await this.settleInput(item, { outcome: "committed" });
		return { committed: true, chars: item.text.length };
	}

	private async storeEvent(
		event: Parameters<SessionStore["appendEvent"]>[0],
		data: Record<string, unknown>,
	): Promise<void> {
		await this.store?.appendEvent(event, data);
	}

	private notifyQueueChanged(): void {
		this.dispatch({ type: "queue", items: this.queues.all() });
	}

	private reportError(error: unknown): void {
		this.dispatch({ type: "error", text: errorMessage(error) });
	}

	private completeActiveRun(): void {
		if (this.pendingRewind) {
			const id = this.pendingRewind.requestId;
			this.pendingRewind = undefined;
			this.reportError(`回溯请求 ${id} 未提交：活动已结束`);
		}
		const settle = this.settleActiveRun;
		this.settleActiveRun = undefined;
		this.activeRun = undefined;
		settle?.();
	}

	private currentSignal(): AbortSignal {
		if (!this.abort) throw new Error("当前没有活动轮次");
		return this.abort.signal;
	}

	private async emitInterrupted(partial = "", thinking = "", thinkingSignature?: string): Promise<void> {
		if (partial.trim() || thinking.trim() || thinkingSignature) {
			await this.appendMessage(
				this.buildAssistantMessage({ reply: partial, thinking, thinkingSignature }, { status: "aborted" }),
			);
		}
		await this.storeEvent("turn_aborted", { turnId: this.turnSeq });
		const delivery = this.dispatch({ type: "turn_aborted", turnNumber: this.turnSeq });
		if (delivery) void delivery.catch((error) => this.reportError(error));
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function eventData(value: object): Record<string, unknown> {
	return { ...value };
}

function isOutputEvent(event: RuntimeEvent): event is OutputEvent {
	return (
		event.type === "output_start" ||
		event.type === "output_update" ||
		event.type === "output_end" ||
		event.type === "output_interrupted"
	);
}
