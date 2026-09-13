/**
 * 接线层回归：usage_update 事件 → activityLine 计账。
 *
 * 背景：`tui.ts` 的 `case "usage_update"` 是"事件 → 速度计账"的唯一接线。
 * 此前只有 ActivityLineComponent 的内部单测；把那行调用删掉，全部 485 个测试依然全绿
 * （子代理变异验证 #4），所以 2218 tps 的接线错误能一路溜到真机。
 * 这里从真实入口 createInteractiveUI 驱动 HostEvent，把接线本身钉住。
 */
import { describe, expect, it, vi } from "vitest";
import { createInteractiveUI } from "../src/ui/tui.js";

/** 假时钟基准：TTFT 与生成跨度靠它区分。 */
const T0 = 1_700_000_000_000;

/** 从 SGR 序列里剥掉颜色与粗体，只留可见字形。 */
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const headerTokens = (tui: ReturnType<typeof createInteractiveUI>): string =>
	plain(tui.host.activityLine.render(200).join("\n"));

describe("InteractiveTUI：usage_update 接线到速度计账", () => {
	it("同一调用的多条 usage_update 只按最后一次计，不叠加；该调用的字符估算被真值取代", () => {
		const tui = createInteractiveUI({ modelName: "TestModel" });
		tui.render({ type: "turn_start", n: 1, text: "做任务" });
		// 模拟一次 text delta 留下的字符估算占位
		tui.host.activityLine.addTokens(999);
		// 同一次调用推两条累积快照（现实中值会一路增长，这里取终值）
		tui.render({ type: "usage_update", callId: "call-1", usedTokens: 1000, outputTokens: 120 });
		tui.render({ type: "usage_update", callId: "call-1", usedTokens: 1000, outputTokens: 120 });
		tui.render({ type: "turn_end", n: 1 });

		const rendered = headerTokens(tui);
		// 有真实值就用真实值，且只计一次
		expect(rendered).toContain("~120 tokens");
		// 不能是"同一调用按推送次数累加"（240），也不能是"真值 + 估算"（1119）
		expect(rendered).not.toContain("~240 tokens");
		expect(rendered).not.toContain("~1119 tokens");
		// 若接线被删，会退回估算 ~999
		expect(rendered).not.toContain("~999 tokens");
	});

	it("跨调用的真实输出累加（多轮 stream→tool→stream）", () => {
		const tui = createInteractiveUI({ modelName: "TestModel" });
		tui.render({ type: "turn_start", n: 1, text: "跑两轮" });
		tui.render({ type: "usage_update", callId: "call-1", usedTokens: 1000, outputTokens: 30 });
		tui.render({ type: "usage_update", callId: "call-2", usedTokens: 1000, outputTokens: 45 });
		tui.render({ type: "turn_end", n: 1 });

		const rendered = headerTokens(tui);
		expect(rendered).toContain("~75 tokens");
	});

	it("思考增量也进解码跨度：分母从「首个生成的 token」起算，而非正文首字", () => {
		// 服务端的 outputTokens 是 completion_tokens，含思考 token。若思考增量不喂
		// addTokens，分母就要等正文首字才起算 —— 分子含思考、分母不含，读数虚高几十倍
		// （真机实测 9952 tps，而同期墙钟下界只有 143 tps）。
		vi.useFakeTimers();
		try {
			vi.setSystemTime(T0);
			const tui = createInteractiveUI({ modelName: "TestModel" });
			tui.render({ type: "turn_start", n: 1, text: "想久一点" });
			vi.setSystemTime(T0 + 1000); // +1s：TTFT 等待，不是生成，不计入分母
			tui.render({ type: "thinking", text: "思".repeat(300) });
			vi.setSystemTime(T0 + 6000); // +5s：思考生成中
			tui.render({ type: "thinking", text: "考".repeat(300) });
			vi.setSystemTime(T0 + 8000); // +2s：正文生成
			tui.render({ type: "text", text: "答".repeat(300) });
			vi.setSystemTime(T0 + 9000);
			tui.render({ type: "turn_end", n: 1 });

			const rendered = headerTokens(tui);
			// 思考的两段估算必须计入（3x100=300），不能只剩正文那一段（100）
			expect(rendered).toContain("~300 tokens");
			expect(rendered).not.toContain("~100 tokens");
			// 分母 = 首个思考 token 到最后一个 token = 7.0s，300/7 约 43 tps；
			// 若思考增量不进跨度，分母退回墙钟 9s、分子只剩 100 → 11 tps。
			expect(rendered).toContain("~43 tps");
		} finally {
			vi.useRealTimers();
		}
	});

	it("上一次调用的真值到位后，本次调用新吐出的 token 仍要进分子（否则读数一路往下掉）", () => {
		// 真机实测：调用 1 收尾报回 672 之后，调用 2 的 2271 个字符估算被永久丢弃，
		// 分子冻在 672、分母照涨 —— 显示值从 297 tps 单调跌到 75，而模型一直在全速输出。
		vi.useFakeTimers();
		try {
			vi.setSystemTime(T0);
			const tui = createInteractiveUI({ modelName: "TestModel" });
			tui.render({ type: "turn_start", n: 1, text: "两轮输出" });
			vi.setSystemTime(T0 + 10);
			tui.render({ type: "thinking", text: "甲".repeat(300) }); // 估算 100
			vi.setSystemTime(T0 + 510);
			// 调用 1 收尾，真值 120 到位
			tui.render({ type: "usage_update", callId: "call-1", usedTokens: 1000, outputTokens: 120 });
			vi.setSystemTime(T0 + 1010);
			tui.render({ type: "thinking", text: "乙".repeat(300) }); // 调用 2 又吐 100
			// 分子 = 120 + 100 = 220，分母 = 1.0s → ~220 tps；丢弃估算则只剩 120 → ~120 tps
			expect(headerTokens(tui)).toContain("~220 tps");
			vi.setSystemTime(T0 + 2010);
			tui.render({ type: "thinking", text: "丙".repeat(300) });
			// 分子 = 120 + 200 = 320，分母 = 2.0s → ~160 tps；丢弃估算则 120/2 = ~60 tps
			const rendered = headerTokens(tui);
			expect(rendered).toContain("~160 tps");
			expect(rendered).not.toContain("~60 tps");
		} finally {
			vi.useRealTimers();
		}
	});
});
