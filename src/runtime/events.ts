import type { ContextSegments, QueuedMessage, ThinkingLevel } from "../core/types.js";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer Item)[]
		? readonly DeepReadonly<Item>[]
		: T extends object
			? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
			: T;

/**
 * RuntimeEvent 是**事实**事件词表（Hook ≠ Event，铁律 L1）：系统告诉世界"这件事已经
 * 发生了"，订阅方无返回值。干预入口（prepare/transform/before/shouldStop）一律走
 * RuntimeHooks 的 hook 词汇（onHook），不得以事件形状混入本流。
 */
export type RuntimeEvent =
	| SessionRewindEvent
	| AgentStartEvent | AgentEndEvent | AgentSettledEvent | TurnStartEvent | TurnEndEvent
	| ToolCallEvent | ToolResultEvent | ModelSelectEvent | ThinkingLevelSelectEvent
	| SessionCompactEvent | SessionCompactFailedEvent
	| OutputStartEvent | OutputUpdateEvent | OutputEndEvent | OutputInterruptedEvent
	| UsageUpdateEvent
	| QueueEvent | TurnAbortedEvent | ErrorEvent
	| CustomMessageEvent | CustomEntryEvent;

export interface AgentStartEvent { readonly type: "agent_start"; readonly turnSeq: number; }
export interface AgentEndEvent { readonly type: "agent_end"; readonly turnSeq: number; readonly success: boolean; readonly error?: string; }
export interface AgentSettledEvent { readonly type: "agent_settled"; readonly turnSeq: number; }
export interface TurnStartEvent { readonly type: "turn_start"; readonly turnNumber: number; readonly userText: string; readonly images?: readonly import("../core/content.js").ImageContent[]; }
export interface TurnEndEvent {
	readonly type: "turn_end";
	readonly turnNumber: number;
	readonly usage?: {
		readonly usedTokens: number;
		readonly contextWindow?: number;
		readonly segments?: ContextSegments;
		readonly actual?: boolean;
		readonly cacheRead?: number;
		readonly cacheWrite?: number;
		readonly inputTokens?: number;
		readonly outputTokens?: number;
	};
}

/**
 * 单次模型调用的真实用量快照。
 *
 * 目的：模型服务端在一次调用的响应收尾就会带上真实 usage，而 turn_end 要等整个回合
 * （可能包含几十次模型调用、工具往返）才发一次。只靠 turn_end 上报，底栏的上下文占用
 * 就会"完成一次任务之后才更新"。这个事件让消费者在每次调用边界就能刷新。
 *
 * 与 turn_end 的区别是**粒度不是语义**：它不表示回合结束，不携带回合级字段，
 * 只回答"此刻上下文里真实有多少 token"。
 */
export interface UsageUpdateEvent {
	readonly type: "usage_update";
	/**
	 * 本次模型调用的标识。同一个 callId 会发多条 usage_update（服务端在调用进行中
	 * 反复推送累积快照），消费者必须按它去重/覆盖，而不是每条都当作增量累加。
	 */
	readonly callId: string;
	readonly usedTokens: number;
	readonly contextWindow?: number;
	readonly segments?: ContextSegments;
	readonly actual?: boolean;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
}
export interface ToolCallEvent { readonly type: "tool_call"; readonly toolName: string; readonly args: DeepReadonly<Record<string, unknown>>; readonly callId: string; }
export interface ToolResultEvent { readonly type: "tool_result"; readonly toolName: string; readonly args: DeepReadonly<Record<string, unknown>>; readonly result: string; readonly images?: readonly import("../core/content.js").ImageContent[]; readonly details?: unknown; readonly status: import("../core/types.js").ToolResultStatus; readonly callId: string; }
export interface ModelSelectEvent { readonly type: "model_select"; readonly model: string; readonly previousModel?: string; }
export interface ThinkingLevelSelectEvent { readonly type: "thinking_level_select"; readonly level: ThinkingLevel; readonly previousLevel?: ThinkingLevel; }
export interface SessionCompactEvent { readonly type: "session_compact"; readonly summary: string; readonly tokensBefore: number; readonly retainedTailCount: number; }
export interface SessionCompactFailedEvent { readonly type: "session_compact_failed"; readonly error: string; }

export interface OutputStartEvent { readonly type: "output_start"; readonly streamId: string; readonly channel: "content" | "thinking" | "tool"; }
export interface OutputUpdateEvent { readonly type: "output_update"; readonly streamId: string; readonly offset: number; readonly channel: "content" | "thinking" | "tool"; readonly text: string; }
export interface OutputEndEvent { readonly type: "output_end"; readonly streamId: string; readonly channel: "content" | "thinking" | "tool"; }
export interface OutputInterruptedEvent { readonly type: "output_interrupted"; readonly streamId: string; readonly channel: "content" | "thinking" | "tool"; readonly reason: "external" | "self" | "cancelled" | "error"; readonly spokenUntil?: number; }

export interface QueueEvent { readonly type: "queue"; readonly items: readonly DeepReadonly<QueuedMessage>[]; }
export interface TurnAbortedEvent { readonly type: "turn_aborted"; readonly turnNumber: number; }
export interface ErrorEvent { readonly type: "error"; readonly text: string; }

export interface SessionRewindEvent { readonly type: "session_rewind"; readonly turnNumber?: number; readonly requestId: string; readonly rewindId: string; readonly fromId: string; readonly targetId: string; readonly entries: readonly import("../session/types.js").SessionEntry[]; }

/** 扩展有意让模型看见的自定义消息（durable：写 journal 后广播）。 */
export interface CustomMessageEvent {
	readonly type: "custom_message";
	readonly message: { readonly customType: string; readonly content: string; readonly images?: readonly import("../core/content.js").ImageContent[]; readonly display?: boolean; readonly details?: unknown };
}
/** 扩展私有持久条目（durable：写 journal 后广播；不进模型上下文）。 */
export interface CustomEntryEvent {
	readonly type: "custom_entry";
	readonly entry: { readonly customType: string; readonly data?: unknown };
}

export type OutputEvent = OutputStartEvent | OutputUpdateEvent | OutputEndEvent | OutputInterruptedEvent;
