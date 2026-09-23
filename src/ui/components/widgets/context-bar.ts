/**
 * 输入框底边下方的稳定信息行与多段式上下文分布条。
 *
 * 核心特性：
 * 1. 严格一终端行稳定布局槽位，Hover 替换明细不产生高度抖动；
 * 2. 真实多段上下文分配算法（Largest-Remainder）：系统、提示词、助手、思考链、工具、空闲空间；
 * 3. 真实数据优先，无分段时平滑双色降级，绝不编造虚拟分段。
 */

import type { Component } from "../../core/types.js";
import { C, truncateToWidth } from "../../core/utils.js";

export interface ContextSegments {
	system: number;
	prompt: number;
	assistant: number;
	thinking: number;
	tools: number;
}

export interface ContextUsageData {
	usedTokens?: number;
	contextWindow?: number;
	actual?: boolean;
	cwd?: string;
	cacheRead?: number;
	cacheWrite?: number;
	inputTokens?: number;
	segments?: ContextSegments;
}

export function formatTokensCompact(n: number): string {
	const value = Math.max(0, Math.round(n));
	if (value >= 1000000) return `${(value / 1000000).toFixed(1)}m`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return `${value}`;
}

export function formatCacheHitRate(cacheRead?: number, input?: number, cacheWrite?: number): string | undefined {
	if (input === undefined || cacheRead === undefined) return undefined;
	const cr = cacheRead;
	const inp = input ?? 0;
	const cw = cacheWrite ?? 0;
	const total = inp + cr + cw;
	if (total <= 0 || cr <= 0) return undefined;
	return `${((cr / total) * 100).toFixed(1)}%`;
}

/** Uina 雾蓝终端主题各分段色彩规范 */
export const CONTEXT_SEGMENTS = [
	{ key: "system", color: "\x1b[38;2;70;95;145m", label: "sys" }, // 深海蓝
	{ key: "prompt", color: "\x1b[38;2;90;125;190m", label: "pr" }, // 靛蓝
	{ key: "assistant", color: "\x1b[38;2;74;138;212m", label: "ast" }, // Uina 雾蓝
	{ key: "thinking", color: "\x1b[38;2;155;114;207m", label: "th" }, // 思考紫
	{ key: "tools", color: "\x1b[38;2;46;184;138m", label: "tl" }, // 工具青
] as const;

/**
 * 最大余数算法（Largest-Remainder）：将各段 Token 按比例分配给固定的终端列宽
 * 确保总分配列数精确等于 width，且有 Token 占用的非空段至少分配 1 列（空间充裕时）。
 */
export function allocateBarColumns(values: readonly number[], width: number): number[] {
	if (width <= 0) return values.map(() => 0);
	const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
	if (total <= 0) return values.map(() => 0);

	const visibleIndices = values
		.map((v, idx) => ({ v, idx }))
		.filter((it) => it.v > 0)
		.map((it) => it.idx);

	if (visibleIndices.length >= width) {
		const rawCols = values.map((v) => Math.max(0, (Math.max(0, v) / total) * width));
		const allocated = rawCols.map(Math.floor);
		let rem = width - allocated.reduce((a, b) => a + b, 0);
		const remainders = rawCols
			.map((v, i) => ({ i, r: v - Math.floor(v) }))
			.sort((a, b) => b.r - a.r);
		for (const slot of remainders) {
			if (rem <= 0) break;
			allocated[slot.i]++;
			rem--;
		}
		return allocated;
	}

	const minCols: number[] = values.map((v) => (v > 0 ? 1 : 0));
	const reserved = minCols.reduce((a: number, b: number) => a + b, 0);
	const remainingWidth = width - reserved;

	const rawCols = values.map((v) => Math.max(0, (Math.max(0, v) / total) * remainingWidth));
	const extraCols = rawCols.map(Math.floor);
	let rem = remainingWidth - extraCols.reduce((a, b) => a + b, 0);
	const remainders = rawCols
		.map((v, i) => ({ i, r: v - Math.floor(v) }))
		.sort((a, b) => b.r - a.r);
	for (const slot of remainders) {
		if (rem <= 0) break;
		extraCols[slot.i]++;
		rem--;
	}

	return minCols.map((min, i) => min + extraCols[i]!);
}

/**
 * 渲染上下文比例条：
 * - 当提供真实 segments 且总量有效时，渲染多段彩色分布条；
 * - 当未提供分段数据时，按已用比例平滑渲染单色/双色条，绝不编造虚拟分段。
 */
