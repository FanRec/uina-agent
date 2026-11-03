/**
 * 能力声明：CallableDescriptor / QueryDescriptor / 调用上下文。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §3。动作使用 NativeCallable；
 * 查询只使用 QueryDescriptor 与 World 查询定义。组合根校验所有确切 ref 唯一。
 */

import type { BodyOps } from "./body.js";
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
	kind: "capability" | "program" | "blueprint" | "experience";
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

export interface CallContext extends ReadCallContext, CallScope {
	readonly world: WorldPort;
	/** 只调用 effect 原要求指定的领域核验者并追加效果判断。 */
	verify(effect: Ref, verifier: ExactRef, input: JsonValue): Promise<EffectReceipt>;
}

export interface BodyCallScope extends CallContext {
	readonly player: BodyOps;
}
