/**
 * 接线层回归：usage_update / output_update / tool_call 事实事件 → activityLine 计账。
 *
 * 背景：`tui.ts` 的 `case "usage_update"` 等分支是"事件 → 速度计账"的唯一接线。
 * 此前只有 ActivityLineComponent 的内部单测；把那行调用删掉，全部 485 个测试依然全绿
 * （子代理变异验证 #4），所以接线错误能一路溜到真机。这里从真实入口 createInteractiveUI
 * 驱动 HostEvent，把接线本身钉住 —— 包括本次修复的根本原因：Provider 把工具调用参数攒成
 * 一个完整 tool_call 才上报，UI 在参数流式期间收不到任何增量，于是那段时间曾经完全不计入
 * 分母（分子含参数、分母不含，不开思考时读数虚拟高两个数量级）。
 */
import { describe, expect, it, vi } from "vitest";
import { foldStreamChars } from "../src/ui/components/widgets/activity-line.js";
import { createInteractiveUI } from "../src/ui/tui.js";

/** 假时钟基准：TTFT 与生成跨度靠它区分。 */
const T0 = 1_700_000_000_000;

/** 从 SGR 序列里剥掉颜色与粗体，只留可见字形。 */
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

import { createSilentTerminal } from "./harness/index.js";

const createTestUI = () => createInteractiveUI({ modelName: "TestModel", terminal: createSilentTerminal(120, 30).terminal });

const headerTokens = (tui: ReturnType<typeof createInteractiveUI>): string =>
	plain(tui.host.activityLine.render(200).join("\n"));

