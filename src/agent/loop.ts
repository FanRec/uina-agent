import type {
	AgentMessage,
	ChatMsg,
	CompletedToolCall,
	ContextSegments,
	FinishReason,
	DeliveryMode,
	Model,
	ModelStreamFn,
	ThinkingLevel,
	ToolResultStatus,
	Usage,
} from "../core/types.js";
import type { SessionStore } from "../session/types.js";
import { projectInputMessage } from "../session/recovery.js";
import { compactHistory, DEFAULT_COMPACTION_SETTINGS, type CompactionSettings, defaultPrepareNextTurn, findKeepFrom, type PrepareNextTurnContext, type PrepareNextTurnResult } from "./compaction.js";
import { buildContext, calculateContextSegments, convertToLlm, defaultSystemPrompt, estimateContextTokens } from "./context.js";
import { InputQueues, type QueuedMessage } from "./queue.js";
import type { PreparedToolCall, ToolView } from "../tools/broker.js";
import type { RuntimeHooks } from "../runtime/hooks.js";
import type { OutputEvent, RuntimeEvent } from "../runtime/events.js";
import { NO_RUNTIME_HOOKS } from "../runtime/noop.js";
import { guardRuntimeHooks } from "../runtime/guard.js";


export interface SubjectOptions {
	store?: SessionStore;
	compaction?: Partial<CompactionSettings>;
	prepareNextTurn?: (ctx: PrepareNextTurnContext) => Promise<PrepareNextTurnResult | null>;
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

export interface AgentInput {
	id: string;
	mode: "steer" | "followUp";
	source: { kind: "user" | "runtime" | "agent"; type: string; ref?: string };
	text?: string;
	data?: unknown;
}

export class Subject {
	private activity: "turn" | "compact" | undefined;
	private history: AgentMessage[] = [];
	private turnSeq = 0;
	private interrupted = false;
	private abort: AbortController | null = null;
	private readonly queues = new InputQueues();
	private readonly systemPrompt: string;
	private readonly compaction: CompactionSettings;
	private readonly store?: SessionStore;
	private activeRun?: Promise<void>;
	private settleActiveRun?: () => void;
	private resumingQueue = false;
	private readonly queueModes: Record<"steer" | "followUp", import("../core/types.js").QueueMode>;
	private model: Model;
	private readonly streamFn: ModelStreamFn;
	private thinkingLevel: ThinkingLevel;
	private preferredThinkingLevel: ThinkingLevel;
	private readonly runtimeHooks: RuntimeHooks;
	private readonly prepareNextTurnSeam: (ctx: PrepareNextTurnContext) => Promise<PrepareNextTurnResult | null>;
	private lastReportedUsage: Usage | null = null;
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
		this.prepareNextTurnSeam = options.prepareNextTurn ?? ((ctx) => defaultPrepareNextTurn(ctx, (input) => this.runtimeHooks.turn.beforeCompact(input)));
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
		return estimateContextTokens(this.history).tokens;
	}

	getContextSegments(usedTokens?: number): ContextSegments {
		const context = buildContext({ history: this.history, systemPrompt: this.systemPrompt });
		const used = usedTokens ?? this.lastReportedUsage?.totalTokens ?? estimateContextTokens(this.history).tokens;
		return calculateContextSegments(context, this.tools.defs(), used);
	}

