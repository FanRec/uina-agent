/**
 * 实时工作状态行组件（复刻 dsh-TUI ActivityLine.tsx 与 shimmer.ts）。
 * 特性：
 * 1. 冰蓝流光扫光（Shimmer Sweep）动态渐变效果；
 * 2. 动态旋转 Spinner 帧（⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏）；
 * 3. 实时耗时统计与 TPS 计算；
 * 4. 支持独立行输出与嵌入圆角盒顶边框（getHeaderString）。
 */

import type { Component } from "../../core/types.js";
import { C, charWidth, truncateToWidth, visibleWidth } from "../../core/utils.js";
import type { QueuedMessage } from "../../../agent/queue.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * 流式过程中把字符数折算成 token 的兜底系数。
 *
 * 与 `agent/context.ts` 的 `CHARS_PER_TOKEN` (=4, 用于上下文压缩阈值) 刻意分开：
 * 这里只服务于"正在生成时的速度显示"，而速度的分母是实时窗口、且只要服务端报了
 * output 就立刻改用真实值，所以它只需要量级对得上，不需要和压缩口径一致。
 * 中文比英文更"贵"（一个汉字 ≈ 1 token，而非 4 字符），所以这个兜底会偏低——
 * 但只要真实值一到就会被覆盖，不会影响最终读数。
 */
