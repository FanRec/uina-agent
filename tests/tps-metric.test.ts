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
		act.addRealOutputTokens("c1", 120); // 真实 120，估算应作废
		act.finish("完成", 1000);
		expect(plain(act.getHeaderString(160))).toContain("~120 tokens");
	});

	it("跨调用的真实输出累加，而不是后者覆盖前者", () => {
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addRealOutputTokens("call-1", 30);
		act.addRealOutputTokens("call-2", 45);
		act.finish("完成", 1000);
		expect(plain(act.getHeaderString(160))).toContain("~75 tokens");
	});

	it("同一次调用反复推送到同一个累积 usage，只计最后一次而不是累加", () => {
		// 服务端在一次调用进行中会反复推送累积快照（同一个 output 值发多次）。
		// 旧实现按"每次调用累加"处理，会把一个调用的输出按推送次数重复计成四位数 tps。
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addRealOutputTokens("call-1", 30);
		act.addRealOutputTokens("call-1", 45);
		act.finish("完成", 1000);
		expect(plain(act.getHeaderString(160))).toContain("~45 tokens");
		expect(plain(act.getHeaderString(160))).not.toContain("~75 tokens");
	});

	it("真值只取代它已覆盖的那段估算；清零之后新到的增量仍要计入", () => {
		// 真值到达时 spanEstimateTokens 被清零，它覆盖的那 300 估算随之作废、不会重复计。
		// 但清零之后新到达的字符属于后续调用的输出，必须继续计入 —— 否则分子冻结、分母照涨，
		// 读数一路往下掉。真机实测：调用 1 报回 672 之后，调用 2 的 2271 个估算被永久丢弃，
		// 显示值从 297 tps 单调跌到 75，而模型一直在全速输出。
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addTokens(300); // 调用 1 的估算占位
		act.addRealOutputTokens("call-1", 120); // 调用 1 真值到达 → 那 300 作废
		act.addTokens(999); // 调用 2 的增量
		act.finish("完成", 1000);
		const out = plain(act.getHeaderString(160));
		expect(out).toContain("~1119 tokens"); // 120（真值）+ 999（新增量）
		expect(out).not.toContain("~1419 tokens"); // 已被真值取代的 300 不得复活
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
		act.addRealOutputTokens("call-1", 50);
		act.sealDecodeSpan(); // tool_start：封存这一跨度

		// 工具执行 30 秒（这段时间不该被算成生成时间）
		vi.setSystemTime(T0 + 31_000);

		// 第二次调用：再解码 1 秒
		act.addTokens(50);
		vi.setSystemTime(T0 + 32_000);
		act.addTokens(50);
		act.addRealOutputTokens("call-2", 50);
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

	it("一次调用内发起多个工具，解码跨度只封存一次（不按工具数切碎）", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");

		// 一次模型调用：解码 1 秒，报回真实输出 100
		act.addTokens(50);
		vi.setSystemTime(T0 + 1000);
		act.addTokens(50);
		act.addRealOutputTokens("call-1", 100);

		// 同一次调用发起两把工具：tui 会在每个 tool_start 上调用 sealDecodeSpan。
		// 第一次封存这一跨度；第二次必须成为空操作，否则工具空档会被反复计入分母。
		act.sealDecodeSpan();
		vi.setSystemTime(T0 + 5000); // 工具执行 4 秒
		act.sealDecodeSpan();
		vi.setSystemTime(T0 + 9000); // 工具继续，共 8 秒
		act.sealDecodeSpan();
		act.finish("完成");

		const header = plain(act.getHeaderString(200));
		expect(header).toContain("~100 tokens");
		// 100 token / 1 秒解码 = 100 tps。守卫若失效，第二次封存会把工具空档并进去，
		// 分母涨到 ~8 秒，读数掉到 ~12 tps。
		expect(header).toContain("~100 tps");
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
	// 采样是私有状态，只能从渲染输出观察；不为测试开公开 getter。
	it("回合结束时按解码跨度算出速度并显示", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "第一轮");
		act.addTokens(100);
		vi.setSystemTime(T0 + 1000);
		act.addTokens(100);
		act.finish("完成");

		// 200 tokens / 1.000s 解码 = 200 tps。
		expect(plain(act.getHeaderString(200))).toContain("~200 tps");
	});

	it("速度采样跨回合保留，量程才有历史参照", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "第一轮");
		act.addTokens(100);
		vi.setSystemTime(T0 + 1000);
		act.addTokens(100);
		act.finish("完成");

		// 第二轮同样 200 tps：峰值仍有上一轮作参照，量程不会每回合从零重缩。
		act.start("streaming", "第二轮");
		act.addTokens(100);
		vi.setSystemTime(T0 + 2000);
		act.addTokens(100);
		act.finish("完成");

		const text = plain(act.getHeaderString(200));
		expect(text).toContain("~200 tps");
		// 两轮都已采样：跨回合保留才会让火花线出现第二个柱（不猜某一格的具体字形）。
		expect(text).toMatch(/[▁▂▃▄▅▆▇█]{2}/);
	});
});