describe("InteractiveTUI：usage_update 接线到速度计账", () => {
	it("同一调用的多条 usage_update 只按最后一次计，不叠加；该调用的字符估算被真值取代", () => {
		const tui = createTestUI();
		tui.render({ type: "turn_start", turnNumber: 1, userText: "做任务" });
		// 模拟一次 text delta 留下的字符估算占位（系数由模块标定，这里只钉"真值取代估算"）
		const placeholder = foldStreamChars({ cjk: 1150, other: 0 });
		tui.host.activityLine.addStreamText("思".repeat(1150));
		// 同一次调用推两条累积快照（现实中值会一路增长，这里取终值）
		tui.render({ type: "usage_update", callId: "call-1", usedTokens: 1000, outputTokens: 120 });
		tui.render({ type: "usage_update", callId: "call-1", usedTokens: 1000, outputTokens: 120 });
		tui.render({ type: "turn_end", turnNumber: 1 });

		const rendered = headerTokens(tui);
		// 有真实值就用真实值，且只计一次
		expect(rendered).toContain("~120 tokens");
		// 不能是"同一调用按推送次数累加"（240），也不能是"真值 + 估算"
		expect(rendered).not.toContain("~240 tokens");
		expect(rendered).not.toContain("~" + (120 + placeholder) + " tokens");
		// 若接线被删，会退回估算
		expect(rendered).not.toContain("~" + placeholder + " tokens");
	});

	it("跨 step 的真实输出累加（多轮 stream→tool→stream）", () => {
		const tui = createTestUI();
		tui.render({ type: "turn_start", turnNumber: 1, userText: "跑两轮" });
		tui.render({ type: "output_update", streamId: "s1", offset: 0, channel: "content", text: "第一轮的输出" }); // 调用 1 有增量 → 有解码区间
		tui.render({ type: "usage_update", callId: "call-1", usedTokens: 1000, outputTokens: 30 });
		tui.render({ type: "tool_call", toolName: "list_dir", args: {}, callId: "tool-1" }); // 调用 1 收尾
		tui.render({ type: "output_update", streamId: "s1", offset: 1, channel: "content", text: "第二轮的输出" }); // 调用 2 的增量
		tui.render({ type: "usage_update", callId: "call-2", usedTokens: 1000, outputTokens: 45 });
		tui.render({ type: "turn_end", turnNumber: 1 });

		const rendered = headerTokens(tui);
		expect(rendered).toContain("~75 tokens");
	});

	it("思考增量也进解码区间：左端从「首个生成的 token」起算，而非正文首字", () => {
		// 服务端的 outputTokens 是 completion_tokens，含思考 token。若思考增量不喂
		// addTokens，这一步就没有任何可见增量 —— 分子有输出、分母无从谈起。
		vi.useFakeTimers();
		try {
			vi.setSystemTime(T0);
			const tui = createTestUI();
			tui.render({ type: "turn_start", turnNumber: 1, userText: "想久一点" });
			vi.setSystemTime(T0 + 1000); // +1s：TTFT 等待，不是生成，不计入分母
			tui.render({ type: "output_update", streamId: "s1", offset: 0, channel: "thinking", text: "思".repeat(300) });
			vi.setSystemTime(T0 + 6000); // +5s：思考生成中
			tui.render({ type: "output_update", streamId: "s1", offset: 1, channel: "thinking", text: "考".repeat(300) });
			vi.setSystemTime(T0 + 8000); // +2s：正文生成
			tui.render({ type: "output_update", streamId: "s1", offset: 2, channel: "content", text: "答".repeat(300) });
			vi.setSystemTime(T0 + 9000);
			tui.render({ type: "turn_end", turnNumber: 1 });

			const rendered = headerTokens(tui);
			// 三段合计 900 字都要计入，不能只剩正文那一段（300 字）。
			const allSegments = foldStreamChars({ cjk: 900, other: 0 });
			const textOnly = foldStreamChars({ cjk: 300, other: 0 });
			expect(rendered).toContain("~" + allSegments + " tokens");
			expect(rendered).not.toContain("~" + textOnly + " tokens");
			// 分母 = 首个思考 token 到最后一个 token = 7.0s；若思考增量不进解码区间，
			// 这一步根本没有可度量的生成时间。
			expect(rendered).toContain("~" + Math.round(allSegments / 7) + " tps");
		} finally {
			vi.useRealTimers();
		}
	});

	it("上一次调用的真值到位后，本次调用新吐出的 token 仍要进分子（否则读数一路往下掉）", () => {
		// 真机实测：调用 1 收尾报回 672 之后，调用 2 的估算被永久丢弃，分子冻在 672、
		// 分母照涨 —— 显示值从 297 tps 单调跌到 75，而模型一直在全速输出。
		// 新模型里 step 在工具边界收尾，调用 2 从零起算，结构上不可能丢。
		vi.useFakeTimers();
		try {
			vi.setSystemTime(T0);
			const tui = createTestUI();
			tui.render({ type: "turn_start", turnNumber: 1, userText: "两轮输出" });
			vi.setSystemTime(T0 + 10);
			tui.render({ type: "output_update", streamId: "s1", offset: 0, channel: "thinking", text: "甲".repeat(300) }); // 估算 300
			vi.setSystemTime(T0 + 510);
			// 调用 1 收尾，真值 120 到位
			tui.render({ type: "usage_update", callId: "call-1", usedTokens: 1000, outputTokens: 120 });
			vi.setSystemTime(T0 + 1010);
			// 调用 1 收尾（它的工具开始跑）：0.5s 解码、120 token 结算进本回合
			tui.render({ type: "tool_call", toolName: "list_dir", args: {}, callId: "tool-1" });
			vi.setSystemTime(T0 + 1510);
			tui.render({ type: "output_update", streamId: "s1", offset: 1, channel: "thinking", text: "乙".repeat(300) }); // 调用 2 又吐 300
			vi.setSystemTime(T0 + 2510);
			tui.render({ type: "output_update", streamId: "s1", offset: 2, channel: "thinking", text: "丙".repeat(300) });
			// 分子 = 120（调用 1 的真值）+ 调用 2 的 600 字折算；分母 = 0.5s + 1.0s。
			// 系数由模块标定，这里只钉跨 step 累加：分子冻在 120 的旧实现读到 ~80 tps。
			const liveTokens = 120 + foldStreamChars({ cjk: 600, other: 0 });
			const rendered = headerTokens(tui);
			expect(rendered).toContain("~" + Math.round(liveTokens / 1.5) + " tps");
			expect(rendered).not.toContain("~80 tps");
		} finally {
			vi.useRealTimers();
		}
	});

	it("不开思考时工具参数流式期间 UI 收不到增量：右端仍是这一步的收尾时刻", () => {
		// 根本原因回归。模型这一步只吐了一句 8 字前言（8 token 估算），随后 3 秒都在流
		// 工具调用参数 —— Provider 攒成一个完整 tool_call 才上报，UI 期间零增量。
		// 右端若取"最后一个可见 token"（10ms 处），500 / 0.01s = 50000 tps。
		vi.useFakeTimers();
		try {
			vi.setSystemTime(T0);
			const tui = createTestUI();
			tui.render({ type: "turn_start", turnNumber: 1, userText: "看下这个文件" });
			vi.setSystemTime(T0 + 10);
			tui.render({ type: "output_update", streamId: "s1", offset: 0, channel: "content", text: "我来看看这个文件" });
			vi.setSystemTime(T0 + 3010); // 3 秒工具参数流式：UI 收不到任何增量
			tui.render({ type: "usage_update", callId: "call-1", usedTokens: 1000, outputTokens: 500 });
			vi.setSystemTime(T0 + 3020);
			tui.render({ type: "tool_call", toolName: "read_file", args: {}, callId: "tool-1" });

			// 500 token / 3.0s 解码 = ~167 tps（分子是整步的 500，分母是整步的 3.0s）。
			// 实时行不展示 token 总数，所以用速度同时钉住两侧：右端取最后一个可见 token
			// 会读到 ~50000；分子丢掉真值、只算那句前言的折算会读到个位数。
			const preambleOnly = Math.round(foldStreamChars({ cjk: 8, other: 0 }) / 3);
			const duringTool = headerTokens(tui);
			expect(duringTool).toContain("~167 tps");
			expect(duringTool).not.toContain("50000");
			expect(duringTool).not.toContain("~" + preambleOnly + " tps");

			// 工具跑 30 秒也不该稀释读数。
			vi.setSystemTime(T0 + 33_020);
			const afterTool = headerTokens(tui);
			expect(afterTool).toContain("~167 tps");
		} finally {
			vi.useRealTimers();
		}
	});
});
