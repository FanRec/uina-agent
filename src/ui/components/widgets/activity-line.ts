/**
 * 实时工作状态行组件（复刻 dsh-TUI ActivityLine.tsx 与 shimmer.ts）。
 * 特性：
 * 1. 冰蓝流光扫光（Shimmer Sweep）动态渐变效果；
 * 2. 动态旋转 Spinner 帧（⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏）；
 * 3. 实时耗时统计与 TPS 计算（口径见 ActivityLineComponent 的注释）；
 * 4. 支持独立行输出与嵌入圆角盒顶边框（getHeaderString）。
 */

import type { Component } from "../../core/types.js";
import { C, charWidth, truncateToWidth, visibleWidth } from "../../core/utils.js";
import type { QueuedMessage } from "../../../agent/queue.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * 可见增量折算 token 的两个系数（token / 字符），来自真机标定：105 个带 usage 的
 * assistant step，用 [汉字类字符, 其余字符, 参数字符, 常数] 对真实 output 做最小二乘，
 * 复现总量偏差 0.1%，逐步残差 RMS ≈ 10%。
 *
 * 分两类的理由是两个量级：汉字类 0.867（≈1.15 字符/token），其余 0.257（≈3.89 字符
 * /token），差 3.4 倍 —— 一律按 4 字符/token 会把中文压到约四分之一。
 * 不枚举语种：汉字/假名/谚文归一类，其余（拉丁、西里尔、阿拉伯……）归一类，新语种
 * 自动落进"其余"。换模型或语料结构明显变化时要重新标定。
 *
 * 已知缺口：工具调用参数占输出字符的中位 23%，但 Provider 把参数攒成一个完整 tool_call
 * 才上报，UI 在真值到达前看不到它 —— 工具密集的 step 在真值到达前会读低，真值一到即
 * 校正。这是如实反映"可见部分"，不是能用系数补偿的偏差。
 *
 * 只在真值缺位时占位；真值一到就让位，两者不相加。
 */
export const STREAM_TOKENS_PER_CJK_CHAR = 0.867;
export const STREAM_TOKENS_PER_OTHER_CHAR = 0.257;

/** 汉字/假名/谚文等"一个字大约一个 token"的书写系统。 */
function isCjk(code: number): boolean {
	return (
		(code >= 0x3040 && code <= 0x30ff) || // 平假名 / 片假名
		(code >= 0x3400 && code <= 0x4dbf) || // 汉字扩展 A
		(code >= 0x4e00 && code <= 0x9fff) || // 汉字基本区
		(code >= 0xf900 && code <= 0xfaff) || // 汉字兼容表意
		(code >= 0xac00 && code <= 0xd7af) // 谚文音节
	);
}

/** 把一段可见增量按书写系统分类计数。累计字符而不是累计折算值：折算留到读取时做。 */
export function classifyStreamText(text: string): { cjk: number; other: number } {
	let cjk = 0;
	let other = 0;
	for (const char of text) {
		if (isCjk(char.codePointAt(0)!)) cjk += 1;
		else other += 1;
	}
	return { cjk, other };
}

/**
 * 把累计的字符计数折算成 token 数；空文本是 0，非空至少 1。
 *
 * 只在累计量上折一次（dsh-TUI 同法：字符攒在 step 上，显示时 Math.ceil(chars/4)）。
 * 不要按 delta 逐条折算：向上取整的零头会随切片累加，估算结果就依赖切分方式了。
 */
export function foldStreamChars(counts: { cjk: number; other: number }): number {
	if (counts.cjk + counts.other === 0) return 0;
	return Math.max(1, Math.round(counts.cjk * STREAM_TOKENS_PER_CJK_CHAR + counts.other * STREAM_TOKENS_PER_OTHER_CHAR));
}

/** 单段文本的折算值（`foldStreamChars(classifyStreamText(text))`）。 */
export function estimateStreamTokens(text: string): number {
	return foldStreamChars(classifyStreamText(text));
}

interface Rgb {
	r: number;
	g: number;
	b: number;
}

const ICE_RGB: Rgb = { r: 147, g: 190, b: 255 };
const FLASH_RGB: Rgb = { r: 240, g: 246, b: 255 };

