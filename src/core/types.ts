/** 跨层共享的公共类型：会话消息与模型协议形状。 */

export type Role = "system" | "user" | "assistant" | "tool";

export type DeliveryMode = "direct" | "steer" | "followUp";
export type QueueMode = "all" | "one-at-a-time";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ToolExecutionMode = "parallel" | "sequential";
export type AssistantStatus = "complete" | "length" | "aborted" | "error";
export type ToolResultStatus =
	| "succeeded"
	| "failed"
	| "cancelled"
	| "unknown"
	| "not_started";

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
}

export interface DiscoveredModel {
	id: string;
	contextWindow?: number;
	thinkingLevels?: readonly ThinkingLevel[];
}

/** 模型流式输出中的一个增量片段（按到达顺序回调）。 */
export type StreamDelta =
	| { kind: "thinking"; text: string }
	| { kind: "thinking_signature"; signature: string }
	| { kind: "text"; text: string }
	| { kind: "usage"; usage: Usage }
	| {
			kind: "tool_call";
			call: { id: string; name: string; args: string; argsValid?: boolean };
		}
	| { kind: "finish"; reason: string };

/** 发给模型的工具声明（OpenAI function calling 形状）。 */
export interface ToolDef {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

/** 一条完整工具调用（解析后的产物，用于回注消息）。 */
export interface CompletedToolCall {
	id: string;
	name: string;
	args: unknown;
	argsValid?: boolean;
}

export type ChatMsg =
	| { role: "system" | "user"; content: string }
	| {
			role: "assistant";
			content: string;
			thinking?: string;
			thinkingSignature?: string;
			tool_calls?: CompletedToolCall[];
			status?: AssistantStatus;
			usage?: Usage;
		}
	| {
			role: "tool";
			tool_call_id: string;
			content: string;
			status?: ToolResultStatus;
		};

export interface ModelRequest {
	messages: ChatMsg[];
	tools?: ToolDef[];
	thinkingLevel?: ThinkingLevel;
	/** Request-scoped transport middleware. It is always present, including when no extensions are active. */
	providerHooks: import("../runtime/hooks.js").ProviderHooks;
}

export interface ModelProvider {
	readonly name: string;
	/** Provider context limit in tokens when known. */
	readonly contextWindow?: number;
	readonly thinkingLevels?: readonly ThinkingLevel[];
	readonly includeThinking?: boolean;
	/** Dynamic providers may refresh their current model catalog. Entries without
	 * a contextWindow are discovery-only and must not become selectable. */
	refreshModels?(): Promise<readonly DiscoveredModel[]>;
	/**
	 * 流式对话：逐段回调 onDelta。
	 * 协议错误、异常断流和不完整响应必须抛错；主动中断通过 signal 传播。
	 */
	stream(
		req: ModelRequest,
		onDelta: (d: StreamDelta) => void,
		signal?: AbortSignal,
	): Promise<void>;
}
