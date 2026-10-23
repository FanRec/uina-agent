import type { ChatMsg, RequestProjection } from "../core/types.js";
import type { DeepReadonly, OutputEvent, RuntimeEvent } from "./events.js";
import type { RuntimeHooks } from "./hooks.js";
import { NO_RUNTIME_HOOKS } from "./noop.js";

/** Marks values this module has already deep-frozen. Marked values pass every
 * guard boundary at zero cost: the contract (hooks can neither mutate
 * runtime-owned values nor retain a mutable reference) is already satisfied by
 * deep immutability, so re-cloning a 38MB projection at each hop is pure tax. */
const IMMUTABLE = Symbol("immutableSnapshot");

function isMarkedImmutable(value: unknown): boolean {
	return typeof value === "object" && value !== null && IMMUTABLE in (value as object);
}

/** 标记 + 原地深冻结。defineProperty 必须在 deepFreeze 之前（冻结后不可扩展）；
 * 已冻结但未标记的值不标记——浅冻结不构成深不可变的证明。 */
function markAndFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.defineProperty(value, IMMUTABLE, { value: true });
		deepFreeze(value);
	}
	return value;
}

/** Copies and freezes data at the kernel boundary so hook implementations can
 * neither mutate runtime-owned values nor retain a mutable return reference.
 * 已标记（本模块深冻结过）的输入零成本穿透。 */
export function readonlySnapshot<T>(value: T): DeepReadonly<T> {
	if (isMarkedImmutable(value)) return value as DeepReadonly<T>;
	if (!value || typeof value !== "object") return value as DeepReadonly<T>;
	if ("type" in (value as object) && typeof (value as any).type === "string") {
		const t = (value as any).type;
		if (t === "output_update" || t === "output_start" || t === "output_end" || t === "output_interrupted") {
			// 浅冻结输出事件是热路径特例：不标记（浅冻结 ≠ 深不可变）。
			return Object.freeze({ ...(value as object) }) as DeepReadonly<T>;
		}
	}
	return markAndFreeze(clone(value)) as DeepReadonly<T>;
}

/** Copies and freezes data at the kernel boundary so hook implementations can
 * neither mutate runtime-owned values nor retain a mutable return reference.
 * AbortSignal lives outside this contract: it is runtime-owned identity that
 * cannot survive structuredClone, so hook inputs carry it through untouched
 * (signals are already immutable). */
function withSignal<T extends { signal: AbortSignal }>(input: Readonly<T>): DeepReadonly<T> {
	const { signal, ...data } = input;
	return Object.freeze({ ...readonlySnapshot(data as Omit<T, "signal">), signal }) as DeepReadonly<T>;
}

/** Owns and deeply freezes one model-semantic request at a hook boundary.
 * 已标记的投影零成本穿透（守卫合同已由深不可变性满足）；新投影克隆一份再冻结，
 * 克隆同时切断与运行时状态（history 条目）的别名共享。 */
export function immutableProjection(projection: RequestProjection): RequestProjection {
	if (isMarkedImmutable(projection)) return projection;
	return markAndFreeze(clone(projection)) as RequestProjection;
}

/** Takes ownership of a hook return without freezing the value the runtime must consume. */
export function copyValue<T>(value: T): T {
	return clone(value);
}

/** clone+freeze 单点边界（P1-3 规则成文）：所有 RuntimeHooks 出口在此统一
 * 过 guard；幂等——已 guard 的实例二次包装零成本返回（Subject 与
 * runner.runtimeHooks 旁路同权，不允许双重克隆）。 */
const GUARDED = Symbol("guardedRuntimeHooks");

