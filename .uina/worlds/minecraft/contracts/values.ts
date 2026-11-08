/**
 * 跨模块公共纯值：身份、观测与失败。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §2。所有模块共享；不允许在
 * driver/world/runtime/capabilities 中复制或收窄这些类型。纯值不依赖 Bot/Host/UI。
 */

/** 开放领域值：只用于查询输入/输出与 progress 等开放结构，不代替运行状态。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonSchema = Readonly<Record<string, JsonValue>>;

/** 完整非空名称@不可变版本；运行时同样校验格式。 */
export type ExactRef = `${string}@${string}`;

/** 确切 ref，或当前调用作用域已固定的简单名称。 */
export type Selector = string;

/** 通用引用：能力声明/记录/效果/流等。各所有者负责自己发号空间的唯一性。 */
export type Ref = string;

/** 五态结果。未知不能算成功或安全重试。 */
export type Outcome = "succeeded" | "failed" | "cancelled" | "unknown" | "not_started";

export interface Vec3 {
	x: number;
	y: number;
	z: number;
}

/** 完整空间身份：世界分区 + 维度 + 整数格坐标。 */
export interface Place {
	world: Ref;
	worldRevision: Ref;
	dimension: Ref;
	position: Vec3;
}

/** 观察游标：stream 内的有序位置；不同 stream/epoch 之间不可比较。 */
export interface ObservationCursor {
	stream: Ref;
	epoch: Ref;
	sequence: number;
}

export type FactSource = "server" | "prediction" | "history" | "derived";

/** 一组相关字段的真实来源依据；paths 是 value 内的 JSON Pointer。 */
export interface FactBasis {
	paths: string[];
	source: FactSource;
	observedAt: string;
	evidence: Ref[];
}

/**
 * 带真实来源/时间/覆盖/未知的事实。unknown 表达未覆盖路径及原因；
 * 未知数值不得填 0 或默认健康值；derived 不升级为 server。
 */
export interface Fact<T> {
	value: T;
	/** UTC ISO 8601；mixed 时为本地采样时刻。 */
	observedAt: string;
	connection?: Ref;
	incarnation?: Ref;
	source: FactSource | "mixed";
	basis?: FactBasis[];
	coverage: "complete" | "partial";
	unknown: string[];
	evidence: Ref[];
}

export interface HistoryProgress {
	stream: Ref;
	receivedThrough: number | null;
	targetThrough: number | null;
	alignment: "caught_up" | "behind" | "gapped" | "unknown";
}

/**
 * World 查询结果 = Fact + 同点游标（+ 可选历史进度）。
 * cursor=null 只用于静态知识查询（item/recipe）：它们没有观察源，
 * 也就没有可比较的水位（capabilities §2.5：这类查询的 version 恒为 null）。
 */
export interface Observation<T> extends Fact<T> {
	cursor: ObservationCursor | null;
	history?: HistoryProgress[];
}

export interface Progress {
	summary?: string;
	[key: string]: JsonValue | undefined;
}

/**
 * 领域目标是否成立。与 Outcome 正交：Outcome 是一次执行的终态，GoalState 是
 * 世界当前是否满足目标——一个 Run 可能 cancelled 而目标恰好已满足，反之亦然。
 * unknown 不授权安全重试，也不等于失败。
 */
export type GoalState = "satisfied" | "unsatisfied" | "unknown";

/**
 * 长任务的领域工作事实（四种）：已完成、已确认未达、已知阻碍、证据不足。
 * 四者之和等于 total；total 是本次固定目标的规模，不是循环计数。
 */
export interface GoalSummary {
	state: GoalState;
	completed: number;
	remaining: number;
	blocked: number;
	uncertain: number;
	total: number;
}

export interface ImageFileRef {
	path: string;
	sha256: string;
	bytes: number;
	mimeType: "image/png";
	width: number;
	height: number;
}

export interface ProgramOrigin {
	call: Ref;
	program: string | null;
	digest: string;
}

export interface ProgramCheckpoint {
	kind: "program";
	value: JsonValue;
	origin: ProgramOrigin;
}

export interface DomainCheckpoint {
	kind: "domain";
	schema: ExactRef;
	value: JsonValue;
	evidence: Ref[];
}

export type Checkpoint = ProgramCheckpoint | DomainCheckpoint;

export interface DecisionRequest {
	code: "NEEDS_DECISION";
	reason: string;
	checkpoint: ProgramCheckpoint | null;
	origin: ProgramOrigin;
}

/** 结构化调用失败。recoverable 不授权重试未知副作用。 */
export interface CallFailureData {
	code: string;
	source: "program" | "capability" | "world" | "input" | "environment";
	message: string;
	hint?: string;
	dispatch: "not_sent" | "sent" | "unknown";
	progress?: Progress;
	effects: Ref[];
	recoverable: boolean;
}

export interface CallFailure extends Error, CallFailureData {}

/** 已派发效果的当前确认程度；sent 不表示服务器已处理。 */
export interface EffectReceipt {
	effect: Ref;
	dispatch: "not_sent" | "sent" | "unknown";
	completion: "met" | "not_met" | "unknown";
	evidence: Ref[];
}

/**
 * 合同类型（Vec3 / EntityRef / 观察值等）→ 纯 JSON 值。
 * 落库与事实 detail 只收 JsonValue；调用方拿到的对象不可再被上游改动污染。
 */
export function plain(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** 构造 CallFailure 的辅助；消息外的字段原样入错误对象。 */
export function callFailure(data: CallFailureData): CallFailure {
	const error = new Error(data.message) as CallFailure;
	error.name = "CallFailure";
	error.code = data.code;
	error.source = data.source;
	error.dispatch = data.dispatch;
	error.effects = data.effects;
	error.recoverable = data.recoverable;
	if (data.hint !== undefined) error.hint = data.hint;
	if (data.progress !== undefined) error.progress = data.progress;
	return error;
}
