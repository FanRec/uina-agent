import { describe, expect, it } from "vitest";
import { WORLD_HOST_EVENT_TYPES, type WorldDef } from "../src/extensions/world-framework/types.js";
import { WorldActivation } from "../src/extensions/world-framework/world-activation.js";
import { createWorldTool } from "../src/extensions/world-framework/world-tool.js";

function makeFakePi() {
	const handlers = new Map<string, Set<(event: unknown) => unknown>>();
	const registered: { name: string; executionMode?: string }[] = [];
	const pi = {
		subject: undefined,
		cwd: process.cwd(),
		submitInput: async () => {},
		registerTool: (tool: { def: { function: { name: string } }; executionMode?: string }) => {
			registered.push({ name: tool.def.function.name, executionMode: tool.executionMode });
			return () => {};
		},
		on: (type: string, handler: (event: unknown) => unknown) => {
			const set = handlers.get(type) ?? new Set();
			set.add(handler);
			handlers.set(type, set);
			return () => set.delete(handler);
		},
		fire(type: string, event: unknown) {
			for (const handler of handlers.get(type) ?? []) handler(event);
		},
		listenerCount(type: string) {
			return (handlers.get(type) ?? new Set()).size;
		},
	};
	return { pi, registered };
}

function makeDef(overrides: Partial<WorldDef> = {}): WorldDef {
	return {
		name: "test-world",
		description: "test",
		actions: {
			noop: { description: "noop", run: () => ({ result: "ok", status: "succeeded" as const }) },
		},
		...overrides,
	};
}

describe("world framework host event 透传", () => {
	it("WORLD_HOST_EVENT_TYPES 包含 agent_end 与 agent_settled", () => {
		expect(WORLD_HOST_EVENT_TYPES).toContain("agent_end");
		expect(WORLD_HOST_EVENT_TYPES).toContain("agent_settled");
	});

	it("onHostEvent 收到 agent_settled 事实事件", async () => {
		const { pi } = makeFakePi();
		const activation = new WorldActivation(makeDef(), {
			pi: pi as never,
			runtime: { definition: makeDef(), enabled: true },
			worldName: "test-world",
			notifyExposed: () => {},
		});
		let received: { type: string } | null = null;
		await activation.start();
		const ctx = activation["context"];
		ctx.onHostEvent?.((event) => {
			received = event as { type: string };
		});
		pi.fire("agent_settled", { type: "agent_settled", turnSeq: 7 });
		expect(received).toEqual({ type: "agent_settled", turnSeq: 7 });
		await activation.stop();
	});

	it("stop 之后 onHostEvent 退订且不再收到事件", async () => {
		const { pi } = makeFakePi();
		const activation = new WorldActivation(makeDef(), {
			pi: pi as never,
			runtime: { definition: makeDef(), enabled: true },
			worldName: "test-world",
			notifyExposed: () => {},
		});
		await activation.start();
		const ctx = activation["context"];
		ctx.onHostEvent?.(() => {});
		expect(pi.listenerCount("agent_settled")).toBe(1);
		await activation.stop();
		expect(pi.listenerCount("agent_settled")).toBe(0);
	});
});

describe("world executionMode 透传", () => {
	it("声明的 executionMode 透传到 Tool", () => {
		const tool = createWorldTool(makeDef({ executionMode: "sequential" }), {
			getRuntime: () => ({ definition: makeDef(), enabled: true }),
		});
		expect(tool.executionMode).toBe("sequential");
	});
	it("未声明时不设置 executionMode（保持默认 parallel）", () => {
		const tool = createWorldTool(makeDef(), { getRuntime: () => ({ definition: makeDef(), enabled: true }) });
		expect(tool.executionMode).toBeUndefined();
	});
	it("WorldActivation 注册的工具携带 executionMode", async () => {
		const { pi, registered } = makeFakePi();
		const activation = new WorldActivation(makeDef({ executionMode: "sequential" }), {
			pi: pi as never,
			runtime: { definition: makeDef(), enabled: true },
			worldName: "test-world",
			notifyExposed: () => {},
		});
		await activation.start();
		expect(registered).toEqual([{ name: "test-world", executionMode: "sequential" }]);
		await activation.stop();
	});
});
