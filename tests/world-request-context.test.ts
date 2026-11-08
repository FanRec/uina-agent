import { getEventListeners } from "node:events";
import { expect, test } from "vitest";
import type { ChatMsg, ModelStreamFn } from "../src/core/types.js";
import { ExtensionHost } from "../src/extensions/host.js";
import { createRuntimeHooks } from "../src/extensions/runtime-hooks.js";
import type { WorldDef } from "../src/extensions/world-framework/types.js";
import { WorldActivation } from "../src/extensions/world-framework/world-activation.js";
import { mockTool, SubjectHarness } from "./harness/index.js";

/** 捕获 world activation 注册的 transformContext handler，同时把 hook 真正挂到 host 上。 */
function probeHost(host: ExtensionHost, capture: (handler: unknown) => void) {
	return {
		subject: undefined,
		cwd: process.cwd(),
		isBusy: () => false,
		registerTool: () => () => {},
		on: () => () => {},
		onHook: (hook: string, registered: unknown, options?: { tail?: boolean }) => {
			if (hook === "turn.transformContext") capture(registered);
			return host.onHook(hook as never, registered as never, { ...(options?.tail ? { tail: true } : {}) });
		},
	} as never;
}

/**
 * 接缝的端到端事实：世界声明的 requestContext 必须出现在**每一次**模型请求的尾部，
 * 而不是回合开头那一份旧消息。Subject.prepareProjection 每请求运行 transformContext，
 * 这条测试把"状态不是消息、是每次决策前重新读的观察"钉在真实投影链路上。
 */
test("世界请求上下文出现在每一次模型请求的尾部，并且是那一刻的新快照", async () => {
	const host = new ExtensionHost();
	// 只留投影消息：ModelRequest 带 providerHooks（函数），不可结构化克隆。
	const requests: { messages: readonly ChatMsg[] }[] = [];
	let snapshot = "第1帧：坐标 (0,64,0) 生命20/20";
	const stream: ModelStreamFn = async (_model, request, delta) => {
		requests.push({ messages: [...request.messages] });
		if (requests.length === 1) {
			// 第一次请求后世界动了：第二次请求必须看到新值，而不是回合开头那份。
			snapshot = "第2帧：坐标 (3,64,1) 生命18/20";
			delta({ kind: "tool_call", call: { id: "call-1", name: "look", args: "{}", argsValid: true } });
			delta({ kind: "finish", reason: "tool_calls" });
			return;
		}
		delta({ kind: "text", text: "好了" });
		delta({ kind: "finish", reason: "stop" });
	};
	const harness = SubjectHarness.create({
		runtimeHooks: createRuntimeHooks(host),
		stream,
		tools: [mockTool("look", () => "看到一片草地")],
	});
	const events: unknown[] = [];
	harness.subscribe((event) => {
		if (event.type === "error") events.push(event);
	});
	const definition: WorldDef = {
		name: "probe",
		description: "request context probe",
		actions: { noop: { description: "noop", run: () => ({ result: "ok", status: "succeeded" as const }) } },
		requestContext: async () => snapshot,
	};
	const pi = {
		subject: undefined,
		cwd: process.cwd(),
		submitInput: (input: Parameters<typeof harness.subject.accept>[0]) => harness.subject.accept(input),
		isBusy: () => harness.isBusy(),
		registerTool: () => () => {},
		on: () => () => {},
		onHook: (hook: string, handler: unknown, options?: { tail?: boolean }) =>
			host.onHook(hook as never, handler as never, { ...(options?.tail ? { tail: true } : {}) }),
	};
	const activation = new WorldActivation(definition, {
		pi: pi as never,
		runtime: { definition, enabled: true },
		worldName: "probe",
		notifyExposed: () => {},
	});
	await activation.start();
	try {
		await harness.run("看看四周");
		expect(events).toEqual([]);
		expect(requests).toHaveLength(2);
		const text = (index: number): string => JSON.stringify(requests[index]!.messages);
		expect(text(0)).toContain("第1帧：坐标 (0,64,0)");
		expect(text(1)).toContain("第2帧：坐标 (3,64,1)");
		expect(text(1)).not.toContain("第1帧：坐标 (0,64,0)");
		// 帧是瞬态投影：不进持久历史，模型之外没人消费它。
		expect(JSON.stringify(harness.subject.historySnapshot())).not.toContain("第2帧");
	} finally {
		await activation.stop();
	}
});

test("世界停用后不再注入，后续请求回到无帧状态", async () => {
	const host = new ExtensionHost();
	const requests: { messages: readonly ChatMsg[] }[] = [];
	const stream: ModelStreamFn = async (_model, request, delta) => {
		requests.push({ messages: [...request.messages] });
		delta({ kind: "text", text: "ok" });
		delta({ kind: "finish", reason: "stop" });
	};
	const harness = SubjectHarness.create({ runtimeHooks: createRuntimeHooks(host), stream });
	const definition: WorldDef = {
		name: "probe",
		description: "request context probe",
		actions: { noop: { description: "noop", run: () => ({ result: "ok", status: "succeeded" as const }) } },
		requestContext: async () => "世界仍在运行",
	};
	const pi = {
		subject: undefined,
		cwd: process.cwd(),
		submitInput: (input: Parameters<typeof harness.subject.accept>[0]) => harness.subject.accept(input),
		isBusy: () => harness.isBusy(),
		registerTool: () => () => {},
		on: () => () => {},
		onHook: (hook: string, handler: unknown, options?: { tail?: boolean }) =>
			host.onHook(hook as never, handler as never, { ...(options?.tail ? { tail: true } : {}) }),
	};
	const activation = new WorldActivation(definition, {
		pi: pi as never,
		runtime: { definition, enabled: true },
		worldName: "probe",
		notifyExposed: () => {},
	});
	await activation.start();
	await harness.run("第一次");
	await activation.stop();
	await harness.run("第二次");
	expect(requests).toHaveLength(2);
	expect(JSON.stringify(requests[0]!.messages)).toContain("世界仍在运行");
	expect(JSON.stringify(requests[1]!.messages)).not.toContain("世界仍在运行");
});

