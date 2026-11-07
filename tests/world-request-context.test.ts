import { expect, test } from "vitest";
import type { ChatMsg, ModelStreamFn } from "../src/core/types.js";
import { ExtensionHost } from "../src/extensions/host.js";
import { createRuntimeHooks } from "../src/extensions/runtime-hooks.js";
import type { WorldDef } from "../src/extensions/world-framework/types.js";
import { WorldActivation } from "../src/extensions/world-framework/world-activation.js";
import { mockTool, SubjectHarness } from "./harness/index.js";

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