export const STREAM_CHARS_PER_TOKEN = 3;

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
	private tokenCount = 0;
	private elapsedMs = 0;

	/**
	 * 首个输出 token 的墙钟时刻；tps 的分母从它算起。
	 *
	 * 不用 startTime：那是回合开始的时刻，回合里还包含工具执行与每次请求的
	 * 首 token 等待（TTFT）。把它们算进分母会把生成速度稀释掉——工具跑 8 秒、
	 * 生成 2 秒，显示出来的 tps 就只有真值的 1/5。dsh-tui 同样只累计
	 * first-token → message 的跨度。
	 */
	private decodeStartTime = 0;
	/** 服务端报过的真实输出 token 数（本次回合累计）；有它就不再用字符估算。 */
	private realOutputTokens = 0;

	// TPS 采样环形缓冲区
	private tpsSamples: number[] = [];
	private lastSampleTime = 0;
	private lastSampleTokens = 0;

	start(phase: ActivityPhase, message: string): void {
		this.phase = phase;
		this.message = message;
		this.startTime = Date.now();
		this.tokenCount = 0;
		this.elapsedMs = 0;
		this.decodeStartTime = 0;
		this.realOutputTokens = 0;
		this.tpsSamples = [];
		this.lastSampleTime = this.startTime;
		this.lastSampleTokens = 0;
	}

	update(phase: ActivityPhase, message: string): void {
		this.phase = phase;
		this.message = message;
	}

	addTokens(count: number): void {
		this.tokenCount += count;
		const now = Date.now();
		// 第一个 token 到达时才开始计解码时间：此前的等待是 TTFT，不是生成。
		if (this.decodeStartTime === 0) this.decodeStartTime = now;
		// 每 250ms 采样一次局部速率
		if (now - this.lastSampleTime >= 250) {
			const deltaTokens = this.tokenCount - this.lastSampleTokens;
			const deltaSec = (now - this.lastSampleTime) / 1000;
			if (deltaSec > 0) {
				const sampleTps = Math.round(deltaTokens / deltaSec);
				this.tpsSamples.push(sampleTps);
				if (this.tpsSamples.length > 10) {
					this.tpsSamples.shift();
				}
			}
			this.lastSampleTime = now;
			this.lastSampleTokens = this.tokenCount;
		}
	}

	finish(summary = "本轮已完成", elapsedOverride?: number, tokensOverride?: number): void {
		this.phase = "done";
		if (tokensOverride !== undefined && tokensOverride > 0) {
			this.tokenCount = tokensOverride;
		}
		if (elapsedOverride !== undefined && elapsedOverride > 0) {
			this.elapsedMs = elapsedOverride;
		} else if (this.startTime > 0) {
			this.elapsedMs = Math.max(0, Date.now() - this.startTime);
		} else {
			this.elapsedMs = 0;
		}
		this.message = summary;
	}

	reset(): void {
		this.phase = "idle";
		this.message = "";
		this.startTime = 0;
		this.tokenCount = 0;
		this.elapsedMs = 0;
		this.decodeStartTime = 0;
		this.realOutputTokens = 0;
		this.tpsSamples = [];
		this.lastSampleTime = 0;
		this.lastSampleTokens = 0;
	}

	getPhase(): ActivityPhase {
		return this.phase;
	}

	getTpsSamples(): readonly number[] {
		return this.tpsSamples;
	}

	/**
	 * 累加一次模型调用报来的真实输出 token 数。
	 *
	 * 服务端的 output 是"本次调用"的 completion_tokens；一个回合可以有多轮调用
	 * （stream → tool → stream），每一轮的输出都应计入这一轮的生成速度，所以这里是
	 * 累加而不是覆盖。字符估算（`chars / 3`）对中文严重偏低（一个汉字远比 3 个字符
	 * 更"贵"），所以只要有真实值就改用它，估算只在流式过程中兜底。
	 */
	addRealOutputTokens(tokens: number): void {
		if (tokens > 0) this.realOutputTokens += tokens;
	}

	/** 生成速度的分子：真实值优先，否则用流式累计的估算。 */
	private outputTokenCount(): number {
		return this.realOutputTokens > 0 ? this.realOutputTokens : this.tokenCount;
	}

	/** 生成速度的分母：只算首个 token 之后的生成耗时（毫秒）。 */
	private decodeMs(now: number): number {
		if (this.phase === "done") return this.elapsedMs;
		return this.decodeStartTime > 0 ? Math.max(0, now - this.decodeStartTime) : 0;
	}

	/** 提取适用于圆角盒顶边框嵌入的状态文本 */
	getHeaderString(maxWidth = 60): string {
		if (this.phase === "idle") return "";
		const now = Date.now();
		// "耗时"展示整个回合的墙钟时间（含工具执行），这是用户感知的总时长。
		const currentElapsed = this.phase === "done" ? this.elapsedMs : (this.startTime > 0 ? now - this.startTime : 0);
		const seconds = (Math.max(0, currentElapsed) / 1000).toFixed(1);
		const tokens = this.outputTokenCount();
		const decodeMs = this.decodeMs(now);

		if (this.phase === "done") {
			const prefix = `${C.green}✓${C.reset}`;
			let sparkStr = "";
			// tps 的分母是解码耗时而非墙钟耗时：工具执行不该稀释生成速度。
			if (tokens > 0 && decodeMs > 0) {
				const avgTps = Math.round(tokens / (decodeMs / 1000));
				const spark = formatTpsSparkline(this.tpsSamples.length > 0 ? this.tpsSamples : [avgTps]);
				const sparkColor = avgTps >= 50 ? C.green : avgTps >= 20 ? C.yellow : C.red;
				sparkStr = spark ? ` · ${sparkColor}${spark}${C.reset} ~${avgTps} tps` : ` · ~${avgTps} tps`;
			}
			const text = `${C.gray}${this.message} · 耗时 ${seconds}s${tokens > 0 ? ` · ~${tokens} tokens` : ""}${sparkStr}${C.reset}`;
			return truncateToWidth(`${prefix} ${text}`, maxWidth);
		}

		const frameIdx = Math.floor(now / 80) % SPINNER_FRAMES.length;
		const spinner = `${C.iceBlue}${SPINNER_FRAMES[frameIdx]}${C.reset}`;
		let tpsStr = "";
		if (tokens > 0 && decodeMs > 400) {
			const tps = Math.round(tokens / (decodeMs / 1000));
			// 量程随采样峰值缩放，柱状图才不会长期满格。
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