export function renderSegmentedBar(
	segments: ContextSegments | undefined,
	usedTokens: number | undefined,
	contextWindow: number | undefined,
	width: number,
	pctFallback?: number,
): string {
	if (width <= 0) return "";

	const hasSegments =
		segments &&
		(segments.system > 0 ||
			segments.prompt > 0 ||
			segments.assistant > 0 ||
			segments.thinking > 0 ||
			segments.tools > 0);

	if (hasSegments && contextWindow && contextWindow > 0) {
		const freeTokens = Math.max(0, contextWindow - (usedTokens ?? 0));
		const values = [
			segments.system,
			segments.prompt,
			segments.assistant,
			segments.thinking,
			segments.tools,
			freeTokens,
		];
		const cols = allocateBarColumns(values, width);

		let bar = "";
		for (let i = 0; i < CONTEXT_SEGMENTS.length; i++) {
			const colCount = cols[i] ?? 0;
			if (colCount <= 0) continue;
			const seg = CONTEXT_SEGMENTS[i]!;
			bar += `${seg.color}${"█".repeat(colCount)}${C.reset}`;
		}
		const freeCols = cols[CONTEXT_SEGMENTS.length] ?? 0;
		if (freeCols > 0) {
			bar += `${C.subtle}${"░".repeat(freeCols)}${C.reset}`;
		}
		return bar;
	}

	// 降级单色条
	const pct = pctFallback ?? (usedTokens !== undefined && contextWindow && contextWindow > 0 ? (usedTokens / contextWindow) * 100 : undefined);
	if (pct === undefined) {
		return `${C.subtle}${"?".repeat(width)}${C.reset}`;
	}
	const barColor = pct >= 90 ? C.error : pct >= 80 ? C.warning : C.claude;
	const filledCols = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
	const emptyCols = width - filledCols;
	return `${barColor}${"█".repeat(filledCols)}${C.reset}${C.subtle}${"░".repeat(emptyCols)}${C.reset}`;
}

export class ContextBarComponent implements Component {
	private usedTokens?: number;
	private contextWindow?: number;
	private cwd = "";
	private cacheRead?: number;
	private cacheWrite?: number;
	private inputTokens?: number;
	private segments?: ContextSegments;
	private isHovered = false;
	private visible = true;

	update(data: ContextUsageData): void {
		this.usedTokens = data.usedTokens;
		this.contextWindow = data.contextWindow && data.contextWindow > 0 ? data.contextWindow : undefined;
		this.cwd = data.cwd ?? "";
		this.cacheRead = data.cacheRead;
		this.cacheWrite = data.cacheWrite;
		this.inputTokens = data.inputTokens;
		this.segments = data.segments;
		this.visible = true;
	}

	setHovered(hovered: boolean): boolean {
		if (this.isHovered !== hovered) {
			this.isHovered = hovered;
			return true;
		}
		return false;
	}

	getHovered(): boolean {
		return this.isHovered;
	}

	render(width: number): string[] {
		if (!this.visible || width <= 0) return [""];

		if (!this.isHovered) {
			return [""];
		}

		// 鼠标悬停时：渲染隐藏明细（工作目录 + 剩余容量 + 分段分布 + 缓存与输入）
		const cwdLabel = this.cwd ? `${C.gray}🗀 ${C.dim}${this.cwd}${C.reset}` : "";

		const parts: string[] = [];

		// 1. 剩余容量（底边框已展示“已用/总量 (百分比)”，此处仅透视剩余可用空间，消除重复）
		if (this.contextWindow !== undefined && this.contextWindow > 0 && this.usedTokens !== undefined) {
			const remaining = Math.max(0, this.contextWindow - this.usedTokens);
			parts.push(`${C.suggestion}剩余 ${formatTokensCompact(remaining)}${C.reset}`);
		} else {
			parts.push(`${C.inactive}上下文上限未知${C.reset}`);
		}

		// 2. 上下文各分段分布情况（系统、提示词、助手、思考链、工具）
		if (this.segments) {
			const segTokens: string[] = [];
			if (this.segments.system > 0) segTokens.push(`${CONTEXT_SEGMENTS[0]!.color}系统 ${formatTokensCompact(this.segments.system)}${C.reset}`);
			if (this.segments.prompt > 0) segTokens.push(`${CONTEXT_SEGMENTS[1]!.color}提示 ${formatTokensCompact(this.segments.prompt)}${C.reset}`);
			if (this.segments.assistant > 0) segTokens.push(`${CONTEXT_SEGMENTS[2]!.color}助手 ${formatTokensCompact(this.segments.assistant)}${C.reset}`);
			if (this.segments.thinking > 0) segTokens.push(`${CONTEXT_SEGMENTS[3]!.color}思考 ${formatTokensCompact(this.segments.thinking)}${C.reset}`);
			if (this.segments.tools > 0) segTokens.push(`${CONTEXT_SEGMENTS[4]!.color}工具 ${formatTokensCompact(this.segments.tools)}${C.reset}`);
			if (segTokens.length > 0) {
				parts.push(segTokens.join(` ${C.subtle}·${C.reset} `));
			}
		}

		// 3. 真实缓存与输入明细（大模型 Prompt Caching 真实数据）
		const cacheParts: string[] = [];
		if (this.cacheRead !== undefined && this.cacheRead > 0) {
			cacheParts.push(`缓存读 ${formatTokensCompact(this.cacheRead)}`);
		}
		if (this.cacheWrite !== undefined && this.cacheWrite > 0) {
			cacheParts.push(`缓存写 ${formatTokensCompact(this.cacheWrite)}`);
		}
		if (this.inputTokens !== undefined) {
			cacheParts.push(`输入 ${formatTokensCompact(this.inputTokens)}`);
		}
		if (cacheParts.length > 0) {
			parts.push(`${C.inactive}${cacheParts.join(` · `)}${C.reset}`);
		}

		const body = parts.join(` ${C.subtle}·${C.reset} `);
		let line = "";
		if (cwdLabel) {
			const sep = ` ${C.subtle}──${C.reset} `;
			line = `${cwdLabel}${sep}${body}`;
		} else {
			line = body;
		}

		return [truncateToWidth(line, width, "")];
	}

	invalidate(): void {}
}
