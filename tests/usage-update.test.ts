/**
 * 上下文占用的刷新粒度：单次模型调用收尾就要上报真实用量，而不是等整个回合结束。
 *
 * 背景：turn_end 只在一次 pushInput 的全部模型调用、工具往返都跑完后才发一次。
 * 一个回合可以有几十次调用，期间底栏的"已用/总量"一直停在上一轮的值——用户看到的就是
 * "完成一次任务之后才更新"。服务端 usage 在每次调用收尾就到手，所以让它在那一刻上报。
 */
import { describe, expect, it } from "vitest";
import type { Model, ModelRequest, ModelStreamFn, StreamDelta } from "../src/core/types.js";
import type { RuntimeEvent } from "../src/runtime/events.js";
import { mockModel } from "./helpers/mock-provider.js";

const MODEL: Model = mockModel({ id: "mock", name: "mock", contextWindow: 100_000 });

/** 一次调用：先吐文本，再报一条真实 usage。 */
function streamWithUsage(usage: { input: number; output: number; totalTokens: number; cacheRead?: number }): ModelStreamFn {
	return async (_m: Model, _req: ModelRequest, onDelta: (d: StreamDelta) => void) => {
		onDelta({ kind: "text", text: "响应体" });
		onDelta({ kind: "usage", usage });
		onDelta({ kind: "finish", reason: "stop" });
	};
}

/** 录制所有 runtime 事件，返回"某类事件在 turn_end 之前出现的次数"这类查询能力。 */
async function collect(): Promise<{ events: RuntimeEvent[]; subject: import("../src/agent/loop.js").Subject }> {
	const { Subject } = await import("../src/agent/loop.js");
	const { ToolBroker } = await import("../src/tools/broker.js");
	const events: RuntimeEvent[] = [];
	const subject = new Subject(MODEL, streamWithUsage({ input: 4_000, output: 200, totalTokens: 12_345, cacheRead: 1_000 }), new ToolBroker(), {
		systemPrompt: "sys",
	});
	subject.subscribe((event) => events.push(event));
	return { events, subject };
}

const indexOf = (events: RuntimeEvent[], type: RuntimeEvent["type"]): number => events.findIndex((e) => e.type === type);

describe("usage_update：每次模型调用收尾就上报真实用量", () => {
	it("在 turn_end 之前就发出 usage_update，且带服务端真实 token 数", async () => {
		const { events, subject } = await collect();
		await subject.pushInput("你好");
		await subject.waitForIdle();

		const usageIdx = indexOf(events, "usage_update");
		const endIdx = indexOf(events, "turn_end");

		expect(usageIdx).toBeGreaterThanOrEqual(0);
		expect(endIdx).toBeGreaterThanOrEqual(0);
		// 关键：实时上报必须先于回合结束事件出现（旧实现里根本没有 usage_update，
		// 只有 turn_end 带 usage —— 这条断言在旧逻辑下 usageIdx === -1 直接失败）。
		expect(usageIdx).toBeLessThan(endIdx);

		const usageEvent = events[usageIdx] as Extract<RuntimeEvent, { type: "usage_update" }>;
		expect(usageEvent.usedTokens).toBe(12_345);
		expect(usageEvent.actual).toBe(true);
		expect(usageEvent.contextWindow).toBe(100_000);
		expect(usageEvent.inputTokens).toBe(4_000);
		expect(usageEvent.outputTokens).toBe(200);
		expect(usageEvent.cacheRead).toBe(1_000);
		// 事件必须带调用标识：同一次调用的多条累积快照要靠它去重（消费端按调用记账）。
		expect(typeof usageEvent.callId).toBe("string");
		expect(usageEvent.callId.length).toBeGreaterThan(0);
	});

	it("每次模型调用都上报一次（多轮工具往返不只报最后一次）", async () => {
		const { Subject } = await import("../src/agent/loop.js");
		const { ToolBroker } = await import("../src/tools/broker.js");
		const events: RuntimeEvent[] = [];

		let call = 0;
		const stream: ModelStreamFn = async (_m, _req, onDelta) => {
			call++;
			const total = 10_000 + call * 1_000;
			// 第一次调用请求一个（必然失败/不存在的）工具，逼出一个工具往返，形成多次调用。
			if (call === 1) onDelta({ kind: "tool_call", call: { id: "c1", name: "no_such_tool", args: "{}" } });
			onDelta({ kind: "usage", usage: { input: 1, output: 1, totalTokens: total } });
			onDelta({ kind: "finish", reason: call === 1 ? "tool_calls" : "stop" });
		};

		const subject = new Subject(MODEL, stream, new ToolBroker(), { systemPrompt: "sys" });
		subject.subscribe((event) => events.push(event));
		await subject.pushInput("跑两轮");
		await subject.waitForIdle();

		const updates = events.filter((e): e is Extract<RuntimeEvent, { type: "usage_update" }> => e.type === "usage_update");
		expect(call).toBeGreaterThanOrEqual(2);
		// 每次调用各自的真实值都要上报，而不是被最后一次覆盖。
		expect(updates.map((u) => u.usedTokens)).toEqual([11_000, 12_000]);
		// 两次调用必须是不同的 callId（一次模型调用一个标识），消费端才能正确切分调用边界。
		expect(new Set(updates.map((u) => u.callId)).size).toBe(updates.length);
	});

	it("turn_end 与实时上报同源（底栏不会在估算值与真实值之间跳）", async () => {
		const { events, subject } = await collect();
		await subject.pushInput("你好");
		await subject.waitForIdle();

		const usageEvent = events.find((e): e is Extract<RuntimeEvent, { type: "usage_update" }> => e.type === "usage_update")!;
		const endEvent = events.find((e): e is Extract<RuntimeEvent, { type: "turn_end" }> => e.type === "turn_end")!;
		expect(endEvent.usage?.usedTokens).toBe(usageEvent.usedTokens);
		expect(endEvent.usage?.actual).toBe(usageEvent.actual);
	});
});

