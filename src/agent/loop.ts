import { randomUUID } from "node:crypto";
import { listSessionNodes, readSessionNode, listSessionBranches, readSessionBranch } from "../session/navigation.js";
import { isSafeRewindTarget, projectAgentHistory, protectRewindContext, recoverRecords } from "../session/recovery.js";
import type { SessionAccess, RewindRequest, RewindResult, SessionRewindRecord } from "../session/types.js";
import { validImages } from "../core/content.js";
import type { Compactor, CompactionTrigger } from "../core/compaction.js";
import { readonlySnapshot } from "../runtime/guard.js";
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
import { clearRetainedUsage, compactHistory, DEFAULT_COMPACTION_SETTINGS, type CompactionSettings, findCutPoint, shouldCompact } from "./compaction.js";
import { buildContext, calculateContextSegments, convertToLlm, defaultSystemPrompt, estimateContextTokens } from "./context.js";
import { InputQueues, type QueuedMessage } from "./queue.js";
import { TurnStreamCollector, type StreamCollectorResult } from "./stream-collector.js";
import type { PreparedToolCall, ToolView } from "../tools/broker.js";
import type { RuntimeHooks } from "../runtime/hooks.js";
import type { OutputEvent, RuntimeEvent } from "../runtime/events.js";
import { NO_RUNTIME_HOOKS } from "../runtime/noop.js";
import { guardRuntimeHooks } from "../runtime/guard.js";


export interface SubjectOptions {
	store?: SessionStore;
	compaction?: Partial<CompactionSettings>;
	compactor?: Compactor;
 compactionTrigger?: CompactionTrigger;
	systemPrompt?: string;
	thinkingLevel?: ThinkingLevel;
	steerQueueMode?: import("../core/types.js").QueueMode;
	followUpQueueMode?: import("../core/types.js").QueueMode;
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

/** One wording for every way an oversized rewind is refused; the mainline never moves in these cases. */
const OVERSIZED_REWIND = "回溯后的上下文估算超过模型上限；主线未改变，请选择其他目标或纠错方式";

export interface AgentInput {
	id: string;
	mode: "steer" | "followUp";
	source: { kind: "user" | "runtime" | "agent"; type: string; ref?: string };
	text?: string;
 images?: import("../core/content.js").ImageContent[];
	data?: unknown;
}

export class Subject {
	private activity: "turn" | "compact" | "rewind" | undefined;
	private compactionActive = false;
	private history: AgentMessage[] = [];
	private turnSeq = 0;
	private interrupted = false;
	private abort: AbortController | null = null;
	private readonly queues = new InputQueues();
	private readonly systemPrompt: string;
	private readonly compaction: CompactionSettings;
	private readonly store?: SessionStore;
	private pendingRewind?: { request: RewindRequest; source: string; requestId: string; signal?: AbortSignal };
	private rewindCommitting = false;
	readonly session: SessionAccess = {
		list: options => {
			if (!this.store) throw new Error("未配置会话存储，会话查询不可用");
			return listSessionNodes(this.store.readRecords(), options);
		},
		listBranches: () => {
			if (!this.store) throw new Error("未配置会话存储，会话查询不可用");
			return listSessionBranches(this.store.readRecords());
		},
		readBranch: id => {
			if (!this.store) throw new Error("未配置会话存储，会话查询不可用");
			return readSessionBranch(this.store.readRecords(), id);
		},
		read: id => {
			if (!this.store) throw new Error("未配置会话存储，会话查询不可用");
			return readSessionNode(this.store.readRecords(), id);
		},
		requestRewind: async (request, source, signal) => {
			if (!this.store) throw new Error("未配置会话存储，回溯不可用");
			return this.requestRewind(request, source, signal);
		},
	};
	private activeRun?: Promise<void>;
	private settleActiveRun?: () => void;
	private resumingQueue = false;
	private readonly queueModes: Record<"steer" | "followUp", import("../core/types.js").QueueMode>;
	private model: Model;
	private readonly streamFn: ModelStreamFn;
	private thinkingLevel: ThinkingLevel;
	private preferredThinkingLevel: ThinkingLevel;
	private readonly runtimeHooks: RuntimeHooks;
	private readonly compactor?: Compactor;
	private readonly compactionTrigger?: CompactionTrigger;
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
		this.compaction = {
			...DEFAULT_COMPACTION_SETTINGS,
			contextWindow: model.contextWindow,
			...options.compaction,
		};
		this.compactor = options.compactor;
		this.compactionTrigger = options.compactionTrigger;
		this.queueModes = {
			steer: options.steerQueueMode ?? "one-at-a-time",
			followUp: options.followUpQueueMode ?? "one-at-a-time",
		};
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

