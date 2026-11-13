import type { ChatMsg, ContextCollection, ContextRead } from "../core/types.js";
import type { RuntimeHooks } from "./hooks.js";

export const NO_RUNTIME_HOOKS: RuntimeHooks = Object.freeze({
	history: Object.freeze({
		project: (history: readonly ChatMsg[]): readonly ChatMsg[] => history,
	}),
	turn: Object.freeze({
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
		observeResponse: async () => {},
	}),
	context: Object.freeze({
		collect: async (_input: Readonly<ContextRead>): Promise<ContextCollection> => ({ contributions: [], omitted: [] }),
	}),
	events: Object.freeze({
		emit: async () => {},
		observe: () => {},
		flush: async () => {},
	}),
});
