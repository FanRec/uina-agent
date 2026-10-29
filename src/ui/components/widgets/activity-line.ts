/**
 * 实时工作状态行组件（复刻 dsh-TUI ActivityLine.tsx 与 shimmer.ts）。
 * 特性：
 * 1. 冰蓝流光扫光（Shimmer Sweep）动态渐变效果；
 * 2. 动态旋转 Spinner 帧（⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏）；
 * 3. 真实秒表与流速呼吸（秒表分期、实时 Token 计数、响应式 TPS 仪表盘）；
 * 4. 纯函数排版渲染器（formatActivityHeader）与高内聚状态机（ActivityLineComponent）。
 */

import type { GenerationTiming } from "../../../core/types.js";
import type { Component } from "../../core/types.js";
import { C, charWidth, sgr, visibleWidth } from "../../core/utils.js";
import { fitLine } from "../../layout/fit.js";

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
 * 只在累计量上折一次，不按 delta 逐条折算，避免向上取整零头随切片累加。
 */
export function foldStreamChars(counts: { cjk: number; other: number }): number {
	if (counts.cjk + counts.other === 0) return 0;
	return Math.max(1, Math.round(counts.cjk * STREAM_TOKENS_PER_CJK_CHAR + counts.other * STREAM_TOKENS_PER_OTHER_CHAR));
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

export function sweep(
	text: string,
	timeMs: number,
	base: Rgb = ICE_RGB,
	highlight: Rgb = FLASH_RGB,
	stepMs = 60,
): string {
	if (!text) return "";
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
			out += sgr(`\x1b[38;2;${colorKey}m\x1b[1m`);
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

function animatedHeader(message: string, elapsedMs: number, now: number, maxWidth: number, suffix = ""): string {
	if (maxWidth <= 0) return "";
	const spinner = `${C.suggestion}${SPINNER_FRAMES[Math.floor(now / 80) % SPINNER_FRAMES.length]}${C.reset} `;
	const seconds = (Math.max(0, elapsedMs) / 1000).toFixed(1);
	const secStr = `${C.gray}· ${seconds}s${C.reset}`;

	const spinnerW = visibleWidth(spinner);
	const suffixW = visibleWidth(secStr) + (suffix ? visibleWidth(suffix) : 0);

	// 优先保障右侧关键指标（秒表、Token、TPS）完整展现，左侧阶段文案按剩余空间自适应
	let availForMessage = maxWidth - spinnerW - suffixW - 1;
	let activeSuffix = suffix;

	// 若空间极端受限，逐级丢弃修饰后缀以保全阶段核心文案和秒表
	if (availForMessage < 3 && suffix) {
		activeSuffix = "";
		const reducedSuffixW = visibleWidth(secStr);
		availForMessage = maxWidth - spinnerW - reducedSuffixW - 1;
	}

	const safeAvail = Math.max(1, availForMessage);
	const safeMsg = visibleWidth(message) > safeAvail ? fitLine(message, safeAvail) : message;
	const shimmerText = safeMsg ? sweep(safeMsg, now, ICE_RGB, FLASH_RGB, 60) : "";

	const line = shimmerText ? `${spinner}${shimmerText} ${secStr}${activeSuffix}` : `${spinner}${secStr}${activeSuffix}`;
	return visibleWidth(line) > maxWidth ? fitLine(line, maxWidth, "clip") : line;
}

/** 扩展工作是独立的可见操作，不借用回合的 ActivityLine 状态和计时。 */
export function formatWorkingHeader(message: string, elapsedMs: number, maxWidth = 60, now = Date.now()): string {
	return animatedHeader(message, elapsedMs, now, maxWidth);
}

/** 表盘量程地板：低于它的峰值会被抬到此处，避免小样本把表盘放得过大。 */
const GAUGE_FLOOR = 40;

/**
 * 可度量解码窗口下限：低于它说明内容是一次成批到达的（Provider/网关把整段塞进一两个
 * SSE chunk），客户端没有观察到解码过程——窗口落在传输抖动量级，分不出「真实高速」与
 * 「整段批处理」。这种 step 不进速度账本（分子分母一起不计），否则 92 个真实 token 除以
 * 30ms 会报出 3000+ tps。真实逐 token 解码哪怕再快，非平凡输出也会把 delta 摊开到更宽。
 */
const MIN_MEASURABLE_DECODE_MS = 100;
const HBLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const VBLOCKS = [" ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const TRACK = "·";

/**
 * 实时 1/8 字符水平仪表盘：`▕██████▋···▏`
 * 依据当前速率 tps 相对于 targetPeak 映射，并按速度区间使用快/中/慢信息色。
 */
function tpsColor(tps: number): string {
	return tps >= 50 ? C.success : tps >= 20 ? C.warning : C.inactive;
}

export function formatTpsGauge(tps: number, targetPeak = 60, gaugeWidth = 8): string {
	if (gaugeWidth <= 0) return "";
	const safeTps = Math.max(0, tps);
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

	const color = tpsColor(safeTps);
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

/** 状态行格式化度量快照参数契约 */
export interface ActivityHeaderMetrics {
	phase: ActivityPhase;
	message: string;
	elapsedMs: number;
	outputTokens: number;
	tps?: number;
	avgTps?: number;
	isWaitingFirstToken?: boolean;
	tpsSamples?: readonly number[];
	/** 本回合首个请求的首包耗时；来自 Provider 真实时序，而非 UI 事件时刻。 */
	ttftMs?: number;
	/** 本回合已结算的思考 token；usage.output 含它，正文 = output - reasoning。 */
	reasoningTokens?: number;
	/** outputTokens 是否来自字符折算估算；服务端真实 usage 为 false。 */
	tokensEstimated: boolean;
	/** tps 分子是否含估算 token；全部来自真实 usage 时为 false。 */
	tpsEstimated: boolean;
}

/**
 * 纯函数：根据度量快照格式化终端状态行（解耦状态与排版视图）
 */
export function formatActivityHeader(metrics: ActivityHeaderMetrics, maxWidth = 60, now = Date.now()): string {
	if (metrics.phase === "idle" || maxWidth <= 0) return "";
	const seconds = (Math.max(0, metrics.elapsedMs) / 1000).toFixed(1);
	const tokens = metrics.outputTokens;

	if (metrics.phase === "done") {
		const prefix = `${C.green}✓${C.reset}`;
		// `~` 只用于字符折算的估算值；服务端报回的 usage 是事实，不带修饰。
		const tokenMark = metrics.tokensEstimated ? "~" : "";
		let sparkStr = "";
		if (metrics.avgTps !== undefined && metrics.avgTps > 0) {
			const avgTps = metrics.avgTps;
			const samples = metrics.tpsSamples ?? [];
			const spark = formatTpsSparkline(samples.slice(-12));
			const sparkColor = tpsColor(avgTps);
			const speedMark = metrics.tpsEstimated ? "~" : "";
			sparkStr = spark
				? ` · ${sparkColor}${spark}${C.reset} ${speedMark}${avgTps} tps`
				: ` · ${speedMark}${avgTps} tps`;
		}
		// 首包等待是真实体验的一部分，之前完全不可见：3.1s 耗时里有 2.4s 在等首包。
		const ttft =
			metrics.ttftMs !== undefined && metrics.ttftMs >= 100 ? ` · 首包 ${(metrics.ttftMs / 1000).toFixed(1)}s` : "";
		// usage.output 含思考 token；宽屏时拆开，避免把「想得多」误读成「吐字慢」。
		const reasoning = metrics.reasoningTokens ?? 0;
		const content = Math.max(0, tokens - reasoning);
		const showSplit = reasoning > 0 && maxWidth >= 90;
		const tokenStr =
			tokens > 0
				? showSplit
					? ` · ${tokenMark}${tokens} tok (思考 ${reasoning} · 正文 ${content})`
					: ` · ${tokenMark}${tokens} tok`
				: "";
		const text = `${C.gray}${metrics.message} · 耗时 ${seconds}s${ttft}${tokenStr}${sparkStr}${C.reset}`;
		return fitLine(`${prefix} ${text}`, maxWidth);
	}

	// 1. 组装 Token 实时体量或首包等待提示
	let tokenStr = "";
	if (metrics.isWaitingFirstToken) {
		tokenStr = ` · ${C.inactive}等待响应${C.reset}`;
	} else if (tokens > 0 && maxWidth >= 48) {
		// 流式中 usage 到达前是字符折算，到达后同一 step 即切换为真实值。
		const tokenMark = metrics.tokensEstimated ? "~" : "";
		tokenStr = ` · ${C.gray}${tokenMark}${tokens} tok${C.reset}`;
	}

	// 2. 组装 TPS 实时流速仪表盘
	// 当存在已度量的流速（模型解码阶段或沿用上一步已结算的流速）时渲染仪表盘
	let tpsStr = "";
	const tps = metrics.tps ?? 0;
	if (tps > 0 && maxWidth >= 40) {
		const peak = Math.max(tps, ...(metrics.tpsSamples ?? []), 0);
		// 响应式表盘宽度：宽屏 8 格，中屏 4 格，窄屏纯数字
		const gaugeWidth = maxWidth >= 75 ? 8 : maxWidth >= 58 ? 4 : 0;
		const gauge = gaugeWidth > 0 ? `${formatTpsGauge(tps, peak, gaugeWidth)} ` : "";
		const speedColor = tpsColor(tps);
		const speedMark = metrics.tpsEstimated ? "~" : "";
		tpsStr = ` · ${gauge}${speedColor}${speedMark}${tps} tps${C.reset}`;
	}

	const suffix = `${tokenStr}${tpsStr}`;
	return animatedHeader(metrics.message || "正在处理...", metrics.elapsedMs, now, maxWidth, suffix);
}

export class ActivityLineComponent implements Component {
	private phase: ActivityPhase = "idle";
	private message = "";
	private startTime = 0;
	private elapsedMs = 0;
	private stepStartedAt = 0;

	private stepFirstTokenAt = 0;
	private stepLastTokenAt = 0;
	private stepCjkChars = 0;
	private stepOtherChars = 0;
	private stepUsageTokens = 0;
	private stepUsageAt = 0;
	/** Provider 真实时序：解码窗口的权威来源，不含 usage 尾部 RTT。 */
	private stepTiming?: GenerationTiming;
	private stepReasoningTokens = 0;

	private settledDecodeMs = 0;
	private settledOutputTokens = 0;
	/** settledOutputTokens 中由字符折算的部分；非 0 表示展示值含估算。 */
	private settledEstimatedOutputTokens = 0;
	/** 速度配对账本：只累计「窗口达到可度量下限」的 step，与 settledDecodeMs 成对使用。 */
	private settledMeasuredTokens = 0;
	/** settledMeasuredTokens 中由字符折算的部分；非 0 表示流速含估算。 */
	private settledEstimatedMeasuredTokens = 0;
	private settledReasoningTokens = 0;
	/** 本回合首个请求的首包耗时（一次回合内恒定，不随 step 累加）。 */
	private firstTtftMs = 0;

	private tpsSamples: number[] = [];

	start(phase: ActivityPhase, message: string): void {
		this.phase = phase;
		this.message = message;
		this.startTime = Date.now();
		this.stepStartedAt = this.startTime;
		this.elapsedMs = 0;
		this.clearStep();
		this.settledDecodeMs = 0;
		this.settledOutputTokens = 0;
		this.settledEstimatedOutputTokens = 0;
		this.settledMeasuredTokens = 0;
		this.settledEstimatedMeasuredTokens = 0;
		this.settledReasoningTokens = 0;
		this.firstTtftMs = 0;
	}

	update(phase: ActivityPhase, message: string): void {
		if (this.phase !== phase) {
			this.stepStartedAt = Date.now();
		}
		this.phase = phase;
		this.message = message;
	}

	addStreamText(text: string): void {
		if (text.length === 0) return;
		const counts = classifyStreamText(text);
		const now = Date.now();
		if (this.stepFirstTokenAt === 0) this.stepFirstTokenAt = now;
		this.stepLastTokenAt = now;
		this.stepCjkChars += counts.cjk;
		this.stepOtherChars += counts.other;
	}

	/** 本 step 的 token 值与来源：服务端 usage 是事实，字符折算是估算。 */
	private stepTokenCount(): { tokens: number; estimated: boolean } {
		if (this.stepUsageTokens > 0) return { tokens: this.stepUsageTokens, estimated: false };
		return {
			tokens: foldStreamChars({ cjk: this.stepCjkChars, other: this.stepOtherChars }),
			estimated: true,
		};
	}

	addRealOutputTokens(tokens: number, timing?: GenerationTiming, reasoningTokens?: number): void {
		if (tokens <= 0) return;
		const hasWindow = timing !== undefined && timing.decodeMs > 0;
		// 整步没有任何成功内容 delta 时，既没有可信窗口也没有可信分母，宁可不报。
		if (this.stepFirstTokenAt === 0 && !hasWindow) return;
		this.stepUsageTokens = tokens;
		this.stepUsageAt = Date.now();
		if (timing) {
			// timing 一律存下（decodeMs=0 也是事实）：endStep 要靠它识别成批到达，
			// 而不是误退回被尾部 RTT 污染的 UI 事件窗口。
			this.stepTiming = timing;
			if (this.firstTtftMs === 0 && timing.ttftMs > 0) this.firstTtftMs = timing.ttftMs;
		}
		this.stepReasoningTokens = reasoningTokens ?? 0;
	}

	endStep(): void {
		// token 总数是事实（服务端报了、输出用户可见），有可见输出就记；
		// 速度是测量：窗口低于可度量下限（成批到达）的 step 不进速度账本。
		const visible = this.stepFirstTokenAt > 0;
		const { tokens: stepTokens, estimated } = this.stepTokenCount();
		if (visible && stepTokens > 0) {
			this.settledOutputTokens += stepTokens;
			if (estimated) this.settledEstimatedOutputTokens += stepTokens;
			this.settledReasoningTokens += this.stepReasoningTokens;
		}
		if (visible && this.observedWindowMs() >= MIN_MEASURABLE_DECODE_MS) {
			this.settledMeasuredTokens += stepTokens;
			if (estimated) this.settledEstimatedMeasuredTokens += stepTokens;
			this.settledDecodeMs += this.observedWindowMs();
		}
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
		if (this.settledMeasuredTokens > 0 && this.settledDecodeMs > 0) {
			this.tpsSamples.push(Math.round(this.settledMeasuredTokens / (this.settledDecodeMs / 1000)));
			if (this.tpsSamples.length > 500) this.tpsSamples.shift();
		}
	}

	reset(): void {
		this.phase = "idle";
		this.message = "";
		this.startTime = 0;
		this.elapsedMs = 0;
		this.stepStartedAt = 0;
		this.clearStep();
		this.settledDecodeMs = 0;
		this.settledOutputTokens = 0;
		this.settledEstimatedOutputTokens = 0;
		this.settledMeasuredTokens = 0;
		this.settledEstimatedMeasuredTokens = 0;
		this.settledReasoningTokens = 0;
		this.firstTtftMs = 0;
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
		this.stepTiming = undefined;
		this.stepReasoningTokens = 0;
	}

	/**
	 * 当前 step 观察到的解码窗口：Provider timing 是权威事实（可能为 0——成批到达），
	 * 缺失时才退回 UI 事件时刻（含 usage 尾部 RTT，仅供无 timing 的旧路径）。
	 */
	private observedWindowMs(): number {
		if (this.stepTiming) return Math.max(0, this.stepTiming.decodeMs);
		if (this.stepFirstTokenAt === 0) return 0;
		return Math.max(0, (this.stepUsageAt > 0 ? this.stepUsageAt : this.stepLastTokenAt) - this.stepFirstTokenAt);
	}

	/** 当前 step 是否达到可度量下限：低于它说明内容是一次成批到达，观察不到解码过程。 */
	private isStepMeasurable(): boolean {
		return this.stepFirstTokenAt > 0 && this.observedWindowMs() >= MIN_MEASURABLE_DECODE_MS;
	}

	private outputTokens(): number {
		const step = this.stepTokenCount();
		return this.settledOutputTokens + (this.stepFirstTokenAt > 0 ? step.tokens : 0);
	}

	/** 展示的 token 总数是否含字符折算；真实 usage 到达后同一 step 立即转为事实。 */
	private outputTokensEstimated(): boolean {
		if (this.stepFirstTokenAt > 0 && this.stepUsageTokens === 0) return true;
		return this.settledEstimatedOutputTokens > 0;
	}

	/** 速度比值的两端：分子只累计可度量 step 的 token，与分母严格配对。 */
	private speedPair(): { tokens: number; ms: number } {
		if (!this.isStepMeasurable()) return { tokens: this.settledMeasuredTokens, ms: this.settledDecodeMs };
		const step = this.stepTokenCount();
		return {
			tokens: this.settledMeasuredTokens + step.tokens,
			ms: this.settledDecodeMs + this.observedWindowMs(),
		};
	}

	/** 流速账本是否混入了字符折算值。 */
	private speedEstimated(): boolean {
		if (this.isStepMeasurable() && this.stepUsageTokens === 0) return true;
		return this.settledEstimatedMeasuredTokens > 0;
	}

	/** 提取适用于圆角盒顶边框嵌入的状态文本 */
	private computeElapsedMs(now: number): number {
		if (this.phase === "done") return this.elapsedMs;
		const origin = this.phase === "tool" && this.stepStartedAt > 0 ? this.stepStartedAt : this.startTime;
		return origin > 0 ? Math.max(0, now - origin) : 0;
	}

	private computeTps(): { tps: number; avgTps: number } {
		if (this.phase === "done") {
			const avgTps =
				this.settledMeasuredTokens > 0 && this.settledDecodeMs > 0
					? Math.round(this.settledMeasuredTokens / (this.settledDecodeMs / 1000))
					: 0;
			return { tps: 0, avgTps };
		}
		// 门控对齐 dsh-TUI：
		// 当前 step 自身跨度 > 500ms → 用「已结算累计 + 当前 step」重算；
		// 不足 500ms（或处于 tool 阶段）→ 沿用已结算的累计值，不把刚起步的 step 混进分母，工具耗时亦不稀释流速；
		// 没有任何已结算 step 时 → 保持 0（未知不是 0）。
		if (this.isStepMeasurable() && this.observedWindowMs() > 500) {
			const { tokens, ms } = this.speedPair();
			if (tokens > 0 && ms > 0) return { tps: Math.round(tokens / (ms / 1000)), avgTps: 0 };
		} else if (this.settledMeasuredTokens > 0 && this.settledDecodeMs > 0) {
			return { tps: Math.round(this.settledMeasuredTokens / (this.settledDecodeMs / 1000)), avgTps: 0 };
		}
		return { tps: 0, avgTps: 0 };
	}

	/** 提取适用于圆角盒顶边框嵌入的状态文本 */
	getHeaderString(maxWidth = 60): string {
		if (this.phase === "idle" || maxWidth <= 0) return "";
		const now = Date.now();
		const currentElapsed = this.computeElapsedMs(now);
		const tokens = this.outputTokens();
		const { tps, avgTps } = this.computeTps();

		return formatActivityHeader(
			{
				phase: this.phase,
				message: this.message,
				elapsedMs: currentElapsed,
				outputTokens: tokens,
				tps,
				avgTps,
				isWaitingFirstToken: this.stepFirstTokenAt === 0 && (this.phase === "thinking" || this.phase === "streaming"),
				tpsSamples: this.tpsSamples,
				...(this.firstTtftMs > 0 ? { ttftMs: this.firstTtftMs } : {}),
				...(this.settledReasoningTokens > 0 ? { reasoningTokens: this.settledReasoningTokens } : {}),
				tokensEstimated: this.outputTokensEstimated(),
				tpsEstimated: this.speedEstimated(),
			},
			maxWidth,
			now,
		);
	}

	render(width: number): string[] {
		const str = this.getHeaderString(width);
		if (!str) return [];
		return [fitLine(`  ${str}`, width)];
	}

	invalidate(): void {}
}

/* ------------------------------------------------------------------ */
/* 待办队列悬浮视窗组件                                                */
/* ------------------------------------------------------------------ */

export interface PendingQueueOptions {
	maxVisible?: number;
}

export interface PendingQueueItem {
	readonly mode: "steer" | "followUp";
	readonly text: string;
}

export class PendingQueueComponent {
	private items: readonly PendingQueueItem[] = [];
	private readonly maxVisible: number;

	constructor(options: PendingQueueOptions = {}) {
		this.maxVisible = options.maxVisible ?? 3;
	}

	setItems(items: readonly PendingQueueItem[]): void {
		this.items = items;
	}

	getItems(): readonly PendingQueueItem[] {
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
				const truncated = fitLine(cleanText, maxContentW);
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
				const truncated = fitLine(cleanText, maxContentW);
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

		return lines.map((l) => fitLine(l, width));
	}
}
