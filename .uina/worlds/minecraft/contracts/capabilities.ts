/**
 * 能力声明：CallableDescriptor / QueryDescriptor / 调用上下文。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §3。动作使用 NativeCallable；
 * 查询只使用 QueryDescriptor 与 World 查询定义。组合根校验所有确切 ref 唯一。
 */

import type { BodyOps, ControlOwner } from "./body.js";
import type { EffectReceipt, ExactRef, Fact, JsonSchema, JsonValue, Progress, Ref, Selector } from "./values.js";
import type { WorldPort, WorldReadPort } from "./world.js";

export interface CallableDescriptor {
	ref: ExactRef;
	summary: string;
	tags?: string[];
	input: JsonSchema;
	output: JsonSchema;
	access: "act";
	/** 明确接受的续段检查点 schema；省略则不接受检查点。 */
	checkpoints?: ExactRef[];
	completion: { scope: "execution" | "capability"; description: string };
	errors: { code: string; meaning: string }[];
	requires: string[];
	examples: { input: JsonValue; output: JsonValue }[];
	implementation: "native";
}

export interface Availability {
	state: "available" | "unavailable" | "unknown";
	reasons: string[];
}

export interface ResolvedCallable {
	descriptor: CallableDescriptor;
	availability: Availability;
	digest: string;
}

export interface QueryDescriptor {
	ref: ExactRef;
	summary: string;
	input: JsonSchema;
	output: JsonSchema;
	tags?: string[];
	access: "read";
	/** watchable 可按查询明确声明的输入/结果条件收窄。 */
	watchable: boolean;
	feedback: boolean;
	/**
	 * 本查询读取的事实类别（Watch 类别化失效）：current 查询声明其实际依赖，
	 * 游标按依赖类别修订和值推进——无关提交不再唤醒等待方。缺省 = 全类别（保守）。
	 * 历史查询（events/places）与派生查询（cursor "none"/planner 端口）不适用。
	 */
	facts?: import("./client-facts.js").FactCategory[];
	examples: { input: JsonValue; output: JsonValue }[];
}

export interface SearchSummary {
	/** guide 是随版本发布的只读官方教学资料：可检索、可读正文，永不 callable。 */
	kind: "capability" | "guide" | "program" | "blueprint" | "experience" | "addon";
	callable: boolean;
	name: string;
	ref?: string;
	summary: string | null;
	tags: string[];
	path?: string;
	availability?: Availability["state"];
	reason?: string;
	access?: "read" | "act";
	watchable?: boolean;
	feedback?: boolean;
}

export type DiscoveryEntry =
	| {
			kind: "capability";
			callable: boolean;
			descriptor: CallableDescriptor | QueryDescriptor;
			availability: Availability;
			digest?: string;
	  }
	| {
			kind: "program";
			callable: true;
			program: import("./library.js").ProgramDescription;
			completion: { scope: "execution" };
	  }
	| {
			kind: "blueprint" | "experience";
			callable: false;
			name: string;
			summary: string | null;
			tags: string[];
			path: string;
	  }
	| {
			kind: "guide";
			callable: false;
			name: string;
			summary: string;
			tags: string[];
			content: string;
	  }
	| {
			/** 已安装/已加载的 Addon 包：只说明装配状态，能力仍按各自 ref 描述。 */
			kind: "addon";
			callable: false;
			name: string;
			summary: string;
			tags: string[];
			status: import("./addons.js").AddonStatus;
	  };

export interface CallableDirectory {
	search(query: string, cursor?: string): Promise<{ items: SearchSummary[]; next?: string }>;
	describe(selector: Selector | { kind: DiscoveryEntry["kind"]; name: string }): Promise<DiscoveryEntry>;
}

/** 查询 resolver：接收查询输入，从当前事实视图组装一个 Fact（组合根由 K1 声明生成注入）。 */
export type QueryResolver = (view: import("./client-facts.js").ClientFactView, input: JsonValue) => Fact<unknown>;

/** Compiled descriptor input boundary; returns normalized input or throws INVALID_INPUT. */
export type QueryValidator = (input: JsonValue) => JsonValue;

/**
 * 查询读取方式（world.md §8.2 三类）：
 * - current：当前提交边界的纯采样（cursor="observed" 有观察游标；"none" 为派生结果，
 *   如 recipe 的 plan——它读当前库存但不发布观察水位）；
 * - static：版本静态知识，不需要连接、没有观察游标；
 * - 历史（events）由 World 自己的存储读取，不经此表。
 */