	/**
	 * 历史被整体替换（压缩 / 回溯）后必须调用：两个 usage 缓存都不再描述当前历史。
	 * 调用点必须排在广播之前 —— session_compact 的监听者会同步读 getUsedTokens()，
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
		return this.compaction.contextWindow;
	}

	getUsedTokens(): number {
		// 服务端报过的真实总量优先：它是权威事实，而 estimateContextTokens 是纯字符启发式。
		// 这个字段跨回合保留，所以底栏不会在回合结束时从真实值跌回估算值。
		const reported = this.lastKnownUsage?.totalTokens;
		return reported !== undefined ? reported : estimateContextTokens(this.history).tokens;
	}

	getContextSegments(usedTokens?: number): ContextSegments {
		const context = buildContext({ history: this.history, systemPrompt: this.systemPrompt });
		const used = usedTokens ?? this.lastKnownUsage?.totalTokens ?? estimateContextTokens(this.history).tokens;
		return calculateContextSegments(context, this.tools.defs(), used);
	}

	async setModel(model: Model): Promise<void> {
		const prev = this.model.name;
		this.model = model;
		this.compaction.contextWindow = model.contextWindow;
		// 口径换了（窗口与 thinking 层级都属于新模型）：旧模型报的真实总量不再描述
		// 当前上下文。锚有两处 —— Subject 缓存（forgetUsage）与最后一条 assistant
		// 消息上的 usage（estimateContextTokens 会从历史重新锚定回来）；只清前者，
		// 底栏数字纹丝不动。与压缩时 clearRetainedUsage 清锚是同一纪律的两个入口。
		this.forgetUsage();
		if (this.history.length > 0) {
			const last = this.history[this.history.length - 1];
			if (last?.role === "assistant" && last.usage) {
				const { usage: _dropped, ...rest } = last;
				this.history[this.history.length - 1] = { ...rest } as typeof last;
			}
		}
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

	async compact(instruction?: string): Promise<void> {
		if (this.isBusy()) throw new Error("Agent 正在运行中，无法手动压缩会话");
		let completed = false;
		this.activity = "compact";
		this.interrupted = false;
		this.abort = new AbortController();
		this.activeRun = new Promise<void>((resolve) => {
			this.settleActiveRun = resolve;
		});
		try {
			await this.performCompaction("manual", instruction);
			completed = true;
		} catch (err) {
			await this.runtimeHooks.events.emit({
				type: "session_compact_failed",
				error: (err as Error).message,
			});
			throw err;
		} finally {
			this.activity = undefined;
			this.abort = null;
			try {
				if (completed && !this.interrupted && this.queues.size > 0) await this.resumeQueued();
				await this.runtimeHooks.events.flush();
			} finally {
				this.completeActiveRun();
			}
		}
	}

	private async requestRewind(request: RewindRequest, source: string, signal?: AbortSignal): Promise<RewindResult> {
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
		if (this.pendingRewind || this.rewindCommitting || this.activity === "compact" || this.activity === "rewind") {
			throw new Error("已有会话转换正在处理");
		}
		const entries = recoverRecords([...this.store.readRecords()], false).entries;
		const index = entries.findIndex((entry) => entry.id === request.targetId);
		if (index < 0 || index === entries.length - 1 || !isSafeRewindTarget(entries, index)) {
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
				const prepared = await this.runtimeHooks.turn.prepare(
					{ prompt: "", systemPrompt: this.systemPrompt },
					this.currentSignal(),
				);
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
			this.reportError(`回溯请求 ${pending.requestId} 未提交: ${safeError(error)}`);
			return false;
		}
	}

	private async commitRewind(pending: NonNullable<Subject["pendingRewind"]>): Promise<string> {
		this.rewindCommitting = true;
		let committed = false;
		try {
			pending.signal?.throwIfAborted();
			this.currentSignal().throwIfAborted();
			if (!this.store) {
				throw new Error("未配置会话存储，回溯不可用");
			}
			const records = [...this.store.readRecords()];
			const entries = recoverRecords(records, false).entries;
			const fromId = entries.at(-1)?.id;
			if (!fromId) {
				throw new Error("会话没有可回溯历史");
			}
			const record: SessionRewindRecord = {
				...pending.request,
				kind: "rewind",
				id: randomUUID(),
				requestId: pending.requestId,
				source: pending.source,
				fromId,
				seq: (records.at(-1)?.seq ?? 0) + 1,
				timestamp: new Date().toISOString(),
			};
			const next = recoverRecords([...records, record]);
			// The projection stays derived from records; an oversized rewind is compacted before it is
			// persisted so a committed rewind never leaves an unusable context behind.
			const history = projectAgentHistory(next.entries);
			const estimated = estimateContextTokens(
				buildContext({ history, systemPrompt: this.systemPrompt }),
				{ tools: this.tools.defs(), includeThinking: this.model.includeThinking },
			).tokens;
			const compacted = await this.compactProjectionForRewind(history, estimated, pending.signal);

			pending.signal?.throwIfAborted();
			this.currentSignal().throwIfAborted();
			// Persist rewind and its optional compaction as one durable transition.
			const finalRecord = compacted ? { ...record, compaction: compacted } : record;
			const finalState = recoverRecords([...records, finalRecord]);
			const finalHistory = projectAgentHistory(finalState.entries);
			await this.store.appendRewind(finalRecord);
			committed = true;
			this.history = finalHistory;
			// 历史刚被替换：先失效 usage 缓存，再广播。
			this.forgetUsage();
			if (compacted) {
				await this.runtimeHooks.events.emit({
					type: "session_compact",
					summary: compacted.summary,
					tokensBefore: compacted.tokensBefore,
					retainedTailCount: compacted.retainedTail.length,
				});
			}
			await this.dispatch({
				type: "session_rewind",
				turnNumber: this.activity === "turn" ? this.turnSeq : undefined,
				requestId: pending.requestId,
				rewindId: record.id,
				fromId,
				targetId: record.targetId,
			});
			return record.id;
		} catch (error) {
			throw new Error(
				`回溯请求 ${pending.requestId} ${committed ? "已提交，但通知失败" : "未提交"}: ${safeError(error)}`,
				{ cause: error },
			);
		} finally {
			this.rewindCommitting = false;
		}
	}

	pushInput(text: string, options: QueueInputOptions = {}): Promise<void> {
		const normalized = text.trim();
		if (!normalized) return Promise.resolve();
		const mode = options.mode ?? (this.isBusy() ? "steer" : "direct");
		if (mode === "direct" && !this.isBusy() && this.queues.size === 0) {
			return this.startRun(normalized);
		}
		const queued = this.queues.create(normalized, mode === "direct" ? "followUp" : mode);
		const persisted = this.storeEvent("queue_enqueued", eventData(queued));
		return persisted.then(async () => {
			this.queues.add(queued);
			this.notifyQueueChanged();
			if (!this.isBusy() && mode === "direct") await this.resumeQueued();
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

	/** Removes queued inputs and returns them in original arrival order for UI editing. */
	async takeQueuedForEditor(): Promise<QueuedMessage[]> {
		const items = this.queues.all();
		for (const item of items) {
			await this.storeEvent("queue_restored", eventData(item));
			this.queues.remove(item.id);
		}
		this.notifyQueueChanged();
		return items;
	}