function interpolateColor(a: Rgb, b: Rgb, factor: number): Rgb {
	const f = Math.max(0, Math.min(1, factor));
	return {
		r: Math.round(a.r + (b.r - a.r) * f),
		g: Math.round(a.g + (b.g - a.g) * f),
		b: Math.round(a.b + (b.b - a.b) * f),
	};
}

export function sweep(text: string, timeMs: number, base: Rgb = ICE_RGB, highlight: Rgb = FLASH_RGB, stepMs = 60): string {
	const width = visibleWidth(text);
	const cycle = width + 18;
	const glimmerStart = (Math.floor(timeMs / stepMs) % cycle) - 8;

	let out = "";
	let col = 0;
	let lastColor = "";

	for (const char of text) {
		const w = charWidth(char);
		const highlighted = col >= glimmerStart && col + w <= glimmerStart + 8;
		const opacity = highlighted ? (Math.sin(timeMs / (stepMs * 2)) + 1) / 2 : 0;
		const rgb = highlighted ? interpolateColor(base, highlight, opacity) : base;
		const colorKey = `${rgb.r};${rgb.g};${rgb.b}`;

		if (colorKey !== lastColor) {
			out += `\x1b[38;2;${colorKey}m\x1b[1m`;
			lastColor = colorKey;
		}
		out += char;
		col += w;
	}

	if (lastColor) {
		out += "\x1b[0m";
	}
	return out;
}

export type ActivityPhase = "idle" | "thinking" | "streaming" | "tool" | "done";