export type QueryReader =
	| {
			kind: "current";
			read: (view: import("./client-facts.js").ClientFactView, input: JsonValue) => Fact<unknown>;
			cursor?: "observed" | "none";
	  }
	| { kind: "static"; read: (input: JsonValue) => Fact<unknown> };

export interface NativeCallable<I, O> {
	descriptor: CallableDescriptor;
	invoke(ctx: CallContext, input: I): Promise<O>;
}

export interface ReadCallScope {
	readonly run: Ref;
	readonly segment: Ref;
	readonly callId: Ref;
	/** 运行/调用取消，绝不是 Uina 工具等待取消。 */
	readonly signal: AbortSignal;
	progress(value: Progress): Promise<void>;
}

export interface CallScope extends ReadCallScope {
	call<I, O>(ref: Selector, input: I): Promise<O>;
	withBody<T>(work: (scope: BodyCallScope) => Promise<T>): Promise<T>;
}

export interface ReadCallContext extends ReadCallScope {
	readonly world: WorldReadPort;
}

/** 自定义 Payload 派发事实在现有 Effect Ledger 中的合同名（不是能力描述符）。 */
export const PROTOCOL_WRITE_CONTRACT: ExactRef = "addon.protocol@1";

/**
 * 受控协议写入：只在 Runtime 已授权的 BodyScope 内注入 CallContext。
 * 每次 withBody 都新建一个绑定该 Call/Lease/Connection/Incarnation 的端口；
 * 保存旧引用、Body 退出、换代后的 send 一律以 not_sent 失败。attach 阶段的
 * 只读端口不提供写能力，裸 bot/socket 不对普通贡献开放。
 */
export interface ProtocolWritePort {
	/**
	 * 发送一个自定义通道 Payload（1.21.11 serverbound custom_payload）。
	 * 返回本次派发的 effect ref：派发本身只证明已提交网络，默认结果仍是 unknown。
	 */
	send(channel: string, data: string | Uint8Array): Ref;
	/**
	 * 用真实观察证据把本次派发结算为 met。只能确认本端口自己发出的 effect，
	 * 且必须带证据 ref；没有服务端 ACK 或观察证据就不要调用，结果保持 unknown。
	 */
	confirm(effect: Ref, evidence: readonly Ref[]): void;
}

/** Driver 当前连接身份；断线或未就绪时为 null。 */
export interface ProtocolWriteIdentity {
	readonly connection: Ref;
	readonly incarnation: Ref;
}

/**
 * 一次 BodyScope 的写入绑定：建立 scoped port 时定稿，之后不再补读"当前连接"。
 * connection/incarnation 为 null 表示建立时没有可用身份，任何 send 都必须失败。
 */
export interface ProtocolWriteBinding {
	readonly run: Ref;
	readonly segment: Ref;
	readonly call: Ref;
	readonly body: Ref;
	readonly owner: ControlOwner;
	readonly connection: Ref | null;
	readonly incarnation: Ref | null;
}

/**
 * 组合根注入的可信派发器：Runtime 不接触 bot/socket。scoped port 已在每次
 * send 前完成 assertLease / Call 活性 / 身份一致性检查，这里只做真实写入，
 * 并在现有 Effect Ledger 中留下一条 dispatch=sent、completion=unknown 的事实。
 * 网络提交成功不等于服务端动作成功，没有 ACK/观察证据就不能写成 met。
 */
/** 一次派发的身份：确认时必须沿用同一个 operation（首条事实固定 operation）。 */
export interface ProtocolDispatch {
	readonly effect: Ref;
	readonly operation: Ref;
}

export interface ProtocolWriteDispatcher {
	identity(): ProtocolWriteIdentity | null;
	/** 写入并记录一条 dispatch=sent / completion=unknown 的派发事实。 */
	send(binding: ProtocolWriteBinding, channel: string, data: string | Uint8Array): ProtocolDispatch;
	/** 追加一条带观察证据的 receipt 事实，把该派发结算为 met。 */
	confirm(binding: ProtocolWriteBinding, dispatch: ProtocolDispatch, evidence: readonly Ref[]): void;
}

export interface CallContext extends ReadCallContext, CallScope {
	readonly world: WorldPort;
	/** 只调用 effect 原要求指定的领域核验者并追加效果判断。 */
	verify(effect: Ref, verifier: ExactRef, input: JsonValue): Promise<EffectReceipt>;
	/** 仅在 Runtime 授权的 BodyScope 内存在，且每个 Scope 一份；普通调用为 undefined。 */
	readonly protocol?: ProtocolWritePort;
}

export interface BodyCallScope extends CallContext {
	readonly player: BodyOps;
}
