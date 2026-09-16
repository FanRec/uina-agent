/**
 * Uina 扩展事件宿主（ExtensionHost）。
 *
 * 作为扩展层的事件分发与生命周期中枢，负责：
 * 1. 统一管理扩展 Handler 注册与派发；
 * 2. 异步执行监听器并提供异常安全隔离（单个扩展异常不阻塞核心运行）；
 * 3. 支持拦截式事件（tool_call、session_before_compact 等）的快速短路判定；
 * 4. 支持链式变换（context、tool_result、before_provider_request 等）。
 */

import { errorMessage } from "../core/errors.js";
import { Registrations } from "../core/registrations.js";
import type { ChatMsg } from "../core/types.js";
import { copyValue, readonlySnapshot } from "../runtime/guard.js";
import type {
	DeepReadonly,
	OutputEvent,
	RuntimeEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "../runtime/events.js";

export type {
	AfterProviderResponseEvent,
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	ContextEvent,
	ErrorEvent,
	ModelSelectEvent,
	OutputEndEvent,
	OutputInterruptedEvent,
	OutputStartEvent,
	OutputUpdateEvent,
	QueueEvent,
	RuntimeEvent,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	ThinkingLevelSelectEvent,
	ToolCallEvent,
	ToolResultEvent,
	TurnAbortedEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../runtime/events.js";

export interface ExtensionError {
	extensionName?: string;
	event: string;
	error: string;
	stack?: string;
}

export type ExtensionErrorListener = (err: ExtensionError) => void;

// 1. 输入与 Prompt 事件
export interface InputEvent {
	readonly type: "input";
	readonly text: string;
	readonly source: Readonly<{ kind: "user" | "runtime" | "agent"; type: string; ref?: string }>;
}

export interface BeforeAgentStartResult {
	readonly message?: ChatMsg;
	readonly systemPrompt?: string;
	/** 换用另一个模型事实（Subject 以 setModel 的完整纪律应用）。 */
	readonly model?: import("../core/types.js").Model;
	readonly thinkingLevel?: import("../core/types.js").ThinkingLevel;
}

export interface ContextEventResult {
	readonly messages: readonly ChatMsg[];
}

export interface ToolCallResult {
	readonly block?: boolean;
	readonly reason?: string;
}

export interface ToolResultEventResult {
	readonly result?: string;
	readonly status?: import("../core/types.js").ToolResultStatus;
	readonly details?: unknown;
 readonly images?: readonly import("../core/content.js").ImageContent[];
}

export interface SessionBeforeCompactResult {
	readonly cancel?: boolean;
}

export interface BeforeProviderHeadersResult {
	readonly headers?: Record<string, string>;
}
export type ExtensionEvent = InputEvent | RuntimeEvent;

export type ExtensionEventHandler<T extends ExtensionEvent = ExtensionEvent> = (
	event: DeepReadonly<T>,
) => Promise<unknown> | unknown;

interface RegisteredHandler {
	readonly handler: ExtensionEventHandler;
	readonly scopeId?: string;
}

export type RuntimeScopeFilter = readonly string[] | undefined;

export class ExtensionHost {
	private readonly contextContributors = new Registrations<{ scopeId?: string; run: (input: Readonly<{ prompt: string; systemPrompt: string }>, signal?: AbortSignal) => Promise<readonly ChatMsg[]> }>();
 registerContextContributor(name: string, contributor: (input: Readonly<{ prompt: string; systemPrompt: string }>, signal?: AbortSignal) => Promise<readonly ChatMsg[]>, options?: { replace?: boolean; scopeId?: string }): () => void { return this.contextContributors.register(name, { run: contributor, scopeId: options?.scopeId }, options); }
 private handlers = new Map<string, Set<RegisteredHandler>>();
	private errorListeners = new Set<ExtensionErrorListener>();
	private observedTail: Promise<void> = Promise.resolve();

	/** 注册事件监听器 */
	on<T extends ExtensionEvent["type"]>(
		eventType: T,
		handler: ExtensionEventHandler<Extract<ExtensionEvent, { type: T }>>,
	): () => void {
		return this.onScoped(undefined, eventType, handler);
	}

	protected onScoped<T extends ExtensionEvent["type"]>(
		scopeId: string | undefined,
		eventType: T,
		handler: ExtensionEventHandler<Extract<ExtensionEvent, { type: T }>>,
	): () => void {
		let set = this.handlers.get(eventType);
		if (!set) {
			set = new Set();
			this.handlers.set(eventType, set);
		}
		const entry: RegisteredHandler = { handler: handler as ExtensionEventHandler, ...(scopeId === undefined ? {} : { scopeId }) };
		set.add(entry);
		return () => {
			set?.delete(entry);
		};
	}

	/** 监听扩展执行异常 */
	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	protected emitError(event: string, err: unknown, extensionName?: string): void {
		const message = errorMessage(err);
		const stack = err instanceof Error ? err.stack : undefined;
		for (const listener of this.errorListeners) {
			try {
				listener({ ...(extensionName === undefined ? {} : { extensionName }), event, error: message, stack });
			} catch {
				// 避免错误监听器本身发生次生异常
			}
		}
	}

	/** 检查某事件是否有监听器 */
	hasHandlers(eventType: string, scope?: RuntimeScopeFilter): boolean {
		return this.handlersFor(eventType, scope).length > 0;
	}

	/** 广播通用无返回值事件（安全隔离异常） */
	async emit(event: ExtensionEvent, scope?: RuntimeScopeFilter): Promise<void> {
		const handlers = this.handlersFor(event.type, scope);
		if (handlers.length === 0) return;

		for (const handler of handlers) {
			try {
				await handler(readonlySnapshot(event));
			} catch (err) {
				this.emitError(event.type, err);
			}
		}
	}

	/** Queue observational events so stream consumers always observe start → update → end. */
	emitObserved(event: OutputEvent, scope?: RuntimeScopeFilter): void {
		this.observedTail = this.observedTail.then(() => this.emit(event, scope)).catch((error) => this.emitError(event.type, error));
	}

	async flush(): Promise<void> {
		await this.observedTail;
	}

	/** 触发工具调用前拦截（支持 block 短路） */
	async emitToolCall(event: ToolCallEvent, scope?: RuntimeScopeFilter): Promise<ToolCallResult | undefined> {
		const handlers = this.handlersFor("tool_call", scope);
		if (handlers.length === 0) return undefined;

		for (const handler of handlers) {
			try {
				const res = (await handler(readonlySnapshot(event))) as ToolCallResult | undefined;
				if (res?.block) {
					return res; // 立即短路，跳过后续拦截器
				}
			} catch (err) {
				this.emitError("tool_call", err);
			}
		}
		return undefined;
	}

	/** 触发工具结果改写/审计（链式传递） */
	async emitToolResult(event: ToolResultEvent, scope?: RuntimeScopeFilter): Promise<ToolResultEventResult | undefined> {
		const handlers = this.handlersFor("tool_result", scope);
		if (handlers.length === 0) return undefined;

		const current = { ...event };
		let modified = false;

		for (const handler of handlers) {
			try {
				const res = (await handler(readonlySnapshot(current))) as ToolResultEventResult | undefined;
				if (res) {
					if (res.result !== undefined) {
						current.result = res.result;
						modified = true;
					}
					if (res.details !== undefined) { current.details = copyValue(res.details); modified = true; }
     if (res.images !== undefined) { current.images = copyValue(res.images); modified = true; }
     if (res.status !== undefined) {
						current.status = res.status;
						modified = true;
					}
				}
			} catch (err) {
				this.emitError("tool_result", err);
			}
		}

		return modified ? { result: current.result, status: current.status, details: current.details, images: current.images } : undefined;
	}

	/** 触发上下文消息变换 */
	async emitContext(messages: readonly ChatMsg[], scope?: RuntimeScopeFilter): Promise<ChatMsg[]> {
		const handlers = this.handlersFor("context", scope);
		if (handlers.length === 0) return [...messages];

		let currentMessages = [...messages];
		for (const handler of handlers) {
			try {
				const res = (await handler(readonlySnapshot({
					type: "context",
					messages: currentMessages,
				}))) as ContextEventResult | undefined;
				if (res?.messages) {
					currentMessages = [...structuredClone(res.messages)];
				}
			} catch (err) {
				this.emitError("context", err);
			}
		}
		return currentMessages;
	}

	/** 触发 Agent 启动前准备（可注入额外消息或修改 systemPrompt） */
	async emitBeforeAgentStart(
		prompt: string,
		systemPrompt: string,
		scope?: RuntimeScopeFilter,
  signal?: AbortSignal,
	): Promise<{ messages?: ChatMsg[]; systemPrompt?: string; model?: import("../core/types.js").Model; thinkingLevel?: import("../core/types.js").ThinkingLevel } | undefined> {
		const handlers = this.handlersFor("before_agent_start", scope);
		const messages: ChatMsg[] = [];
		let currentPrompt = systemPrompt;
		let currentModel: import("../core/types.js").Model | undefined;
		let currentThinking: import("../core/types.js").ThinkingLevel | undefined;
		let modified = false;

		for (const handler of handlers) {
			try {
				const res = (await handler(readonlySnapshot({
					type: "before_agent_start",
					prompt,
					systemPrompt: currentPrompt,
				}))) as BeforeAgentStartResult | undefined;
				if (res) {
					if (res.message) {
						messages.push(structuredClone(res.message));
						modified = true;
					}
					if (res.systemPrompt !== undefined) {
						currentPrompt = res.systemPrompt;
						modified = true;
					}
					if (res.model !== undefined) {
						currentModel = structuredClone(res.model);
						modified = true;
					}
					if (res.thinkingLevel !== undefined) {
						currentThinking = res.thinkingLevel;
						modified = true;
					}
				}
			} catch (err) {
				this.emitError("before_agent_start", err);
			}
		}

  {
   for (const contributor of this.contextContributors.values()) {
    if (scope && (!contributor.scopeId || !scope.includes(contributor.scopeId))) continue;
    const additions = await contributor.run(readonlySnapshot({ prompt, systemPrompt: currentPrompt }), signal);
    messages.push(...structuredClone(additions));
    if (additions.length) modified = true;
   }
  }
		return modified
			? {
					messages: messages.length > 0 ? messages : undefined,
					systemPrompt: currentPrompt !== systemPrompt ? currentPrompt : undefined,
					...(currentModel !== undefined ? { model: currentModel } : {}),
					...(currentThinking !== undefined ? { thinkingLevel: currentThinking } : {}),
				}
			: undefined;
	}

	/** 触发压缩前检查（支持取消压缩） */
	async emitSessionBeforeCompact(tokensBefore: number, scope?: RuntimeScopeFilter): Promise<boolean> {
		const handlers = this.handlersFor("session_before_compact", scope);
		if (handlers.length === 0) return false;

		for (const handler of handlers) {
			try {
				const res = (await handler(readonlySnapshot({
					type: "session_before_compact",
					tokensBefore,
				}))) as SessionBeforeCompactResult | undefined;
				if (res?.cancel) {
					return true; // 请求取消压缩
				}
			} catch (err) {
				this.emitError("session_before_compact", err);
			}
		}
		return false;
	}

	/** 回合间停止决策：任一扩展返回 stop 即收尾（对应 Pi shouldStopAfterTurn）。 */
	async emitTurnShouldStop(
		input: { turnNumber: number; finishReason: import("../core/types.js").FinishReason; reply: string; toolCallCount: number },
		scope?: RuntimeScopeFilter,
	): Promise<boolean> {
		const handlers = this.handlersFor("turn_should_stop", scope);
		for (const handler of handlers) {
			try {
				const res = (await handler(readonlySnapshot({
					type: "turn_should_stop",
					...input,
				}))) as { stop?: boolean } | undefined;
				if (res?.stop) return true;
			} catch (err) {
				this.emitError("turn_should_stop", err);
			}
		}
		return false;
	}

	/** 触发 Provider 请求 Headers 修改 */
	async emitBeforeProviderHeaders(
		provider: string,
		headers: Readonly<Record<string, string>>,
		scope?: RuntimeScopeFilter,
	): Promise<Record<string, string>> {
		const handlers = this.handlersFor("before_provider_headers", scope);
		if (handlers.length === 0) return { ...headers };

		let current = { ...headers };
		for (const handler of handlers) {
			try {
				const res = (await handler(readonlySnapshot({
					type: "before_provider_headers",
					provider,
					headers: current,
				}))) as BeforeProviderHeadersResult | undefined;
				if (res?.headers) current = structuredClone(res.headers);
			} catch (err) {
				this.emitError("before_provider_headers", err);
			}
		}
		return structuredClone(current);
	}

	/** 触发 Provider 请求 Payload 修改 */
	async emitBeforeProviderRequest(provider: string, payload: DeepReadonly<unknown>, scope?: RuntimeScopeFilter): Promise<unknown> {
		const handlers = this.handlersFor("before_provider_request", scope);
		if (handlers.length === 0) return payload;

		let current = payload;
		for (const handler of handlers) {
			try {
				const res = await handler(readonlySnapshot({
					type: "before_provider_request",
					provider,
					payload: current,
				}));
				if (res !== undefined) {
					current = copyValue(res);
				}
			} catch (err) {
				this.emitError("before_provider_request", err);
			}
		}
		return copyValue(current);
	}

	/** 触发 Provider 响应审计 */
	async emitAfterProviderResponse(
		provider: string,
		status: number, headers: Readonly<Record<string, string>>,
		scope?: RuntimeScopeFilter,
	): Promise<void> {
		const handlers = this.handlersFor("after_provider_response", scope);
		if (handlers.length === 0) return;

		for (const handler of handlers) {
			try {
				await handler(readonlySnapshot({
					type: "after_provider_response",
					provider,
					status,
					headers,
				}));
			} catch (err) {
				this.emitError("after_provider_response", err);
			}
		}
	}

	private handlersFor(eventType: string, scope?: RuntimeScopeFilter): ExtensionEventHandler[] {
		const set = this.handlers.get(eventType);
		if (!set) return [];
		if (scope === undefined) return [...set].map((entry) => entry.handler);
		const visible = new Set(scope);
		return [...set].filter((entry) => entry.scopeId === undefined || visible.has(entry.scopeId)).map((entry) => entry.handler);
	}
}
