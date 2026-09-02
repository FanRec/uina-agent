import type {
	ChatMsg,
	CompletedToolCall,
	DeliveryMode,
	ModelProvider,
	ToolResultStatus,
} from "../core/types.js";
import type { SessionStore } from "../session/types.js";
import { compactHistory, DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from "./compaction.js";
import { buildContext, defaultSystemPrompt } from "./context.js";
import { InputQueues, type QueuedMessage } from "./queue.js";
import type { PreparedToolCall, ToolBroker } from "../tools/broker.js";

export interface LoopHooks {
	onToken: (text: string) => void;
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
	}

	pushInput(text: string, options: QueueInputOptions = {}): void {
		const normalized = text.trim();
		if (!normalized) return;
		const mode = options.mode ?? (this.busy ? "steer" : "direct");
		if (mode === "direct" && !this.busy && this.queues.size === 0) {
			void this.runTurn(normalized);
			return;
		}
		const queued = this.queues.enqueue(normalized, mode === "direct" ? "followUp" : mode);
		void this.storeEvent("queue_enqueued", queued as unknown as Record<string, unknown>);
		this.notifyQueueChanged();
		if (!this.busy && mode === "direct") void this.resumeQueued();
	}

	/** Queue an input for the next model request while the current run is active. */
	steer(text: string): void {
		this.pushInput(text, { mode: "steer" });
	}

	/** Queue an input until the current run has otherwise completed. */
	followUp(text: string): void {
		this.pushInput(text, { mode: "followUp" });
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
	takeQueuedForEditor(): QueuedMessage[] {
		const items = this.queues.takeAll();
		for (const item of items) void this.storeEvent("queue_restored", eventData(item));
		this.notifyQueueChanged();
		return items;
	}

	private async runTurn(text: string): Promise<void> {
		this.busy = true;
		this.interrupted = false;
		this.abort = new AbortController();
		const turn = ++this.turnSeq;
		this.hooks.onTurnStart?.(turn, text);
		try {
			await this.appendMessage({ role: "user", content: text });
			await this.decide();
		} catch (error) {
			if (this.interrupted || this.currentSignal().aborted) {
				await this.emitInterrupted();
				this.hooks.onNotice?.("本轮已中断，排队消息已保留在输入框待恢复。");
			} else {
				const message = safeError(error);
				await this.appendMessage({ role: "user", content: `（系统提示）上轮处理出错：${message}` });
				await this.storeEvent("turn_failed", { turnId: turn, error: message });
				this.hooks.onError?.(message);
			}
		} finally {
			this.abort = null;
			this.busy = false;
			this.hooks.onTurnEnd?.(turn);
			for (const resolve of this.idleWaiters.splice(0)) resolve();
		}
	}

	private async resumeQueued(): Promise<void> {
		if (this.busy) return;
		const all = this.queues.takeAll();
		this.notifyQueueChanged();
		if (all.length === 0) return;
		for (const item of all) await this.storeEvent("queue_consumed", eventData(item));
		await this.runTurn(all.map((item) => item.text).join("\n"));
	}

	private async decide(): Promise<void> {
		await this.maybeCompact();
		let nextUser: ChatMsg | undefined;
		for (;;) {
			if (this.interrupted) {
				await this.emitInterrupted();
				return;
			}
			if (nextUser) {
				await this.appendMessage(nextUser);
				nextUser = undefined;
			}

			const requestMessages = buildContext({ history: this.history, systemPrompt: this.systemPrompt });
			const toolCalls: CompletedToolCall[] = [];
			let reply = "";
			let finishReason: string | null = null;
			try {
				await this.provider.stream(
					{ messages: requestMessages, tools: this.tools.defs() },
					(delta) => {
						if (delta.kind === "text") {
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
					await this.emitInterrupted(reply);
					return;
				}
				if (reply.trim()) {
					await this.appendMessage({ role: "assistant", content: reply, status: "error" });
				}
				throw error;
			}

			if (this.interrupted || this.currentSignal().aborted) {
				await this.emitInterrupted(reply);
				return;
			}
			if (
				!finishReason ||
				!['stop', 'tool_calls', 'length'].includes(finishReason)
			) {
				throw new Error(`模型返回未知或缺失 finish reason: ${finishReason ?? "none"}`);
			}
			if (finishReason === "length") {
				this.hooks.onNotice?.("本轮回复达到输出长度上限。");
			}
			if (toolCalls.length === 0) {
				if (reply.trim()) {
					await this.appendMessage({
						role: "assistant",
						content: reply,
						status: finishReason === "length" ? "length" : "complete",
					});
				}
				const steer = this.queues.takeSteer();
				if (steer) {
					await this.consumeQueueItem(steer);
					nextUser = { role: "user", content: steer.text };
					continue;
				}
				const followUp = this.queues.takeFollowUp();
				if (followUp) {
					await this.consumeQueueItem(followUp);
					nextUser = { role: "user", content: followUp.text };
					continue;
				}
				this.notifyQueueChanged();
				return;
			}

			const assistant: ChatMsg = {
				role: "assistant",
				content: reply,
				tool_calls: toolCalls,
				status: finishReason === "length" ? "length" : "complete",
			};
			await this.appendMessage(assistant);
			const results = await this.executeToolCalls(toolCalls);
			for (const result of results) {
				await this.appendMessage({
					role: "tool",
					tool_call_id: result.callId,
					content: truncateToolContext(result.result),
					status: result.status,
				});
			}
			if (this.interrupted || this.currentSignal().aborted) {
				await this.emitInterrupted();
				return;
			}
			const steer = this.queues.takeSteer();
			if (steer) {
				await this.consumeQueueItem(steer);
				nextUser = { role: "user", content: steer.text };
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
		this.notifyQueueChanged();
	}

	private async storeEvent(event: Parameters<SessionStore["appendEvent"]>[0], data: Record<string, unknown>): Promise<void> {
		await this.store?.appendEvent(event, data);
	}

	private notifyQueueChanged(): void {
		this.hooks.onQueueChanged?.(this.queues.all());
	}

	private currentSignal(): AbortSignal {
		if (!this.abort) throw new Error("当前没有活动轮次");
		return this.abort.signal;
	}

	private async emitInterrupted(partial = ""): Promise<void> {
		if (partial.trim()) {
			await this.appendMessage({ role: "assistant", content: partial, status: "aborted" });
		}
		await this.appendMessage({ role: "assistant", content: "[已中断]", status: "aborted" });
		await this.storeEvent("turn_aborted", { turnId: this.turnSeq });
		this.hooks.onToken("\n[已中断] 当前对话已停止。\n");
	}
}

export function findOrphanToolCalls(messages: readonly ChatMsg[]): string[] {
	const pending = new Set<string>();
	const results = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant" && message.tool_calls) {
			for (const call of message.tool_calls) pending.add(call.id);
		}
		if (message.role === "tool") results.add(message.tool_call_id);
	}
	return [...pending].filter((id) => !results.has(id));
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

function truncateToolContext(value: string): string {
	const maxChars = 2000;
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}…[工具结果已截断，完整结果见 session 事件记录]`;
}
