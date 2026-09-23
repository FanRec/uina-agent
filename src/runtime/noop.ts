import type { ChatMsg, RequestProjection } from "../core/types.js";
import type { DeepReadonly } from "./events.js";
import type { RuntimeHooks } from "./hooks.js";

export const NO_RUNTIME_HOOKS: RuntimeHooks = Object.freeze({
	turn: Object.freeze({
		prepare: async () => ({}),
		transformContext: async (projection: DeepReadonly<RequestProjection>) => ({
			...projection,
			messages: [...projection.messages] as ChatMsg[],
			tools: [...projection.tools],
		}),
		preflight: async () => ({ action: "send" as const }),
		afterEnd: async () => {},
		shouldStop: async () => ({}),
	}),
	tools: Object.freeze({
		beforeCall: async () => ({}),
		transformResult: async () => ({}),
	}),
	provider: Object.freeze({
		transformHeaders: async (_provider: string, headers: Readonly<Record<string, string>>) => ({ ...headers }),
		transformPayload: async (_provider: string, payload: DeepReadonly<unknown>) => payload,
		observeResponse: async () => {},
	}),
	events: Object.freeze({
		emit: async () => {},
		observe: () => {},
		flush: async () => {},
	}),
});
