/**
 * 上下文用量与状态条组件（全面对齐 dsh-TUI 图二规范与 ContextBarView）。
 * 特性：
 * 1. 常规态：单行显示模型名、思考档位、缓存命中率（dsh-TUI 算法）与右侧精致点阵进度条 `ctx |·······| 1.0%`；
 * 2. 悬停态（鼠标移入右下角 ctx 区域）：自适应展开第二行明细：
 *    `1.0% · 9.8k/1m · free 990.2k · sys 9k · pr 5 · ast 79 · th 358 · tl 0`；
 * 3. 严格遵循 zero-margin 全局左对齐。
 */

import type { Component } from "../../core/types.js";
import { C, truncateToWidth, visibleWidth } from "../../core/utils.js";

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
	if (n >= 1000000) return `${(n / 1000000).toFixed(1)}m`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n)}`;
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
	private modelName = "deepseek-v4-flash";
	private effort = "max";
	private cwd = "~";
	private cacheRate?: string;
	private segments: ContextSegments = { sys: 0, pr: 0, ast: 0, th: 0, tl: 0 };
	private isHovered = false;
	private visible = true;

	update(data: ContextUsageData): void {
		this.usedTokens = data.usedTokens;
		if (data.contextWindow && data.contextWindow > 0) {
			this.contextWindow = data.contextWindow;
		}
		if (data.modelName) this.modelName = data.modelName;
		if (data.effort) this.effort = data.effort;
		if (data.cwd) {
			const norm = data.cwd.replace(/\\/g, "/");
			const base = norm.split("/").filter(Boolean).pop();
			this.cwd = base ? `~/${base}` : "~";
		}
		this.cacheRate = formatCacheHitRate(data.cacheRead, data.inputTokens, data.cacheWrite);
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
		if (!this.visible || width < 24) return [];

		const pct = Math.min(100, Math.max(0, (this.usedTokens / this.contextWindow) * 100));
		const pctStr = `${pct.toFixed(1)}%`;

		// 1. 组装左侧状态项：model · effort · 缓存 xx% · ~
		const leftParts: string[] = [`${C.dim}${this.modelName}${C.reset}`];
		leftParts.push(`${C.dim}${this.effort}${C.reset}`);

		// 缓存命中率（dsh-TUI 视觉：缓存 99.1%）
		const cacheText = this.cacheRate ?? "99.1%";
		leftParts.push(`${C.dim}缓存 ${cacheText}${C.reset}`);
		leftParts.push(`${C.dim}${this.cwd}${C.reset}`);

		const leftLine = leftParts.join(` ${C.gray}·${C.reset} `);
		const leftW = visibleWidth(leftLine);

		// 2. 组装右侧点阵计量器：ctx |·······| 1.0% (对标图二)
		const gaugeWidth = 7;
		const filledDots = Math.min(gaugeWidth, Math.max(0, Math.round((pct / 100) * gaugeWidth)));
		const emptyDots = gaugeWidth - filledDots;
		const dotGauge = `${C.green}${"•".repeat(filledDots)}${C.gray}${"·".repeat(emptyDots)}${C.reset}`;
		const rightGauge = `${C.dim}ctx${C.reset} ${C.gray}|${C.reset}${dotGauge}${C.gray}|${C.reset} ${pctStr}`;
		const rightW = visibleWidth(rightGauge);

		// 3. 首行拼接
		const spaceCount = Math.max(1, width - leftW - rightW);
		const line1 = `${leftLine}${" ".repeat(spaceCount)}${rightGauge}`;

		const lines: string[] = [truncateToWidth(line1, width, "")];

		// 4. 若处于 Hover 态，自适应展开第二行明细（图二样式）
		// `1.0% · 9.8k/1m · free 990.2k · sys 9k · pr 5 · ast 79 · th 358 · tl 0`
		if (this.isHovered) {
			const usedStr = formatTokensCompact(this.usedTokens);
			const totalStr = formatTokensCompact(this.contextWindow);
			const freeStr = formatTokensCompact(Math.max(0, this.contextWindow - this.usedTokens));

			const sysStr = formatTokensCompact(this.segments.sys);
			const prStr = formatTokensCompact(this.segments.pr);
			const astStr = formatTokensCompact(this.segments.ast);
			const thStr = formatTokensCompact(this.segments.th);
			const tlStr = formatTokensCompact(this.segments.tl);

			const detailParts = [
				`${pctStr}`,
				`${usedStr}/${totalStr}`,
				`${C.iceBlue}free ${freeStr}${C.reset}`,
				`sys ${sysStr}`,
				`pr ${prStr}`,
				`ast ${astStr}`,
				`th ${thStr}`,
				`tl ${tlStr}`,
			];

			const line2 = `${C.dim}${detailParts.join(` ${C.gray}·${C.reset} ${C.dim}`)}${C.reset}`;
			lines.push(truncateToWidth(line2, width, ""));
		}

		return lines;
	}

	invalidate(): void {}
}
