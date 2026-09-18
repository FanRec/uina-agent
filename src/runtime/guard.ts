import type { ChatMsg } from "../core/types.js";
import type { DeepReadonly, OutputEvent, RuntimeEvent } from "./events.js";
import type { RuntimeHooks } from "./hooks.js";
import { NO_RUNTIME_HOOKS } from "./noop.js";

/** Copies and freezes data at the kernel boundary so hook implementations can
 * neither mutate runtime-owned values nor retain a mutable return reference. */
export function readonlySnapshot<T>(value: T): DeepReadonly<T> {
	return deepFreeze(clone(value)) as DeepReadonly<T>;
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
			transformContext: async (messages) => copyMessages(await hooks.turn.transformContext(readonlySnapshot(messages))),
			shouldStop: async (input) => Object.freeze({ ...(await hooks.turn.shouldStop(readonlySnapshot(input))) }),
		}),
		tools: Object.freeze({
			beforeCall: async (input) => Object.freeze({ ...(await hooks.tools.beforeCall(readonlySnapshot(input))) }),
			transformResult: async (input) => copyValue(await hooks.tools.transformResult(readonlySnapshot(input))),
		}),
		provider: Object.freeze({
			transformHeaders: async (provider: string, headers: Readonly<Record<string, string>>) => clone(await hooks.provider.transformHeaders(provider, readonlySnapshot(headers))),
			transformPayload: async (provider: string, payload: DeepReadonly<unknown>) => clone(await hooks.provider.transformPayload(provider, readonlySnapshot(payload))),
			observeResponse: async (input: Readonly<{ provider: string; status: number; headers: Record<string, string> }>) => hooks.provider.observeResponse(readonlySnapshot(input)),
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
	value: Readonly<{ messages?: readonly ChatMsg[]; systemPrompt?: string; model?: import("../core/types.js").Model; thinkingLevel?: import("../core/types.js").ThinkingLevel }>,
): Readonly<{ messages?: readonly ChatMsg[]; systemPrompt?: string; model?: import("../core/types.js").Model; thinkingLevel?: import("../core/types.js").ThinkingLevel }> {
	return Object.freeze({
		...(value.messages ? { messages: copyMessages(value.messages) } : {}),
		...(value.systemPrompt !== undefined ? { systemPrompt: value.systemPrompt } : {}),
		...(value.model !== undefined ? { model: clone(value.model) } : {}),
		...(value.thinkingLevel !== undefined ? { thinkingLevel: value.thinkingLevel } : {}),
	});
}

function copyMessages(messages: readonly DeepReadonly<ChatMsg>[] | readonly ChatMsg[]): ChatMsg[] {
	return clone(messages) as ChatMsg[];
}

function clone<T>(value: T): T {
	try { return structuredClone(value); }
	catch {
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
