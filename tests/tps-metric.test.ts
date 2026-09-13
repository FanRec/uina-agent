/**
 * 生成速度（tps）的量纲问题。对齐 dsh-TUI channel.ts 的做法：
 *
 * 1. 分子：服务端每次调用收尾报的真实输出 token 优先；字符估算（chars / N）只在真实值
 *    到达前占位，真实值一到就作废，两者不相加。一个回合可以有多轮模型调用，各轮输出
 *    都计入这一轮的速度。
 * 2. 分母：只累加每个「step」（一次模型调用 + 它触发的工具）的「首个 token → 调用结束」
 *    跨度。工具执行与每次请求的首 token 等待（TTFT）都不计入，否则工具跑 30 秒就会把
 *    速度摊薄成真值的零头。
 * 3. 实时值的右端是「最近一个 token 到达的时刻」，不是渲染时刻：否则两次 token 之间
 *    分母继续涨而分子不动，画面就会显示成"一开始很快、越跑越慢"。
 * 4. 量程随采样峰值自适应（地板 40），柱状图不至于长期满格；采样跨回合保留，量程才有
 *    历史参照。
 *
 * 这些都和时间有关，所以用假时钟把时间钉死，"算错了"才会表现为断言失败而不是随机。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityLineComponent, formatTpsGauge, STREAM_CHARS_PER_TOKEN } from "../src/ui/components/widgets/activity-line.js";

/** 从 SGR 序列里剥掉颜色与粗体，只留可见字形。 */
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const T0 = 1_700_000_000_000;

afterEach(() => {
	vi.useRealTimers();
});

describe("formatTpsGauge：量程自适应", () => {
	it("同一速度在不同量程下填充不同，不再一律满格", () => {
		const atPeak60 = plain(formatTpsGauge(111, 60, 8));
		const atPeak200 = plain(formatTpsGauge(111, 200, 8));
		expect(atPeak200).not.toBe(atPeak60);
		expect((atPeak200.match(/█/g) ?? []).length).toBeLessThan(8);
	});

	it("峰值低于地板时抬到地板，避免小样本把表盘放大", () => {
		const g = plain(formatTpsGauge(20, 10, 8));
		expect((g.match(/█/g) ?? []).length).toBeLessThanOrEqual(5);
	});
});

describe("ActivityLineComponent：真实值优先于字符估算", () => {
	it("真实值取代当前跨度的估算，不会两者相加", () => {
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addTokens(300); // 估算 300
		act.addRealOutputTokens(120); // 真实 120，估算应作废
		act.finish("完成", 1000);
		expect(plain(act.getHeaderString(160))).toContain("~120 tokens");
	});

	it("多轮调用的真实输出累加，而不是后者覆盖前者", () => {
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addRealOutputTokens(30);
		act.addRealOutputTokens(45);
		act.finish("完成", 1000);
		expect(plain(act.getHeaderString(160))).toContain("~75 tokens");
	});

	it("没有真实值时退回字符估算（÷ STREAM_CHARS_PER_TOKEN）", () => {
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		const chars = 300;
		act.addTokens(Math.ceil(chars / STREAM_CHARS_PER_TOKEN));
		act.finish("完成", 1000);
		expect(plain(act.getHeaderString(160))).toContain("~100 tokens");
	});
});

describe("ActivityLineComponent：分母只算解码跨度", () => {
	it("工具执行时间不进分母", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");

		// 第一次调用：解码 1 秒
		act.addTokens(50);
		vi.setSystemTime(T0 + 1000);
		act.addTokens(50);
		act.addRealOutputTokens(50);
		act.sealDecodeSpan(); // tool_start：封存这一跨度

		// 工具执行 30 秒（这段时间不该被算成生成时间）
		vi.setSystemTime(T0 + 31_000);

		// 第二次调用：再解码 1 秒
		act.addTokens(50);
		vi.setSystemTime(T0 + 32_000);
		act.addTokens(50);
		act.addRealOutputTokens(50);
		act.finish("完成");

		const header = plain(act.getHeaderString(200));
		expect(header).toContain("~100 tokens");
		// 100 token / 2 秒解码 = 50 tps。若把工具那 30 秒算进分母，会掉到 ~3。
		expect(header).toContain("~50 tps");
	});

	it("两次 token 之间的停顿不让速度下滑（右端是 token 到达时刻）", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addTokens(100);
		vi.setSystemTime(T0 + 1000);
		act.addTokens(100); // 1 秒内累计 200 token

		const during = plain(act.getHeaderString(200));
		expect(during).toContain("~200 tps");

		// 停顿 5 秒，期间没有任何 token 到达
		vi.setSystemTime(T0 + 6000);
		const after = plain(act.getHeaderString(200));
		// 分母没变，读数就不该变。旧实现按渲染时刻算分母，这里会掉到 ~33。
		expect(after).toContain("~200 tps");
	});

	it("解码跨度太短时不显示速度，避免抖出离谱数字", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addTokens(50);
		const header = plain(act.getHeaderString(200));
		expect(header).not.toContain("tps");
		expect(header).not.toContain("NaN");
		expect(header).not.toContain("Infinity");
	});
});

describe("ActivityLineComponent：回合级采样", () => {
	it("速度采样跨回合保留，量程才有历史参照", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "第一轮");
		act.addTokens(100);
		vi.setSystemTime(T0 + 1000);
		act.addTokens(100);
		act.finish("完成");

		expect(act.getTpsSamples().length).toBe(1);
		expect(act.getTpsSamples()[0]).toBe(200);

		// 新一轮开始不应丢掉上一轮：只留一回合时峰值恒等于当前值，表盘每回合都满格。
		act.start("streaming", "第二轮");
		expect(act.getTpsSamples().length).toBe(1);
	});
});
