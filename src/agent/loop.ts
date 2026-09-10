import type {
	AgentMessage,
	ChatMsg,
	CompletedToolCall,
	ContextSegments,
	FinishReason,
	DeliveryMode,
	ModelProvider,
	ThinkingLevel,
	ToolResultStatus,
	Usage,
} from "../core/types.js";
import type { SessionStore } from "../session/types.js";
import { projectInputMessage } from "../session/recovery.js";
import { compactHistory, DEFAULT_COMPACTION_SETTINGS, type CompactionSettings, defaultPrepareNextTurn, findKeepFrom, type PrepareNextTurnContext, type PrepareNextTurnResult } from "./compaction.js";
import { buildContext, calculateContextSegments, convertToLlm, defaultSystemPrompt, estimateContextTokens } from "./context.js";
import { InputQueues, type QueuedMessage } from "./queue.js";
import type { PreparedToolCall, ToolBroker } from "../tools/broker.js";
import type { RuntimeHooks } from "../runtime/hooks.js";
import { NO_RUNTIME_HOOKS } from "../runtime/noop.js";
import { guardRuntimeHooks } from "../runtime/guard.js";

export interface LoopHooks {
	onToken: (text: string) => void;
	onThinking?: (text: string) => void;
	onTurnStart?: (n: number, text: string) => void;
	onTurnEnd?: (
		n: number,
		usage?: {
			usedTokens: number;
			contextWindow?: number;
			actual: boolean;
			cacheRead?: number;
			cacheWrite?: number;
			inputTokens?: number;
			outputTokens?: number;
			segments?: ContextSegments;
		},
	) => void;
	onTurnAborted?: (turn: number) => void;
	onToolStart?: (name: string, args: unknown, callId?: string) => void;
	onToolDone?: (
		name: string,
		result: string,
		status?: ToolResultStatus,
		callId?: string,
	) => void;
	onError?: (msg: string) => void;
	onQueueChanged?: (items: readonly QueuedMessage[]) => void;
}

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
	private provider: ModelProvider;
	private thinkingLevel: ThinkingLevel;
	private preferredThinkingLevel: ThinkingLevel;
	private readonly runtimeHooks: RuntimeHooks;
	private readonly prepareNextTurnSeam: (ctx: PrepareNextTurnContext) => Promise<PrepareNextTurnResult | null>;
	private lastReportedUsage: Usage | null = null;
	private streamSeq = 0;

	constructor(
		provider: ModelProvider,
		private readonly tools: ToolBroker,
		private readonly hooks: LoopHooks,
		options: SubjectOptions = {},
	) {
		this.provider = provider;
		this.store = options.store;
		this.systemPrompt = options.systemPrompt ?? defaultSystemPrompt();
		this.compaction = {
			...DEFAULT_COMPACTION_SETTINGS,
			contextWindow: provider.contextWindow,
			...options.compaction,
		};
		this.prepareNextTurnSeam = options.prepareNextTurn ?? ((ctx) => defaultPrepareNextTurn(ctx, (input) => this.runtimeHooks.turn.beforeCompact(input)));
		this.queueModes = {
			steer: options.steerQueueMode ?? "one-at-a-time",
			followUp: options.followUpQueueMode ?? "one-at-a-time",
		};
		this.preferredThinkingLevel = options.thinkingLevel ?? provider.thinkingLevels?.[0] ?? "off";
		if (this.preferredThinkingLevel !== "off" && !provider.thinkingLevels?.includes(this.preferredThinkingLevel)) {
			throw new Error(`provider ${provider.name} 未声明支持 thinking level: ${this.preferredThinkingLevel}`);
		}
		this.thinkingLevel = this.preferredThinkingLevel;
		this.runtimeHooks = guardRuntimeHooks(options.runtimeHooks ?? NO_RUNTIME_HOOKS);
	}

	getModel(): ModelProvider {
		return this.provider;
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

	getContextSegments(): ContextSegments {
		const context = buildContext({ history: this.history, systemPrompt: this.systemPrompt });
		const used = this.lastReportedUsage?.totalTokens ?? estimateContextTokens(this.history).tokens;
		return calculateContextSegments(context, this.tools.defs(), used);
	}

	async setModel(provider: ModelProvider): Promise<void> {
		const prev = this.provider.name;
		this.provider = provider;
		this.compaction.contextWindow = provider.contextWindow;
		const prevLevel = this.thinkingLevel;
		this.thinkingLevel = clampThinkingLevel(this.preferredThinkingLevel, provider.thinkingLevels);

		await this.runtimeHooks.events.emit({
			type: "model_select",
			model: provider.name,
			provider,
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
		this.thinkingLevel = clampThinkingLevel(level, this.provider.thinkingLevels);

		void this.runtimeHooks.events.emit({
			type: "thinking_level_select",
			level: this.thinkingLevel,
			previousLevel: prev,
		});
	}

	cycleThinkingLevel(): ThinkingLevel {
		const levels: readonly ThinkingLevel[] = this.provider.thinkingLevels?.length ? this.provider.thinkingLevels : ["off"];
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
				this.provider,
				this.systemPrompt,
				this.tools.defs(),
				{ ...this.compaction, contextWindow: 0, reserveTokens: 0 },
				this.runtimeHooks.provider,
				this.abort?.signal,
				this.provider.includeThinking,
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
		const queued = this.queues.enqueue(normalized, mode === "direct" ? "followUp" : mode);
		this.notifyQueueChanged();
		const persisted = this.storeEvent("queue_enqueued", eventData(queued));
		if (!this.isBusy() && mode === "direct") return persisted.then(() => this.resumeQueued());
		return persisted;
	}

	accept(input: AgentInput): Promise<void> {
		if (!input.id || !input.text?.trim()) return Promise.reject(new Error("AgentInput 必须包含 id 和 text"));
		if (input.source.kind !== "runtime" && !this.isBusy() && this.queues.size === 0) return this.startRun(input.text.trim());
		const queued = { ...this.queues.create(input.text.trim(), input.mode, { source: input.source, data: input.data }), id: input.id };
		this.queues.add(queued);
		return this.storeEvent("queue_enqueued", { ...eventData(queued), source: input.source, data: input.data }).then(async () => {
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

	private async startRun(text?: string, queuedInput?: QueuedMessage): Promise<void> {
		if (this.activity) return Promise.reject(new Error("已有活动轮次"));
		const isRootRun = this.activeRun === undefined;
		if (isRootRun) {
			this.activeRun = new Promise<void>((resolve) => {
				this.settleActiveRun = resolve;
			});
		}

		try {
			if (this.provider.thinkingLevels && !this.provider.thinkingLevels.includes(this.thinkingLevel)) {
				this.reportError(new Error(`provider ${this.provider.name} 不支持 thinking level: ${this.thinkingLevel}`));
				return;
			}
			this.activity = "turn";
			this.interrupted = false;
			this.abort = new AbortController();
			const turn = ++this.turnSeq;

			const prepared = await this.runtimeHooks.turn.prepare({ prompt: text ?? "", systemPrompt: this.systemPrompt });
			await this.runtimeHooks.events.emit({ type: "agent_start", turnSeq: turn });

			await this.runTurn(text, turn, this.provider, prepared.systemPrompt ?? this.systemPrompt, prepared.messages ? [...prepared.messages] : [], queuedInput);
		} catch (error) {
			this.abort = null;
			this.activity = undefined;
			this.reportError(error);
		} finally {
			if (isRootRun) this.completeActiveRun();
		}
	}

	private async runTurn(text: string | undefined, turn: number, provider = this.provider, systemPrompt = this.systemPrompt, beforeMessages: readonly (AgentMessage | ChatMsg)[] = [], queuedInput?: QueuedMessage): Promise<void> {
		let success = false;
		let runError: string | undefined;
		try {
			this.hooks.onTurnStart?.(turn, text ?? "");
			await this.runtimeHooks.events.emit({ type: "turn_start", turnNumber: turn, userText: text ?? "" });
			if (queuedInput) await this.consumeQueueItem(queuedInput);
			else if (text !== undefined) await this.appendMessage({ role: "user", content: text, timestamp: new Date().toISOString() });
			await this.decide(provider, systemPrompt, beforeMessages);
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
				const segments = this.getContextSegments();
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
				this.hooks.onTurnEnd?.(turn, usage);
				await this.runtimeHooks.events.emit({
					type: "turn_end",
					turnNumber: turn,
					usage: { usedTokens: used, contextWindow: this.getContextWindow(), segments },
				});
			} catch (error) {
				try { this.hooks.onError?.(safeError(error)); } catch { /* hooks cannot own lifecycle */ }
			} finally {
				this.lastReportedUsage = null;
			}
			await this.runtimeHooks.events.emit({ type: "agent_end", turnSeq: turn, success, error: runError });
			if (success && !this.interrupted && this.queues.size > 0) {
				try { await this.resumeQueued(); } catch (error) { this.reportError(error); }
			} else if (this.queues.size === 0) {
				await this.runtimeHooks.events.emit({ type: "agent_settled", turnSeq: turn });
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

	private async decide(provider = this.provider, systemPrompt = this.systemPrompt, beforeMessages: readonly (AgentMessage | ChatMsg)[] = []): Promise<void> {
		await this.prepareTurn(provider, systemPrompt);
		for (;;) {
			if (this.interrupted) {
				await this.emitInterrupted();
				return;
			}

			let requestMessages = [...buildContext({
				history: this.history,
				systemPrompt,
				includeThinking: provider.includeThinking,
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
					this.runtimeHooks.events.observe(
						outcome === "end"
							? { type: "output_end", streamId, channel: "thinking" }
							: { type: "output_interrupted", streamId, channel: "thinking", reason: reason! },
					);
					hasEmittedThinkingStart = false;
				}
				if (hasEmittedContentStart) {
					this.runtimeHooks.events.observe(
						outcome === "end"
							? { type: "output_end", streamId, channel: "content" }
							: { type: "output_interrupted", streamId, channel: "content", reason: reason!, spokenUntil: textOffset },
					);
					hasEmittedContentStart = false;
				}
			};

			try {
				await provider.stream(
					{
						messages: requestMessages,
						tools: this.tools.defs(),
						thinkingLevel: clampThinkingLevel(this.thinkingLevel, provider.thinkingLevels),
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
								this.runtimeHooks.events.observe({ type: "output_start", streamId, channel: "thinking" });
							}
							thinkingOffset += delta.text.length;
							this.runtimeHooks.events.observe({
								type: "output_update",
								streamId,
								offset: thinkingOffset,
								channel: "thinking",
								text: delta.text,
							});
							try { this.hooks.onThinking?.(delta.text); } catch (error) { this.reportError(error); }
						} else if (delta.kind === "thinking_signature") {
							thinkingSignature = delta.signature;
						} else if (delta.kind === "text") {
							reply += delta.text;
							if (!hasEmittedContentStart) {
								hasEmittedContentStart = true;
								this.runtimeHooks.events.observe({ type: "output_start", streamId, channel: "content" });
							}
							textOffset += delta.text.length;
							this.runtimeHooks.events.observe({
								type: "output_update",
								streamId,
								offset: textOffset,
								channel: "content",
								text: delta.text,
							});
							try { this.hooks.onToken(delta.text); } catch (error) { this.reportError(error); }
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
		if (this.currentSignal().aborted) {
			const result = JSON.stringify({ error: "工具调用未启动（本轮已取消）", status: "not_started" });
			await this.storeEvent("tool_finished", {
				callId: call.id,
				name: call.name,
				status: "not_started",
			});
			return { callId: call.id, result, status: "not_started" };
		}

		const callArgs = (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>;
		const blocked = await this.runtimeHooks.tools.beforeCall({ callId: call.id, name: call.name, args: callArgs });
		if (blocked.block) {
				const reason = blocked.reason || "操作已被扩展阻止";
				const blockedResult = `[blocked] 工具执行已被拦截: ${reason}`;
				try { this.hooks.onToolDone?.(call.name, blockedResult, "not_started", call.id); } catch (error) { this.reportError(error); }
				await this.storeEvent("tool_finished", {
					callId: call.id,
					name: call.name,
					status: "not_started",
					result: blockedResult,
				});
				return { callId: call.id, result: blockedResult, status: "not_started" };
		}

		if (prepared.error) {
			const outcome = await this.tools.execute(prepared, this.currentSignal());
			await this.storeEvent("tool_finished", {
				callId: call.id,
				name: call.name,
				status: outcome.status,
				result: outcome.result,
			});
			try { this.hooks.onToolDone?.(call.name, outcome.result, outcome.status, call.id); } catch (error) { this.reportError(error); }
			return { callId: call.id, result: outcome.result, status: outcome.status };
		}
		try { this.hooks.onToolStart?.(call.name, call.args, call.id); } catch (error) { this.reportError(error); }
		await this.storeEvent("tool_started", {
			callId: call.id,
			name: call.name,
			args: call.args,
		});
		const outcome = await this.tools.execute(prepared, this.currentSignal());

		let outcomeResult = outcome.result;
		let outcomeStatus: ToolResultStatus = outcome.status;
		const transformed = await this.runtimeHooks.tools.transformResult({ callId: call.id, name: call.name, args: callArgs, result: outcomeResult, status: outcomeStatus });
		if (transformed.result !== undefined) outcomeResult = transformed.result;
		if (transformed.status !== undefined) outcomeStatus = transformed.status;

		await this.storeEvent("tool_finished", {
			callId: call.id,
			name: call.name,
			status: outcomeStatus,
			result: outcomeResult,
		});
		try { this.hooks.onToolDone?.(call.name, outcomeResult, outcomeStatus, call.id); } catch (error) { this.reportError(error); }
		return { callId: call.id, result: outcomeResult, status: outcomeStatus, continuation: outcome.continuation };
	}

	private async prepareTurn(provider = this.provider, systemPrompt = this.systemPrompt): Promise<void> {
		if (!this.prepareNextTurnSeam) return;
		try {
			const prepResult = await this.prepareNextTurnSeam({
				turnNumber: this.turnSeq,
				history: this.history,
				provider,
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
		try { this.hooks.onQueueChanged?.(this.queues.all()); } catch (error) { this.reportError(error); }
	}

	private reportError(error: unknown): void {
		try { this.hooks.onError?.(safeError(error)); } catch { /* reporting cannot alter runtime state */ }
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
		this.hooks.onTurnAborted?.(this.turnSeq);
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
