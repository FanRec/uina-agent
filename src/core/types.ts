import type { ImageContent } from "./content.js";
/** 跨层共享的公共类型：会话消息与模型协议形状。 */

export type DeliveryMode = "direct" | "steer" | "followUp";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ToolExecutionMode = "parallel" | "sequential";
export type AssistantStatus = "complete" | "length" | "aborted" | "error";
export type FinishReason = "stop" | "tool_calls" | "length";
export type ToolResultStatus =
	| "succeeded"
	| "failed"
	| "cancelled"
	| "unknown"
	| "not_started";

/**
 * 一个由工具自行声明的通用外部效果事实。Core 只存储与聚合 effectType/标识，
 * 不理解 "file.write / command.exec / task.dispatch" 等具体语义——那是声明它的
 * 工具（Extension 层）与其消费者（如 Host 装配）之间的契约。
 */
export interface ToolEffect {
	/** 声明方自定义的效果类型标签（约定用点分小写，如 "file.write"）。 */
	effectType: string;
	/** 外部操作的稳定身份（jobId、子代理 id 等），存在时用于跨会话追踪。 */
	externalOperationId?: string;
	/** 人类可读的摘要行，用于回溯通知等展示面。 */
	label?: string;
	/** 声明方自定义的补充数据，Core 不解释。 */
	data?: unknown;
}

export interface QueuedMessage {
	id: string;
	order: number;
	mode: Exclude<DeliveryMode, "direct">;
	text: string;
 images?: ImageContent[];
	source?: { kind: "user" | "runtime" | "agent"; type: string; ref?: string; provenance?: { branchId?: string; abandoned?: boolean } };
	data?: unknown;
}

/** Opaque replay content is produced and consumed only by the matching adapter. */
export interface ProviderReplay { format: string; blocks: unknown[]; }

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	totalTokens?: number;
}

export interface ContextSegments {
	system: number;
	prompt: number;
	assistant: number;
	thinking: number;
	tools: number;
}

export interface DiscoveredModel {
 imageInput?: boolean;
	id: string;
	contextWindow?: number;
	thinkingLevels?: readonly ThinkingLevel[];
}

/** 模型流式输出中的一个增量片段（按到达顺序回调）。 */
export type StreamDelta =
	| { kind: "provider_replay"; replay: ProviderReplay }
	| { kind: "thinking"; text: string }
	| { kind: "thinking_signature"; signature: string }
	| { kind: "text"; text: string }
	| { kind: "usage"; usage: Usage }
	| {
			kind: "tool_call";
			call: { id: string; name: string; args: string; argsValid?: boolean; thinkingSignature?: string };
		}
	| { kind: "finish"; reason: FinishReason };

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
	/** Provider-native reasoning signature associated with this tool call, when supplied. */
	thinkingSignature?: string;
}

export interface SystemAgentMessage {
	id?: string;
	role: "system";
	content: string;
 images?: ImageContent[];
	timestamp?: string;
}

export interface UserAgentMessage {
	id?: string;
	role: "user";
	content: string;
 images?: ImageContent[];
	timestamp?: string;
}

export interface AssistantAgentMessage {
	id?: string;
	role: "assistant";
	content: string;
 images?: ImageContent[];
	thinking?: string;
	thinkingSignature?: string;
	providerReplay?: ProviderReplay;
	tool_calls?: CompletedToolCall[];
	status?: AssistantStatus;
	usage?: Usage;
	timestamp?: string;
}

export interface ToolAgentMessage {
 details?: unknown;
	id?: string;
	role: "tool";
	tool_call_id: string;
	name?: string;
	content: string;
 images?: ImageContent[];
	status?: ToolResultStatus;
	timestamp?: string;
}

export interface CustomAgentMessage {
	id?: string;
	role: "custom";
	customType: string;
	content: string;
 images?: ImageContent[];
	display?: boolean;
	details?: unknown;
	timestamp?: string;
}

export type AgentMessage =
	| SystemAgentMessage
	| UserAgentMessage
	| AssistantAgentMessage
	| ToolAgentMessage
	| CustomAgentMessage;

export type ChatMsg =
	| { role: "system" | "user"; content: string; images?: ImageContent[] }
	| {
			role: "assistant";
			content: string;
 images?: ImageContent[];
			thinking?: string;
			thinkingSignature?: string;
			providerReplay?: ProviderReplay;
			tool_calls?: CompletedToolCall[];
			status?: AssistantStatus;
			usage?: Usage;
		}
	| {
			role: "tool";
			tool_call_id: string;
   details?: unknown;
			content: string;
 images?: ImageContent[];
			status?: ToolResultStatus;
		};

export interface ModelRequest {
	messages: ChatMsg[];
	tools?: ToolDef[];
	thinkingLevel?: ThinkingLevel;
	/** Request-scoped transport middleware. It is always present, including when no extensions are active. */
	providerHooks: import("../runtime/hooks.js").ProviderHooks;
}

export type ThinkingWireFormat = "openai" | "deepseek" | "qwen";
export type GeminiThinkingFormat = "budget" | "level";

export interface ModelCompat {
	readonly thinkingFormat?: ThinkingWireFormat;
	readonly geminiToolCallIds?: boolean;
	readonly geminiThinkingFormat?: GeminiThinkingFormat;
}

/** 模型规格：纯数据，不携带端点、凭据与传输方法（对齐 Pi packages/ai/src/types.ts:830） */
export interface Model {
 /** Explicit catalog/config fact. Missing means unknown. */
 readonly imageInput?: boolean;
	/** wire 上的模型标识（请求体中的 model 字段） */
	readonly id: string;
	/** 显示名称 */
	readonly name: string;
	/** 所属 Provider 的 id 字符串标签（绝非对象实例） */
	readonly providerId: string;
	/** 有效上下文上限（token），已知时为数字，未知为 undefined */
	readonly contextWindow?: number;
	readonly maxContextWindow?: number;
	readonly modelContextWindow?: number;
	/** 最大输出 token 数（Anthropic messages 必须显式给出） */
	readonly maxOutputTokens?: number;
	/** 支持的思考等级档位 */
	readonly thinkingLevels?: readonly ThinkingLevel[];
	/** 上下文投影是否携带历史 thinking */
	readonly includeThinking?: boolean;
	/** 思考档位与数值 token 的预算映射 */
	readonly thinkingBudgets?: Partial<Record<ThinkingLevel, number>>;
	/** 协议兼容参数 */
	readonly compat?: ModelCompat;
}

/** 通信端点：持有 baseUrl、apiKey 与传输，不持有具体模型规格（对齐 Pi packages/ai/src/models.ts:97） */
export interface Provider {
	/** Provider 身份标识（配置条目名或扩展注册名） */
	readonly id: string;
	readonly name?: string;
	readonly baseUrl?: string;
	/** Dynamic providers may refresh their current model catalog. Entries without
	 * a contextWindow are discovery-only and must not become selectable. */
	refreshModels?(): Promise<readonly DiscoveredModel[]>;
	/**
	 * 以给定 Model 向该端点发起流式对话：逐段回调 onDelta。
	 * 协议错误、异常断流和不完整响应必须抛错；主动中断通过 signal 传播。
	 */
	stream(
		model: Model,
		req: ModelRequest,
		onDelta: (d: StreamDelta) => void,
		signal?: AbortSignal,
	): Promise<void>;
}

export type ModelStreamFn = (
	model: Model,
	req: ModelRequest,
	onDelta: (d: StreamDelta) => void,
	signal?: AbortSignal,
) => Promise<void>;
