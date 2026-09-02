import type {
	ChatMsg,
	CompletedToolCall,
	DeliveryMode,
	ModelProvider,
	ThinkingLevel,
	ToolResultStatus,
} from "../core/types.js";
import type { SessionStore } from "../session/types.js";
import { compactHistory, DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from "./compaction.js";
import { buildContext, defaultSystemPrompt } from "./context.js";
import { InputQueues, type QueuedMessage } from "./queue.js";
import type { PreparedToolCall, ToolBroker } from "../tools/broker.js";

export interface LoopHooks {
	onToken: (text: string) => void;
	onThinking?: (text: string) => void;
	onTurnStart?: (n: number, text: string) => void;
	onTurnEnd?: (n: number) => void;
	onToolStart?: (name: string, args: unknown, callId?: string) => void;
	onToolDone?: (
		name: string,
		result: string,
		status?: ToolResultStatus,
		callId?: string,
	) => void;
	onError?: (msg: string) => void;
	onNotice?: (msg: string) => void;
	onQueueChanged?: (items: readonly QueuedMessage[]) => void;
}

export interface SubjectOptions {
	store?: SessionStore;
	compaction?: Partial<CompactionSettings>;
	systemPrompt?: string;
	thinkingLevel?: ThinkingLevel;
	steerQueueMode?: import("../core/types.js").QueueMode;
	followUpQueueMode?: import("../core/types.js").QueueMode;
}

export interface QueueInputOptions {
	mode?: DeliveryMode;
}

export class Subject {
	private busy = false;
	private history: ChatMsg[] = [];
	private turnSeq = 0;
	private interrupted = false;
	private abort: AbortController | null = null;
	private readonly queues = new InputQueues();
	private readonly systemPrompt: string;
	private readonly compaction: CompactionSettings;
	private readonly store?: SessionStore;
	private idleWaiters: Array<() => void> = [];
	private resumingQueue = false;
	private readonly queueModes: Record<"steer" | "followUp", import("../core/types.js").QueueMode>;
	private readonly thinkingLevel: ThinkingLevel;

	constructor(
		private readonly provider: ModelProvider,
		private readonly tools: ToolBroker,
		private readonly hooks: LoopHooks,
		options: SubjectOptions = {},
	) {
		this.store = options.store;
		this.systemPrompt = options.systemPrompt ?? defaultSystemPrompt();
		this.compaction = {
			...DEFAULT_COMPACTION_SETTINGS,
			contextWindow: provider.contextWindow ?? DEFAULT_COMPACTION_SETTINGS.contextWindow,
			...options.compaction,
		};
		this.queueModes = {
			steer: options.steerQueueMode ?? "one-at-a-time",
			followUp: options.followUpQueueMode ?? "one-at-a-time",
		};
		this.thinkingLevel = options.thinkingLevel ?? "off";
	}

	pushInput(text: string, options: QueueInputOptions = {}): Promise<void> {
		const normalized = text.trim();
		if (!normalized) return Promise.resolve();
		const mode = options.mode ?? (this.busy ? "steer" : "direct");
		if (mode === "direct" && !this.busy && this.queues.size === 0) {
			return this.startRun(normalized);
		}
		const queued = this.queues.enqueue(normalized, mode === "direct" ? "followUp" : mode);
		this.notifyQueueChanged();
		const persisted = this.storeEvent("queue_enqueued", eventData(queued));
		if (!this.busy && mode === "direct") return persisted.then(() => this.resumeQueued());
		return persisted;
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
		if (!this.busy) return;
		this.interrupted = true;
		this.abort?.abort();
	}

	isBusy(): boolean {
		return this.busy;
	}

	waitForIdle(): Promise<void> {
		if (!this.busy) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	addHistory(messages: ChatMsg[]): void {
		this.history.push(...structuredClone(messages));
	}

	seedQueue(items: readonly QueuedMessage[]): void {
		this.queues.seed(items);
		this.notifyQueueChanged();
	}

	historySnapshot(): ChatMsg[] {
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

	private startRun(text: string): Promise<void> {
		if (this.busy) return Promise.reject(new Error("已有活动轮次"));
		if (this.provider.thinkingLevels && !this.provider.thinkingLevels.includes(this.thinkingLevel)) {
			this.reportError(new Error(`provider ${this.provider.name} 不支持 thinking level: ${this.thinkingLevel}`));
			return Promise.resolve();
		}
		this.busy = true;
		this.interrupted = false;
		this.abort = new AbortController();
		const turn = ++this.turnSeq;
		return this.runTurn(text, turn);
	}

	private async runTurn(text: string, turn: number): Promise<void> {
		try {
			this.hooks.onTurnStart?.(turn, text);
			await this.appendMessage({ role: "user", content: text });
			await this.decide();
		} catch (error) {
			if (this.interrupted || this.currentSignal().aborted) {
				await this.emitInterrupted();
				this.hooks.onNotice?.("本轮已中断，排队消息已保留在输入框待恢复。");
			} else {
				const message = safeError(error);
				await this.storeEvent("turn_failed", { turnId: turn, error: message });
				this.reportError(message);
			}
		} finally {
			this.abort = null;
			this.busy = false;
			try { this.hooks.onTurnEnd?.(turn); } catch (error) {
				try { this.hooks.onError?.(safeError(error)); } catch { /* hooks cannot own lifecycle */ }
			}
			if (!this.interrupted && this.queues.size > 0) {
				try { await this.resumeQueued(); } catch (error) { this.reportError(error); }
			}
			for (const resolve of this.idleWaiters.splice(0)) resolve();
		}
	}

	private async resumeQueued(): Promise<void> {
		if (this.busy || this.resumingQueue) return;
		const item = this.queues.peek("steer") ?? this.queues.peek("followUp");
		if (!item) return;
		this.resumingQueue = true;
		try {
			await this.consumeQueueItem(item);
			this.resumingQueue = false;
			await this.startRun(item.text);
		} finally {
			this.resumingQueue = false;
		}
	}

	private async decide(): Promise<void> {
		await this.maybeCompact();
		let nextUser: ChatMsg | undefined;
		let nextUsers: ChatMsg[] = [];
		for (;;) {
			if (this.interrupted) {
				await this.emitInterrupted();
				return;
			}
			if (nextUsers.length > 0) {
				for (const message of nextUsers) await this.appendMessage(message);
				nextUsers = [];
			} else if (nextUser) {
				await this.appendMessage(nextUser);
				nextUser = undefined;
			}

			const requestMessages = buildContext({ history: this.history, systemPrompt: this.systemPrompt, includeThinking: this.provider.includeThinking });
			const toolCalls: CompletedToolCall[] = [];
			let reply = "";
			let thinking = "";
			let thinkingSignature: string | undefined;
			let finishReason: string | null = null;
			try {
				await this.provider.stream(
					{ messages: requestMessages, tools: this.tools.defs(), thinkingLevel: this.thinkingLevel },
					(delta) => {
						if (delta.kind === "thinking") {
							thinking += delta.text;
							try { this.hooks.onThinking?.(delta.text); } catch (error) { this.reportError(error); }
						} else if (delta.kind === "thinking_signature") {
							thinkingSignature = delta.signature;
						} else if (delta.kind === "text") {
							reply += delta.text;
							this.hooks.onToken(delta.text);
						} else if (delta.kind === "tool_call") {
							const parsedArgs = parseToolArgs(delta.call.args);
							toolCalls.push({
								id: delta.call.id,
								name: delta.call.name,
								args: parsedArgs.value,
								argsValid: delta.call.argsValid !== false && parsedArgs.valid,
							});
						} else if (!finishReason) {
							finishReason = delta.reason;
						}
					},
					this.currentSignal(),
				);
			} catch (error) {
				if (this.interrupted || this.currentSignal().aborted) {
					await this.emitInterrupted(reply, thinking, thinkingSignature);
					return;
				}
				if (reply.trim()) {
						await this.appendMessage({ role: "assistant", content: reply, thinking: thinking || undefined, thinkingSignature, status: "error" });
				}
				throw error;
			}

			if (this.interrupted || this.currentSignal().aborted) {
				await this.emitInterrupted(reply, thinking, thinkingSignature);
				return;
			}
			if (
				!finishReason ||
				!['stop', 'tool_calls', 'length'].includes(finishReason)
			) {
				throw new Error(`模型返回未知或缺失 finish reason: ${finishReason ?? "none"}`);
			}
			if (finishReason === "tool_calls" && toolCalls.length === 0) {
				throw new Error("模型声明了 tool_calls，但没有返回工具调用");
			}
			if (finishReason === "length") {
				this.hooks.onNotice?.("本轮回复达到输出长度上限。");
			}
			if (toolCalls.length === 0) {
				if (reply.trim()) {
						await this.appendMessage({
							role: "assistant",
							content: reply,
							thinking: thinking || undefined,
							thinkingSignature,
							status: finishReason === "length" ? "length" : "complete",
					});
				}
				const steer = this.queues.peekMany("steer", this.queueModes.steer);
				if (steer.length > 0) {
					for (const item of steer) await this.consumeQueueItem(item);
					nextUsers = steer.map((item) => ({ role: "user", content: item.text }));
					continue;
				}
				const followUp = this.queues.peekMany("followUp", this.queueModes.followUp);
				if (followUp.length > 0) {
					for (const item of followUp) await this.consumeQueueItem(item);
					nextUsers = followUp.map((item) => ({ role: "user", content: item.text }));
					continue;
				}
				this.notifyQueueChanged();
				return;
			}

			const assistant: ChatMsg = {
				role: "assistant",
					content: reply,
					thinking: thinking || undefined,
					thinkingSignature,
					tool_calls: toolCalls,
				status: finishReason === "length" ? "length" : "complete",
			};
			await this.appendMessage(assistant);
			const results = await this.executeToolCalls(toolCalls);
			for (const result of results) {
				await this.appendMessage({
					role: "tool",
					tool_call_id: result.callId,
					content: result.result,
					status: result.status,
				});
			}
			if (this.interrupted || this.currentSignal().aborted) {
					await this.emitInterrupted("", thinking, thinkingSignature);
				return;
			}
			const steer = this.queues.peekMany("steer", this.queueModes.steer);
			if (steer.length > 0) {
				for (const item of steer) await this.consumeQueueItem(item);
				nextUsers = steer.map((item) => ({ role: "user", content: item.text }));
			}
		}
	}

	private async executeToolCalls(calls: CompletedToolCall[]): Promise<Array<{
		callId: string;
		result: string;
		status: ToolResultStatus;
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
		if (prepared.error) {
			const outcome = await this.tools.execute(prepared, this.currentSignal());
			await this.storeEvent("tool_finished", {
				callId: call.id,
				name: call.name,
				status: outcome.status,
				result: outcome.result,
			});
			this.hooks.onToolDone?.(call.name, outcome.result, outcome.status, call.id);
			return { callId: call.id, result: outcome.result, status: outcome.status };
		}
		this.hooks.onToolStart?.(call.name, call.args, call.id);
		await this.storeEvent("tool_started", {
			callId: call.id,
			name: call.name,
			args: call.args,
		});
		const outcome = await this.tools.execute(prepared, this.currentSignal());
		await this.storeEvent("tool_finished", {
			callId: call.id,
			name: call.name,
			status: outcome.status,
			result: outcome.result,
		});
		this.hooks.onToolDone?.(call.name, outcome.result, outcome.status, call.id);
		return { callId: call.id, result: outcome.result, status: outcome.status };
	}

	private async maybeCompact(): Promise<void> {
		const result = await compactHistory(
			this.history,
			this.provider,
			this.systemPrompt,
			this.tools.defs(),
			this.compaction,
			this.abort?.signal,
			this.provider.includeThinking,
		);
		if (!result) return;
		const replacement: ChatMsg[] = [
			{ role: "user", content: `[历史摘要] ${result.summary}` },
			...result.retainedTail,
		];
		await this.store?.appendCompaction(result.summary, result.retainedTail, result.tokensBefore);
		this.history = replacement;
	}

	private async appendMessage(message: ChatMsg): Promise<void> {
		await this.store?.appendMessage(message);
		this.history.push(message);
	}

	private async consumeQueueItem(item: QueuedMessage): Promise<void> {
		await this.storeEvent("queue_consumed", eventData(item));
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

	private currentSignal(): AbortSignal {
		if (!this.abort) throw new Error("当前没有活动轮次");
		return this.abort.signal;
	}

	private async emitInterrupted(partial = "", thinking = "", thinkingSignature?: string): Promise<void> {
		if (partial.trim() || thinking.trim() || thinkingSignature) {
			await this.appendMessage({ role: "assistant", content: partial, thinking: thinking || undefined, thinkingSignature, status: "aborted" });
		}
		await this.appendMessage({ role: "assistant", content: "[已中断]", status: "aborted" });
		await this.storeEvent("turn_aborted", { turnId: this.turnSeq });
		this.hooks.onToken("\n[已中断] 当前对话已停止。\n");
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
