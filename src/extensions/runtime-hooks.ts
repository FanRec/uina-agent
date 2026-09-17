import type { DeepReadonly, OutputEvent, RuntimeEvent } from "../runtime/events.js";
import type { RuntimeHooks } from "../runtime/hooks.js";
import { ExtensionHost, type RuntimeScopeFilter } from "./host.js";

/**
 * A stateless view over one Host. Scope selection filters dispatch only; the
 * Host remains the sole owner of registrations, errors and observed output.
 */
export function createRuntimeHooks(host: ExtensionHost, scope?: RuntimeScopeFilter): RuntimeHooks {
	const hooks: RuntimeHooks = {
		turn: Object.freeze({
			prepare: async (input, signal) => {
				const prepared = await host.runTurnPrepare(input, scope, signal);
				return Object.freeze({
					...(prepared?.messages ? { messages: structuredClone(prepared.messages) } : {}),
					...(prepared?.systemPrompt !== undefined ? { systemPrompt: prepared.systemPrompt } : {}),
					...(prepared?.model !== undefined ? { model: structuredClone(prepared.model) } : {}),
					...(prepared?.thinkingLevel !== undefined ? { thinkingLevel: prepared.thinkingLevel } : {}),
				});
			},
			transformContext: (messages) => host.runTransformContext(messages as readonly import("../core/types.js").ChatMsg[], scope),
			beforeCompact: async (input) => Object.freeze({ cancel: await host.runBeforeCompact(input.tokensBefore, scope) || undefined }),
			shouldStop: async (input) => Object.freeze({ stop: await host.runShouldStop(input, scope) || undefined }),
		}),
		tools: Object.freeze({
			beforeCall: async (input) => Object.freeze(await host.runBeforeCall(input, scope) ?? {}),
			transformResult: async (input) => {
				const result = await host.runTransformResult(input, scope);
				return Object.freeze({
					...(result?.result !== undefined ? { result: result.result } : {}),
					...(result?.status !== undefined ? { status: result.status } : {}),
					...(result?.images !== undefined ? { images: result.images } : {}),
					...(result?.details !== undefined ? { details: result.details } : {}),
				});
			},
		}),
		provider: Object.freeze({
			transformHeaders: (provider: string, headers: Readonly<Record<string, string>>) => host.runTransformHeaders(provider, headers, scope),
			transformPayload: (provider: string, payload: DeepReadonly<unknown>) => host.runTransformPayload(provider, payload, scope),
			observeResponse: (input: Readonly<{ provider: string; status: number; headers: Record<string, string> }>) => host.runObserveResponse(input, scope),
		}),
		events: Object.freeze({
			emit: (event: RuntimeEvent) => host.emit(event, scope),
			observe: (event: OutputEvent) => host.emitObserved(event, scope),
			flush: () => host.flush(),
		}),
	};
	return Object.freeze(hooks);
}
