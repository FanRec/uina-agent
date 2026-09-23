import type { DeepReadonly, OutputEvent, RuntimeEvent } from "../runtime/events.js";
import type { RuntimeHooks } from "../runtime/hooks.js";
import { ExtensionHost, type RuntimeScopeFilter } from "./host.js";

/**
 * RuntimeHooks（Core 接缝）的扩展宿主实现：唯一职责是把 host.run* 的链式合并结果
 * 冻结为所有权边界（Core 拿到的是不可变快照），并把 scope 过滤透传给宿主。
 * 合并规则本身在宿主内实现（host.run*），这里不做第二次解释——压扁评估结论：
 * 适配层不可删（删掉 Core 就得 import extensions 层），可删的只有字段级克隆仪式。
 */
export function createRuntimeHooks(host: ExtensionHost, scope?: RuntimeScopeFilter): RuntimeHooks {
	const hooks: RuntimeHooks = {
		turn: {
			prepare: async (input) => (await host.runTurnPrepare(input, scope)) ?? {},
			transformContext: (projection) => host.runTransformContext(projection as never, scope),
			preflight: (input) => host.runPreflight(input as never, scope),
			afterEnd: (input) => host.runAfterEnd(input as never, scope),
			shouldStop: async (input) => ({ stop: await host.runShouldStop(input, scope) }),
		},
		tools: {
			beforeCall: async (input) => (await host.runBeforeCall(input, scope)) ?? {},
			transformResult: async (input) => (await host.runTransformResult(input, scope)) ?? {},
		},
		provider: {
			transformHeaders: (provider: string, headers: Readonly<Record<string, string>>) => host.runTransformHeaders(provider, headers, scope),
			transformPayload: (provider: string, payload: DeepReadonly<unknown>) => host.runTransformPayload(provider, payload, scope),
			observeResponse: (input: Readonly<{ provider: string; status: number; headers: Record<string, string> }>) => host.runObserveResponse(input, scope),
		},
		events: {
			emit: (event: RuntimeEvent) => host.emit(event, scope),
			observe: (event: OutputEvent) => host.emitObserved(event, scope),
			flush: () => host.flush(),
		},
	};
	return Object.freeze(hooks);
}
