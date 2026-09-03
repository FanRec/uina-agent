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

	for (const char of text) {
		const w = charWidth(char);
		const highlighted = col >= glimmerStart && col + w <= glimmerStart + 8;
		const opacity = highlighted ? (Math.sin(timeMs / (stepMs * 2)) + 1) / 2 : 0;
		const rgb = highlighted ? interpolateColor(base, highlight, opacity) : base;

		out += `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m\x1b[1m${char}\x1b[0m`;
		col += w;
	}

	return out;
}

export type ActivityPhase = "idle" | "thinking" | "streaming" | "tool" | "done";

export class ActivityLineComponent implements Component {
	private phase: ActivityPhase = "idle";
	private message = "";
	private startTime = 0;
	private tokenCount = 0;
	private elapsedMs = 0;

	start(phase: ActivityPhase, message: string): void {
		this.phase = phase;
		this.message = message;
		this.startTime = Date.now();
		this.tokenCount = 0;
		this.elapsedMs = 0;
	}

	update(phase: ActivityPhase, message: string): void {
		this.phase = phase;
		this.message = message;
	}

	addTokens(count: number): void {
		this.tokenCount += count;
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
	}

	getPhase(): ActivityPhase {
		return this.phase;
	}

	/** 提取适用于圆角盒顶边框嵌入的状态文本 */
	getHeaderString(maxWidth = 60): string {
		if (this.phase === "idle") return "";
		const now = Date.now();
		const currentElapsed = this.phase === "done" ? this.elapsedMs : (this.startTime > 0 ? now - this.startTime : 0);
		const seconds = (Math.max(0, currentElapsed) / 1000).toFixed(1);

		if (this.phase === "done") {
			const prefix = `${C.green}✓${C.reset}`;
			const text = `${C.gray}${this.message} · 耗时 ${seconds}s${this.tokenCount > 0 ? ` · ${this.tokenCount} tokens` : ""}${C.reset}`;
			return truncateToWidth(`${prefix} ${text}`, maxWidth);
		}

		const frameIdx = Math.floor(now / 80) % SPINNER_FRAMES.length;
		const spinner = `${C.iceBlue}${SPINNER_FRAMES[frameIdx]}${C.reset}`;
		let tpsStr = "";
		if (this.tokenCount > 0 && currentElapsed > 400) {
			const tps = Math.round(this.tokenCount / (currentElapsed / 1000));
			tpsStr = ` · ${tps} tps`;
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
