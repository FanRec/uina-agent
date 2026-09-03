/**
 * 输入框底边下方的稳定信息行。
 *
 * 这行故意始终占一个终端行：静止时为空白，鼠标悬停在输入框底边的
 * 上下文进度区时才把目录、上下文分段和缓存读写明细放进来。这样 Hover
 * 只替换内容，不改变布局高度，鼠标在边框附近移动时不会把聊天内容顶
 * 上下抖动。
 */

import type { Component } from "../../core/types.js";
import { C, truncateToWidth } from "../../core/utils.js";

export interface ContextSegments {
	sys: number;
	pr: number;
	ast: number;
	th: number;
	tl: number;
}

export interface ContextUsageData {
	usedTokens: number;
	contextWindow?: number;
	modelName?: string;
	effort?: string;
	cwd?: string;
	cacheRead?: number;
	cacheWrite?: number;
	inputTokens?: number;
	segments?: Partial<ContextSegments>;
}

export function formatTokensCompact(n: number): string {
	const value = Math.max(0, Math.round(n));
	if (value >= 1000000) return `${(value / 1000000).toFixed(1)}m`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return `${value}`;
}

export function formatCacheHitRate(cacheRead?: number, input?: number, cacheWrite?: number): string | undefined {
	const cr = cacheRead ?? 0;
	const inp = input ?? 0;
	const cw = cacheWrite ?? 0;
	const total = inp + cr + cw;
	if (total <= 0 || cr <= 0) return undefined;
	return `${((cr / total) * 100).toFixed(1)}%`;
}

export class ContextBarComponent implements Component {
	private usedTokens = 0;
	private contextWindow = 1024 * 1024; // 默认 1.0M
	private cwd = "~";
	private segments: ContextSegments = { sys: 0, pr: 0, ast: 0, th: 0, tl: 0 };
	private cacheRead?: number;
	private cacheWrite?: number;
	private inputTokens?: number;
	private isHovered = false;
	private visible = true;

	update(data: ContextUsageData): void {
		this.usedTokens = data.usedTokens;
		if (data.contextWindow && data.contextWindow > 0) {
			this.contextWindow = data.contextWindow;
		}
		if (data.cwd) {
			this.cwd = data.cwd;
		}
		this.cacheRead = data.cacheRead;
		this.cacheWrite = data.cacheWrite;
		this.inputTokens = data.inputTokens;
		if (data.segments) {
			this.segments = {
				sys: data.segments.sys ?? this.segments.sys,
				pr: data.segments.pr ?? this.segments.pr,
				ast: data.segments.ast ?? this.segments.ast,
				th: data.segments.th ?? this.segments.th,
				tl: data.segments.tl ?? this.segments.tl,
			};
		}
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
		// 即使终端很窄也保留这个布局槽位；调用方依赖它来保证输入框
		// 下方的稳定一行不会因宽度变化而消失。
		if (!this.visible || width <= 0) return [""];

		// 未悬停时：渲染 1 行纯空白占位，确保无论 hover 与否，高度恒定为 1 行。
		if (!this.isHovered) {
			return [""];
		}

		// 鼠标悬停时：在此固定行内渲染隐藏信息：目录 + 上下文占用 + 使用情况。
		const pct = Math.min(100, Math.max(0, (this.usedTokens / this.contextWindow) * 100));
		const pctStr = `${pct.toFixed(1)}%`;
		const usedStr = formatTokensCompact(this.usedTokens);
		const totalStr = formatTokensCompact(this.contextWindow);
		const freeStr = formatTokensCompact(Math.max(0, this.contextWindow - this.usedTokens));

		const sysStr = formatTokensCompact(this.segments.sys);
		const prStr = formatTokensCompact(this.segments.pr);
		const astStr = formatTokensCompact(this.segments.ast);
		const thStr = formatTokensCompact(this.segments.th);
		const tlStr = formatTokensCompact(this.segments.tl);

		// 目录徽章：宽屏完整路径，窄屏短路径
		const cwdLabel = this.cwd ? `${C.gray}🗀 ${C.dim}${this.cwd}${C.reset}` : "";

		// 上下文占用详情
		const detailParts = [
			`${pctStr}`,
			`${usedStr}/${totalStr}`,
			`${C.suggestion}剩余 ${freeStr}${C.reset}`,
			`系统 ${sysStr}`,
			`提示词 ${prStr}`,
			`助手 ${astStr}`,
			`思考 ${thStr}`,
			`工具 ${tlStr}`,
		];
		const usageDetail = `${C.inactive}${detailParts.join(` ${C.subtle}·${C.reset} ${C.inactive}`)}${C.reset}`;
		const cacheDetail =
			this.cacheRead !== undefined || this.cacheWrite !== undefined || this.inputTokens !== undefined
				? ` ${C.subtle}·${C.reset} ${C.inactive}缓存读 ${formatTokensCompact(this.cacheRead ?? 0)} · 缓存写 ${formatTokensCompact(this.cacheWrite ?? 0)} · 输入 ${formatTokensCompact(this.inputTokens ?? 0)}${C.reset}`
				: "";

		let line = "";
		if (cwdLabel) {
			const sep = ` ${C.subtle}──${C.reset} `;
			line = `${cwdLabel}${sep}${usageDetail}${cacheDetail}`;
		} else {
			line = `${usageDetail}${cacheDetail}`;
		}

		return [truncateToWidth(line, width, "")];
	}

	invalidate(): void {}
}
