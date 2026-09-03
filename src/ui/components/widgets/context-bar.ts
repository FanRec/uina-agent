/**
 * 上下文用量进度条组件（复刻 dsh-TUI ContextBarView.tsx 核心算法）。
 * 特性：
 * 1. 蓝白分段精细进度条（█ 代表已占用，░ 代表可用空间）；
 * 2. 具备呼吸间距与精致的边缘修剪；
 * 3. 超过 80% 变黄告警，超过 90% 变红危险。
 */

import type { Component } from "../../core/types.js";
import { C, truncateToWidth, visibleWidth } from "../../core/utils.js";

function formatTokens(n: number): string {
	if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${n}`;
}

export class ContextBarComponent implements Component {
	private usedTokens = 0;
	private contextWindow = 64 * 1024; // 默认 64k
	private visible = false;

	update(usedTokens: number, contextWindow?: number): void {
		this.usedTokens = usedTokens;
		if (contextWindow && contextWindow > 0) {
			this.contextWindow = contextWindow;
		}
		this.visible = true;
	}

	hide(): void {
		this.visible = false;
	}

	show(): void {
		this.visible = true;
	}

	render(width: number): string[] {
		if (!this.visible || width < 32 || this.contextWindow <= 0) {
			return [];
		}

		const pct = Math.min(100, Math.max(0, (this.usedTokens / this.contextWindow) * 100));
		const pctStr = `${pct.toFixed(1)}%`;
		const readout = `${formatTokens(this.usedTokens)}/${formatTokens(this.contextWindow)} (${pctStr})`;
		const readoutWidth = visibleWidth(readout);

		// 计算可分配给进度条图形的宽度
		const prefix = "  ctx ";
		const prefixWidth = visibleWidth(prefix);
		const barWidth = Math.max(8, width - prefixWidth - readoutWidth - 3);

		const filledCols = Math.min(barWidth, Math.max(0, Math.round((pct / 100) * barWidth)));
		const emptyCols = barWidth - filledCols;

		// 配色梯度：正常为冰蓝，>=80% 变黄，>=90% 变红
		let barColor = C.iceBlue;
		if (pct >= 90) barColor = C.red;
		else if (pct >= 80) barColor = C.yellow;

		const filledBar = `${barColor}${"█".repeat(filledCols)}${C.reset}`;
		const emptyBar = `${C.gray}${"░".repeat(emptyCols)}${C.reset}`;
		const readoutText = `${C.dim}${readout}${C.reset}`;

		const barLine = `${C.gray}${prefix}${C.reset}${filledBar}${emptyBar} ${readoutText}`;
		return [truncateToWidth(barLine, width)];
	}

	invalidate(): void {}
}
