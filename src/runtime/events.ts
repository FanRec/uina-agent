import type { ChatMsg, ContextSegments, ThinkingLevel } from "../core/types.js";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer Item)[]
		? readonly DeepReadonly<Item>[]
		: T extends object
			? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
			: T;

export interface BeforeAgentStartEvent {
	readonly type: "before_agent_start";
	readonly prompt: string;
	readonly systemPrompt: string;
}

export interface AgentStartEvent { readonly type: "agent_start"; readonly turnSeq: number; }
export interface AgentEndEvent { readonly type: "agent_end"; readonly turnSeq: number; readonly success: boolean; readonly error?: string; }
export interface AgentSettledEvent { readonly type: "agent_settled"; readonly turnSeq: number; }
export interface TurnStartEvent { readonly type: "turn_start"; readonly turnNumber: number; readonly userText: string; }
export interface TurnEndEvent { readonly type: "turn_end"; readonly turnNumber: number; readonly usage?: { readonly usedTokens: number; readonly contextWindow?: number; readonly segments?: ContextSegments }; }

export interface ContextEvent { readonly type: "context"; readonly messages: readonly DeepReadonly<ChatMsg>[]; }
export interface ToolCallEvent { readonly type: "tool_call"; readonly toolName: string; readonly args: DeepReadonly<Record<string, unknown>>; readonly callId: string; }
export interface ToolResultEvent { readonly type: "tool_result"; readonly toolName: string; readonly args: DeepReadonly<Record<string, unknown>>; readonly result: string; readonly status: import("../core/types.js").ToolResultStatus; readonly callId: string; }
export interface ModelSelectEvent { readonly type: "model_select"; readonly model: string; readonly previousModel?: string; }
export interface ThinkingLevelSelectEvent { readonly type: "thinking_level_select"; readonly level: ThinkingLevel; readonly previousLevel?: ThinkingLevel; }
export interface SessionBeforeCompactEvent { readonly type: "session_before_compact"; readonly tokensBefore: number; }
export interface SessionCompactEvent { readonly type: "session_compact"; readonly summary: string; readonly tokensBefore: number; readonly retainedTailCount: number; }
export interface SessionCompactFailedEvent { readonly type: "session_compact_failed"; readonly error: string; }

export interface OutputStartEvent { readonly type: "output_start"; readonly streamId: string; readonly channel: "content" | "thinking" | "tool"; }
export interface OutputUpdateEvent { readonly type: "output_update"; readonly streamId: string; readonly offset: number; readonly channel: "content" | "thinking" | "tool"; readonly text: string; }
export interface OutputEndEvent { readonly type: "output_end"; readonly streamId: string; readonly channel: "content" | "thinking" | "tool"; }
export interface OutputInterruptedEvent { readonly type: "output_interrupted"; readonly streamId: string; readonly channel: "content" | "thinking" | "tool"; readonly reason: "external" | "self" | "cancelled" | "error"; readonly spokenUntil?: number; }

export interface BeforeProviderHeadersEvent { readonly type: "before_provider_headers"; readonly provider: string; readonly headers: Readonly<Record<string, string>>; }
export interface BeforeProviderRequestEvent { readonly type: "before_provider_request"; readonly provider: string; readonly payload: DeepReadonly<unknown>; }
export interface AfterProviderResponseEvent { readonly type: "after_provider_response"; readonly provider: string; readonly status: number; readonly headers: Readonly<Record<string, string>>; }

export type RuntimeEvent =
	| BeforeAgentStartEvent | AgentStartEvent | AgentEndEvent | AgentSettledEvent | TurnStartEvent | TurnEndEvent
	| ContextEvent | ToolCallEvent | ToolResultEvent | ModelSelectEvent | ThinkingLevelSelectEvent
	| SessionBeforeCompactEvent | SessionCompactEvent | SessionCompactFailedEvent
	| OutputStartEvent | OutputUpdateEvent | OutputEndEvent | OutputInterruptedEvent
	| BeforeProviderHeadersEvent | BeforeProviderRequestEvent | AfterProviderResponseEvent;

export type OutputEvent = OutputStartEvent | OutputUpdateEvent | OutputEndEvent | OutputInterruptedEvent;
