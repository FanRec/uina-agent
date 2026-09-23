import { randomUUID } from "node:crypto";
import { errorMessage } from "../core/errors.js";
import type { RewindRequest, RewindResult } from "../session/types.js";
import { validImages } from "../core/content.js";
import type {
	AgentMessage,
	ChatMsg,
	CompletedToolCall,
	ContextSnapshot,
	DeliveryMode,
	Model,
	ModelStreamFn,
	RequestProjection,
	RequestInspection,
	RequestUsage,
	TokenMeasurement,
	ThinkingLevel,
	ToolResultStatus,
	Usage,
} from "../core/types.js";
import { inputTokenBudget, modelKey } from "../core/model.js";
import type { SessionStore } from "../session/types.js";
import { projectInputMessage } from "../session/recovery.js";
import { commitRewindTransition } from "./rewind.js";
import { requestToolDefs, resolveProjectionPolicy, type ProjectionPolicy, type ResolvedProjection } from "./projection.js";
import { buildContext, defaultSystemPrompt, measureRequestContext } from "./context.js";
import { InputQueues, type QueuedMessage } from "./queue.js";
import { TurnStreamCollector, type StreamCollectorResult } from "./stream-collector.js";
import type { PreparedToolCall, ToolView } from "../tools/broker.js";
import type { RuntimeHooks } from "../runtime/hooks.js";
import type { OutputEvent, RuntimeEvent } from "../runtime/events.js";
import { NO_RUNTIME_HOOKS } from "../runtime/noop.js";
import { guardRuntimeHooks, immutableProjection } from "../runtime/guard.js";


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

export function clampThinkingLevel(
	requested: ThinkingLevel,
	available?: readonly ThinkingLevel[],
): ThinkingLevel {
	if (!available || available.length === 0) return "off";
	if (available.includes(requested)) return requested;
	return available[0]!;
}

export interface QueueInputOptions {
	mode?: DeliveryMode;
 source?: import("../core/types.js").InputSource;
}

