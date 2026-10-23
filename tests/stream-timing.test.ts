/**
 * Provider 真实时序：TTFT 与解码窗口必须由 SSE 边界给出，而不是 UI 事件时刻。
 *
 * 背景：表盘的分母曾经取 usage 事件到达的 UI 时刻，usage chunk 在 finish_reason 之后
 * 单独到达，尾部 RTT 被算进解码窗口，短回合读数因此被压掉三成以上。Collector 是唯一
 * 能看到「首个内容 delta → 末个内容 delta」的位置，它同时覆盖思考、正文与工具调用参数，
 * 且不含 usage 的尾部 RTT。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnStreamCollector } from "../src/agent/stream-collector.js";
import type { GenerationTiming } from "../src/core/types.js";

const T0 = 1_700_000_000_000;

afterEach(() => {
	vi.useRealTimers();
});

function createCollector(): {
	collector: TurnStreamCollector;
	timings: Array<GenerationTiming | undefined>;
} {
	const timings: Array<GenerationTiming | undefined> = [];
	const collector = new TurnStreamCollector("stream-1", () => {}, {
		onUsage: (_usage, timing) => timings.push(timing),
	});
	return { collector, timings };
}

describe("TurnStreamCollector：真实生成时序", () => {
	it("TTFT 从请求发出算到首个内容 delta；解码窗口到末个内容 delta，不含 usage 尾部 RTT", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const { collector, timings } = createCollector();

		vi.setSystemTime(T0 + 500);
		collector.handleDelta({ kind: "thinking", text: "想" });
		vi.setSystemTime(T0 + 900);
		collector.handleDelta({ kind: "text", text: "答" });
		vi.setSystemTime(T0 + 1200); // usage 比末个 delta 晚 300ms 才到
		collector.handleDelta({ kind: "usage", usage: { output: 23, reasoning: 16 } });

		expect(timings).toEqual([{ ttftMs: 500, decodeMs: 400 }]);
	});

	it("工具调用参数段计入窗口：tool_call delta 的到达时刻就是末个 delta", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const { collector, timings } = createCollector();

		vi.setSystemTime(T0 + 10);
		collector.handleDelta({ kind: "text", text: "我来看看这个文件" });
		vi.setSystemTime(T0 + 3010); // 3 秒工具参数流式期间没有任何 UI 增量
		collector.handleDelta({ kind: "tool_call", call: { id: "call-1", name: "read_file", args: "{}" } });
		vi.setSystemTime(T0 + 3050);
		collector.handleDelta({ kind: "usage", usage: { output: 500 } });

		expect(timings).toEqual([{ ttftMs: 10, decodeMs: 3000 }]);
	});

	it("整步没有任何内容 delta 时不给时序：没有窗口就不该拿 usage 时刻凑一个", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const { collector, timings } = createCollector();

		vi.setSystemTime(T0 + 3000);
		collector.handleDelta({ kind: "usage", usage: { output: 175 } });

		expect(timings).toEqual([undefined]);
	});
});
