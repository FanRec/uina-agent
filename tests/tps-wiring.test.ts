/**
 * 接线层回归：usage_update 事件 → activityLine 计账。
 *
 * 背景：`tui.ts` 的 `case "usage_update"` 是"事件 → 速度计账"的唯一接线。
 * 此前只有 ActivityLineComponent 的内部单测；把那行调用删掉，全部 485 个测试依然全绿
 * （子代理变异验证 #4），所以 2218 tps 的接线错误能一路溜到真机。
 * 这里从真实入口 createInteractiveUI 驱动 HostEvent，把接线本身钉住。
 */
import { describe, expect, it } from "vitest";
import { createInteractiveUI } from "../src/ui/tui.js";

/** 从 SGR 序列里剥掉颜色与粗体，只留可见字形。 */
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const headerTokens = (tui: ReturnType<typeof createInteractiveUI>): string =>
	plain(tui.host.activityLine.render(200).join("\n"));

describe("InteractiveTUI：usage_update 接线到速度计账", () => {
	it("同一调用的多条 usage_update 只按最后一次计，不叠加、不与估算相加", () => {
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
});
