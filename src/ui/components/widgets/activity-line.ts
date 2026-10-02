/**
 * 实时工作状态行组件（复刻 dsh-TUI ActivityLine.tsx 与 shimmer.ts）。
 * 特性：
 * 1. 冰蓝流光扫光（Shimmer Sweep）动态渐变效果；
 * 2. 动态旋转 Spinner 帧（⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏）；
 * 3. 真实秒表与流速呼吸（秒表分期、实时 Token 计数、响应式 TPS 仪表盘）；
 * 4. 纯函数排版渲染器（formatActivityHeader）与高内聚状态机（ActivityLineComponent）。
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

export function sweep(text: string, timeMs: number, base: Rgb = ICE_RGB, highlight: Rgb = FLASH_RGB, stepMs = 60): string {
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

function animatedHeader(message: string, elapsedMs: number, now: number, maxWidth: number, suffix = ""): string {
	if (maxWidth <= 0) return "";
	const spinner = `${C.iceBlue}${SPINNER_FRAMES[Math.floor(now / 80) % SPINNER_FRAMES.length]}${C.reset} `;
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
	const safeMsg = visibleWidth(message) > safeAvail ? truncateToWidth(message, safeAvail, "…") : message;
	const shimmerText = safeMsg ? sweep(safeMsg, now, ICE_RGB, FLASH_RGB, 60) : "";

	const line = shimmerText ? `${spinner}${shimmerText} ${secStr}${activeSuffix}` : `${spinner}${secStr}${activeSuffix}`;
	return visibleWidth(line) > maxWidth ? truncateToWidth(line, maxWidth, "") : line;
}

/** 扩展工作是独立的可见操作，不借用回合的 ActivityLine 状态和计时。 */
export function formatWorkingHeader(message: string, elapsedMs: number, maxWidth = 60, now = Date.now()): string {
	return animatedHeader(message, elapsedMs, now, maxWidth);
}

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
}

/**
 * 纯函数：根据度量快照格式化终端状态行（解耦状态与排版视图）
 */
export function formatActivityHeader(
	metrics: ActivityHeaderMetrics,
	maxWidth = 60,
	now = Date.now(),
): string {
	if (metrics.phase === "idle" || maxWidth <= 0) return "";
	const seconds = (Math.max(0, metrics.elapsedMs) / 1000).toFixed(1);
	const tokens = metrics.outputTokens;

	if (metrics.phase === "done") {
		const prefix = `${C.green}✓${C.reset}`;
		let sparkStr = "";
		if (metrics.avgTps !== undefined && metrics.avgTps > 0) {
			const avgTps = metrics.avgTps;
			const samples = metrics.tpsSamples ?? [];
			const spark = formatTpsSparkline(samples.slice(-12));
			const sparkColor = avgTps >= 50 ? C.green : avgTps >= 20 ? C.yellow : C.red;
			sparkStr = spark ? ` · ${sparkColor}${spark}${C.reset} ~${avgTps} tps` : ` · ~${avgTps} tps`;
		}
		const text = `${C.gray}${metrics.message} · 耗时 ${seconds}s${tokens > 0 ? ` · ~${tokens} tokens` : ""}${sparkStr}${C.reset}`;
		return truncateToWidth(`${prefix} ${text}`, maxWidth);
	}

	// 1. 组装 Token 实时体量或首包等待提示
	let tokenStr = "";
	if (metrics.isWaitingFirstToken) {
		tokenStr = ` · ${C.inactive}等待响应${C.reset}`;
	} else if (tokens > 0 && maxWidth >= 48) {
		tokenStr = ` · ${C.gray}~${tokens} tok${C.reset}`;
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
		const tpsColor = tps >= 50 ? C.green : tps >= 20 ? C.yellow : C.red;
		tpsStr = ` · ${gauge}${tpsColor}~${tps} tps${C.reset}`;
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

	private settledDecodeMs = 0;
	private settledOutputTokens = 0;

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

	private estimateTokens(): number {
		return foldStreamChars({ cjk: this.stepCjkChars, other: this.stepOtherChars });
	}

	addRealOutputTokens(tokens: number): void {
		if (tokens <= 0 || this.stepFirstTokenAt === 0) return;
		this.stepUsageTokens = tokens;
		this.stepUsageAt = Date.now();
	}

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
		this.stepStartedAt = 0;
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

	private outputTokens(): number {
		const inFlight = this.stepUsageTokens > 0 ? this.stepUsageTokens : this.estimateTokens();
		return this.settledOutputTokens + (this.stepFirstTokenAt > 0 ? inFlight : 0);
	}

	private decodeMs(): number {
		if (this.stepFirstTokenAt === 0) return this.settledDecodeMs;
		const end = this.stepUsageAt > 0 ? this.stepUsageAt : this.stepLastTokenAt;
		return this.settledDecodeMs + Math.max(0, end - this.stepFirstTokenAt);
	}

	/** 提取适用于圆角盒顶边框嵌入的状态文本 */
	private computeElapsedMs(now: number): number {
		if (this.phase === "done") return this.elapsedMs;
		const origin = this.phase === "tool" && this.stepStartedAt > 0 ? this.stepStartedAt : this.startTime;
		return origin > 0 ? Math.max(0, now - origin) : 0;
	}

	private computeTps(): { tps: number; avgTps: number } {
		const tokens = this.outputTokens();
		if (this.phase === "done") {
			const avgTps = tokens > 0 && this.settledDecodeMs > 0 ? Math.round(tokens / (this.settledDecodeMs / 1000)) : 0;
			return { tps: 0, avgTps };
		}
		// 门控对齐 dsh-TUI：
		// 当前 step 自身跨度 > 500ms → 用「已结算累计 + 当前 step」重算；
		// 不足 500ms（或处于 tool 阶段）→ 沿用已结算的累计值，不把刚起步的 step 混进分母，工具耗时亦不稀释流速；
		// 没有任何已结算 step 时 → 保持 0（未知不是 0）。
		const openMs = this.stepFirstTokenAt === 0 ? 0 : Math.max(0, (this.stepUsageAt > 0 ? this.stepUsageAt : this.stepLastTokenAt) - this.stepFirstTokenAt);
		if (openMs > 500) {
			const decodeMs = this.decodeMs();
			if (tokens > 0 && decodeMs > 0) return { tps: Math.round(tokens / (decodeMs / 1000)), avgTps: 0 };
		} else if (this.settledDecodeMs > 0 && this.settledOutputTokens > 0) {
			return { tps: Math.round(this.settledOutputTokens / (this.settledDecodeMs / 1000)), avgTps: 0 };
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
			},
			maxWidth,
			now,
		);
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