/** 表盘量程地板：低于它的峰值会被抬到此处，避免小样本把表盘放得过大。 */
const GAUGE_FLOOR = 40;
const HBLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const VBLOCKS = [" ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const TRACK = "·";

/**
 * 实时 1/8 字符水平仪表盘：`▕██████▋···▏`
 * 依据当前速率 tps 相对于 targetPeak 映射，并按速度区间着色（≥50 绿、≥20 黄、<20 红）。
 */
export function formatTpsGauge(tps: number, targetPeak = 60, gaugeWidth = 8): string {
	if (gaugeWidth <= 0) return "";
	const safeTps = Math.max(0, tps);
	// 量程按采样峰值自适应（地板 40）：写死峰值会让"超过峰值"的一切都画成满格，
	// 表盘就失去了区分度。dsh-tui 的 renderTpsGauge 用 max(peak, floor) 同理。
	const ratio = Math.min(1, safeTps / Math.max(GAUGE_FLOOR, targetPeak));
	const eighths = Math.round(ratio * gaugeWidth * 8);
	const full = Math.floor(eighths / 8);
	const rem = eighths % 8;

	let fill = "█".repeat(Math.min(full, gaugeWidth));
	if (full < gaugeWidth && rem > 0) {
		fill += HBLOCKS[rem]!;
	}
	const emptyLen = Math.max(0, gaugeWidth - visibleWidth(fill));
	const track = TRACK.repeat(emptyLen);

	const color = safeTps >= 50 ? C.green : safeTps >= 20 ? C.yellow : C.red;
	return `▕${color}${fill}${C.reset}${C.dim}${track}${C.reset}▏`;
}

/**
 * 垂直火花线趋势图：` ▂▃▅▆▇█`
 * 将历史速率采样数组归一化映射为 Unicode 柱状符号。
 */
export function formatTpsSparkline(samples: readonly number[]): string {
	if (!samples || samples.length === 0) return "";
	const valid = samples.map((s) => Math.max(0, s));
	const min = Math.min(...valid);
	const max = Math.max(...valid);
	const range = max - min;

	return valid
		.map((val) => {
			if (range <= 0) return VBLOCKS[3]!;
			const idx = Math.min(VBLOCKS.length - 1, Math.floor(((val - min) / range) * (VBLOCKS.length - 1)));
			return VBLOCKS[idx]!;
		})
		.join("");
}

export class ActivityLineComponent implements Component {
	private phase: ActivityPhase = "idle";
	private message = "";
	private startTime = 0;
	private elapsedMs = 0;

	/**
	 * 一个 step = 一次模型调用。分子与分母必须量同一段生成：
	 *
	 *   左端 = 这个 step 首个可见增量到达的时刻
	 *   右端 = 这个 step 收尾报回真实 usage 的时刻（没报回时退回最后一个可见增量）
	 *   分子 = 这个 step 的真实输出 token（没报回时退回可见增量折算的估算）
	 *   回合速度 = Σ分子 ÷ Σ(右端 - 左端)，只计入两者都有的 step
	 *
	 * 这套口径抄自 dsh 的权威折叠（session-stats/projection.ts 的 decodeMs/decodeTokens
	 * 与 ui-chat/contract/turn-metrics.ts 的 tokensPerSecond；dsh-TUI 是同一套的适配层）：
	 * 那里右端是 assistant/message（步收尾）时刻，不是最后一个 token 的时刻。
	 *
	 * 右端用「收尾」而非「最后一个可见 token」，差在工具调用参数上：服务端把参数也算进
	 * completion_tokens（真机一个回合 37 个 step 里，参数占输出 token 的中位 25%、最高
	 * 56%），但 Provider 层把它们攒成一个完整的 tool_call 才上报，UI 在参数流式期间收不到
	 * 任何增量。于是「最后一个可见 token」会把参数段的生成时间整段漏掉 —— 分子含它、
	 * 分母不含。不开思考时输出几乎全是参数，实测正是这条把读数顶到 700 tps 量级。
	 * usage 到达即 step 收尾（OpenAI 最后一个 chunk、Anthropic message_delta、Gemini 每个
	 * chunk 都带），是 UI 能观测到的、最接近流结束的时刻，且与分子同源。
	 *
	 * 已知且接受的口径代价：整个 step 一个可见增量都没有时（纯工具调用，且没有前言文本），
	 * 它既没有可信的左端也没有可信的右端，分子分母一起不计 —— 宁可不报，也不拿没有生成
	 * 时间可除的输出量充数。dsh 能计这类 step，是因为它的流式 chunk 里本来就有
	 * tool-call-delta；Uina 的 Provider 攒完才上报，UI 无从得知。
	 *
	 * 这些都和时间有关，所以测试用假时钟把时间钉死。
	 */
	private stepFirstTokenAt = 0;
	/** 当前 step 最近一个可见增量到达的时刻：真实 usage 未到时用它当右端。 */
	private stepLastTokenAt = 0;
	/** 当前 step 可见增量的字符计数，按书写系统分开；折算留到读取时做。 */
	private stepCjkChars = 0;
	private stepOtherChars = 0;
	/** 当前 step 收尾报回的真实输出 token；同一 step 的多次推送取最后一次。0 = 未报回。 */
	private stepUsageTokens = 0;
	/** 当前 step 真实 usage 最近一次到达的时刻，也就是这个 step 的右端。0 = 未报回。 */
	private stepUsageAt = 0;

	/** 已结算进本回合的解码耗时（毫秒）与输出 token（真实值优先，估算只补空档）。 */
	private settledDecodeMs = 0;
	private settledOutputTokens = 0;

	/** 每回合一个速度采样，跨回合保留（结束后的火花线取最近若干个回合）。 */
	private tpsSamples: number[] = [];

	start(phase: ActivityPhase, message: string): void {
		this.phase = phase;
		this.message = message;
		this.startTime = Date.now();
		this.elapsedMs = 0;
		this.clearStep();
		this.settledDecodeMs = 0;
		this.settledOutputTokens = 0;
		// tpsSamples 不在这里清空：只留一个回合的历史，量程峰值就等于当前值，
		// 表盘每个回合都会从满格重新开始缩；跨回合保留才有参照物。
	}

	update(phase: ActivityPhase, message: string): void {
		this.phase = phase;
		this.message = message;
	}

	/**
	 * 记一次可见增量（正文或思考的原始文本）。
	 *
	 * 存字符、不存折算值：折算发生在读取时，切分方式因此不影响结果。
	 * 空增量直接丢弃，不开启 step —— 上游 provider 目前会过滤空 delta，但不依赖它。
	 *
	 * 左端只取「首个增量到达的时刻」，量的是纯解码速度：TTFT（组装上下文 + 网络 +
	 * 服务端预热）与尾部静默都不在分母里。这两段都确实不是模型在吐字的时间，把它们
	 * 算进分母会让短调用被摊薄到几十 tps —— 那回答的是「本轮平均吞吐」，不是解码速度。
	 *
	 * 没有真实 usage 时右端取「最近一个增量到达的时刻」而不是渲染时刻：否则两次 token
	 * 之间分母继续涨而分子不动，画面就会显示成"一开始很快、越跑越慢"。dsh-TUI 的实时值
	 * 同样以 token 事件自身的时间戳为右端。
	 */
	addStreamText(text: string): void {
		if (text.length === 0) return;
		const counts = classifyStreamText(text);
		const now = Date.now();
		if (this.stepFirstTokenAt === 0) this.stepFirstTokenAt = now;
		this.stepLastTokenAt = now;
		this.stepCjkChars += counts.cjk;
		this.stepOtherChars += counts.other;
	}

	/** 当前 step 可见增量的折算值（真值缺位时的占位）。 */
	private estimateTokens(): number {
		return foldStreamChars({ cjk: this.stepCjkChars, other: this.stepOtherChars });
	}

	/**
	 * 记一次模型调用报回的真实输出 token 数。
	 *
	 * 服务端会在同一次调用内反复推送累积快照（Gemini 每个 chunk 都带），所以同一 step
	 * 只取最后一次（覆盖），绝不逐条累加 —— 那会把一个调用的输出按推送次数重复计。
	 * 同时记下它到达的时刻：这是这个 step 解码区间的右端（见类注释）。
	 *
	 * 没有可见增量的 step（stepFirstTokenAt = 0）丢弃这条真值：没有左端就没有生成时间
	 * 可除，只把分子做大就是虚高（真机实测 175 / 820 这类 token 曾把读数顶到 902 tps）。
	 */
	addRealOutputTokens(tokens: number): void {
		if (tokens <= 0 || this.stepFirstTokenAt === 0) return;
		this.stepUsageTokens = tokens;
		this.stepUsageAt = Date.now();
	}

	/**
	 * 结束当前 step：把它的解码区间与输出量成对结算进本回合。
	 * 模型调用结束（进入工具执行）或回合结束时调用；没有可见增量的 step 是空操作。
	 *
	 * 工具执行期间不会再调用它，于是工具耗时落不进分母；下一个可见增量会开启新 step。
	 */
	endStep(): void {
		if (this.stepFirstTokenAt === 0) return;
		const end = this.stepUsageAt > 0 ? this.stepUsageAt : this.stepLastTokenAt;
		this.settledDecodeMs += Math.max(0, end - this.stepFirstTokenAt);
		this.settledOutputTokens += this.stepUsageTokens > 0 ? this.stepUsageTokens : this.estimateTokens();
		this.clearStep();
	}

	finish(summary = "本轮已完成", elapsedOverride?: number): void {
		this.endStep();
		this.phase = "done";
		if (elapsedOverride !== undefined && elapsedOverride > 0) {
			this.elapsedMs = elapsedOverride;
		} else if (this.startTime > 0) {
			this.elapsedMs = Math.max(0, Date.now() - this.startTime);
		} else {
			this.elapsedMs = 0;
		}
		this.message = summary;
		// 回合级采样：结束后火花线用最近若干个回合的速度。
		if (this.settledOutputTokens > 0 && this.settledDecodeMs > 0) {
			this.tpsSamples.push(Math.round(this.settledOutputTokens / (this.settledDecodeMs / 1000)));
			if (this.tpsSamples.length > 500) this.tpsSamples.shift();
		}
	}

	reset(): void {
		this.phase = "idle";
		this.message = "";
		this.startTime = 0;
		this.elapsedMs = 0;
		this.clearStep();
		this.settledDecodeMs = 0;
		this.settledOutputTokens = 0;
	}

	getPhase(): ActivityPhase {
		return this.phase;
	}

	private clearStep(): void {
		this.stepFirstTokenAt = 0;
		this.stepLastTokenAt = 0;
		this.stepCjkChars = 0;
		this.stepOtherChars = 0;
		this.stepUsageTokens = 0;
		this.stepUsageAt = 0;
	}

	/**
	 * 速度分子：已结算 step 的输出量 + 当前 step 的输出量。
	 *
	 * 当前 step 优先用它自己的真实值（累积快照，覆盖整个 step 到此刻的输出），没有真实
	 * 值才用可见增量折算的估算。两者是替代关系，不相加：真实值描述的就是这个 step 的
	 * 全部输出，已经覆盖它自己的每一个可见增量。
	 */
	private outputTokens(): number {
		const inFlight = this.stepUsageTokens > 0 ? this.stepUsageTokens : this.estimateTokens();
		return this.settledOutputTokens + (this.stepFirstTokenAt > 0 ? inFlight : 0);
	}

	/**
	 * 速度分母（毫秒）：已结算 step 的解码耗时 + 当前 step 正在进行的解码耗时。
	 *
	 * 当前 step 的右端同样优先取真实 usage 的到达时刻；没有新 token 时这个值不变，
	 * 显示的速度也就不会自己往下掉。
	 */
	private decodeMs(): number {
		if (this.stepFirstTokenAt === 0) return this.settledDecodeMs;
		const end = this.stepUsageAt > 0 ? this.stepUsageAt : this.stepLastTokenAt;
		return this.settledDecodeMs + Math.max(0, end - this.stepFirstTokenAt);
	}

	/** 提取适用于圆角盒顶边框嵌入的状态文本 */
	getHeaderString(maxWidth = 60): string {
		if (this.phase === "idle") return "";
		const now = Date.now();
		// "耗时"展示整个回合的墙钟时间（含工具执行），这是用户感知的总时长。
		const currentElapsed = this.phase === "done" ? this.elapsedMs : (this.startTime > 0 ? now - this.startTime : 0);
		const seconds = (Math.max(0, currentElapsed) / 1000).toFixed(1);
		const tokens = this.outputTokens();

		if (this.phase === "done") {
			const prefix = `${C.green}✓${C.reset}`;
			let sparkStr = "";
			// tps 的分母是解码耗时而非墙钟耗时：工具执行不该稀释生成速度。
			// 一个可度量的 step 都没有时不显示速度 —— 那是"未知"，不是 0。
			const decodeMs = this.settledDecodeMs;
			if (tokens > 0 && decodeMs > 0) {
				const avgTps = Math.round(tokens / (decodeMs / 1000));
				// 火花线取最近 12 个回合（dsh-TUI 同为 slice(-12)）。
				const spark = formatTpsSparkline(this.tpsSamples.slice(-12));
				const sparkColor = avgTps >= 50 ? C.green : avgTps >= 20 ? C.yellow : C.red;
				sparkStr = spark ? ` · ${sparkColor}${spark}${C.reset} ~${avgTps} tps` : ` · ~${avgTps} tps`;
			}
			const text = `${C.gray}${this.message} · 耗时 ${seconds}s${tokens > 0 ? ` · ~${tokens} tokens` : ""}${sparkStr}${C.reset}`;
			return truncateToWidth(`${prefix} ${text}`, maxWidth);
		}

		const frameIdx = Math.floor(now / 80) % SPINNER_FRAMES.length;
		const spinner = `${C.iceBlue}${SPINNER_FRAMES[frameIdx]}${C.reset}`;
		let tpsStr = "";
		// 门控抄 dsh-TUI（channel.ts 实时路径：Math.max(0, event.time - step.firstTokenTime)
		// > 500 才重算 state.tps，否则保留上一次的可度量值）：
		//   当前 step 自身跨度 > 500ms → 用「已结算累计 + 当前 step」重算；
		//   不足 500ms → 沿用已结算的累计值，不把刚起步的 step 混进分母：那几十毫秒会
		//   带着自己的取整误差和切分抖动一起进入读数；
		//   还没有任何已结算 step → 不显示（未知不是 0）。
		const openMs = this.stepFirstTokenAt === 0 ? 0 : Math.max(0, (this.stepUsageAt > 0 ? this.stepUsageAt : this.stepLastTokenAt) - this.stepFirstTokenAt);
		let tps = 0;
		if (openMs > 500) {
			const decodeMs = this.decodeMs();
			if (tokens > 0 && decodeMs > 0) tps = Math.round(tokens / (decodeMs / 1000));
		} else if (this.settledDecodeMs > 0 && this.settledOutputTokens > 0) {
			tps = Math.round(this.settledOutputTokens / (this.settledDecodeMs / 1000));
		}
		if (tps > 0) {
			// 量程随采样峰值缩放（地板 40），柱状图才不会长期满格。
			const peak = Math.max(tps, ...this.tpsSamples, 0);
			const gauge = formatTpsGauge(tps, peak, 8);
			tpsStr = ` · ${gauge} ~${tps} tps`;
		}

		const shimmerText = sweep(this.message || "正在处理...", now, ICE_RGB, FLASH_RGB, 60);
		const suffix = `${C.gray} · ${seconds}s${tpsStr}${C.reset}`;

		return truncateToWidth(`${spinner} ${shimmerText}${suffix}`, maxWidth);
	}

	render(width: number): string[] {
		const str = this.getHeaderString(width);
		if (!str) return [];
		return [truncateToWidth(`  ${str}`, width)];
	}

	invalidate(): void {}
}

/* ------------------------------------------------------------------ */
/* 待办队列悬浮视窗组件                                                */
/* ------------------------------------------------------------------ */

export interface PendingQueueOptions {
	maxVisible?: number;
}

export class PendingQueueComponent {
	private items: readonly QueuedMessage[] = [];
	private readonly maxVisible: number;

	constructor(options: PendingQueueOptions = {}) {
		this.maxVisible = options.maxVisible ?? 3;
	}

	setItems(items: readonly QueuedMessage[]): void {
		this.items = items;
	}

	getItems(): readonly QueuedMessage[] {
		return this.items;
	}

	render(width: number): string[] {
		if (this.items.length === 0) return [];

		const steerItems = this.items.filter((i) => i.mode === "steer");
		const followUpItems = this.items.filter((i) => i.mode === "followUp");
		const lines: string[] = [];

		const maxContentW = Math.max(4, width - 8);
		let renderedCount = 0;

		// 1. 渲染 Steer (插话)
		if (steerItems.length > 0) {
			const steerSuffix = steerItems.length > 1 ? ` (${steerItems.length} 条待办)` : "";
			lines.push(`  ${C.suggestion}◆ (Steer)${C.reset} ${C.inactive}· 下一步送达${steerSuffix}${C.reset}`);
			for (const item of steerItems) {
				if (renderedCount >= this.maxVisible) break;
				const cleanText = item.text.replace(/[\r\n]+/g, " ").trim();
				const truncated = truncateToWidth(cleanText, maxContentW);
				lines.push(`    ${C.subtle}↳${C.reset} ${C.text}${truncated}${C.reset}`);
				renderedCount++;
			}
		}

		// 2. 渲染 Follow-up (排队)
		if (followUpItems.length > 0) {
			const countSuffix = followUpItems.length > 1 ? ` (${followUpItems.length} 条待办)` : "";
			lines.push(`  ${C.inactive}◇ (Follow-up)${C.reset} ${C.inactive}· 本轮结束后送达${countSuffix}${C.reset}`);
			for (const item of followUpItems) {
				if (renderedCount >= this.maxVisible) break;
				const cleanText = item.text.replace(/[\r\n]+/g, " ").trim();
				const truncated = truncateToWidth(cleanText, maxContentW);
				lines.push(`    ${C.subtle}↳${C.reset} ${C.text}${truncated}${C.reset}`);
				renderedCount++;
			}
		}

		// 3. 超出最大显示预算折叠
		const remaining = this.items.length - renderedCount;
		if (remaining > 0) {
			lines.push(`    ${C.subtle}↳${C.reset} ${C.inactive}...另有 ${remaining} 条待办已排队${C.reset}`);
		}

		// 4. 操作指引行
		lines.push(`  ${C.subtle}↳ Alt+↑ 撤回 · Esc 打断并发送 · Ctrl+Enter 插队${C.reset}`);

		return lines.map((l) => truncateToWidth(l, width));
	}
}
