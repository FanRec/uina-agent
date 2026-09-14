/**
 * 生成速度（tps）的量纲问题：分子与分母必须量同一个 step（一次模型调用）。
 *
 * 口径对齐 dsh 的权威折叠（session-stats/projection.ts 的 decodeMs/decodeTokens、
 * ui-chat/contract/turn-metrics.ts 的 tokensPerSecond；dsh-TUI 是同一套的适配层）：
 *
 * 1. 分子：服务端每个 step 收尾报回的真实输出 token（含思考 token 与工具调用参数）。
 *    同一 step 的累积快照只计最后一次；真值缺位时才退回可见增量折算的估算，两者不相加。
 * 2. 分母：只累加每个 step 的「首个可见增量 → 该 step 收尾」跨度。工具执行与 TTFT 都不
 *    计入，否则工具跑 30 秒就会把速度摊薄成真值的零头。
 * 3. 右端必须是 step 收尾（真实 usage 到达）而不是「最后一个可见 token」：Provider 把
 *    工具调用参数攒成一个完整 tool_call 才上报，参数流式期间 UI 收不到任何增量。用最后
 *    一个可见 token 当右端会把参数段的生成时间整段漏掉 —— 分子含它、分母不含，不开思考
 *    时读数因此虚高到几百上千 tps（真机实测 700 量级）。这是本次修复针对的根本原因，
 *    下面「分子与分母同源」里第一条就是它的回归。
 * 4. 整个 step 一个可见增量都没有时分子分母一起不计：宁可不报，也不拿没有生成时间可除
 *    的输出量充数（真机实测 175 / 820 这类 token 曾把读数顶到 902 tps）。
 * 5. 折算方式对齐 dsh-TUI：**把字符攒在 step 上，读取时折一次**，不按 delta 逐条折算
 *    （逐条折会把每个切片向上取整的零头累起来，估算就依赖切分方式）。系数来自真机标定，
 *    见 activity-line.ts 的 STREAM_TOKENS_PER_*_CHAR。
 *
 * 这些都和时间有关，所以用假时钟把时间钉死，"算错了"才会表现为断言失败而不是随机。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ActivityLineComponent,
	classifyStreamText,
	estimateStreamTokens,
	foldStreamChars,
	formatTpsGauge,
} from "../src/ui/components/widgets/activity-line.js";

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

describe("可见增量的折算：系数来自真机标定", () => {
	it("英文约 3.9 字符/token", () => {
		expect(estimateStreamTokens("a".repeat(400))).toBe(103);
	});

	it("中文约 1.15 字符/token，不再被一律 ÷4 压成四分之一", () => {
		expect(estimateStreamTokens("思".repeat(120))).toBe(104);
	});

	it("混排时两类分别折算后相加", () => {
		expect(estimateStreamTokens("思".repeat(120) + "a".repeat(400))).toBe(207);
	});

	it("分类只按书写系统，不枚举语种：汉字/假名/谚文同类，其余同类", () => {
		expect(classifyStreamText("思aカ한")).toEqual({ cjk: 3, other: 1 });
	});

	it("空文本折算为 0，不凭空产生 token", () => {
		expect(foldStreamChars({ cjk: 0, other: 0 })).toBe(0);
		expect(estimateStreamTokens("")).toBe(0);
	});

	it("折一次而不是逐条折：逐条折会把取整零头累起来", () => {
		const text = "思".repeat(200) + "hello world ".repeat(20);
		let perDelta = 0;
		for (const char of text) perDelta += estimateStreamTokens(char);
		expect(estimateStreamTokens(text)).toBeLessThan(perDelta);
	});
});

describe("ActivityLineComponent：分子与分母量同一个 step", () => {
	it("工具调用参数流完后真值才到：右端是真值到达时刻，不是最后一个可见 token", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addStreamText("我来看看这个文件"); // 这一步的可见增量（一句前言）
		vi.setSystemTime(T0 + 3000); // 接下来 3 秒都在流工具调用参数，UI 收不到任何增量
		act.addRealOutputTokens(500); // 流结束，服务端报回整步的真实输出

		// 实时行不展示 token 总数，速度本身已经说明了分子：500 / 3.0s = 167 tps。
		// 右端取最后一个可见 token（0.0s）会读到 ~1667；分子丢掉真值只算那句前言会读到 ~2。
		const header = plain(act.getHeaderString(200));
		expect(header).toContain("~167 tps");
		expect(header).not.toContain("1667");
		expect(header).not.toContain(`~${Math.round(foldStreamChars({ cjk: 8, other: 0 }) / 3)} tps`);
	});

	it("step 收尾后（done）用同一对数值，实时读数与结束读数一致", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addStreamText("我来看看这个文件");
		vi.setSystemTime(T0 + 3000);
		act.addRealOutputTokens(500);
		act.endStep();
		vi.setSystemTime(T0 + 33_000); // 工具跑 30 秒，不该进分母
		act.finish("完成");

		const header = plain(act.getHeaderString(200));
		expect(header).toContain("~500 tokens");
		expect(header).toContain("~167 tps");
		expect(header).not.toContain("~15 tps"); // 把工具时间算进分母会掉到这附近
	});

	it("整个 step 没有可见增量时，真实输出既不进分子也不进分母", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addStreamText("想想");
		vi.setSystemTime(T0 + 1000);
		act.addRealOutputTokens(120); // step 1 有增量 → 可度量
		act.endStep();
		vi.setSystemTime(T0 + 5000); // step 2 整步只有工具调用参数
		act.addRealOutputTokens(175);
		act.finish("完成");

		const rendered = plain(act.getHeaderString(200));
		expect(rendered).toContain("~120 tokens"); // 只有占过解码区间的 120
		expect(rendered).not.toContain("~295 tokens"); // 不是 120 + 175
		expect(rendered).toContain("~120 tps"); // 120 / 1.0s
	});

	it("同一 step 里的真实值取代估算，不相加", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		const estimate = foldStreamChars({ cjk: 300, other: 0 });
		act.addStreamText("思".repeat(300)); // 估算占位
		vi.setSystemTime(T0 + 800);
		act.addRealOutputTokens(120); // 真值描述的就是这一步的全部输出
		act.finish("完成");

		const rendered = plain(act.getHeaderString(200));
		expect(rendered).toContain("~120 tokens");
		expect(rendered).toContain("~150 tps"); // 120 / 0.8s
		expect(rendered).not.toContain(`~${Math.round((estimate + 120) / 0.8)} tps`); // 相加
	});

	it("同一 step 反复推送的累积快照只计最后一次，右端也取最后一次到达时刻", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		const estimate = foldStreamChars({ cjk: 52, other: 0 });
		act.addStreamText("思".repeat(52));
		vi.setSystemTime(T0 + 500);
		act.addRealOutputTokens(30); // 服务端流式期间的累积快照
		vi.setSystemTime(T0 + 900);
		act.addRealOutputTokens(45); // 收尾快照才是这一步的输出量
		act.finish("完成");

		const rendered = plain(act.getHeaderString(200));
		expect(rendered).toContain("~45 tokens");
		expect(rendered).not.toContain(`~${45 + 30} tokens`); // 逐条累加
		expect(rendered).toContain("~50 tps"); // 45 / 0.9s
		expect(rendered).not.toContain(`~${Math.round((estimate + 45) / 0.9)} tps`); // 真值 + 估算
	});

	it("没有真实值时退回可见增量的估算，且分子分母都只覆盖可见部分", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addStreamText("思".repeat(231)); // 累计 231 字
		vi.setSystemTime(T0 + 2000);
		act.addStreamText("思".repeat(230)); // 累计 461 字
		act.finish("完成");

		const rendered = plain(act.getHeaderString(200));
		const total = foldStreamChars({ cjk: 461, other: 0 });
		expect(rendered).toContain(`~${total} tokens`);
		expect(rendered).toContain(`~${Math.round(total / 2)} tps`); // 分母 = 2.0s
	});

	it("一个可度量的 step 都没有时不显示速度：未知就是未知，不是 0", () => {
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addRealOutputTokens(500); // 整步没有可见增量
		act.finish("完成", 3000);

		const rendered = plain(act.getHeaderString(200));
		expect(rendered).toContain("耗时 3.0s");
		expect(rendered).not.toContain("tps");
		expect(rendered).not.toContain("tokens");
	});
});

describe("ActivityLineComponent：累计字符，切分无关", () => {
	it("同一段文本切成任意块，估算完全一致", () => {
		// 必须钉时钟：本测试比较三种切法的渲染文本，而分母是真实的毫秒跨度。
		// 不钉的话，切得越碎就越多一次 Date.now()，偶尔跨 1 毫秒就会让「每字符一段」
		// 那一份算出 235000 tps 而另外两份不显示速度 —— 那是时钟抖动，不是切分敏感。
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const text = "思".repeat(200) + "hello world ".repeat(20);
		const run = (chunks: string[]): string => {
			const act = new ActivityLineComponent();
			act.start("streaming", "生成");
			for (const chunk of chunks) act.addStreamText(chunk);
			act.finish("完成", 1000);
			return plain(act.getHeaderString(200));
		};

		const whole = run([text]);
		expect(whole).toContain(`~${estimateStreamTokens(text)} tokens`);
		expect(run([...text])).toBe(whole); // 每字符一段
		expect(run([text.slice(0, 7), text.slice(7, 8), text.slice(8)])).toBe(whole);
	});

	it("空增量不开启 step：不会造出一段没有生成时间的输出", () => {
		const act = new ActivityLineComponent();
		act.start("streaming", "生成");
		act.addStreamText("");
		act.addRealOutputTokens(500); // 没有左端，这条真值无处可量
		act.finish("完成", 3000);

		const rendered = plain(act.getHeaderString(200));
		expect(rendered).not.toContain("tokens");
		expect(rendered).not.toContain("tps");
	});
});

describe("ActivityLineComponent：分母只算解码跨度", () => {
	it("工具执行时间不进分母", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");

		// 第一次调用：解码 1 秒
		act.addStreamText("思".repeat(58));
		vi.setSystemTime(T0 + 1000);
		act.addStreamText("思".repeat(58));
		act.addRealOutputTokens(50);
		act.endStep(); // tool_start：结算这一 step

		// 工具执行 30 秒（这段时间不该被算成生成时间）
		vi.setSystemTime(T0 + 31_000);

		// 第二次调用：再解码 1 秒
		act.addStreamText("思".repeat(58));
		vi.setSystemTime(T0 + 32_000);
		act.addStreamText("思".repeat(58));
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
		act.addStreamText("思".repeat(115));
		vi.setSystemTime(T0 + 1000);
		act.addStreamText("思".repeat(116)); // 1 秒内累计 231 字

		const tokens = foldStreamChars({ cjk: 231, other: 0 });
		const during = plain(act.getHeaderString(200));
		expect(during).toContain(`~${tokens} tps`);

		// 停顿 5 秒，期间没有任何 token 到达
		vi.setSystemTime(T0 + 6000);
		const after = plain(act.getHeaderString(200));
		// 分母没变，读数就不该变。按渲染时刻算分母会掉到 ~33。
		expect(after).toContain(`~${tokens} tps`);
	});

	it("一次调用内发起多个工具，只结算一次（不按工具数切碎）", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");

		// 一次模型调用：解码 1 秒，报回真实输出 100
		act.addStreamText("思".repeat(58));
		vi.setSystemTime(T0 + 1000);
		act.addStreamText("思".repeat(58));
		act.addRealOutputTokens(100);

		// 同一次调用发起两把工具：tui 会在每个 tool_start 上调用 endStep。
		// 第一次结算这一 step；第二次必须成为空操作，否则工具空档会被反复计入分母。
		act.endStep();
		vi.setSystemTime(T0 + 5000); // 工具执行 4 秒
		act.endStep();
		vi.setSystemTime(T0 + 9000); // 工具继续，共 8 秒
		act.endStep();
		act.finish("完成");

		const header = plain(act.getHeaderString(200));
		expect(header).toContain("~100 tokens");
		// 100 token / 1 秒解码 = 100 tps。守卫若失效，第二次结算会把工具空档并进去，
		// 分母涨到 ~8 秒，读数掉到 ~12 tps。
		expect(header).toContain("~100 tps");
	});

	it("解码跨度太短时不显示速度，避免抖出离谱数字", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addStreamText("思".repeat(58));
		const header = plain(act.getHeaderString(200));
		expect(header).not.toContain("tps");
		expect(header).not.toContain("NaN");
		expect(header).not.toContain("Infinity");
	});

	it("门控与 dsh-TUI 一致：当前 step 不足 500ms 沿用已结算值，不把它混进分母", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addStreamText("思".repeat(115));
		vi.setSystemTime(T0 + 300);
		act.addStreamText("思".repeat(116));
		act.addRealOutputTokens(200);
		act.endStep(); // 结算：200 token / 0.3s

		// 新 step 从 0.3s 起步，0.4s 时自身才跨 100ms：沿用已结算的 200 / 0.3s。
		// 把刚起步的 step 混进分母会读到 (200 + 折算(10 字)) / 0.4s —— 那几十毫秒带着
		// 自己的折算残差和流式切分误差一起进读数，dsh-TUI 此时也不重算 state.tps。
		act.addStreamText("新".repeat(5));
		vi.setSystemTime(T0 + 400);
		act.addStreamText("新".repeat(5));
		const mixed = Math.round((200 + foldStreamChars({ cjk: 10, other: 0 })) / 0.4);
		const header = plain(act.getHeaderString(200));
		expect(header).toContain("~667 tps"); // 200 / 0.3s
		expect(header).not.toContain(`~${mixed} tps`);

		// 越过 500ms 后重新起算：已结算累计 + 当前 step 一起进分子分母。
		vi.setSystemTime(T0 + 900); // 当前 step 跨 0.3s → 0.9s = 600ms
		act.addStreamText("新".repeat(5));
		const combined = Math.round((200 + foldStreamChars({ cjk: 15, other: 0 })) / 0.9);
		expect(plain(act.getHeaderString(200))).toContain(`~${combined} tps`);
	});

	it("首个 step 还不足 500ms 时不显示速度：没有可度量的跨度就说未知", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "正在输出...");
		act.addStreamText("思".repeat(10));
		vi.setSystemTime(T0 + 200);

		const header = plain(act.getHeaderString(200));
		expect(header).toContain("0.2s");
		expect(header).not.toContain("tps");
	});
});

describe("ActivityLineComponent：回合级采样", () => {
	// 采样是私有状态，只能从渲染输出观察；不为测试开公开 getter。
	it("回合结束时按解码跨度算出速度并显示", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "第一轮");
		act.addStreamText("思".repeat(115));
		vi.setSystemTime(T0 + 1000);
		act.addStreamText("思".repeat(116));

		const tokens = foldStreamChars({ cjk: 231, other: 0 });
		act.finish("完成");

		// 231 字折算 / 1.000s 解码。
		expect(plain(act.getHeaderString(200))).toContain(`~${tokens} tps`);
	});

	it("速度采样跨回合保留，量程才有历史参照", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const act = new ActivityLineComponent();
		act.start("streaming", "第一轮");
		act.addStreamText("思".repeat(115));
		vi.setSystemTime(T0 + 1000);
		act.addStreamText("思".repeat(116));
		act.finish("完成");

		// 第二轮同样速度：峰值仍有上一轮作参照，量程不会每回合从零重缩。
		act.start("streaming", "第二轮");
		act.addStreamText("思".repeat(115));
		vi.setSystemTime(T0 + 2000);
		act.addStreamText("思".repeat(116));
		act.finish("完成");

		const tokens = foldStreamChars({ cjk: 231, other: 0 });
		const text = plain(act.getHeaderString(200));
		expect(text).toContain(`~${tokens} tps`);
		// 两轮都已采样：跨回合保留才会让火花线出现第二个柱（不猜某一格的具体字形）。
		expect(text).toMatch(/[▁▂▃▄▅▆▇█]{2}/);
	});
});