	async setModel(model: Model): Promise<void> {
		const prev = this.model.name;
		this.model = model;
		this.compaction.contextWindow = model.contextWindow;
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
		this.activeRun = new Promise<void>(resolve => { this.settleActiveRun = resolve; });
		try {
			const keepFrom = findKeepFrom(this.history, this.compaction.keepRecentTokens, true);
			if (keepFrom <= 0) {
				await this.runtimeHooks.events.emit({
					type: "session_compact_failed",
					error: "当前会话消息过短，无需压缩",
				});
				return;
			}
			const tokensBefore = Math.ceil(this.history.reduce((acc, m) => acc + m.content.length + 16, 0) / 4);
			const compactDecision = await this.runtimeHooks.turn.beforeCompact({ tokensBefore });
			if (compactDecision.cancel) {
				await this.runtimeHooks.events.emit({
					type: "session_compact_failed",
					error: "会话压缩已被扩展取消",
				});
				return;
			}

			const result = await compactHistory(
				this.history,
				this.model,
				this.streamFn,
				this.systemPrompt,
				this.tools.defs(),
				{ ...this.compaction, contextWindow: 0, reserveTokens: 0 },
				this.runtimeHooks.provider,
				this.abort?.signal,
				this.model.includeThinking,
				instruction,
				true,
			);
			if (!result) {
				await this.runtimeHooks.events.emit({
					type: "session_compact_failed",
					error: "当前会话消息过短，无需压缩",
				});
				return;
			}
			this.abort?.signal.throwIfAborted();
			const replacement: AgentMessage[] = [
				{ role: "compactionSummary", summary: result.summary, content: `[历史摘要] ${result.summary}`, tokensBefore: result.tokensBefore },
				...result.retainedTail,
			];
			await this.store?.appendCompaction(result.summary, result.retainedTail, result.tokensBefore);
			this.history = replacement;

			await this.runtimeHooks.events.emit({
				type: "session_compact",
				summary: result.summary,
				tokensBefore: result.tokensBefore,
				retainedTailCount: result.retainedTail.length,
			});
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
			} finally { this.completeActiveRun(); }
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
		if (!input.id || !input.text?.trim()) return Promise.reject(new Error("AgentInput 必须包含 id 和 text"));
		const queued: QueuedMessage = { ...this.queues.create(input.text.trim(), input.mode, { source: input.source, data: input.data }), id: input.id };
		if (!this.isBusy() && this.queues.size === 0) {
			const promptText = queued.source?.kind === "runtime" ? undefined : queued.text;
			return this.startRun(promptText, queued, { needsEnqueueEvent: true });
		}
		return this.storeEvent("queue_enqueued", { ...eventData(queued), source: input.source, data: input.data }).then(async () => {
			this.queues.add(queued);
			this.notifyQueueChanged();
			if (!this.isBusy()) await this.resumeQueued();
		});
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

	private async startRun(text?: string, queuedInput?: QueuedMessage, options: { needsEnqueueEvent?: boolean } = {}): Promise<void> {
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
				await this.storeEvent("queue_enqueued", { ...eventData(queuedInput), source: queuedInput.source, data: queuedInput.data });
			}
			this.activity = "turn";
			this.interrupted = false;
			this.abort = new AbortController();
			const turn = ++this.turnSeq;

			const prepared = await this.runtimeHooks.turn.prepare({ prompt: text ?? "", systemPrompt: this.systemPrompt });
			await this.runtimeHooks.events.emit({ type: "agent_start", turnSeq: turn });

			await this.runTurn(text, turn, this.model, prepared.systemPrompt ?? this.systemPrompt, prepared.messages ? [...prepared.messages] : [], queuedInput);
		} catch (error) {
			this.abort = null;
			this.activity = undefined;
			this.reportError(error);
		} finally {
			if (isRootRun) this.completeActiveRun();
		}
	}

	private async runTurn(text: string | undefined, turn: number, model = this.model, systemPrompt = this.systemPrompt, beforeMessages: readonly (AgentMessage | ChatMsg)[] = [], queuedInput?: QueuedMessage): Promise<void> {
		let success = false;
		let runError: string | undefined;
		try {
			await this.dispatch({ type: "turn_start", turnNumber: turn, userText: text ?? "" });
			if (queuedInput) await this.consumeQueueItem(queuedInput);
			else if (text !== undefined) await this.appendMessage({ role: "user", content: text, timestamp: new Date().toISOString() });
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
				this.lastReportedUsage = null;
			}
			await this.dispatch({ type: "agent_end", turnSeq: turn, success, error: runError });
			if (success && !this.interrupted && this.queues.size > 0) {
				try { await this.resumeQueued(); } catch (error) { this.reportError(error); }
			} else if (this.queues.size === 0) {
				await this.dispatch({ type: "agent_settled", turnSeq: turn });
			}
			await this.runtimeHooks.events.flush();
		}
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

	private async decide(model = this.model, systemPrompt = this.systemPrompt, beforeMessages: readonly (AgentMessage | ChatMsg)[] = []): Promise<void> {
		await this.prepareTurn(model, systemPrompt);
		for (;;) {
			if (this.interrupted) {
				await this.emitInterrupted();
				return;
			}

			let requestMessages = [...buildContext({
				history: this.history,
				systemPrompt,
				includeThinking: model.includeThinking,
			}), ...convertToLlm(beforeMessages)];
			requestMessages = await this.runtimeHooks.turn.transformContext(requestMessages);

			const toolCalls: CompletedToolCall[] = [];
			let reply = "";
			let thinking = "";
			let thinkingSignature: string | undefined;
			let usage: Usage | undefined;
			let providerReplay: import("../core/types.js").ProviderReplay | undefined;
			let finishReason: FinishReason | null = null;
			this.lastReportedUsage = null;

			const streamId = `stream-${this.turnSeq}-${++this.streamSeq}`;
			let textOffset = 0;
			let thinkingOffset = 0;
			let hasEmittedContentStart = false;
			let hasEmittedThinkingStart = false;
			const closeOutput = (outcome: "end" | "interrupted", reason?: "cancelled" | "error"): void => {
				if (hasEmittedThinkingStart) {
					this.dispatch(
						outcome === "end"
							? { type: "output_end", streamId, channel: "thinking" }
							: { type: "output_interrupted", streamId, channel: "thinking", reason: reason! },
					);
					hasEmittedThinkingStart = false;
				}
				if (hasEmittedContentStart) {
					this.dispatch(
						outcome === "end"
							? { type: "output_end", streamId, channel: "content" }
							: { type: "output_interrupted", streamId, channel: "content", reason: reason!, spokenUntil: textOffset },
					);
					hasEmittedContentStart = false;
				}
			};

			try {
				await this.streamFn(
					model,
					{
						messages: requestMessages,
						tools: this.tools.defs(),
						thinkingLevel: clampThinkingLevel(this.thinkingLevel, model.thinkingLevels),
						providerHooks: this.runtimeHooks.provider,
					},
					(delta) => {
						if (finishReason && delta.kind !== "usage") throw new Error("模型 finish 后仍返回输出事件");
						if (delta.kind === "provider_replay") {
							providerReplay = structuredClone(delta.replay);
						} else if (delta.kind === "thinking") {
							thinking += delta.text;
							if (!hasEmittedThinkingStart) {
								hasEmittedThinkingStart = true;
								this.dispatch({ type: "output_start", streamId, channel: "thinking" });
							}
							thinkingOffset += delta.text.length;
							this.dispatch({
								type: "output_update",
								streamId,
								offset: thinkingOffset,
								channel: "thinking",
								text: delta.text,
							});
						} else if (delta.kind === "thinking_signature") {
							thinkingSignature = delta.signature;
						} else if (delta.kind === "text") {
							reply += delta.text;
							if (!hasEmittedContentStart) {
								hasEmittedContentStart = true;
								this.dispatch({ type: "output_start", streamId, channel: "content" });
							}
							textOffset += delta.text.length;
							this.dispatch({
								type: "output_update",
								streamId,
								offset: textOffset,
								channel: "content",
								text: delta.text,
							});
						} else if (delta.kind === "usage") {
							usage = delta.usage;
							this.lastReportedUsage = delta.usage;
						} else if (delta.kind === "tool_call") {
							const parsedArgs = parseToolArgs(delta.call.args);
							toolCalls.push({
								id: delta.call.id,
								name: delta.call.name,
								args: parsedArgs.value,
								argsValid: delta.call.argsValid !== false && parsedArgs.valid,
								...(delta.call.thinkingSignature ? { thinkingSignature: delta.call.thinkingSignature } : {}),
							});
						} else if (!finishReason) {
							finishReason = delta.reason;
						}
					},
					this.currentSignal(),
				);

			} catch (error) {
				closeOutput("interrupted", this.interrupted || this.currentSignal().aborted ? "cancelled" : "error");
				if (this.interrupted || this.currentSignal().aborted) {
					await this.emitInterrupted(reply, thinking, thinkingSignature);
					return;
				}
				if (reply.trim() || thinking.trim() || thinkingSignature) {
					await this.appendMessage({
						role: "assistant",
						content: reply,
						thinking: thinking || undefined,
						thinkingSignature,
						providerReplay,
						status: "error",
						usage,
					});
				}
				throw error;
			}

			if (this.interrupted || this.currentSignal().aborted) {
				closeOutput("interrupted", "cancelled");
				await this.emitInterrupted(reply, thinking, thinkingSignature);
				return;
			}
			if (!finishReason) {
				closeOutput("interrupted", "error");
				throw new Error(`模型返回未知或缺失 finish reason: ${finishReason ?? "none"}`);
			}
			if (finishReason === "tool_calls" && toolCalls.length === 0) {
				closeOutput("interrupted", "error");
				throw new Error("模型声明了 tool_calls，但没有返回工具调用");
			}
			closeOutput("end");
			if (finishReason !== "tool_calls") {
				if (reply.trim() || toolCalls.length > 0) {
					await this.appendMessage({
						role: "assistant",
						content: reply,
						thinking: thinking || undefined,
						thinkingSignature,
						providerReplay,
						...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
						status: finishReason === "length" ? "length" : "complete", usage,
					});
					for (const call of toolCalls) {
						await this.appendMessage({
							role: "tool",
							tool_call_id: call.id,
							content: JSON.stringify({ error: "工具调用未执行（模型没有以 tool_calls 终止）", status: "not_started" }),
							status: "not_started",
						});
					}
				}
				const steer = this.queues.peekMany("steer", this.queueModes.steer);
				if (steer.length > 0) {
					for (const item of steer) await this.consumeQueueItem(item);
					continue;
				}
				const followUp = this.queues.peekMany("followUp", this.queueModes.followUp);
				if (followUp.length > 0) {
					for (const item of followUp) await this.consumeQueueItem(item);
					continue;
				}
				this.notifyQueueChanged();
				return;
			}

			const assistant: AgentMessage = {
				role: "assistant",
				content: reply,
				thinking: thinking || undefined,
				thinkingSignature,
				providerReplay,
				tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
				status: finishReason === "length" ? "length" : "complete",
				usage,
				timestamp: new Date().toISOString(),
			};
			await this.appendMessage(assistant);
			const results = await this.executeToolCalls(toolCalls);
			for (const result of results) {
				await this.appendMessage({
					role: "tool",
					tool_call_id: result.callId,
					content: result.result,
					status: result.status,
					timestamp: new Date().toISOString(),
				});
			}
			if (this.interrupted || this.currentSignal().aborted) {
				await this.emitInterrupted("", "", undefined);
				return;
			}
			if (results.some(result => result.continuation === "stop")) return;
			const steer = this.queues.peekMany("steer", this.queueModes.steer);
			if (steer.length > 0) {
				for (const item of steer) await this.consumeQueueItem(item);
			}
		}
	}

	private async executeToolCalls(calls: CompletedToolCall[]): Promise<Array<{
		callId: string;
		result: string;
		status: ToolResultStatus;
		continuation?: "stop";
	}>> {
		const prepared: Array<{ call: CompletedToolCall; tool: PreparedToolCall }> = [];
		for (const call of calls) {
			const args = isRecord(call.args) ? call.args : {};
			const tool = call.argsValid === false
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

	private async executeOne(call: CompletedToolCall, prepared: PreparedToolCall): Promise<{
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
							status: outcome.status,
							callId: call.id,
						});
					},
				},
			},
		);
	}

	private async prepareTurn(model = this.model, systemPrompt = this.systemPrompt): Promise<void> {
		if (!this.prepareNextTurnSeam) return;
		try {
			const prepResult = await this.prepareNextTurnSeam({
				turnNumber: this.turnSeq,
				history: this.history,
				model,
				stream: this.streamFn,
				systemPrompt,
				tools: this.tools.defs(),
				compaction: this.compaction,
				providerHooks: this.runtimeHooks.provider,
				signal: this.abort?.signal,
			});
			if (!prepResult) return;
			if (prepResult.compaction) {
				await this.store?.appendCompaction(
					prepResult.compaction.summary,
					prepResult.compaction.retainedTail,
					prepResult.compaction.tokensBefore,
				);
				await this.runtimeHooks.events.emit({
					type: "session_compact",
					summary: prepResult.compaction.summary,
					tokensBefore: prepResult.compaction.tokensBefore,
					retainedTailCount: prepResult.compaction.retainedTail.length,
				});
			}
			if (prepResult.history) {
				this.history = prepResult.history as AgentMessage[];
			}
		} catch (err) {
			await this.runtimeHooks.events.emit({
				type: "session_compact_failed",
				error: (err as Error).message,
			});
			throw err;
		}
	}

	private async appendMessage(message: AgentMessage): Promise<void> {
		await this.store?.appendMessage(message);
		this.history.push(message);
	}

	/** Adds trusted extension content to both v2 persistence and the next provider context. */
	async appendCustomMessage(message: { customType: string; content: string; display?: boolean; details?: unknown }): Promise<void> {
		if (this.activity === "compact") throw new Error("压缩期间不能修改模型历史");
		await this.store?.appendCustomMessage(message);
		this.history.push({
			role: "custom",
			customType: message.customType,
			content: message.content,
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

	private async storeEvent(event: Parameters<SessionStore["appendEvent"]>[0], data: Record<string, unknown>): Promise<void> {
		await this.store?.appendEvent(event, data);
	}

	private notifyQueueChanged(): void {
		this.dispatch({ type: "queue", items: this.queues.all() });
	}

	private reportError(error: unknown): void {
		this.dispatch({ type: "error", text: safeError(error) });
	}

	private completeActiveRun(): void {
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

function parseToolArgs(text: string): { value: unknown; valid: boolean } {
	try {
		const value = JSON.parse(text || "{}");
		return {
			value,
			valid: !!value && typeof value === "object" && !Array.isArray(value),
		};
	} catch {
		return { value: {}, valid: false };
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
