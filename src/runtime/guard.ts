import type { ChatMsg, ContextRead } from "../core/types.js";
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
 * neither mutate runtime-owned values nor retain a mutable reference.
 * 已标记（本模块深冻结过）的输入零成本穿透。 */
export function readonlySnapshot<T>(value: T): DeepReadonly<T> {
	if (isMarkedImmutable(value)) return value as DeepReadonly<T>;
	if (!value || typeof value !== "object") return value as DeepReadonly<T>;
	if ("type" in (value as object) && typeof (value as any).type === "string") {
		const t = (value as any).type;
		if (
			t === "output_update" ||
			t === "output_start" ||
			t === "output_end" ||
			t === "output_interrupted" ||
			t === "expression"
		) {
			// 浅冻结输出事件是热路径特例：不标记（浅冻结 ≠ 深不可变）。
			return Object.freeze({ ...(value as object) }) as DeepReadonly<T>;
		}
	}
	return markAndFreeze(clone(value)) as DeepReadonly<T>;
}

/** Copies and freezes data at the kernel boundary so hook implementations can
 * neither mutate runtime-owned values nor retain a mutable reference.
 * AbortSignal lives outside this contract: it is runtime-owned identity that
 * cannot survive structuredClone, so hook inputs carry it through untouched
 * (signals are already immutable). */
function withSignal<T extends { signal: AbortSignal }>(input: Readonly<T>): DeepReadonly<T> {
	const { signal, ...data } = input;
	return Object.freeze({ ...readonlySnapshot(data as Omit<T, "signal">), signal }) as DeepReadonly<T>;
}

/** Takes ownership of a hook return without freezing the value the runtime must consume. */
export function copyValue<T>(value: T): T {
	return clone(value);
}

/** In-place deep freeze for a projection the runtime itself just built. 用于
 * Subject/Composer 的自有装配结果：对象树全部为本次请求新建（无运行时可变态的别名），
 * 原地冻结即满足守卫合同，免去克隆一整份 38MB 投影的纯开销。已冻结值零成本穿透。 */
export function freezeProjection(
	projection: import("../core/types.js").RequestProjection,
): import("../core/types.js").RequestProjection {
	return markAndFreeze(projection) as import("../core/types.js").RequestProjection;
}

/** In-place deep freeze for the canonical history projection the Subject builds
 * fresh per request（History View 的输入边界）。 */
export function freezeHistory(history: readonly ChatMsg[]): readonly ChatMsg[] {
	return markAndFreeze(history) as readonly ChatMsg[];
}

/** clone+freeze 单点边界（P1-3 规则成文）：所有 RuntimeHooks 出口在此统一
 * 过 guard；幂等——已 guard 的实例二次包装零成本返回（Subject 与
 * runner.runtimeHooks 旁路同权，不允许双重克隆）。 */
const GUARDED = Symbol("guardedRuntimeHooks");

export function guardRuntimeHooks(hooks: RuntimeHooks): RuntimeHooks {
	if (hooks === NO_RUNTIME_HOOKS) return hooks;
	if ((hooks as { [GUARDED]?: boolean })[GUARDED]) return hooks;
	const guarded: RuntimeHooks = {
		history: Object.freeze({
			project: (history: readonly ChatMsg[]) => {
				// 输出即本次装配采用的可见历史：标记冻结后下游（preflight 输入、
				// composer、inspection）零成本穿透；hook 自有的新对象（如摘要）一并冻结。
				return markAndFreeze(
					hooks.history.project(readonlySnapshot(history) as readonly ChatMsg[]),
				) as readonly ChatMsg[];
			},
		}),
		turn: Object.freeze({
			preflight: async (input) =>
				// projection 可能是 38MB 已冻结投影：逐字段穿透已标记部分，
				// 不能走 withSignal 的整体深克隆（会连投影一起复制一份）。
				Object.freeze({
					...(await hooks.turn.preflight({
						projection: readonlySnapshot(input.projection),
						history: readonlySnapshot(input.history) as readonly ChatMsg[],
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
			observeResponse: async (input: Readonly<{ provider: string; status: number; headers: Record<string, string> }>) =>
				hooks.provider.observeResponse(readonlySnapshot(input)),
		}),
		context: Object.freeze({
			// ContextRead 只携带字符串与 signal：signal 是运行时所有物，照 withSignal 纪律穿透。
			collect: async (input: Readonly<ContextRead>) => readonlySnapshot(await hooks.context.collect(withSignal(input))),
		}),
		output: Object.freeze({
			// 注册快照本身已冻结（Registry 产出），直接穿透。
			tags: () => hooks.output.tags(),
		}),
		events: Object.freeze({
			// DeepReadonly 视图传给 emit：契约形状是 RuntimeEvent，但只读性由 deepFreeze 保证。
			emit: (event: RuntimeEvent) => hooks.events.emit(readonlySnapshot(event) as RuntimeEvent),
			// DeepReadonly 会把 rawRange 元组放宽为数组：观察出口按契约形状穿透。
			observe: (event: OutputEvent) => hooks.events.observe(readonlySnapshot(event) as OutputEvent),
			flush: () => hooks.events.flush(),
		}),
		[GUARDED]: true,
	} as RuntimeHooks & { [GUARDED]?: boolean };
	return Object.freeze(guarded);
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

function deepFreeze<T>(value: T): void {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	Object.freeze(value);
}
