import type { DeepReadonly, OutputEvent, RuntimeEvent } from "../runtime/events.js";
import type { RuntimeHooks } from "../runtime/hooks.js";
import { ExtensionHost, type RuntimeScopeFilter } from "./host.js";

/**
 * RuntimeHooks（Core 接缝）的扩展宿主实现：唯一职责是把 host.run* 的链式合并结果
 * 冻结为所有权边界（Core 拿到的是不可变快照），并把 scope 过滤透传给宿主。
 * 合并规则本身在宿主内实现（host.run*），这里不做第二次解释——压扁评估结论（P2）：
 * 适配层不可删（删掉 Core 就得 import extensions 层），可删的只有字段级克隆仪式。
 */
export function createRuntimeHooks(host: ExtensionHost, scope?: RuntimeScopeFilter): RuntimeHooks {
	const hooks: RuntimeHooks = {
		turn: Object.freeze({
			prepare: async (input) => Object.freeze(await host.runTurnPrepare(input, scope) ?? {}),
			transformContext: (messages) => host.runTransformContext(messages as readonly import("../core/types.js").ChatMsg[], scope),
			shouldStop: async (input) => Object.freeze({ stop: await host.runShouldStop(input, scope) }),
		}),
		tools: Object.freeze({
			beforeCall: async (input) => Object.freeze(await host.runBeforeCall(input, scope) ?? {}),
			transformResult: async (input) => Object.freeze(await host.runTransformResult(input, scope) ?? {}),
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
