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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
	const ratio = Math.min(1, safeTps / Math.max(20, targetPeak));
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

	/** 提取适用于圆角盒顶边框嵌入的状态文本 */
	getHeaderString(maxWidth = 60): string {
		if (this.phase === "idle") return "";
		const now = Date.now();
		const currentElapsed = this.phase === "done" ? this.elapsedMs : (this.startTime > 0 ? now - this.startTime : 0);
		const seconds = (Math.max(0, currentElapsed) / 1000).toFixed(1);

		if (this.phase === "done") {
			const prefix = `${C.green}✓${C.reset}`;
			let sparkStr = "";
			if (this.tokenCount > 0 && this.elapsedMs > 0) {
				const avgTps = Math.round(this.tokenCount / (this.elapsedMs / 1000));
				const spark = formatTpsSparkline(this.tpsSamples.length > 0 ? this.tpsSamples : [avgTps]);
				const sparkColor = avgTps >= 50 ? C.green : avgTps >= 20 ? C.yellow : C.red;
				sparkStr = spark ? ` · ${sparkColor}${spark}${C.reset} ~${avgTps} tps` : ` · ~${avgTps} tps`;
			}
			const text = `${C.gray}${this.message} · 耗时 ${seconds}s${this.tokenCount > 0 ? ` · ~${this.tokenCount} tokens` : ""}${sparkStr}${C.reset}`;
			return truncateToWidth(`${prefix} ${text}`, maxWidth);
		}

		const frameIdx = Math.floor(now / 80) % SPINNER_FRAMES.length;
		const spinner = `${C.iceBlue}${SPINNER_FRAMES[frameIdx]}${C.reset}`;
		let tpsStr = "";
		if (this.tokenCount > 0 && currentElapsed > 400) {
			const tps = Math.round(this.tokenCount / (currentElapsed / 1000));
			const gauge = formatTpsGauge(tps, 60, 8);
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
