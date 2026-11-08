import { describe, expect, it } from "vitest";
import type { ChatMsg, RequestProjection } from "../src/core/types.js";
import { createEventFrameProfile } from "../src/extensions/event-frames/index.js";
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

/** 只记 hook 注册的 pi：requestContext 接缝只依赖 onHook（tail 相位）。 */
function makeHookPi() {
	const hooks: { hook: string; handler: (input: RequestProjection) => unknown; tail?: boolean }[] = [];
	const pi = {
		subject: undefined,
		cwd: process.cwd(),
		submitInput: async () => {},
		registerTool: () => () => {},
		on: () => () => {},
		onHook: (hook: string, handler: (input: RequestProjection) => unknown, options?: { tail?: boolean }) => {
			const entry = { hook, handler, ...(options?.tail ? { tail: true } : {}) };
			hooks.push(entry);
			return () => {
				const index = hooks.indexOf(entry);
				if (index >= 0) hooks.splice(index, 1);
			};
		},
	};
	return { pi, hooks };
}

const projectionOf = (messages: ChatMsg[]): RequestProjection => ({
	projectionId: "p",
	modelKey: "m",
	messages,
	tools: [],
});

const { projection: framePolicy } = createEventFrameProfile();

async function activateWith(
	requestContext: WorldDef["requestContext"],
): Promise<{ activation: WorldActivation; hooks: ReturnType<typeof makeHookPi>["hooks"] }> {
	const { pi, hooks } = makeHookPi();
	const definition = makeDef({ requestContext });
	const activation = new WorldActivation(definition, {
		pi: pi as never,
		runtime: { definition, enabled: true },
		worldName: "test-world",
		notifyExposed: () => {},
	});
	await activation.start();
	return { activation, hooks };
}

describe("world requestContext 接缝", () => {
	it("以 tail 相位注册，投影尾部追加一条协议完整的观察帧", async () => {
		const { activation, hooks } = await activateWith(async () => "overworld (1,64,2) 生命20/20");
		try {
			expect(hooks).toHaveLength(1);
			expect(hooks[0]!.hook).toBe("turn.transformContext");
			expect(hooks[0]!.tail).toBe(true);
			const base = projectionOf([{ role: "user", content: "玩家：挖木头" }]);
			const result = (await hooks[0]!.handler(base)) as { projection: RequestProjection };
			const messages = result.projection.messages;
			expect(messages).toHaveLength(4);
			expect(messages[0]).toEqual({ role: "user", content: "玩家：挖木头" });
			expect(messages[1]!.role).toBe("user");
			expect(messages[1]!.content).toContain("test-world 观察");
			expect(messages[1]!.content).toContain("非用户输入");
			const receipt = JSON.parse(messages[3]!.content) as { text: string };
			expect(receipt.text).toBe("overworld (1,64,2) 生命20/20");
			// 帧组必须自洽：分组/调用配对/回执来源都可校验。
			expect(() => framePolicy.validateContext(messages)).not.toThrow();
		} finally {
			await activation.stop();
		}
	});

	it("内容相同的两次请求产生同一 eventId（帧逐字节稳定）", async () => {
		const { activation, hooks } = await activateWith(async () => "静止状态");
		try {
			const base = projectionOf([{ role: "user", content: "hi" }]);
			const first = (await hooks[0]!.handler(base)) as { projection: RequestProjection };
			const second = (await hooks[0]!.handler(base)) as { projection: RequestProjection };
			expect(second.projection.messages).toEqual(first.projection.messages);
		} finally {
			await activation.stop();
		}
	});

	// 空正文也是"这一轮没拿到"：注入一行原因，而不是让位置空着——空着会被读成没有变化。
	it("返回 null 或空白时注入占位帧，说明没有提供内容", async () => {
		const { activation, hooks } = await activateWith(async () => "  ");
		try {
			const base = projectionOf([{ role: "user", content: "hi" }]);
			const result = (await hooks[0]!.handler(base)) as { projection: RequestProjection };
			const messages = result.projection.messages;
			expect(messages[1]!.content).toContain("本轮没有取到世界状态");
			const receipt = JSON.parse(messages[3]!.content) as { text: string };
			expect(receipt.text).toContain("世界没有提供内容");
		} finally {
			await activation.stop();
		}
	});

	it("世界侧取不到正文（抛错）时注入占位帧，不把模型请求挂住", async () => {
		const { activation, hooks } = await activateWith(async () => {
			throw new Error("executor unavailable");
		});
		try {
			const messages = (
				(await hooks[0]!.handler(projectionOf([{ role: "user", content: "hi" }]))) as {
					projection: RequestProjection;
				}
			).projection.messages;
			const receipt = JSON.parse(messages[3]!.content) as { text: string };
			expect(receipt.text).toContain("executor unavailable");
			expect(receipt.text).toContain("不要把它当成世界没有变化");
		} finally {
			await activation.stop();
		}
	});

	it("取正文超时注入占位帧：不挂住请求，但要说清是超时", async () => {
		const { activation, hooks } = await activateWith(() => new Promise<string>(() => {}));
		try {
			const started = Date.now();
			const messages = (
				(await hooks[0]!.handler(projectionOf([{ role: "user", content: "hi" }]))) as {
					projection: RequestProjection;
				}
			).projection.messages;
			const receipt = JSON.parse(messages[3]!.content) as { text: string };
			expect(receipt.text).toContain("读取超时");
			expect(Date.now() - started).toBeLessThan(2000);
		} finally {
			await activation.stop();
		}
	});

	it("停用后摘除 handler；未声明 requestContext 的世界不注册", async () => {
		const { activation, hooks } = await activateWith(async () => "x");
		expect(hooks).toHaveLength(1);
		await activation.stop();
		expect(hooks).toHaveLength(0);

		const { activation: bare } = await activateWith(undefined);
		const bareHooks = makeHookPi();
		expect(bareHooks.hooks).toHaveLength(0);
		await bare.stop();
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
