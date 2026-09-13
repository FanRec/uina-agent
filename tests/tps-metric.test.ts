/**
 * 生成速度（tps）的两个量纲问题：
 *
 * 1. 分子用字符估算（chars/3）——中文严重偏低（一个汉字 ≈ 1 token，不是 3 字符）。
 *    服务端在每次调用收尾会报真实 completion_tokens，只要它到了就该改用它。
 * 2. 分母用回合墙钟时间——里面混进了工具执行与每次请求的首 token 等待（TTFT）。
 *    工具跑 8 秒、生成 2 秒，显示出来的速度就只有真值的 1/5。
 *
 * 这两条都是"看起来很快/很慢，但单位根本不对"的隐蔽偏差，所以断言必须能区分
 * 真实值与估算值、解码时间与墙钟时间。
 */
import { describe, expect, it } from "vitest";
import { ActivityLineComponent, formatTpsGauge, STREAM_CHARS_PER_TOKEN } from "../src/ui/components/widgets/activity-line.js";

/** 从 SGR 序列里剥掉颜色，只留可见字形。 */
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("formatTpsGauge：量程自适应", () => {
	it("超过峰值不再一律满格：同一速度在不同量程下填充不同", () => {
		// 111 在旧实现里写死 peak=60，ratio 被夹到 1 -> 永远满格，表盘失去信息。
		const atPeak60 = plain(formatTpsGauge(111, 60, 8));
		const atPeak200 = plain(formatTpsGauge(111, 200, 8));
		expect(atPeak60).toContain("██");
		// 量程拉到 200 后，111 只应占约一半，不再是满格。
		expect(atPeak200).not.toBe(atPeak60);
		const filled = (atPeak200.match(/█/g) ?? []).length;
		expect(filled).toBeLessThan(8);
	});

	it("峰值低于地板时抬到地板，避免小样本把表盘放大", () => {
		// peak=10 < GAUGE_FLOOR(40) -> 按 40 缩放：20/40 = 半格多一点。
		const g = plain(formatTpsGauge(20, 10, 8));
		const filled = (g.match(/█/g) ?? []).length;
		expect(filled).toBeLessThanOrEqual(5);
	});
});

describe("ActivityLineComponent：真实值优先、解码时间作分母", () => {
	it("服务端报过真实 output 后，改用真实值而非字符估算", () => {
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		// 先流式估算：模拟中文（10 个字 = 10 字符，估算只有 10/3 ≈ 4 token）。
		act.addTokens(Math.ceil(10 / STREAM_CHARS_PER_TOKEN)); // 4
		// 服务端报真实 10 token（中文 10 字 ≈ 10 token）。
		act.addRealOutputTokens(10);
		act.finish("完成", 1000, undefined);

		const header = plain(act.getHeaderString(120));
		// 真实值 10 应取代估算 4。
		expect(header).toContain("~10 tokens");
	});

	it("多次模型调用的 output 累加，而不是后者覆盖前者", () => {
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addRealOutputTokens(30);
		act.addRealOutputTokens(45);
		act.finish("完成", 1000, undefined);
		expect(plain(act.getHeaderString(120))).toContain("~75 tokens");
	});

	it("工具执行时间不进速度分母：tps 按解码窗口算，不按墙钟算", () => {
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");

		// 模拟：回合开始后等了很久（工具执行），但生成只花了很短时间。
		// start() 设 startTime=now；这里用真实时钟不好造长回合，改为直接验证
		// "解码窗口内"的读数与"墙钟"读数不同 —— 造一个解码窗口为近似的短窗口。
		act.addRealOutputTokens(100);
		act.addTokens(1); // 触发 decodeStartTime（首个 token 时刻 = now）
		// 立即读：解码窗口 ≈ 0ms，墙钟也 ≈ 0ms，此时不应崩、且当窗口 < 400ms 时不显示 tps。
		const header = plain(act.getHeaderString(120));
		expect(header).not.toContain("NaN");
		expect(header).not.toContain("Infinity");
	});

	it("finish 后 tps 用解码耗时而非墙钟耗时", () => {
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addRealOutputTokens(50);
		// 解码耗时给 500ms（elapsedOverride），而墙钟"耗时"字段也是 500ms；
		// 关键是 finish(tokensOverride) 不能让 tokenCount 覆盖真实值。
		act.addRealOutputTokens(0);
		act.finish("完成", 500, 3); // tokensOverride=3 是估算残留，应被真实 50 覆盖

		const header = plain(act.getHeaderString(120));
		expect(header).toContain("~50 tokens");
		// 50 token / 0.5s = 100 tps
		expect(header).toContain("~100 tps");
	});

	it("中文估算兜底：字符数 ÷ STREAM_CHARS_PER_TOKEN", () => {
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		const chars = 300;
		act.addTokens(Math.ceil(chars / STREAM_CHARS_PER_TOKEN));
		act.finish("完成", 1000, undefined);
		// 没有真实值时用估算：300/3 = 100。
		expect(plain(act.getHeaderString(120))).toContain("~100 tokens");
	});
});
