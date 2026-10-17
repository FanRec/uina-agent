/**
 * Program（普通函数、宿主桥接）合同（lead 固定合同）。
 * 唯一设计来源：docs/proposals/mc/public-api.md §6（第一块类型）。
 */

import type { ReadLibrary, WriteLibrary } from "./assets.js";
import type { BodyOps, ControlInput, FeedbackFrame } from "./body.js";
import type { CallableDescriptor } from "./callables.js";
import type { Checkpoint, ExactRef, JsonValue, Observation, Progress, Ref, Selector } from "./values.js";
import type { WorldQuery } from "./world.js";

export interface WaitRequest {
	condition: ExactRef;
	input: JsonValue;
	checkpoint?: Checkpoint;
}

export interface WaitResult {
	observation: Ref;
	evidence: Ref[];
}

export interface ProgramBody extends BodyOps {
	call<I, O>(ref: Selector, input: I): Promise<O>;
	loop(
		step: (frame: FeedbackFrame) => ControlInput | { done: true },
		sensors: Record<string, WorldQuery>,
	): Promise<void>;
}

export interface ReadProgramAPI {
	readonly checkpoint: Checkpoint | null;
	call<I, O>(ref: Selector, input: I): Promise<O>;
	read<T>(query: WorldQuery): Promise<Observation<T>>;
	wait(request: WaitRequest): Promise<WaitResult>;
	decide(reason: string, checkpoint: Checkpoint): Promise<never>;
	progress(value: Progress): Promise<void>;
	readonly assets: ReadLibrary;
}

export interface ProgramAPI extends ReadProgramAPI {
	withBody<T>(work: (body: ProgramBody) => Promise<T>): Promise<T>;
	readonly assets: WriteLibrary;
}

/** 程序入口是 async function(mc, input)，input/output 按声明 schema 校验。 */
export interface ProgramDefinition {
	descriptor: Omit<CallableDescriptor, "ref" | "implementation">;
	/** async function(mc, input) 的函数体；不是 npm 包。 */
	source: string;
	/** 显式前置检查，不宣称穷尽动态调用。 */
	dependencies: ExactRef[];
	/** 提供时是闭合的裸名表；不再回退到当前原生环境。 */
	bindings?: ProgramBinding[];
}

export interface ProgramBinding {
	name: string;
	refs: ExactRef[];
}