export interface AgentInput {
	id: string;
	mode: "steer" | "followUp";
	source: import("../core/types.js").InputSource;
 receivedAt?: string;
	text?: string;
	images?: import("../core/content.js").ImageContent[];
	data?: unknown;
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

export class Subject {
	private activity: "turn" | "rewind" | undefined;
	private history: AgentMessage[] = [];
	private turnSeq = 0;
	private interrupted = false;
	private abort: AbortController | null = null;
	private readonly queues = new InputQueues();
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
	 * 单次模型调用的真实 usage 到达时立即上报，让底栏不必等 turn_end。
	 *
	 * 这里是唯一的写入点，所以历史 usage 与它派发出的 usage_update 永远同源：
	 * pi.usage()/turn_end 与实时刷新看到的是同一个事实。
	 */
	private publishUsage(usage: Usage, callId: string, projection: RequestProjection, callSeq: number): void {
		const requestUsage: RequestUsage = {
			callId,
			projectionId: projection.projectionId,
			modelKey: projection.modelKey,
			promptTokens: usage.input,
			outputTokens: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
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
		const measurement = measureRequestContext(projection, this.measureContext ? (value) => this.measureContext!(model, value) : undefined);
		return { projection, measurement, contextWindow: model.contextWindow, inputBudget: inputTokenBudget(model, projection.thinkingLevel) };
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

		await this.runtimeHooks.events.emit({
			type: "model_select",
			model: model.name,
			previousModel: prev,
		});

		if (this.thinkingLevel !== prevLevel) {
			await this.runtimeHooks.events.emit({
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
			await this.runtimeHooks.events.emit({
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

	pushInput(text: string, options: QueueInputOptions = {}): Promise<void> {
		const normalized = text.trim();
		if (!normalized) return Promise.resolve();
		const busy = this.isBusy();
		// 投递模式规则唯一归属（P2-C）：显式 steer/followUp 原样入队；direct 空闲
		// 即开跑；忙时语义化升级为 steer（下一请求注入，与 submitText 规则一致），
		// 不再静默降级 followUp；空闲但有排队时随队保序（followUp）并立即消化。
		const mode = options.mode ?? (busy ? "steer" : "direct");
		if (mode === "direct") {
			if (busy) return this.enqueueQueued(normalized, "steer", false, options.source);
			if (this.queues.size > 0) return this.enqueueQueued(normalized, "followUp", true, options.source);
			const queued = this.queues.create(normalized, "followUp", { source: options.source });
			this.publishInputAccepted(queued);
			return this.startRun(normalized, queued, { needsEnqueueEvent: true });
		}
		return this.enqueueQueued(normalized, mode, false, options.source);
	}

	/** 输入受理的唯一入口：队列入队、直接开跑、accept 都经此发布 input_accepted。 */
	private publishInputAccepted(queued: QueuedMessage): void {
		this.dispatch({
			type: "input_accepted",
			inputId: queued.id,
			...(queued.source ? { source: queued.source } : {}),
			receivedAt: queued.receivedAt ?? new Date().toISOString(),
		});
	}

	/** 队列入队的单一持久化路径：storeEvent → 内存队列 → 通知 → 可选空闲消化。 */
	private enqueueQueued(text: string, mode: "steer" | "followUp", resumeIfIdle: boolean, source?: import("../core/types.js").InputSource): Promise<void> {
		const queued = this.queues.create(text, mode, { source });
		const persisted = this.storeEvent("queue_enqueued", eventData(queued));
		return persisted.then(async () => {
			this.queues.add(queued);
			this.publishInputAccepted(queued);
			this.notifyQueueChanged();
			if (resumeIfIdle && !this.isBusy()) await this.resumeQueued();
		});
	}

	/** 瞬态世界快照的 runtime 输入类型：同一内容由 tail 相位帧每请求注入，
	 * 历史里再多一份副本纯属冗余（viewport-event-frame-refactor.md:29 "不落 Session 历史"）。
	 * 客户端侧重复投递从此无害：accept 直接丢弃，不进队列、不落史、不启动回合。 */
	private static readonly TRANSIENT_SNAPSHOT_TYPES = new Set(["app-viewport", "embodiment-state"]);

	accept(input: AgentInput): Promise<void> {
		if (!validImages(input.images)) return Promise.reject(new Error("图片内容无效"));
		if (input.source?.kind === "runtime" && input.source.type !== undefined && Subject.TRANSIENT_SNAPSHOT_TYPES.has(input.source.type)) {
			// 瞬态世界快照：tail 帧已在请求层提供最新一份，历史副本被丢弃。
			return Promise.resolve();
		}
		if (!input.id || !input.text?.trim()) return Promise.reject(new Error("AgentInput 必须包含 id 和 text"));
		const queued: QueuedMessage = {
			...this.queues.create(input.text.trim(), input.mode, {
				source: input.source,
                ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
				data: input.data,
				images: input.images,
			}),
			id: input.id,
		};
		if (!this.isBusy() && this.queues.size === 0) {
			const promptText = queued.source?.kind === "runtime" ? undefined : queued.text;
			this.publishInputAccepted(queued);
			return this.startRun(promptText, queued, { needsEnqueueEvent: true });
		}
		return this.storeEvent("queue_enqueued", { ...queued }).then(
			async () => {
				this.queues.add(queued);
				this.publishInputAccepted(queued);
				this.notifyQueueChanged();
				if (!this.isBusy()) await this.resumeQueued();
			},
		);
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
		this.interrupted = true;
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

	addHistory(messages: readonly (AgentMessage | ChatMsg)[]): void {
		if (this.isBusy()) throw new Error("活动期间不能替换历史");
		// 仅补进程内事件 id。journal 回放使用条目 id，不把这里的随机 id 写成事实。
		this.history.push(...messages.map((m) => {
			const hasId = "id" in m && Boolean((m as { id?: string }).id);
			const hasInput = "input" in m && Boolean((m as { input?: unknown }).input);
			if (m.role === "user" && !hasId && !hasInput) return { ...structuredClone(m as AgentMessage), id: randomUUID() };
			return structuredClone(m as AgentMessage);
		}));
	}

	seedQueue(items: readonly QueuedMessage[]): void {
		this.queues.seed(items);
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
				await this.storeEvent("queue_restored", eventData(item));
				claimed.push(item);
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
			await this.storeEvent("queue_restored", { ...claimed });
		} catch (error) {
			this.queues.add(claimed);
			this.notifyQueueChanged();
			throw error;
		}
		this.notifyQueueChanged();
		return claimed;
	}

	private async startRun(
		text?: string,
		queuedInput?: QueuedMessage,
		options: { needsEnqueueEvent?: boolean } = {},
	): Promise<void> {
		if (this.activity) return Promise.reject(new Error("已有活动轮次"));
		const isRootRun = this.activeRun === undefined;
		if (isRootRun) {
			this.activeRun = new Promise<void>((resolve) => {
				this.settleActiveRun = resolve;
			});
		}

		try {
		if (queuedInput && options.needsEnqueueEvent) {
				await this.storeEvent("queue_enqueued", {
					...queuedInput,
					source: queuedInput.source,
					data: queuedInput.data,
				});
			}
			this.activity = "turn";
			this.interrupted = false;
			this.abort = new AbortController();
			const turn = ++this.turnSeq;
			if (queuedInput) {
				// Claim ownership synchronously before the first await; the item must leave the
				// queue before prepare/emits so it can neither be restored to the editor nor re-consumed.
				this.queues.remove(queuedInput.id);
				this.notifyQueueChanged();
			}

			const prepared = await this.runtimeHooks.turn.prepare({ prompt: text ?? "", systemPrompt: this.systemPrompt });
			await this.applyPreparedRuntime(prepared);
			await this.runtimeHooks.events.emit({ type: "agent_start", turnSeq: turn });

			await this.runTurn(
				text,
				turn,
				this.model,
				prepared.systemPrompt ?? this.systemPrompt,
				prepared.messages ? [...prepared.messages] : [],
				queuedInput,
			);
		} catch (error) {
			this.abort = null;
			this.activity = undefined;
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
	): Promise<void> {
		let success = false;
		let runError: string | undefined;
		let currentTurn = turn;
		// afterEnd 的 post-turn signal：回合结算前捕获（finally 会先置空 this.abort）。
		const turnSignal = this.currentSignal();
		try {
			await this.dispatch({ type: "turn_start", turnNumber: currentTurn, userText: text ?? "", images: queuedInput?.images });
			if (queuedInput) await this.consumeQueueItem(queuedInput);
			else if (text !== undefined)
				await this.appendMessage({ role: "user", content: text, timestamp: new Date().toISOString() });
			const outcome = await this.decide(model, systemPrompt, beforeMessages, (nextTurn) => {
				currentTurn = nextTurn;
			}, () => currentTurn);
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
			runError = errorMessage(error);
			if (this.interrupted || this.currentSignal().aborted) {
				await this.emitInterrupted();
			} else {
				await this.storeEvent("turn_failed", { turnId: currentTurn, error: runError });
				this.reportError(runError);
			}
		} finally {
			if (this.pendingRewind && (!success || this.interrupted)) {
				const requestId = this.pendingRewind.requestId; this.pendingRewind = undefined;
				this.reportError(`回溯请求 ${requestId} 未提交：回合失败或被取消，主线保持不变`);
			}
			this.abort = null;
			this.activity = undefined;
			try {
				await this.dispatch({
					type: "turn_end",
					turnNumber: currentTurn,
					requestUsage: this.currentCallUsage ? structuredClone(this.currentCallUsage) : undefined,
				});
			} catch (error) {
				this.reportError(error);
			}
			await this.dispatch({ type: "agent_end", turnSeq: currentTurn, success, error: runError });
			if (success && !this.interrupted && this.pendingRewind) {
				await this.applyPendingRewind();
			}
			try {
				await this.runtimeHooks.turn.afterEnd({ turnNumber: currentTurn, success, ...(runError ? { error: runError } : {}), signal: turnSignal });
			} catch (error) {
				this.reportError(error);
			}
			try {
				await this.getContextSnapshot("idle_baseline");
			} catch (error) {
				this.reportError(error);
			}
			if (success && !this.interrupted && this.queues.size > 0) {
				try {
					await this.resumeQueued();
				} catch (error) {
					this.reportError(error);
				}
			} else if (this.queues.size === 0) {
				await this.dispatch({ type: "agent_settled", turnSeq: currentTurn });
			}
			await this.runtimeHooks.events.flush();
		}
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
		const item = this.queues.peek("steer") ?? this.queues.peek("followUp");
		if (!item) return;
		this.resumingQueue = false;
		await this.startRun(item.source?.kind === "runtime" ? undefined : item.text, item);
	}

	/** Applies runtime-provided model/thinking facts at a run-safety point.
	 * Model swaps reuse setModel's full discipline (usage-anchor invalidation +
	 * model_select broadcast); thinking swaps clamp against the current model. */
	private async applyPreparedRuntime(
		prepared: Readonly<{ model?: Model; thinkingLevel?: ThinkingLevel }>,
	): Promise<void> {
		if (prepared.model && !(prepared.model.id === this.model.id && prepared.model.providerId === this.model.providerId)) {
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
			if (!await this.applyPendingRewind()) return false;
			const prepared = await this.runtimeHooks.turn.prepare({ prompt: "", systemPrompt: this.systemPrompt });
			await this.applyPreparedRuntime(prepared);
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
			const callId = `stream-${this.turnSeq}-${++this.streamSeq}`;
			const callSeq = this.streamSeq;
			const collector = new TurnStreamCollector(
				callId,
				(event) => this.dispatch(event),
				{
					onUsage: (usage) => void this.publishUsage(usage, callId, projection, callSeq),
					onRetry: (event) => this.dispatch(event.kind === "provider_retry"
					? { type: "provider_retry", provider: model.providerId, ...event }
					: { type: "provider_recovered", provider: model.providerId, attempt: event.attempt }),
				},
			);
			this.currentCallUsage = undefined;

			try {
				await this.streamFn(
					model,
					{
						messages: [...projection.messages],
						tools: [...projection.tools],
						thinkingLevel: projection.thinkingLevel,
						providerHooks: this.runtimeHooks.provider,
					},
					(delta) => collector.handleDelta(delta),
					this.currentSignal(),
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
				console.warn(`[Subject:decide] 提示：本回合已处理工具调用 ${processedToolCalls} 次（上限 ${this.maxConsecutiveToolCalls}）`);
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
			await this.drainQueuedInputs("steer", onTurnTransition, getCurrentTurn);
		}
	}

	private async prepareProjectionForSend(
		model: Model,
		systemPrompt: string,
		beforeMessages: readonly (AgentMessage | ChatMsg)[],
		turnSignal: AbortSignal,
	): Promise<RequestProjection> {
		for (let pass = 0; pass <= 1; pass++) {
			const projection = await this.prepareProjection(model, systemPrompt, beforeMessages, true);
			const measurement = measureRequestContext(projection, this.measureContext ? (p) => this.measureContext!(model, p) : undefined);
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
			this.publishContextSnapshot(this.contextSnapshot({ projection, measurement, contextWindow: model.contextWindow, inputBudget: budget }, "active_request"));
			return projection;
		}
		throw new Error("请求准备失败");
	}

	private async prepareProjection(
		model: Model,
		systemPrompt: string,
		beforeMessages: readonly (AgentMessage | ChatMsg)[],
		runTransforms: boolean,
	): Promise<RequestProjection> {
		const built = [
			...buildContext({
				history: this.history,
				systemPrompt,
				includeThinking: model.includeThinking,
				convertToLlm: this.projection.convertToLlm,
			}),
			...this.projection.convertToLlm(beforeMessages),
		];
		const currentInputId = [...this.history].findLast((message) =>
			(message.role === "user" || message.role === "custom") && Boolean(message.id),
		)?.id;
		const messages = currentInputId
			? built.map((message) => message.context?.entryId === currentInputId
				? { ...message, context: { ...message.context, retain: true } }
				: message)
			: built;
		const base: RequestProjection = immutableProjection({
			projectionId: randomUUID(),
			modelKey: modelKey(model),
			messages,
			tools: this.declaredTools(),
			thinkingLevel: clampThinkingLevel(this.thinkingLevel, model.thinkingLevels),
		});
		if (!runTransforms) return base;
		const transformed = await this.runtimeHooks.turn.transformContext(base);
		if (transformed.projectionId !== base.projectionId || transformed.modelKey !== base.modelKey) {
			throw new Error("turn.transformContext 不得修改 projectionId 或 modelKey");
		}
		if (transformed.thinkingLevel !== undefined && transformed.thinkingLevel !== "off" && !model.thinkingLevels?.includes(transformed.thinkingLevel)) {
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
		if (result.reply.trim() || result.toolCalls.length > 0) {
			await this.appendMessage(this.buildAssistantMessage(result));
			for (const call of result.toolCalls) {
				await this.appendMessage({
					role: "tool",
					tool_call_id: call.id,
					content: JSON.stringify({ error: notExecutedReason ?? "工具调用未执行（模型没有以 tool_calls 终止）", status: "not_started" }),
					status: "not_started",
					timestamp: new Date().toISOString(),
				});
			}
		}
	}

	private async settleToolExchange(result: StreamCollectorResult): Promise<{ stopped: boolean }> {
		await this.appendMessage(this.buildAssistantMessage(result));
		const results = await this.executeToolCalls(result.toolCalls);
		for (const res of results) {
			// 阶段 D/M7：canonical journal 落原始执行正文（未经 transformResult 改写）；
			// 模型可见改写投影经后续请求的投影链生效，不进 canonical 历史。
			const evidence = res.canonical ?? res;
			await this.appendMessage({
				role: "tool",
				tool_call_id: res.callId,
				content: evidence.result,
				images: evidence.images,
				details: evidence.details,
				status: evidence.status,
				timestamp: new Date().toISOString(),
			});
		}
		return { stopped: results.some((res) => res.continuation === "stop") };
	}

	private async drainQueuedInputs(
		mode: "steer" | "followUp",
		onTurnTransition?: (nextTurn: number) => void,
		getCurrentTurn?: () => number,
	): Promise<boolean> {
		const items = this.queues.peekMany(mode);
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
				if (item.source?.kind !== "runtime") {
					const previousTurn = getCurrentTurn?.() ?? this.turnSeq;
					await this.dispatch({ type: "turn_end", turnNumber: previousTurn, requestUsage: this.currentCallUsage ? structuredClone(this.currentCallUsage) : undefined });
					const nextTurn = ++this.turnSeq;
					onTurnTransition?.(nextTurn);
					await this.dispatch({ type: "turn_start", turnNumber: nextTurn, userText: item.text, images: item.images });
					await this.consumeQueueItem(item);
				} else {
					await this.consumeQueueItem(item);
				}
			} catch (error) {
				// 某项持久化/消费失败时，将尚未处理的后续 items 全部恢复回队列，防止消息丢失
				for (let j = i + 1; j < items.length; j++) {
					this.queues.add(items[j]);
				}
				this.notifyQueueChanged();
				throw error;
			}
		}
		return true;
	}

	private async executeToolCalls(calls: CompletedToolCall[]): Promise<
		Array<{
			callId: string;
			result: string;
			status: ToolResultStatus;
			continuation?: "stop";
			images?: import("../core/content.js").ImageContent[];
			details?: unknown;
			/** 原始执行结果（阶段 D/M7）：canonical journal 落盘用，未经 transformResult 改写。 */
			canonical?: import("../tools/broker.js").ToolExecutionResult;
		}>
	> {
		const prepared: Array<{ call: CompletedToolCall; tool: PreparedToolCall }> = [];
		for (const call of calls) {
			const args = isRecord(call.args) ? call.args : {};
			const tool =
				this.projection.contextTools.some(t => t.function.name === call.name)
                    ? { name: call.name, args, error: "该名称仅用于解释上下文，不能主动执行" }
                : call.argsValid === false
					? { name: call.name, args, error: "工具参数 JSON 不完整，调用未执行" }
					: this.tools.prepare(call.name, args);
			prepared.push({ call, tool });
		}
		const sequential = prepared.some(({ call }) => this.tools.getExecutionMode(call.name) === "sequential");
		if (sequential) {
			const results = [];
			for (const item of prepared) results.push(await this.executeOne(item.call, item.tool));
			return results;
		}
		return Promise.all(prepared.map(({ call, tool }) => this.executeOne(call, tool)));
	}

	private async executeOne(
		call: CompletedToolCall,
		prepared: PreparedToolCall,
	): Promise<import("../tools/broker.js").ToolExecutionResult & { callId: string }> {
		const callArgs = (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>;
		// 在流水线启动前广播 tool_call，确保 UI 必定能收到工具调用声明并建立节点，
		// 消除后续 onDone 产生孤儿 tool_result 的异常
		this.dispatch({
			type: "tool_call",
			toolName: call.name,
			args: callArgs,
			callId: call.id,
		});
		return this.tools.executePipeline(
			{ callId: call.id, name: call.name, args: callArgs, prepared },
			{
				signal: this.currentSignal(),
				hooks: this.runtimeHooks.tools,
				observers: {
					onStart: async () => {
						await this.storeEvent("tool_started", {
							callId: call.id,
							name: call.name,
							args: call.args,
						});
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

	private async consumeQueueItem(item: QueuedMessage): Promise<void> {
		// Claim synchronously: once consumption begins the item can no longer be restored to the editor.
		this.queues.remove(item.id);
		this.notifyQueueChanged();
		try {
			await this.store?.appendInput(item);
		} catch (error) {
			// Commit failure means the input was never consumed; return ownership to the queue.
			this.queues.add(item);
			this.notifyQueueChanged();
			throw error;
		}
		const message = projectInputMessage(item);
		if (message) this.history.push(message);
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
			const id=this.pendingRewind.requestId;this.pendingRewind=undefined;
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
				this.buildAssistantMessage(
					{ reply: partial, thinking, thinkingSignature },
					{ status: "aborted" },
				),
			);
		}
		await this.storeEvent("turn_aborted", { turnId: this.turnSeq });
		this.dispatch({ type: "turn_aborted", turnNumber: this.turnSeq });
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
