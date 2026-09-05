import type { ChatMsg } from "../core/types.js";
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
			prepare: async (input) => {
				const prepared = await host.emitBeforeAgentStart(input.prompt, input.systemPrompt, scope);
				return Object.freeze({
					...(prepared?.messages ? { messages: structuredClone(prepared.messages) } : {}),
					...(prepared?.systemPrompt !== undefined ? { systemPrompt: prepared.systemPrompt } : {}),
				});
			},
			transformContext: async (messages) => host.emitContext(messages as readonly ChatMsg[], scope),
			beforeCompact: async (input) => Object.freeze({ cancel: await host.emitSessionBeforeCompact(input.tokensBefore, scope) || undefined }),
		}),
		tools: Object.freeze({
			beforeCall: async (input) => Object.freeze(await host.emitToolCall({
				type: "tool_call", toolName: input.name, args: input.args, callId: input.callId,
			}, scope) ?? {}),
			transformResult: async (input) => {
				const result = await host.emitToolResult({
					type: "tool_result", toolName: input.name, args: input.args, result: input.result,
					status: input.status, callId: input.callId,
				}, scope);
				return Object.freeze({
					...(result?.result !== undefined ? { result: result.result } : {}),
					...(result?.status !== undefined ? { status: result.status } : {}),
				});
			},
		}),
		provider: Object.freeze({
			transformHeaders: (provider: string, headers: Readonly<Record<string, string>>) => host.emitBeforeProviderHeaders(provider, headers, scope),
			transformPayload: (provider: string, payload: DeepReadonly<unknown>) => host.emitBeforeProviderRequest(provider, payload, scope),
			observeResponse: (input: Readonly<{ provider: string; status: number; headers: Record<string, string> }>) => host.emitAfterProviderResponse(input.provider, input.status, input.headers, scope),
		}),
		events: Object.freeze({
			emit: (event: RuntimeEvent) => host.emit(event, scope),
			observe: (event: OutputEvent) => host.emitObserved(event, scope),
			flush: () => host.flush(),
		}),
	};
	return Object.freeze(hooks);
}
