import type { ImageContent } from "./content.js";
/** 跨层共享的公共类型：会话消息与模型协议形状。 */

export type DeliveryMode = "direct" | "steer" | "followUp";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** 协议决定的历史 thinking 回放范围。缺省语义为 none。
 * - none：不回放；
 * - all：每轮 assistant 都回放（thinking 模式下须原样回传推理原文）。
 * 回放范围由协议决定，与这一轮有没有工具调用无关。 */
export type ThinkingReplay = "none" | "all";
export type ToolExecutionMode = "parallel" | "sequential";
export type AssistantStatus = "complete" | "length" | "aborted" | "error";
export type FinishReason = "stop" | "tool_calls" | "length";
export type ToolResultStatus = "succeeded" | "failed" | "cancelled" | "unknown" | "not_started";

/** Transport metadata for one fixed producer material and one delivery attempt. */
export interface HostDeliveryTag {
	key: string;
	attempt: string;
}
export interface HostCommitReceipt extends HostDeliveryTag {
	namespace: string;
	session: string;
	record: string;
	channel: "tool" | "input";
}
export type HostDeliveryState =
	| { kind: "committed"; receipt: HostCommitReceipt }
	| ({ kind: "pending"; attempt: string; since: string } & (
			| { channel: "tool"; activity: "processing" }
			| { channel: "input"; activity: "queued" | "processing" }
	  ))
	| { kind: "absent" }
	| { kind: "unavailable"; reason: string };
export type HostRetireReply =
	| { kind: "retired" }
	| { kind: "committed"; receipt: HostCommitReceipt }
	| { kind: "changed"; state: HostDeliveryState }
	| { kind: "unavailable"; reason: string };
export interface HostDeliveryPort {
	readonly namespace: string;
	readonly session: string;
	readonly durability: "durable" | "volatile";
	inspect(key: string): Promise<HostDeliveryState>;
	retire(key: string, expectedAttempt: string): Promise<HostRetireReply>;
}
/** Bound by the actual registration, never by model parameters or message content. */
export interface InputDeliveryOwner {
	namespace: string;
	isActive(): boolean;
}

/** ToolResultStatus 的合法值集合（P2-H 单一事实）：broker 的运行时校验与
 * recovery.checkEvent 的 journal 校验共用；第三方 Tool 是不可信边界，两处
 * 校验都保留。 */
export const TOOL_RESULT_STATUSES: readonly ToolResultStatus[] = [
	"succeeded",
	"failed",
	"cancelled",
	"unknown",
	"not_started",
];

/**
 * 一个由工具自行声明的通用外部效果事实。Core 只存储与聚合 effectType/标识，
 * 不理解 "file.write / command.exec" 等具体语义——那是声明它的
 * 工具（Extension 层）与其消费者（如 Host 装配）之间的契约。
 */
export interface ToolEffect {
	/** 声明方自定义的效果类型标签（约定用点分小写，如 "file.write"）。 */
	effectType: string;
	/** 外部操作的稳定身份，存在时用于跨会话追踪。 */
	externalOperationId?: string;
	/** 人类可读的摘要行，用于回溯通知等展示面。 */
	label?: string;
	/** 声明方自定义的补充数据，Core 不解释。 */
	data?: unknown;
}

export interface InputSource {
	kind: "user" | "runtime" | "agent";
	type: string;
	ref?: string;
	origin?: "external" | "internal";
	channel?: string;
	actor?: { id?: string; label?: string; relation?: "operator" | "participant" | "unknown" };
	provenance?: { branchId?: string; abandoned?: boolean };
}
export interface InputProvenance {
	eventId: string;
	source?: InputSource;
	receivedAt?: string;
}
export interface ModelContextMeta {
	input?: InputProvenance;
	group?: { id: string; index: number; size: number };
	kind?: string;
	/** Stable canonical request-bearing entry identity; never serialized to Provider wire. */
	entryId?: string;
}

export interface QueuedMessage {
	receipt?: HostDeliveryTag;
	receiptNamespace?: string;
	id: string;
	order: number;
	mode: Exclude<DeliveryMode, "direct">;
	text: string;
	images?: ImageContent[];
	source?: InputSource;
	receivedAt?: string;
	data?: unknown;
}

