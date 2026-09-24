import type { ContextSnapshot, QueuedMessage, RequestUsage, ThinkingLevel } from "../core/types.js";

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
	| SessionCompactStartEvent | SessionCompactProgressEvent | SessionCompactEvent
	| OutputStartEvent | OutputUpdateEvent | OutputEndEvent | OutputInterruptedEvent
	| UsageUpdateEvent | ContextUpdateEvent
	| ProviderRetryEvent | ProviderRecoveredEvent
	| QueueEvent | TurnAbortedEvent | ErrorEvent
	| InputAcceptedEvent
	| CustomMessageEvent | CustomEntryEvent;

export interface AgentStartEvent { readonly type: "agent_start"; readonly turnSeq: number; }
export interface AgentEndEvent { readonly type: "agent_end"; readonly turnSeq: number; readonly success: boolean; readonly error?: string; }
export interface AgentSettledEvent { readonly type: "agent_settled"; readonly turnSeq: number; }
export interface TurnStartEvent { readonly type: "turn_start"; readonly turnNumber: number; readonly userText: string; readonly images?: readonly import("../core/content.js").ImageContent[]; }

/**
 * 输入已接纳（事实，一次输入恰好一条）。
 *
 * 与 turn_start 的分工：turn_start 表示"一个可见回合已经开始"，排队输入要等到被消费
 * 才触发，且不携带来源；本事件在输入通过受理校验、进入直接开跑或队列时立即发出，
 * 是"外部/运行时有人有东西在动"的唯一权威事实，供应用活动感知等消费方使用。
 *
 * 只携带最小来源事实：不携带正文与图片（正文事实已由 journal 的 input 记录持有）。
 * source 保持 core InputSource 原样，消费方据 kind/origin 自行归类，不靠内容或时机猜测。
 */
export interface InputAcceptedEvent {
	readonly type: "input_accepted";
	readonly inputId: string;
	readonly source?: import("../core/types.js").InputSource;
	readonly receivedAt: string;
}
export interface TurnEndEvent {
	readonly type: "turn_end";
	readonly turnNumber: number;
	readonly requestUsage?: RequestUsage;
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
	readonly usage: RequestUsage;
}
export interface ContextUpdateEvent {
	readonly type: "context_update";
	readonly snapshot: ContextSnapshot;
}
export interface ProviderRetryEvent {
	readonly type: "provider_retry";
	readonly provider: string;
	readonly attempt: number;
	readonly delayMs: number;
	readonly status?: number;
	readonly reason: string;
}
export interface ProviderRecoveredEvent {
	readonly type: "provider_recovered";
	readonly provider: string;
	readonly attempt: number;
}
export interface ToolCallEvent { readonly type: "tool_call"; readonly toolName: string; readonly args: DeepReadonly<Record<string, unknown>>; readonly callId: string; }
export interface ToolResultEvent { readonly type: "tool_result"; readonly toolName: string; readonly args: DeepReadonly<Record<string, unknown>>; readonly result: string; readonly images?: readonly import("../core/content.js").ImageContent[]; readonly details?: unknown; readonly status: import("../core/types.js").ToolResultStatus; readonly callId: string; }
export interface ModelSelectEvent { readonly type: "model_select"; readonly model: string; readonly previousModel?: string; }
export interface ThinkingLevelSelectEvent { readonly type: "thinking_level_select"; readonly level: ThinkingLevel; readonly previousLevel?: ThinkingLevel; }
export interface SessionCompactStartEvent {
	readonly type: "session_compact_start";
	readonly operationId: string;
	readonly reason: "manual" | "automatic";
	readonly modelKey: string;
}
export interface SessionCompactProgressEvent {
	readonly type: "session_compact_progress";
	readonly operationId: string;
	readonly phase: "queued" | "planning" | "summarizing" | "applying" | "measuring";
	readonly detail?: string;
}
export interface SessionCompactEvent {
	readonly type: "session_compact";
	readonly operationId: string;
	readonly status: "completed" | "failed" | "cancelled" | "noop";
	readonly summary?: string;
	readonly error?: string;
	readonly tokensBefore?: number;
	readonly tokensAfter?: number;
	/** canonical 主线中压缩后保留的条目数（tailStartsAtEntryId 起算）。 */
	readonly retainedTailEntries?: number;
}

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
