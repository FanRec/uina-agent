/**
 * 能力（Callable）声明、目录与调用上下文合同（lead 固定合同）。
 * 唯一设计来源：docs/proposals/mc/public-api.md §3。
 */

import type { WorldPort, WorldReadPort } from "./world.js";
import type { BodyOps } from "./body.js";
import type { Checkpoint, EffectReceipt, ExactRef, JsonSchema, JsonValue, Progress, Ref, Selector } from "./values.js";
import type { ReadAssets, ScriptAssets } from "./assets.js";
import type { WaitRequest, WaitResult } from "./program.js";

export interface CallableDescriptor {
	ref: ExactRef;
	summary: string;
	input: JsonSchema;
	output: JsonSchema;
	access: "read" | "act";
	completion: { scope: "execution" | "capability" | "goal"; description: string; verifier?: ExactRef };
	errors: { code: string; meaning: string }[];
	requires: string[];
	examples: { input: JsonValue; output: JsonValue }[];
	implementation: "native" | "program";
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
	feedback: boolean;
}

export type DiscoveryEntry =
	| ({ kind: "callable" } & ResolvedCallable)
	| { kind: "query"; descriptor: QueryDescriptor; availability: Availability };

export interface SearchSummary {
	kind: "callable" | "query";
	ref: ExactRef;
	summary: string;
	availability: Availability["state"];
	reason?: string;
	access?: "read" | "act";
	feedback?: boolean;
}

export interface CallableDirectory {
	search(query: string, cursor?: string): Promise<{ items: SearchSummary[]; next?: string }>;
	describe(selector: Selector): Promise<DiscoveryEntry>;
}

export type NativeCallable<I, O> =
	| { descriptor: CallableDescriptor & { access: "read" }; invoke(ctx: ReadCallContext, input: I): Promise<O> }
	| { descriptor: CallableDescriptor & { access: "act" }; invoke(ctx: CallContext, input: I): Promise<O> };

export interface ReadCallScope {
	readonly run: Ref;
	readonly segment: Ref;
	readonly callId: Ref;
	/** 运行/调用取消，绝不是 Uina 工具等待取消。 */
	readonly signal: AbortSignal;
	readonly checkpoint: Checkpoint | null;
	call<I, O>(ref: Selector, input: I): Promise<O>;
	wait(request: WaitRequest): Promise<WaitResult>;
	decide(reason: string, checkpoint: Checkpoint): Promise<never>;
	progress(value: Progress): Promise<void>;
}

export interface CallScope extends ReadCallScope {
	withBody<T>(work: (scope: BodyCallScope) => Promise<T>): Promise<T>;
}

export interface ReadCallContext extends ReadCallScope {
	readonly world: WorldReadPort;
	readonly assets: ReadAssets;
	readonly policy: Readonly<Record<string, JsonValue>>;
}

export interface CallContext extends ReadCallContext, CallScope {
	readonly world: WorldPort;
	readonly assets: ScriptAssets;
	verify(effect: Ref, verifier: ExactRef, input: JsonValue): Promise<EffectReceipt>;
}

export interface BodyCallScope extends CallContext {
	readonly player: BodyOps;
}