/** Opaque replay content is produced and consumed only by the matching adapter. */
export interface ProviderReplay {
	format: string;
	blocks: unknown[];
}

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
	| { kind: "provider_retry"; attempt: number; delayMs: number; status?: number; reason: string }
	| { kind: "provider_recovered"; attempt: number }
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
	input?: InputProvenance;
	id?: string;
	role: "system";
	content: string;
	images?: ImageContent[];
	timestamp?: string;
}

export interface UserAgentMessage {
	input?: InputProvenance;
	id?: string;
	role: "user";
	content: string;
	images?: ImageContent[];
	timestamp?: string;
}

export interface AssistantAgentMessage {
	input?: InputProvenance;
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

/**
 * 工具消息的可选模型视图（信息注入重构）：tools.transformResult 的改写正文随同一条
 * Tool 消息持久化。canonical 字段仍是执行事实的唯一权威；模型可见投影在历史转换时
 * 采用 modelView ?? canonical 的字段级回退，status 永远来自 canonical。
 * 原始结果未被改写时不写冗余 modelView。
 */
export interface ModelToolView {
	readonly content: string;
	readonly images?: ImageContent[];
	/** 内部投影信息；不保证 Provider 会序列化，不能冒充模型已读到的正文。 */
	readonly details?: unknown;
}

export interface ToolAgentMessage {
	receipt?: HostDeliveryTag;
	receiptNamespace?: string;
	input?: InputProvenance;
	details?: unknown;
	id?: string;
	role: "tool";
	tool_call_id: string;
	name?: string;
	content: string;
	images?: ImageContent[];
	status?: ToolResultStatus;
	modelView?: ModelToolView;
	timestamp?: string;
}

export interface CustomAgentMessage {
	input?: InputProvenance;
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

export type ChatMsg = { context?: ModelContextMeta } & (
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
			/** 已解析的模型视图（历史转换的输入直接携带时）；转换层按同一规则回退。 */
			modelView?: ModelToolView;
	  }
);

export interface ModelRequest {
	messages: ChatMsg[];
	tools?: ToolDef[];
	thinkingLevel?: ThinkingLevel;
	/** Request-scoped transport middleware. It is always present, including when no extensions are active. */
	providerHooks: import("../runtime/hooks.js").ProviderHooks;
	/**
	 * 请求关联诊断 id（Subject 每次真实发送时建立）。只用于内部对账（usage/装配追踪/
	 * Wire 观察），绝不进入 Provider 网络载荷；缺省（如扩展直连 stream）表示无关联。
	 */
	requestId?: string;
	/**
	 * Wire 观察出口（只观察，无返回协议）：在协议编码完成、HTTP 序列化发送之前回调。
	 * 观察方不得借它修改请求。
	 */
	onWireObservation?: (observation: ProviderWireObservation) => void;
}

/** Provider 载荷的摘要事实：默认只记录哈希与量级，不保存原始正文。 */
export interface WirePayloadSummary {
	/** 序列化载荷的 SHA-256（诊断对账用；不含任何凭据——载荷本身不携带鉴权）。 */
	readonly hash: string;
	/** 序列化后的 UTF-8 字节数。 */
	readonly bytes: number;
	/** 已知形状下的消息区条数（messages / contents）；未知形状缺省。 */
	readonly messageCount?: number;
	/** 已知形状下的工具声明条数（tools 数组长度）；未知形状缺省。 */
	readonly toolCount?: number;
}

/** 一次真实发送的 Provider Wire 观察：实际准备发送载荷的摘要（HTTP 序列化之前）。 */
export interface ProviderWireObservation {
	readonly requestId?: string;
	readonly provider: string;
	readonly payload: WirePayloadSummary;
}

/**
 * The complete model-semantic request assembled by Core before a Provider turns
 * it into wire format.  This deliberately excludes transport concerns such as
 * retries, headers, endpoints and tracing metadata.
 */
export interface RequestProjection {
	readonly projectionId: string;
	readonly modelKey: string;
	readonly messages: readonly ChatMsg[];
	readonly tools: readonly ToolDef[];
	readonly thinkingLevel?: ThinkingLevel;
}

export interface TokenMeasurement {
	readonly inputTokens: number;
	readonly kind: "exact" | "approximate";
	readonly source: string;
	readonly segments?: ContextSegments;
}

export type ContextSnapshotBasis = "idle_baseline" | "active_request";

export interface ContextSnapshot {
	readonly projectionId: string;
	readonly modelKey: string;
	readonly basis: ContextSnapshotBasis;
	readonly source: string;
	readonly inputTokens: number;
	readonly contextWindow?: number;
	readonly availableInputBudget?: number;
	readonly measurementKind: "exact" | "approximate";
	readonly segments?: ContextSegments;
}

export interface RequestInspection {
	readonly projection: RequestProjection;
	/** 本次装配实际采用的 History View（压缩后可见历史）：与 projection.messages 中的
	 * 历史段同一对象集合；不含 System、固定 Guidance、当前动态 Source 与工具定义。
	 * 历史压缩（Compaction）据此规划边界与预算，不从完整投影里按 role/kind 反猜。 */
	readonly history: readonly ChatMsg[];
	readonly measurement: TokenMeasurement;
	readonly contextWindow?: number;
	readonly inputBudget?: number;
	/** 预览标记：本检视按当前状态预测请求，不承诺曾发送（活动请求观察另经 Subject 查询）。 */
	readonly basis?: "preview";
	/** 预览的独立身份；不冒充活动请求的 requestId。 */
	readonly requestId?: string;
	/** 本次预览装配的来源追踪（与活动请求的 RequestAssemblyTrace 同一形状）。 */
	readonly assembly?: RequestAssemblyTrace;
}

/**
 * Context Source 合同（信息注入重构）：扩展以声明方式提供三类模型可见信息。
 *
 * - guidance：扩展作者写下的稳定、可信用法/协议；注册时确定，不随在线状态或请求内容变化。
 *   不允许把网页、游戏聊天、工具返回等外部数据转换成此类型。
 * - capability：当前能做什么（动态状态、可用入口、少量 Affordance）；不可用时返回简短
 *   真实状态或 null，不保留上次成功值。
 * - observation：此刻提供给模型的事实或证据（当前世界快照；未来也可承载已检索的记忆片段，
 *   用 source.type="memory.recall" 标出）。检索证据不等于当前发生的事件。
 *
 * read() 是只读快照：不得持久写入、推进游标、消费事件、触发模型请求或产生业务副作用。
 * 新输入走 Input，历史走 Session，工具结果走 Tool Result——三者不是第四种上下文源。
 */
export type ContextSourceKind = "guidance" | "capability" | "observation";

export interface ContextRead {
	readonly modelKey: string;
	readonly signal: AbortSignal;
}

/** 动态 Source 的单次只读快照值。 */
export interface ContextValue {
	readonly text: string;
	readonly images?: readonly ImageContent[];
	/** 来源事实由 Source 自报：类型、内外部与可选引用；展示外壳由 Composer 统一渲染。 */
	readonly source: {
		readonly type: string;
		readonly origin: "internal" | "external";
		readonly ref?: string;
	};
	/** 有真实观察时间才填写；没有就保持未知。 */
	readonly observedAt?: string;
	/** 仅用于显示与对照（诊断/变化追踪）；不参与事实真实性判定，不实现按它缓存。 */
	readonly revision?: string;
}

/**
 * 文件式 guidance 的编译元数据（扩展 Prompt 文件机制）：文件在注册时一次性编译为
 * 静态文本，这里只携带诊断对账信息，不参与装配语义；不写入模型正文或 Journal。
 */
export interface PromptCompileMeta {
	/** 相对扩展资源根的入口路径。 */
	readonly entry: string;
	/** 实际读取的文件（相对资源根，按首次访问顺序去重）。 */
	readonly sources: readonly string[];
	/** 编译后正文的 SHA-256。 */
	readonly hash: string;
}

export type ContextSource =
	| {
			readonly id: string;
			readonly kind: "guidance";
			readonly text: string;
			/** 文件式注册时由 Runner 附加的编译元数据；内联注册没有。 */
			readonly prompt?: PromptCompileMeta;
	  }
	| {
			readonly id: string;
			readonly kind: "capability" | "observation";
			read(ctx: Readonly<ContextRead>): Promise<ContextValue | null> | ContextValue | null;
	  };

/**
 * 文件式 guidance 的注册声明（ExtensionAPI.provideContext 的重载入参）：注册时由
 * Runner 在扩展资源根内编译为普通静态 guidance；不允许与 text 同时指定。
 */
export interface FileGuidanceSource {
	readonly id: string;
	readonly kind: "guidance";
	/** 相对扩展资源根的 Markdown 入口（可经 {{include:...}} 组合根内其他 .md）。 */
	readonly file: string;
}

/**
 * Registry 补齐 owner/id 后的不可变贡献（不是 ChatMsg；排版归 Request Composer）。
 * owner 由 Registry 注入真实激活身份，不由 Source 自报；guidance 的值只有 text。
 */
export type ContextContribution = Readonly<{
	key: string;
	owner: string;
	kind: ContextSourceKind;
	value: Readonly<{ text: string }> | ContextValue;
	/** 文件式 guidance 的编译元数据（诊断对账用）。 */
	prompt?: PromptCompileMeta;
}>;

/**
 * 单个 Source 本次未贡献的事实（Trace 条目）。失败与注销必须可见，不得伪装成
 * "环境无变化"，也不得用旧数据顶替。
 */
export interface ContextSourceTraceEntry {
	readonly key: string;
	readonly owner: string;
	readonly id: string;
	readonly kind: ContextSourceKind;
	readonly status: "included" | "empty" | "error" | "unregistered";
	/** 注入到本次投影的第几条消息（included 时填写）。 */
	readonly messageIndex?: number;
	/** 贡献正文在该消息中的片段偏移（UTF-16 code unit；included 时填写）。 */
	readonly charOffset?: number;
	readonly chars?: number;
	readonly revision?: string;
	readonly observedAt?: string;
	/** 文件式 guidance 的编译元数据（入口、依赖文件与内容指纹；诊断对账用）。 */
	readonly prompt?: PromptCompileMeta;
	/** empty/error/unregistered 时的原因说明。 */
	readonly reason?: string;
}

/** 一次装配的来源追踪（附随诊断；不进 messages、不进 Journal）。 */
export interface RequestAssemblyTrace {
	readonly sources: readonly ContextSourceTraceEntry[];
}

/** context.collect 端口的返回：贡献 + 未贡献事实（各自按 key 稳定排序由 Composer 负责）。 */
export interface ContextCollection {
	readonly contributions: readonly ContextContribution[];
	readonly omitted: readonly ContextSourceTraceEntry[];
}

/** 一次模型调用的真实时序，单位毫秒，相对请求发出时刻。 */
export interface GenerationTiming {
	/** 请求发出到首个内容 delta（思考/正文/工具调用），含网络与排队。 */
	readonly ttftMs: number;
	/** 首个内容 delta 到末个内容 delta：整步真实解码窗口。 */
	readonly decodeMs: number;
}

/** Usage reported by one completed or in-flight Provider request. */
export interface RequestUsage {
	readonly callId: string;
	readonly projectionId?: string;
	readonly modelKey?: string;
	readonly promptTokens?: number;
	readonly outputTokens?: number;
	readonly reasoningTokens?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly totalTokens?: number;
	readonly timing?: GenerationTiming;
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
	/** 最大输出 token 数（Anthropic messages 必须显式给出） */
	readonly maxOutputTokens?: number;
	/** 显式覆盖每请求输入预算；缺省走 core/model.ts 的默认上限，0 表示不额外设限 */
	readonly inputBudgetTokens?: number;
	/** 支持的思考等级档位 */
	readonly thinkingLevels?: readonly ThinkingLevel[];
	/** 历史 thinking 的回放范围；缺省按 none 处理 */
	readonly thinkingReplay?: ThinkingReplay;
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
	/** Optional exact or provider-specific context measurement. */
	measureContext?(model: Model, projection: RequestProjection): TokenMeasurement | undefined;
	/**
	 * 以给定 Model 向该端点发起流式对话：逐段回调 onDelta。
	 * 协议错误、异常断流和不完整响应必须抛错；主动中断通过 signal 传播。
	 */
	stream(model: Model, req: ModelRequest, onDelta: (d: StreamDelta) => void, signal?: AbortSignal): Promise<void>;
}

export type ModelStreamFn = (
	model: Model,
	req: ModelRequest,
	onDelta: (d: StreamDelta) => void,
	signal?: AbortSignal,
) => Promise<void>;
