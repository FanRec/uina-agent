/**
 * 上下文占用的刷新粒度：单次模型调用收尾就要上报真实用量，而不是等整个回合结束。
 *
 * 背景：turn_end 只在一次 pushInput 的全部模型调用、工具往返都跑完后才发一次。
 * 一个回合可以有几十次调用，期间底栏的"已用/总量"一直停在上一轮的值——用户看到的就是
 * "完成一次任务之后才更新"。服务端 usage 在每次调用收尾就到手，所以让它在那一刻上报。
 */
import { describe, expect, it, mockModel, SubjectHarness } from "./harness/index.js";
import type { Model, ModelRequest, ModelStreamFn, StreamDelta } from "../src/core/types.js";
import type { RuntimeEvent } from "../src/runtime/events.js";

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
function collect(): { events: RuntimeEvent[]; harness: SubjectHarness } {
	const events: RuntimeEvent[] = [];
	const harness = SubjectHarness.create({
		model: MODEL,
		stream: streamWithUsage({ input: 4_000, output: 200, totalTokens: 12_345, cacheRead: 1_000 }),
		systemPrompt: "sys",
	});
	harness.subscribe((event) => events.push(event));
	return { events, harness };
}

const indexOf = (events: RuntimeEvent[], type: RuntimeEvent["type"]): number => events.findIndex((e) => e.type === type);

describe("usage_update：每次模型调用收尾就上报真实用量", () => {
	it("在 turn_end 之前就发出 usage_update，且带服务端真实 token 数", async () => {
		const { events, harness } = collect();
		await harness.run("你好");

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

		const harness = SubjectHarness.create({ model: MODEL, stream, systemPrompt: "sys" });
		harness.subscribe((event) => events.push(event));
		await harness.run("跑两轮");

		const updates = events.filter((e): e is Extract<RuntimeEvent, { type: "usage_update" }> => e.type === "usage_update");
		expect(call).toBeGreaterThanOrEqual(2);
		// 每次调用各自的真实值都要上报，而不是被最后一次覆盖。
		expect(updates.map((u) => u.usedTokens)).toEqual([11_000, 12_000]);
		// 两次调用必须是不同的 callId（一次模型调用一个标识），消费端才能正确切分调用边界。
		expect(new Set(updates.map((u) => u.callId)).size).toBe(updates.length);
	});

	it("turn_end 与实时上报同源（底栏不会在估算值与真实值之间跳）", async () => {
		const { events, harness } = collect();
		await harness.run("你好");

		const usageEvent = events.find((e): e is Extract<RuntimeEvent, { type: "usage_update" }> => e.type === "usage_update")!;
		const endEvent = events.find((e): e is Extract<RuntimeEvent, { type: "turn_end" }> => e.type === "turn_end")!;
		expect(endEvent.usage?.usedTokens).toBe(usageEvent.usedTokens);
		expect(endEvent.usage?.actual).toBe(usageEvent.actual);
	});
});

describe("getUsedTokens：真实值优先于字符估算", () => {
	it("服务端报过总量后返回真实值，而不是 estimateContextTokens 的启发式结果", async () => {
		const stream: ModelStreamFn = async (_m, _req, onDelta) => {
			onDelta({ kind: "usage", usage: { input: 1, output: 1, totalTokens: 99_999 } });
			onDelta({ kind: "finish", reason: "stop" });
		};
		const harness = SubjectHarness.create({ model: MODEL, stream, systemPrompt: "sys" });
		const before = harness.subject.getUsedTokens();
		await harness.run("你好");
		const after = harness.subject.getUsedTokens();

		expect(after).toBe(99_999);
		// 真实值不和估算值重合（否则这条测试区分不出实现）——历史里带着用户输入与回复，
		// 估算结果远小于 99_999。
		expect(before).not.toBe(99_999);
	});
});

describe("setModel：口径换了，旧模型的 usage 锚必须失效", () => {
	it("切换模型后 getUsedTokens() 不再返回旧模型报的真实总量", async () => {
		const harness = SubjectHarness.create({
			model: MODEL,
			stream: streamWithUsage({ input: 1, output: 1, totalTokens: 99_999 }),
			systemPrompt: "sys",
		});
		await harness.run("你好");
		expect(harness.subject.getUsedTokens()).toBe(99_999);

		const bigger = mockModel({ id: "mock2", name: "mock2", contextWindow: 200_000 });
		await harness.subject.setModel(bigger);

		// 旧模型报的 99_999 是旧窗口口径下的绝对总量，对新窗口没有描述力：
		// 切模型后必须回落到字符估算，与压缩 / 回溯同一条失效纪律。
		// 回退本修复（删掉 setModel 里的 forgetUsage()）后，这里恒为 99_999。
		expect(harness.subject.getUsedTokens()).not.toBe(99_999);
		expect(harness.subject.getContextWindow()).toBe(200_000);
	});

	it("带 usage 的 assistant 不在末位时（后跟工具结果），旧锚同样必须失效", async () => {
		const harness = SubjectHarness.create({
			model: MODEL,
			stream: streamWithUsage({ input: 1, output: 1, totalTokens: 99_999 }),
			systemPrompt: "sys",
		});
		// 工具交换中途停手的形态：带 usage 的 assistant 后面跟着 tool 结果 ——
		// 回合被打断、工具 stop 收尾、not_started 尾巴都长这样。
		// estimateContextTokens 从后往前找，仍会锚到那条 assistant。
		harness.subject.addHistory([
			{ role: "user", content: "第一回合" },
			{ role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read", args: "{}" }], status: "complete", usage: { input: 1, output: 1, totalTokens: 99_999 } },
			{ role: "tool", tool_call_id: "c1", content: "结果", status: "succeeded" },
		] as never);
		expect(harness.subject.getUsedTokens()).toBe(99_999 + 5);

		await harness.subject.setModel(mockModel({ id: "mock2", name: "mock2", contextWindow: 200_000 }));

		// 只剥最后一条 assistant 的 usage 盖不住这个形态：旧锚从历史深处存活，
		// getUsedTokens() 继续顶着旧口径的 99_999。
		expect(harness.subject.getUsedTokens()).not.toBe(99_999);
	});
});
