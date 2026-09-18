import { randomUUID } from "node:crypto";
import { errorMessage } from "../core/errors.js";
import type { RewindRequest, RewindResult } from "../session/types.js";
import { validImages } from "../core/content.js";
import type {
	AgentMessage,
	ChatMsg,
	CompletedToolCall,
	ContextSegments,
	DeliveryMode,
	Model,
	ModelStreamFn,
	ThinkingLevel,
	ToolResultStatus,
	Usage,
} from "../core/types.js";
import type { SessionStore } from "../session/types.js";
import { projectInputMessage } from "../session/recovery.js";
import { commitRewindTransition } from "./rewind.js";
import { resolveProjectionPolicy, type ProjectionPolicy, type ResolvedProjection } from "./projection.js";
import { buildContext, calculateContextSegments, defaultSystemPrompt, estimateContextTokens } from "./context.js";
import { InputQueues, type QueuedMessage } from "./queue.js";
import { TurnStreamCollector, type StreamCollectorResult } from "./stream-collector.js";
import type { PreparedToolCall, ToolView } from "../tools/broker.js";
import type { RuntimeHooks } from "../runtime/hooks.js";
import type { OutputEvent, RuntimeEvent } from "../runtime/events.js";
import { NO_RUNTIME_HOOKS } from "../runtime/noop.js";
import { guardRuntimeHooks } from "../runtime/guard.js";


export interface SubjectOptions {
	store?: SessionStore;
	/** 投影 Replacement 缝（单 owner = 本 Subject 实例；缺省字段回落默认实现）。 */
	projection?: ProjectionPolicy;
	systemPrompt?: string;
	thinkingLevel?: ThinkingLevel;
	runtimeHooks?: RuntimeHooks;
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
}

export interface AgentInput {
	id: string;
	mode: "steer" | "followUp";
	source: { kind: "user" | "runtime" | "agent"; type: string; ref?: string };
	text?: string;
 images?: import("../core/content.js").ImageContent[];
	data?: unknown;
}

export class Subject {
	private activity: "turn" | "rewind" | undefined;
	private history: AgentMessage[] = [];
	private turnSeq = 0;
	private interrupted = false;
	private abort: AbortController | null = null;
	private readonly queues = new InputQueues();
	private readonly systemPrompt: string;
	private readonly store?: SessionStore;
	private pendingRewind?: { request: RewindRequest; source: string; requestId: string; signal?: AbortSignal };
	private rewindCommitting = false;
	private activeRun?: Promise<void>;
	private settleActiveRun?: () => void;
	private resumingQueue = false;
	private readonly queueModes: Record<"steer" | "followUp", import("../core/types.js").QueueMode> = {
		steer: "one-at-a-time",
		followUp: "one-at-a-time",
	};
	private model: Model;
	private readonly streamFn: ModelStreamFn;
	private thinkingLevel: ThinkingLevel;
	private preferredThinkingLevel: ThinkingLevel;
	private readonly runtimeHooks: RuntimeHooks;
	/** 投影 Replacement 缝的现役实现（解析后两字段非空；本实例即单 owner）。 */
	readonly projection: ResolvedProjection;
	/** 本次模型调用拿到的 usage；每次调用开始前清空，只对本次调用有意义。 */
	private lastReportedUsage: Usage | null = null;
	/**
	 * 最后一次拿到的真实用量，跨回合保留。
	 *
	 * `lastReportedUsage` 会在回合结束时清空（它的语义是"本次调用"），但底栏要的是"最后已知
	 * 的真实上下文占用"，不该因为一次回合结束就退回字符估算。只有历史真的被替换（压缩、
	 * 回溯）时它才失效——那时旧值不再描述任何东西。
	 */
	private lastKnownUsage: Usage | null = null;
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
	 * 这里是唯一的写入点，所以 `lastReportedUsage` 与它派发出的 usage_update 永远同源：
	 * getUsedTokens()/turn_end 与实时刷新看到的是同一个数。
	 */
	private publishUsage(usage: Usage, callId: string): void {
		this.lastReportedUsage = usage;
		this.lastKnownUsage = usage;
		const used = usage.totalTokens ?? estimateContextTokens(this.history).tokens;
		void this.dispatch({
			type: "usage_update",
			callId,
			usedTokens: used,
			contextWindow: this.getContextWindow(),
			actual: usage.totalTokens !== undefined,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			inputTokens: usage.input,
			outputTokens: usage.output,
			segments: this.getContextSegments(used),
		});
	}

