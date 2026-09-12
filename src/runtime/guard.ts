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

export function guardRuntimeHooks(hooks: RuntimeHooks): RuntimeHooks {
	if (hooks === NO_RUNTIME_HOOKS) return hooks;
	const guarded: RuntimeHooks = {
		turn: Object.freeze({
			prepare: async (input, signal) => copyPrepare(await hooks.turn.prepare(readonlySnapshot(input), signal)),
			transformContext: async (messages) => copyMessages(await hooks.turn.transformContext(readonlySnapshot(messages))),
			beforeCompact: async (input) => Object.freeze({ ...(await hooks.turn.beforeCompact(readonlySnapshot(input))) }),
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
			emit: (event: RuntimeEvent) => hooks.events.emit(readonlySnapshot(event)),
			observe: (event: OutputEvent) => hooks.events.observe(readonlySnapshot(event)),
			flush: () => hooks.events.flush(),
		}),
	};
	return Object.freeze(guarded);
}

function copyPrepare(value: Readonly<{ messages?: readonly ChatMsg[]; systemPrompt?: string }>): Readonly<{ messages?: readonly ChatMsg[]; systemPrompt?: string }> {
	return Object.freeze({
		...(value.messages ? { messages: copyMessages(value.messages) } : {}),
		...(value.systemPrompt !== undefined ? { systemPrompt: value.systemPrompt } : {}),
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