	/** Removes the latest queued input and returns it for UI editing. */
	async takeLastQueuedForEditor(): Promise<QueuedMessage | null> {
		const items = this.queues.all();
		if (items.length === 0) return null;
		const last = items[items.length - 1]!;
		await this.storeEvent("queue_restored", eventData(last));
		this.queues.remove(last.id);
		this.notifyQueueChanged();
		return last;
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
			if (this.model.thinkingLevels && !this.model.thinkingLevels.includes(this.thinkingLevel)) {
				this.reportError(new Error(`model ${this.model.name} 不支持 thinking level: ${this.thinkingLevel}`));
				return;
			}
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

			const prepared = await this.runtimeHooks.turn.prepare(
				{ prompt: text ?? "", systemPrompt: this.systemPrompt },
				this.abort.signal,
			);
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
			runError = safeError(error);
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
				const estimate = estimateContextTokens(this.history);
				const last = this.lastReportedUsage;
				const used = last?.totalTokens ?? estimate.tokens;
				const segments = this.getContextSegments(used);
				const usage = {
					usedTokens: used,
					contextWindow: this.getContextWindow(),
					actual: last?.totalTokens !== undefined || estimate.actual,
					cacheRead: last?.cacheRead,
					cacheWrite: last?.cacheWrite,
					inputTokens: last?.input,
					outputTokens: last?.output,
					segments,
				};
				await this.dispatch({
					type: "turn_end",
					turnNumber: turn,
					usage,
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

	private async decide(
		model = this.model,
		systemPrompt = this.systemPrompt,
		beforeMessages: readonly (AgentMessage | ChatMsg)[] = [],
	): Promise<void> {
		const applyRewind = async (): Promise<boolean> => {
			if (!await this.applyPendingRewind()) return false;
			const prepared = await this.runtimeHooks.turn.prepare(
				{ prompt: "", systemPrompt: this.systemPrompt },
				this.currentSignal(),
			);
			systemPrompt = prepared.systemPrompt ?? this.systemPrompt;
			beforeMessages = prepared.messages ? [...prepared.messages] : [];
			return true;
		};
		// A scheduled rewind commits before turn preparation, so compaction always measures the
		// mainline that is about to be sent — never a projection the rewind is about to replace.
		await applyRewind();
		for (;;) {
			if (this.interrupted) {
				await this.emitInterrupted();
				return;
			}

			await applyRewind();
			// 每步体检（对齐 dsh between-step pressure）：回合内工具输出能让上下文暴涨，
			// 只在回合边界查一次会一路涨到越界，压缩请求本身就成了超大请求。
			await this.prepareTurn(model, systemPrompt);
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
				if (await this.drainQueuedInputs("steer")) continue;
				if (await this.drainQueuedInputs("followUp")) continue;
				this.notifyQueueChanged();
				return;
			}

			const { stopped } = await this.settleToolExchange(streamResult);
			if (this.interrupted || this.currentSignal().aborted) {
				await this.emitInterrupted("", "", undefined);
				return;
			}
			if (await applyRewind()) continue;
			if (stopped) return;
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
			}),
			...convertToLlm(beforeMessages),
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
		for (const item of items) {
			await this.consumeQueueItem(item);
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

	private async prepareTurn(model = this.model, systemPrompt = this.systemPrompt): Promise<void> {
		try {
			await this.performCompaction("automatic", undefined, model, systemPrompt);
		} catch (error) {
			await this.runtimeHooks.events.emit({ type: "session_compact_failed", error: String(error) });
			throw error;
		}
	}

	private async performCompaction(
		reason: "manual" | "automatic",
		instruction?: string,
		model = this.model,
		systemPrompt = this.systemPrompt,
	): Promise<void> {
		const manual = reason === "manual";
		const tokensBefore = estimateContextTokens(buildContext({ history: this.history, systemPrompt }), {
			tools: this.tools.defs(),
			includeThinking: model.includeThinking,
		}).tokens;
		const defaultDecision = shouldCompact(tokensBefore, this.compaction);
		if (
			!manual &&
			!(
				this.compactionTrigger?.(
					readonlySnapshot({ historyLength: this.history.length, tokensBefore, model, defaultDecision }),
				) ?? defaultDecision
			)
		)
			return;
		const cutPoint = findCutPoint(this.history, this.compaction.keepRecentTokens, manual);
		if (!this.history.length || (cutPoint.firstKeptEntryIndex <= 0 && !this.compactor)) {
			if (manual)
				await this.runtimeHooks.events.emit({ type: "session_compact_failed", error: "当前会话消息过短，无需压缩" });
			return;
		}
		this.compactionActive = true;
		try {
			const signal = this.currentSignal();
			const decision = await this.runtimeHooks.turn.beforeCompact({ tokensBefore });
			if (decision.cancel) {
				if (manual)
					await this.runtimeHooks.events.emit({ type: "session_compact_failed", error: "会话压缩已被扩展取消" });
				return;
			}
			const request = readonlySnapshot({
				reason,
				history: this.history,
				suggestedKeepFrom: cutPoint.firstKeptEntryIndex,
				tokensBefore,
				model,
				instruction,
			});
			const proposal = await this.compactor?.(request as import("../core/compaction.js").CompactionRequest, signal);
			signal.throwIfAborted();
			let result: import("./compaction.js").CompactionResult | null;
			if (proposal !== undefined) {
				const { summary, keepFrom } = proposal;
				if (typeof summary !== "string" || !summary.trim()) throw new Error("compaction 返回空摘要");
				// A cut that keeps the whole history compacts nothing; accepting it would persist a
				// summary plus the very messages it summarizes, growing the context it was meant to shrink.
				if (!Number.isInteger(keepFrom) || keepFrom <= 0 || keepFrom >= this.history.length) throw new Error("compaction 保留位置无效");
				if (this.history[keepFrom]?.role === "tool") throw new Error("compaction 不能切断工具调用与结果");
				result = { summary: summary.trim(), retainedTail: clearRetainedUsage(this.history.slice(keepFrom)), tokensBefore };
			} else {
				result = await compactHistory(
					this.history,
					model,
					this.streamFn,
					{ cut: cutPoint, tokensBefore, instruction },
					this.runtimeHooks.provider,
					signal,
				);
			}
			if (!result) return;
			signal.throwIfAborted();
			await this.store?.appendCompaction(result.summary, result.retainedTail, result.tokensBefore);
			this.history = protectRewindContext([
				{
					role: "compactionSummary",
					summary: result.summary,
					content: "[历史摘要] " + result.summary,
					tokensBefore: result.tokensBefore,
				},
				...result.retainedTail,
			], this.store ? recoverRecords([...this.store.readRecords()]).entries : []);
			// 历史换成摘要 + 尾巴：先失效 usage 缓存，再广播。
			this.forgetUsage();
			await this.runtimeHooks.events.emit({
				type: "session_compact",
				summary: result.summary,
				tokensBefore: result.tokensBefore,
				retainedTailCount: result.retainedTail.length,
			});
		} finally {
			this.compactionActive = false;
		}
	}

	/**
	 * A rewind can re-expose history that was already compacted away, so the projected main line is
	 * measured before it is persisted. Returns a fitting compaction, or null when the projection
	 * already fits the model window; throws when compaction cannot bring it back under the window.
	 */
	private async compactProjectionForRewind(
		history: AgentMessage[],
		estimated: number,
		signal?: AbortSignal,
	): Promise<import("./compaction.js").CompactionResult | null> {
		const contextWindow = this.model.contextWindow;
		if (contextWindow === undefined || estimated <= contextWindow) return null;
		const cutPoint = findCutPoint(history, this.compaction.keepRecentTokens, false);
		if (cutPoint.firstKeptEntryIndex <= 0) throw new Error(OVERSIZED_REWIND);
		const compactionSignal = signal ?? this.currentSignal();
		const proposal = await this.compactor?.(
			{
				reason: "automatic",
				history,
				suggestedKeepFrom: cutPoint.firstKeptEntryIndex,
				tokensBefore: estimated,
				model: this.model,
				instruction: "由于回溯使历史重新展开导致上下文超限，请压缩前期历史",
			},
			compactionSignal,
		);
		let prepared: import("./compaction.js").CompactionResult | null;
		if (proposal !== undefined) {
			const keepFrom = proposal.keepFrom;
			if (typeof proposal.summary !== "string" || !proposal.summary.trim()) throw new Error("compaction 返回空摘要");
			if (!Number.isInteger(keepFrom) || keepFrom <= 0 || keepFrom >= history.length) throw new Error("compaction 保留位置无效");
			if (history[keepFrom]?.role === "tool") throw new Error("compaction 不能切断工具调用与结果");
			prepared = { summary: proposal.summary.trim(), retainedTail: clearRetainedUsage(history.slice(keepFrom)), tokensBefore: estimated };
		} else {
			prepared = await compactHistory(
				history,
				this.model,
				this.streamFn,
				{ cut: cutPoint, tokensBefore: estimated },
				this.runtimeHooks.provider,
				compactionSignal,
			);
		}
		if (!prepared) throw new Error(OVERSIZED_REWIND);
		compactionSignal.throwIfAborted();
		const after = estimateContextTokens(
			buildContext({
				history: [
					{
						role: "compactionSummary",
						summary: prepared.summary,
						content: "[历史摘要] " + prepared.summary,
						tokensBefore: prepared.tokensBefore,
					},
					...prepared.retainedTail,
				],
				systemPrompt: this.systemPrompt,
			}),
			{ tools: this.tools.defs(), includeThinking: this.model.includeThinking },
		).tokens;
		if (after > contextWindow) {
			throw new Error(
				`${OVERSIZED_REWIND}：压缩后仍约 ${after} tokens，模型上限 ${contextWindow}`,
			);
		}
		return prepared;
	}

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
		if (this.compactionActive || this.activity === "compact") throw new Error("压缩期间不能修改模型历史");
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
	}

	async appendCustomEntry(entry: { customType: string; data?: unknown }): Promise<void> {
		await this.store?.appendCustomEntry(entry);
	}

	private async consumeQueueItem(item: QueuedMessage): Promise<void> {
		await this.store?.appendInput(item);
		const message = projectInputMessage(item);
		if (message) this.history.push(message);
		this.queues.remove(item.id);
		this.notifyQueueChanged();
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
		this.dispatch({ type: "error", text: safeError(error) });
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

function safeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
