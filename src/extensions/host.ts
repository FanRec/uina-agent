/**
 * Uina 扩展事件宿主（ExtensionHost）。
 *
 * 作为核心事件总线与生命周期中枢，负责：
 * 1. 统一管理扩展 Handler 注册与派发；
 * 2. 异步执行监听器并提供异常安全隔离（单个扩展异常不阻塞核心运行）；
 * 3. 支持拦截式事件（tool_call、session_before_compact 等）的快速短路判定；
 * 4. 支持链式变换（context、tool_result、before_provider_request 等）。
 */

import type { ChatMsg, ThinkingLevel } from "../core/types.js";
import type { ModelProvider } from "../core/types.js";

export interface ExtensionError {
	extensionName?: string;
	event: string;
	error: string;
	stack?: string;
}

export type ExtensionErrorListener = (err: ExtensionError) => void;

// 1. 输入与 Prompt 事件
export interface InputEvent {
	type: "input";
	text: string;
	source: { kind: "user" | "runtime" | "agent"; type: string; ref?: string };
}

export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	systemPrompt: string;
}

export interface BeforeAgentStartResult {
	message?: ChatMsg;
	systemPrompt?: string;
}

// 2. Agent 任务与回合生命周期
export interface AgentStartEvent {
	type: "agent_start";
	turnSeq: number;
}

export interface AgentEndEvent {
	type: "agent_end";
	turnSeq: number;
	success: boolean;
	error?: string;
}

export interface AgentSettledEvent {
	type: "agent_settled";
	turnSeq: number;
}

export interface TurnStartEvent {
	type: "turn_start";
	turnNumber: number;
	userText: string;
}

export interface TurnEndEvent {
	type: "turn_end";
	turnNumber: number;
	usage?: { usedTokens: number; contextWindow?: number };
}

// 3. 上下文变换事件
export interface ContextEvent {
	type: "context";
	messages: ChatMsg[];
}

export interface ContextEventResult {
	messages: ChatMsg[];
}

// 4. 工具调用与结果拦截
export interface ToolCallEvent {
	type: "tool_call";
	toolName: string;
	args: Record<string, unknown>;
	callId: string;
}

export interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

export interface ToolResultEvent {
	type: "tool_result";
	toolName: string;
	args: Record<string, unknown>;
	result: string;
	isError: boolean;
	callId: string;
}

export interface ToolResultEventResult {
	result?: string;
	isError?: boolean;
	details?: unknown;
}

// 5. 模型与思考深度
export interface ModelSelectEvent {
	type: "model_select";
	model: string;
	provider: ModelProvider;
	previousModel?: string;
}

export interface ThinkingLevelSelectEvent {
	type: "thinking_level_select";
	level: ThinkingLevel;
	previousLevel?: ThinkingLevel;
}

// 6. 会话压缩事件
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	tokensBefore: number;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
}

export interface SessionCompactEvent {
	type: "session_compact";
	summary: string;
	tokensBefore: number;
	retainedTailCount: number;
}

export interface SessionCompactFailedEvent {
	type: "session_compact_failed";
	error: string;
}

// 7. 规范化输出流事件（语音输出 / 外部端）
export interface OutputStartEvent {
	type: "output_start";
	streamId: string;
	channel: "content" | "thinking" | "tool";
}

export interface OutputUpdateEvent {
	type: "output_update";
	streamId: string;
	offset: number;
	channel: "content" | "thinking" | "tool";
	text: string;
}

export interface OutputEndEvent {
	type: "output_end";
	streamId: string;
	channel: "content" | "thinking" | "tool";
}

export interface OutputInterruptedEvent {
	type: "output_interrupted";
	streamId: string;
	channel: "content" | "thinking" | "tool";
	reason: "external" | "self" | "cancelled" | "error";
	spokenUntil?: number;
}

// 8. 资源发现事件
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

export interface ResourcesDiscoverResult {
	toolPaths?: string[];
	promptPaths?: string[];
}

// 9. Provider 协议层网络拦截
export interface BeforeProviderHeadersEvent {
	type: "before_provider_headers";
	provider: string;
	headers: Record<string, string>;
}