// 取不到快照是小事，挂住回合不是；但"取不到"必须说出来——什么都不注入会被模型读成
// "世界没有变化"，那比没有状态更危险。这条同时钉住 handler 自己不许抛。
test("世界读取抛错时注入占位帧，handler 不抛错", async () => {
	const host = new ExtensionHost();
	let handler: ((projection: { messages: readonly ChatMsg[] }) => Promise<unknown>) | undefined;
	const definition: WorldDef = {
		name: "probe",
		description: "request context probe",
		actions: { noop: { description: "noop", run: () => ({ result: "ok", status: "succeeded" as const }) } },
		requestContext: async () => {
			throw new Error("world snapshot crashed");
		},
	};
	const activation = new WorldActivation(definition, {
		pi: probeHost(host, (registered) => {
			handler = registered as (projection: { messages: readonly ChatMsg[] }) => Promise<unknown>;
		}),
		runtime: { definition, enabled: true },
		worldName: "probe",
		notifyExposed: () => {},
	});
	await activation.start();
	try {
		expect(handler).toBeDefined();
		const result = await handler!({ messages: [] });
		const text = JSON.stringify(result);
		expect(text).toContain("本轮没有取到世界观察");
		expect(text).toContain("world snapshot crashed");
		expect(text).toContain("不要把它当成世界没有变化");
	} finally {
		await activation.stop();
	}
});

// 超时与抛错走同一条路径（withTimeout 只把 reject 提前），但"超时"必须和"世界报错"
// 说成两件事：前者是世界侧卡住，后者是它明确失败。
test("世界读取超时时注入占位帧，不静默消失", async () => {
	const host = new ExtensionHost();
	let handler: ((projection: { messages: readonly ChatMsg[] }) => Promise<unknown>) | undefined;
	const definition: WorldDef = {
		name: "probe",
		description: "request context probe",
		actions: { noop: { description: "noop", run: () => ({ result: "ok", status: "succeeded" as const }) } },
		// 永不结算：模拟世界侧卡住。
		requestContext: () => new Promise<string | null>(() => {}),
	};
	const activation = new WorldActivation(definition, {
		pi: probeHost(host, (registered) => {
			handler = registered as (projection: { messages: readonly ChatMsg[] }) => Promise<unknown>;
		}),
		runtime: { definition, enabled: true },
		worldName: "probe",
		notifyExposed: () => {},
	});
	await activation.start();
	try {
		const text = JSON.stringify(await handler!({ messages: [] }));
		expect(text).toContain("本轮没有取到世界观察");
		expect(text).toContain("读取超时");
	} finally {
		await activation.stop();
	}
});

// 清理不能挂在"原始读取结算"上：读取永久挂起时，超时分支必须当场摘掉 abort 监听器，
// 否则每个卡住的请求都往 scope 上留一份，直到世界停用才被一起触发。
test("超时当场摘掉 abort 监听器，不等原始读取结算", async () => {
	const host = new ExtensionHost();
	let handler: ((projection: { messages: readonly ChatMsg[] }) => Promise<unknown>) | undefined;
	const definition: WorldDef = {
		name: "probe",
		description: "request context probe",
		actions: { noop: { description: "noop", run: () => ({ result: "ok", status: "succeeded" as const }) } },
		requestContext: () => new Promise<string | null>(() => {}),
	};
	const activation = new WorldActivation(definition, {
		pi: probeHost(host, (registered) => {
			handler = registered as (projection: { messages: readonly ChatMsg[] }) => Promise<unknown>;
		}),
		runtime: { definition, enabled: true },
		worldName: "probe",
		notifyExposed: () => {},
	});
	await activation.start();
	try {
		const signal = activation.scope.signal;
		const before = getEventListeners(signal, "abort").length;
		await handler!({ messages: [] });
		expect(getEventListeners(signal, "abort").length).toBe(before);
	} finally {
		await activation.stop();
	}
});

// 卡住的那一份还在飞时，第二个请求不再压一份上去：否则世界越卡，压上去的读取越多，
// 每个请求还会各留一个永不清理的 abort 监听器。
test("上一份读取还在飞时，下一份直接说还没回来", async () => {
	const host = new ExtensionHost();
	let handler: ((projection: { messages: readonly ChatMsg[] }) => Promise<unknown>) | undefined;
	let calls = 0;
	const definition: WorldDef = {
		name: "probe",
		description: "request context probe",
		actions: { noop: { description: "noop", run: () => ({ result: "ok", status: "succeeded" as const }) } },
		requestContext: () => {
			calls++;
			return new Promise<string | null>(() => {});
		},
	};
	const activation = new WorldActivation(definition, {
		pi: probeHost(host, (registered) => {
			handler = registered as (projection: { messages: readonly ChatMsg[] }) => Promise<unknown>;
		}),
		runtime: { definition, enabled: true },
		worldName: "probe",
		notifyExposed: () => {},
	});
	await activation.start();
	try {
		const first = handler!({ messages: [] });
		const second = JSON.stringify(await handler!({ messages: [] }));
		expect(second).toContain("上一次读取仍未返回");
		expect(JSON.stringify(await first)).toContain("读取超时");
		expect(calls).toBe(1);
	} finally {
		await activation.stop();
	}
});