	/** turn_end 与配对终态事件共用的用量快照：真实测量优先，缺锚回退字符估算。 */
	private buildUsageSnapshot() {
		const estimate = estimateContextTokens(this.history);
		const last = this.lastReportedUsage;
		const used = last?.totalTokens ?? estimate.tokens;
		return {
			usedTokens: used,
			contextWindow: this.getContextWindow(),
			actual: last?.totalTokens !== undefined || estimate.actual,
			cacheRead: last?.cacheRead,
			cacheWrite: last?.cacheWrite,
			inputTokens: last?.input,
			outputTokens: last?.output,
			segments: this.getContextSegments(used),
		};
	}

	/**
	 * 当前 model 的计量口径失效（setModel），或 canonical history 被真正替换
	 * （回溯提交）时清除：两个 usage 缓存都不再描述当前事实。
	 * 调用点必须排在广播之前 —— 回溯事件的监听者会同步读 getUsedTokens()，
	 * 清晚了它拿到的还是替换前的旧真值（底栏数字不动、只多一个 ~）。
	 */
	private forgetUsage(): void {
		this.lastReportedUsage = null;
		this.lastKnownUsage = null;
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

	getUsedTokens(): number {
		// 服务端报过的真实总量优先：它是权威事实，而 estimateContextTokens 是纯字符启发式。
		// 这个字段跨回合保留，所以底栏不会在回合结束时从真实值跌回估算值。
		const reported = this.lastKnownUsage?.totalTokens;
		return reported !== undefined ? reported : estimateContextTokens(this.history).tokens;
	}

	getContextSegments(usedTokens?: number): ContextSegments {
		const context = buildContext({ history: this.history, systemPrompt: this.systemPrompt, convertToLlm: this.projection.convertToLlm });
		const used = usedTokens ?? this.lastKnownUsage?.totalTokens ?? estimateContextTokens(this.history).tokens;
		return calculateContextSegments(context, this.tools.defs(), used);
	}

	async setModel(model: Model): Promise<void> {
		const prev = this.model.name;
		this.model = model;
		// 口径换了（窗口与 thinking 层级都属于新模型）：历史里任何 assistant 消息上残留的
		// usage 都是旧模型报的绝对总量，estimateContextTokens 会从最后一条重新锚定 ——
		// 不只是末位那条（工具交换中途停手时它后面还跟着 tool 结果）。
		// 与压缩时 clearRetainedUsage 清锚是同一纪律：usage 锚随口径切换整体失效。
		this.forgetUsage();
		this.history = this.history.map((message) => {
			if (message.role !== "assistant" || !message.usage) return message;
			const { usage: _dropped, ...rest } = message;
			return { ...rest } as typeof message;
		});
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
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.preferredThinkingLevel = level;
		const prev = this.thinkingLevel;
		this.thinkingLevel = clampThinkingLevel(level, this.model.thinkingLevels);

		void this.runtimeHooks.events.emit({
			type: "thinking_level_select",
			level: this.thinkingLevel,
			previousLevel: prev,
		});
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
			(request.summary !== undefined && typeof request.summary !== "string")
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
			this.forgetUsage();
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
			if (busy) return this.enqueueQueued(normalized, "steer", false);
			if (this.queues.size > 0) return this.enqueueQueued(normalized, "followUp", true);
			return this.startRun(normalized);
		}
		return this.enqueueQueued(normalized, mode, false);
	}