export function guardRuntimeHooks(hooks: RuntimeHooks): RuntimeHooks {
	if (hooks === NO_RUNTIME_HOOKS) return hooks;
	if ((hooks as { [GUARDED]?: boolean })[GUARDED]) return hooks;
	const guarded: RuntimeHooks = {
		turn: Object.freeze({
			prepare: async (input) => copyPrepare(await hooks.turn.prepare(readonlySnapshot(input))),
			transformContext: async (projection) => {
				const result = await hooks.turn.transformContext(readonlySnapshot(projection));
				// 出口已标记 = 运行时侧（runner 链）产出且已深冻结，穿透即可；
				// 未标记 = hook 自有可变数据，必须复制以切断 hook 的可变引用持有。
				return isMarkedImmutable(result)
					? (result as RequestProjection)
					: copyProjection(result as DeepReadonly<RequestProjection>);
			},
			preflight: async (input) =>
				// projection 可能是 38MB 已冻结投影：逐字段穿透已标记部分，
				// 不能走 withSignal 的整体深克隆（会连投影一起复制一份）。
				Object.freeze({
					...(await hooks.turn.preflight({
						projection: readonlySnapshot(input.projection),
						measurement: readonlySnapshot(input.measurement),
						pass: input.pass,
						signal: input.signal,
					})),
				}),
			afterEnd: async (input) => hooks.turn.afterEnd(withSignal(input)),
			shouldStop: async (input) => Object.freeze({ ...(await hooks.turn.shouldStop(readonlySnapshot(input))) }),
		}),
		tools: Object.freeze({
			beforeCall: async (input) => Object.freeze({ ...(await hooks.tools.beforeCall(readonlySnapshot(input))) }),
			transformResult: async (input) => copyValue(await hooks.tools.transformResult(readonlySnapshot(input))),
		}),
		provider: Object.freeze({
			transformHeaders: async (provider: string, headers: Readonly<Record<string, string>>) =>
				clone(await hooks.provider.transformHeaders(provider, readonlySnapshot(headers))),
			transformPayload: async (provider: string, payload: DeepReadonly<unknown>) =>
				clone(await hooks.provider.transformPayload(provider, readonlySnapshot(payload))),
			observeResponse: async (input: Readonly<{ provider: string; status: number; headers: Record<string, string> }>) =>
				hooks.provider.observeResponse(readonlySnapshot(input)),
		}),
		events: Object.freeze({
			// DeepReadonly 视图传给 emit：契约形状是 RuntimeEvent，但只读性由 deepFreeze 保证。
			emit: (event: RuntimeEvent) => hooks.events.emit(readonlySnapshot(event) as RuntimeEvent),
			observe: (event: OutputEvent) => hooks.events.observe(readonlySnapshot(event)),
			flush: () => hooks.events.flush(),
		}),
		[GUARDED]: true,
	} as RuntimeHooks & { [GUARDED]?: boolean };
	return Object.freeze(guarded);
}

function copyPrepare(
	value: Readonly<{
		messages?: readonly ChatMsg[];
		systemPrompt?: string;
		model?: import("../core/types.js").Model;
		thinkingLevel?: import("../core/types.js").ThinkingLevel;
		injections?: readonly import("./events.js").InjectionProvenance[];
	}>,
): Readonly<{
	messages?: readonly ChatMsg[];
	systemPrompt?: string;
	model?: import("../core/types.js").Model;
	thinkingLevel?: import("../core/types.js").ThinkingLevel;
	injections?: readonly import("./events.js").InjectionProvenance[];
}> {
	return Object.freeze({
		...(value.messages ? { messages: copyMessages(value.messages) } : {}),
		...(value.systemPrompt !== undefined ? { systemPrompt: value.systemPrompt } : {}),
		...(value.model !== undefined ? { model: clone(value.model) } : {}),
		...(value.thinkingLevel !== undefined ? { thinkingLevel: value.thinkingLevel } : {}),
		...(value.injections !== undefined ? { injections: clone(value.injections) } : {}),
	});
}

function copyMessages(messages: readonly DeepReadonly<ChatMsg>[] | readonly ChatMsg[]): ChatMsg[] {
	return clone(messages) as ChatMsg[];
}

function copyProjection(projection: DeepReadonly<RequestProjection> | RequestProjection): RequestProjection {
	// 已标记（runner 链已深冻结）零成本穿透；未标记的 hook 自有数据复制后
	// 标记冻结——下游（loop 侧 immutableProjection、preflight 输入）随之穿透。
	if (isMarkedImmutable(projection)) return projection as RequestProjection;
	return markAndFreeze({
		projectionId: projection.projectionId,
		modelKey: projection.modelKey,
		messages: copyMessages(projection.messages),
		tools: clone(projection.tools),
		...(projection.thinkingLevel !== undefined ? { thinkingLevel: projection.thinkingLevel } : {}),
	}) as RequestProjection;
}

function clone<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch {
		if (Array.isArray(value)) return value.map(clone) as T;
		if (value && typeof value === "object") return { ...(value as Record<string, unknown>) } as T;
		return value;
	}
}

function deepFreeze<T>(value: T): T {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return Object.freeze(value);
}
