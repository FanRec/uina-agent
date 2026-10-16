/**
 * Minecraft World 公共值、失败与观测（lead 固定合同）。
 *
 * 唯一设计来源：docs/proposals/mc/public-api.md §2（在主工作区 E:/Uina/Uina 可读；
 * worktree 内 docs/proposals 被 gitignore，按 LEAD.md 的路径约定读主工作区）。
 *
 * 本目录（contracts/）由技术负责人独占修改。模块所有者发现合同缺口时，
 * 在 LEAD.md 登记变更请求，不得自行修改本目录任何文件。
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Readonly<Record<string, JsonValue>>;
/** 完整非空名称@不可变版本；运行时同样校验（isExactRef）。 */
export type ExactRef = `${string}@${string}`;
/** 确切 ref 或当前调用作用域已固定的简单名称。 */
export type Selector = string;
export type Ref = string;
export type Outcome = "succeeded" | "failed" | "cancelled" | "unknown" | "not_started";

export interface Vec3 {
	x: number;
	y: number;
	z: number;
}

export interface Place {
	world: Ref;
	worldRevision: Ref;
	dimension: Ref;
	position: Vec3;
}

export interface ObservationCursor {
	stream: Ref;
	epoch: Ref;
	sequence: number;
}

export type FactSource = "server" | "prediction" | "history" | "derived";

export interface FactBasis {
	/** value 内的 JSON Pointer；一组可覆盖 motion/vitals 等相关字段。 */
	paths: string[];
	source: FactSource;
	observedAt: string;
	evidence: Ref[];
}

export interface Fact<T> {
	value: T;
	/** UTC ISO 8601。 */
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

export interface Observation<T> extends Fact<T> {
	cursor: ObservationCursor;
	history?: HistoryProgress[];
}

export interface Progress {
	summary: string;
	measures: { name: string; value: number; unit: string; evidence: Ref[] }[];
}

export interface Checkpoint {
	schema: ExactRef;
	value: JsonValue;
	evidence: Ref[];
}

/** 领域失败的纯数据形状；桥接层负责在脚本域还原 Error 属性。 */
export interface CallFailure extends Error {
	code: string;
	dispatch: "not_sent" | "sent" | "unknown";
	progress?: Progress;
	effects: Ref[];
	/** 不授权重试未确认副作用。 */
	recoverable: boolean;
}

export interface EffectReceipt {
	effect: Ref;
	dispatch: "not_sent" | "sent" | "unknown";
	completion: "met" | "not_met" | "unknown";
	evidence: Ref[];
}

/** ExactRef 运行时校验：非空名称 + "@" + 非空版本。 */
export function isExactRef(value: unknown): value is ExactRef {
	if (typeof value !== "string") return false;
	const at = value.indexOf("@");
	return at > 0 && at < value.length - 1 && !value.includes("@", at + 1);
}