describe("getUsedTokens：真实值优先于字符估算", () => {
	it("服务端报过总量后返回真实值，而不是 estimateContextTokens 的启发式结果", async () => {
		const { Subject } = await import("../src/agent/loop.js");
		const { ToolBroker } = await import("../src/tools/broker.js");
		const stream: ModelStreamFn = async (_m, _req, onDelta) => {
			onDelta({ kind: "usage", usage: { input: 1, output: 1, totalTokens: 99_999 } });
			onDelta({ kind: "finish", reason: "stop" });
		};
		const subject = new Subject(MODEL, stream, new ToolBroker(), { systemPrompt: "sys" });
		const before = subject.getUsedTokens();
		await subject.pushInput("你好");
		await subject.waitForIdle();
		const after = subject.getUsedTokens();

		expect(after).toBe(99_999);
		// 真实值不和估算值重合（否则这条测试区分不出实现）——历史里带着用户输入与回复，
		// 估算结果远小于 99_999。
		expect(before).not.toBe(99_999);
	});
});
describe("压缩后：底栏回落估算，而不是接着显示压缩前的真值", () => {
	it("session_compact 广播的那一刻，监听者读到的已按新历史重算", async () => {
		const { ExtensionHost } = await import("../src/extensions/host.js");
		const { createRuntimeHooks } = await import("../src/extensions/runtime-hooks.js");

		const host = new ExtensionHost();
		const subject = new (await import("../src/agent/loop.js")).Subject(
			MODEL,
			streamWithUsage({ input: 1, output: 1, totalTokens: 99_999 }),
			new (await import("../src/tools/broker.js")).ToolBroker(),
			{ systemPrompt: "sys", runtimeHooks: createRuntimeHooks(host) },
		);
		subject.addHistory([
			{ role: "user", content: "第一条" },
			{ role: "assistant", content: "回复一" },
			{ role: "user", content: "第二条" },
			{ role: "assistant", content: "回复二" },
		]);

		await subject.pushInput("你好");
		await subject.waitForIdle();
		expect(subject.getUsedTokens()).toBe(99_999);

		let seenInHandler: number | undefined;
		host.on("session_compact", () => {
			seenInHandler = subject.getUsedTokens();
		});
		await subject.compact();

		// 压缩换掉了历史，压缩前的 99_999 不再描述现在。如果清空发生在广播之后，
		// 监听者（底栏刷新）会把旧真值写回去 —— 数字不动、只多一个 ~。
		expect(seenInHandler).toBeDefined();
		expect(seenInHandler).not.toBe(99_999);
		// 广播里看到的就是压缩后的最终状态，不留瞬态。
		expect(seenInHandler).toBe(subject.getUsedTokens());
	});
});
