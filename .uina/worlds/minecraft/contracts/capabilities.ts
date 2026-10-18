/**
 * 能力声明：CallableDescriptor / QueryDescriptor / 调用上下文。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §3。动作使用 NativeCallable；
 * 查询只使用 QueryDescriptor 与 World 查询定义。组合根校验所有确切 ref 唯一。
 */

import type { WorldPort, WorldReadPort } from "./world.js";
import type { BodyOps } from "./body.js";
import type { EffectReceipt, ExactRef, JsonSchema, JsonValue, Progress, Ref, Selector } from "./values.js";

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
			program: import("./program.js").ProgramDescription;
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