export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	provider: string;
	payload: unknown;
}

export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	provider: string;
	status: number;
	headers: Record<string, string>;
}

// 全部事件联合类型
export type ExtensionEvent =
	| InputEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| AgentSettledEvent
	| TurnStartEvent
	| TurnEndEvent
	| ContextEvent
	| ToolCallEvent
	| ToolResultEvent
	| ModelSelectEvent
	| ThinkingLevelSelectEvent
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionCompactFailedEvent
	| OutputStartEvent
	| OutputUpdateEvent
	| OutputEndEvent
	| OutputInterruptedEvent
	| ResourcesDiscoverEvent
	| BeforeProviderHeadersEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent;

export type ExtensionEventHandler<T extends ExtensionEvent = ExtensionEvent> = (
	event: T,
) => Promise<unknown> | unknown;

export class ExtensionHost {
	private handlers = new Map<string, Set<ExtensionEventHandler<any>>>();
	private errorListeners = new Set<ExtensionErrorListener>();
	private observedTail: Promise<void> = Promise.resolve();

	/** 注册事件监听器 */
	on<T extends ExtensionEvent["type"]>(
		eventType: T,
		handler: ExtensionEventHandler<Extract<ExtensionEvent, { type: T }>>,
	): () => void {
		let set = this.handlers.get(eventType);
		if (!set) {
			set = new Set();
			this.handlers.set(eventType, set);
		}
		set.add(handler);
		return () => {
			set?.delete(handler);
		};
	}