	/** 队列入队的单一持久化路径：storeEvent → 内存队列 → 通知 → 可选空闲消化。 */
	private enqueueQueued(text: string, mode: "steer" | "followUp", resumeIfIdle: boolean): Promise<void> {
		const queued = this.queues.create(text, mode);
		const persisted = this.storeEvent("queue_enqueued", eventData(queued));
		return persisted.then(async () => {
			this.queues.add(queued);
			this.notifyQueueChanged();
			if (resumeIfIdle && !this.isBusy()) await this.resumeQueued();
		});
	}

	accept(input: AgentInput): Promise<void> {
		if (!validImages(input.images)) return Promise.reject(new Error("图片内容无效"));
		if (!input.id || !input.text?.trim()) return Promise.reject(new Error("AgentInput 必须包含 id 和 text"));
		const queued: QueuedMessage = {
			...this.queues.create(input.text.trim(), input.mode, {
				source: input.source,
				data: input.data,
				images: input.images,
			}),
			id: input.id,
		};
		if (!this.isBusy() && this.queues.size === 0) {
			const promptText = queued.source?.kind === "runtime" ? undefined : queued.text;
			return this.startRun(promptText, queued, { needsEnqueueEvent: true });
		}
		return this.storeEvent("queue_enqueued", { ...eventData(queued), source: input.source, data: input.data }).then(
			async () => {
				this.queues.add(queued);
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
		this.history.push(...messages.map((m) => structuredClone(m as AgentMessage)));
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
	 * Ownership is claimed synchronously before any await so concurrent queue consumption cannot see claimed items. */
	async claimAllQueued(): Promise<QueuedMessage[]> {
		const items = this.queues.takeAll();
		for (const item of items) {
			await this.storeEvent("queue_restored", eventData(item));
		}
		this.notifyQueueChanged();
		return items;
	}

	/** Claims one queued input by identity；不存在的身份返回 null（幂等领取）。 */
	async claimQueued(id: string): Promise<QueuedMessage | null> {
		const claimed = this.queues.remove(id);
		if (!claimed) return null;
		await this.storeEvent("queue_restored", eventData(claimed));
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
					...eventData(queuedInput),
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
		try {
			await this.dispatch({ type: "turn_start", turnNumber: turn, userText: text ?? "", images: queuedInput?.images });
			if (queuedInput) await this.consumeQueueItem(queuedInput);
			else if (text !== undefined)
				await this.appendMessage({ role: "user", content: text, timestamp: new Date().toISOString() });
			await this.decide(model, systemPrompt, beforeMessages);
			success = true;
		} catch (error) {
			runError = errorMessage(error);
			if (this.interrupted || this.currentSignal().aborted) {
				await this.emitInterrupted();
			} else {
				await this.storeEvent("turn_failed", { turnId: turn, error: runError });
				this.reportError(runError);
			}
		} finally {
			if (this.pendingRewind) {
				const requestId = this.pendingRewind.requestId; this.pendingRewind = undefined;
				this.reportError(`回溯请求 ${requestId} 未提交：回合失败或被取消，主线保持不变`);
			}
			this.abort = null;
			this.activity = undefined;
			try {
				await this.dispatch({
					type: "turn_end",
					turnNumber: turn,
					usage: this.buildUsageSnapshot(),
				});
			} catch (error) {
				this.reportError(error);
			} finally {
				// 只清"本次调用"的值；lastKnownUsage 留着，底栏不必退回估算。
				this.lastReportedUsage = null;
			}
			await this.dispatch({ type: "agent_end", turnSeq: turn, success, error: runError });
			if (success && !this.interrupted && this.queues.size > 0) {
				try {
					await this.resumeQueued();
				} catch (error) {
					this.reportError(error);
				}
			} else if (this.queues.size === 0) {
				await this.dispatch({ type: "agent_settled", turnSeq: turn });
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
	): Promise<void> {
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
		await applyRewind();
		for (;;) {
			if (this.interrupted) {
				await this.emitInterrupted();
				return;
			}

			await applyRewind();
			// 回合内暴涨由每请求的 transformContext 裁剪收敛（compaction capability
			// 拥有上下文窗口管理）——这里不再有 between-step 压缩体检。
			const requestMessages = await this.buildRequestMessages(model, systemPrompt, beforeMessages);

			const callId = `stream-${this.turnSeq}-${++this.streamSeq}`;
			const collector = new TurnStreamCollector(
				callId,
				(event) => this.dispatch(event),
				{ onUsage: (usage) => void this.publishUsage(usage, callId) },
			);
			this.lastReportedUsage = null;

			try {
				await this.streamFn(
					model,
					{
						messages: requestMessages,
						tools: this.tools.defs(),
						thinkingLevel: clampThinkingLevel(this.thinkingLevel, model.thinkingLevels),
						providerHooks: this.runtimeHooks.provider,
					},
					(delta) => collector.handleDelta(delta),
					this.currentSignal(),
				);
			} catch (error) {
				await this.handleStreamError(collector, error);
				return;
			}

			if (this.interrupted || this.currentSignal().aborted) {
				collector.closeOutput("interrupted", "cancelled");
				const partial = collector.getPartialOutput();
				await this.emitInterrupted(partial.reply, partial.thinking, partial.thinkingSignature);
				return;
			}

			const streamResult = collector.validateAndFinalize();

			if (streamResult.finishReason !== "tool_calls") {
				await this.recordTerminalAssistant(streamResult);
				if (await applyRewind()) continue;
				// steer/followUp 续跑不在这里内联消费：decide 的 model 参数是回合开始的快照，
				// 在此 drain 会让切模型/改思考档后的排队输入仍用旧口径（假切换）。
				// 交还 runTurn 收尾的 resumeQueued 链路 —— startRun 会重新取 this.model 快照。
				return;
			}

			const { stopped } = await this.settleToolExchange(streamResult);
			if (this.interrupted || this.currentSignal().aborted) {
				await this.emitInterrupted("", "", undefined);
				return;
			}
			if (await applyRewind()) continue;
			if (stopped) return;
			// 回合间停止决策（对应 Pi shouldStopAfterTurn）：任一扩展要求停止时立即收尾，
			// 不再发起下一次模型调用。仅作用于本运行内的续跑；队列恢复语义不变。
			const stopDecision = await this.runtimeHooks.turn.shouldStop({
				turnNumber: this.turnSeq,
				finishReason: streamResult.finishReason,
				reply: streamResult.reply,
				toolCallCount: streamResult.toolCalls.length,
			});
			if (stopDecision.stop) return;
			await this.drainQueuedInputs("steer");
		}
	}

	private async buildRequestMessages(
		model: Model,
		systemPrompt: string,
		beforeMessages: readonly (AgentMessage | ChatMsg)[],
	) {
		const requestMessages = [
			...buildContext({
				history: this.history,
				systemPrompt,
				includeThinking: model.includeThinking,
				convertToLlm: this.projection.convertToLlm,
			}),
			...this.projection.convertToLlm(beforeMessages),
		];
		return this.runtimeHooks.turn.transformContext(requestMessages);
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
			await this.appendMessage({
				role: "assistant",
				content: partial.reply,
				thinking: partial.thinking || undefined,
				thinkingSignature: partial.thinkingSignature,
				providerReplay: partial.providerReplay,
				status: "error",
				usage: partial.usage,
			});
		}
		throw error;
	}

	private async recordTerminalAssistant(result: StreamCollectorResult): Promise<void> {
		if (result.reply.trim() || result.toolCalls.length > 0) {
			await this.appendMessage({
				role: "assistant",
				content: result.reply,
				thinking: result.thinking || undefined,
				thinkingSignature: result.thinkingSignature,
				providerReplay: result.providerReplay,
				...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
				status: result.finishReason === "length" ? "length" : "complete",
				usage: result.usage,
			});
			for (const call of result.toolCalls) {
				await this.appendMessage({
					role: "tool",
					tool_call_id: call.id,
					content: JSON.stringify({ error: "工具调用未执行（模型没有以 tool_calls 终止）", status: "not_started" }),
					status: "not_started",
				});
			}
		}
	}

	private async settleToolExchange(result: StreamCollectorResult): Promise<{ stopped: boolean }> {
		const assistant: AgentMessage = {
			role: "assistant",
			content: result.reply,
			thinking: result.thinking || undefined,
			thinkingSignature: result.thinkingSignature,
			providerReplay: result.providerReplay,
			tool_calls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
			status: result.finishReason === "length" ? "length" : "complete",
			usage: result.usage,
			timestamp: new Date().toISOString(),
		};
		await this.appendMessage(assistant);
		const results = await this.executeToolCalls(result.toolCalls);
		for (const res of results) {
			await this.appendMessage({
				role: "tool",
				tool_call_id: res.callId,
				content: res.result,
				images: res.images,
				details: res.details,
				status: res.status,
				timestamp: new Date().toISOString(),
			});
		}
		return { stopped: results.some((res) => res.continuation === "stop") };
	}

	private async drainQueuedInputs(mode: "steer" | "followUp"): Promise<boolean> {
		const items = this.queues.peekMany(mode, this.queueModes[mode]);
		if (items.length === 0) return false;
		// Claim all items synchronously before the first await so none of them can be
		// restored to the editor while a previous item is being persisted.
		for (const item of items) {
			this.queues.remove(item.id);
		}
		this.notifyQueueChanged();
		for (const item of items) {
			// 用户输入的排队项被消费时开一个可见回合（与首条消费路径的 turn_start 对齐）：
			// 否则 TUI 只收到 queue 事件清空待办区，transcript 没有任何它被采纳的痕迹。
			// runtime 来源项投影为 display:false 的 custom 消息，不开可见回合。
			if (item.source?.kind !== "runtime") {
				const itemTurn = ++this.turnSeq;
				await this.dispatch({ type: "turn_start", turnNumber: itemTurn, userText: item.text, images: item.images });
				await this.consumeQueueItem(item);
				// turn_start/turn_end 按 turnNumber 严格一一配对：runTurn 收尾只携带最初
				// 回合号，中途消费的可见回合必须自带终态事件，否则 trajectory /
				// transcript 的 turn 号口径漂移。
				await this.dispatch({ type: "turn_end", turnNumber: itemTurn, usage: this.buildUsageSnapshot() });
			} else {
				await this.consumeQueueItem(item);
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
		}>
	> {
		const prepared: Array<{ call: CompletedToolCall; tool: PreparedToolCall }> = [];
		for (const call of calls) {
			const args = isRecord(call.args) ? call.args : {};
			const tool =
				call.argsValid === false
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
	): Promise<{
		callId: string;
		result: string;
		status: ToolResultStatus;
		continuation?: "stop";
	}> {
		const callArgs = (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>;
		return this.tools.executePipeline(
			{ callId: call.id, name: call.name, args: callArgs, prepared },
			{
				signal: this.currentSignal(),
				hooks: this.runtimeHooks.tools,
				observers: {
					onStart: async () => {
						this.dispatch({
							type: "tool_call",
							toolName: call.name,
							args: callArgs,
							callId: call.id,
						});
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
		await this.store?.appendMessage(message);
		this.history.push(message);
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
			await this.appendMessage({
				role: "assistant",
				content: partial,
				thinking: thinking || undefined,
				thinkingSignature,
				status: "aborted",
				timestamp: new Date().toISOString(),
			});
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