	/** 监听扩展执行异常 */
	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	protected emitError(event: string, err: unknown, extensionName?: string): void {
		const message = err instanceof Error ? err.message : String(err);
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
	hasHandlers(eventType: string): boolean {
		const set = this.handlers.get(eventType);
		return !!set && set.size > 0;
	}

	/** 广播通用无返回值事件（安全隔离异常） */
	async emit(event: ExtensionEvent): Promise<void> {
		const set = this.handlers.get(event.type);
		if (!set || set.size === 0) return;

		for (const handler of set) {
			try {
				await handler(event);
			} catch (err) {
				this.emitError(event.type, err);
			}
		}
	}

	/** Queue observational events so stream consumers always observe start → update → end. */
	emitObserved(event: ExtensionEvent): void {
		this.observedTail = this.observedTail.then(() => this.emit(event)).catch((error) => this.emitError(event.type, error));
	}

	async flush(): Promise<void> {
		await this.observedTail;
	}

	/** 触发工具调用前拦截（支持 block 短路） */
	async emitToolCall(event: ToolCallEvent): Promise<ToolCallResult | undefined> {
		const set = this.handlers.get("tool_call");
		if (!set || set.size === 0) return undefined;

		for (const handler of set) {
			try {
				const res = (await handler(event)) as ToolCallResult | undefined;
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
	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		const set = this.handlers.get("tool_result");
		if (!set || set.size === 0) return undefined;

		const current = { ...event };
		let modified = false;

		for (const handler of set) {
			try {
				const res = (await handler(current)) as ToolResultEventResult | undefined;
				if (res) {
					if (res.result !== undefined) {
						current.result = res.result;
						modified = true;
					}
					if (res.isError !== undefined) {
						current.isError = res.isError;
						modified = true;
					}
				}
			} catch (err) {
				this.emitError("tool_result", err);
			}
		}

		return modified ? { result: current.result, isError: current.isError } : undefined;
	}

	/** 触发上下文消息变换 */
	async emitContext(messages: ChatMsg[]): Promise<ChatMsg[]> {
		const set = this.handlers.get("context");
		if (!set || set.size === 0) return messages;

		let currentMessages = [...messages];
		for (const handler of set) {
			try {
				const res = (await handler({
					type: "context",
					messages: currentMessages,
				})) as ContextEventResult | undefined;
				if (res?.messages) {
					currentMessages = res.messages;
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
	): Promise<{ messages?: ChatMsg[]; systemPrompt?: string } | undefined> {
		const set = this.handlers.get("before_agent_start");
		if (!set || set.size === 0) return undefined;

		const messages: ChatMsg[] = [];
		let currentPrompt = systemPrompt;
		let modified = false;

		for (const handler of set) {
			try {
				const res = (await handler({
					type: "before_agent_start",
					prompt,
					systemPrompt: currentPrompt,
				})) as BeforeAgentStartResult | undefined;
				if (res) {
					if (res.message) {
						messages.push(res.message);
						modified = true;
					}
					if (res.systemPrompt !== undefined) {
						currentPrompt = res.systemPrompt;
						modified = true;
					}
				}
			} catch (err) {
				this.emitError("before_agent_start", err);
			}
		}

		return modified
			? {
					messages: messages.length > 0 ? messages : undefined,
					systemPrompt: currentPrompt !== systemPrompt ? currentPrompt : undefined,
				}
			: undefined;
	}

	/** 触发压缩前检查（支持取消压缩） */
	async emitSessionBeforeCompact(tokensBefore: number): Promise<boolean> {
		const set = this.handlers.get("session_before_compact");
		if (!set || set.size === 0) return false;

		for (const handler of set) {
			try {
				const res = (await handler({
					type: "session_before_compact",
					tokensBefore,
				})) as SessionBeforeCompactResult | undefined;
				if (res?.cancel) {
					return true; // 请求取消压缩
				}
			} catch (err) {
				this.emitError("session_before_compact", err);
			}
		}
		return false;
	}

	/** 触发资源发现聚合 */
	async emitResourcesDiscover(
		cwd: string,
		reason: "startup" | "reload",
	): Promise<ResourcesDiscoverResult> {
		const set = this.handlers.get("resources_discover");
		if (!set || set.size === 0) return {};

		const toolPaths: string[] = [];
		const promptPaths: string[] = [];

		for (const handler of set) {
			try {
				const res = (await handler({
					type: "resources_discover",
					cwd,
					reason,
				})) as ResourcesDiscoverResult | undefined;
				if (res?.toolPaths) {
					toolPaths.push(...res.toolPaths);
				}
				if (res?.promptPaths) {
					promptPaths.push(...res.promptPaths);
				}
			} catch (err) {
				this.emitError("resources_discover", err);
			}
		}

		return {
			toolPaths: toolPaths.length > 0 ? toolPaths : undefined,
			promptPaths: promptPaths.length > 0 ? promptPaths : undefined,
		};
	}

	/** 触发 Provider 请求 Headers 修改 */
	async emitBeforeProviderHeaders(
		provider: string,
		headers: Record<string, string>,
	): Promise<Record<string, string>> {
		const set = this.handlers.get("before_provider_headers");
		if (!set || set.size === 0) return headers;

		const current = { ...headers };
		for (const handler of set) {
			try {
				await handler({
					type: "before_provider_headers",
					provider,
					headers: current,
				});
			} catch (err) {
				this.emitError("before_provider_headers", err);
			}
		}
		return current;
	}

	/** 触发 Provider 请求 Payload 修改 */
	async emitBeforeProviderRequest(provider: string, payload: unknown): Promise<unknown> {
		const set = this.handlers.get("before_provider_request");
		if (!set || set.size === 0) return payload;

		let current = payload;
		for (const handler of set) {
			try {
				const res = await handler({
					type: "before_provider_request",
					provider,
					payload: current,
				});
				if (res !== undefined) {
					current = res;
				}
			} catch (err) {
				this.emitError("before_provider_request", err);
			}
		}
		return current;
	}

	/** 触发 Provider 响应审计 */
	async emitAfterProviderResponse(
		provider: string,
		status: number,
		headers: Record<string, string>,
	): Promise<void> {
		const set = this.handlers.get("after_provider_response");
		if (!set || set.size === 0) return;

		for (const handler of set) {
			try {
				await handler({
					type: "after_provider_response",
					provider,
					status,
					headers,
				});
			} catch (err) {
				this.emitError("after_provider_response", err);
			}
		}
	}
}
