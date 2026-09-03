/**
 * 会话时间线导航轨组件（复刻 dsh-TUI 图一 TimelineRail 规范）。
 * 特性：
 * 1. 占转录区最右侧 2 列宽；
 * 2. 顶端 ▲ 与底端 ▼ 步进按钮；
 * 3. 对应对话轮次的刻度线（Tick）：当前可见轮 ━━，悬停 ──，闲置  ─；
 * 4. 鼠标悬停在 Tick 时，向左侧浮现迷你预览卡片（╭────╮\n│ 文本 │\n╰────╯）；
 * 5. 单击 Tick 瞬间跳转至对应对话轮次；
 * 6. 全轨具备 noSelect 保护，划词复制决不拾取导航轨字符。
 */

import type { Component } from "../../core/types.js";
import { C, truncateToWidth, visibleWidth } from "../../core/utils.js";

export interface TimelineRailTurn {
	n: number;
	userText: string;
}

export interface TimelineRailClickTarget {
	type: "tick" | "up" | "down";
	turnN?: number;
	row: number;
}

export class TimelineRailComponent implements Component {
	private turns: TimelineRailTurn[] = [];
	private activeTurnN: number | null = null;
	private hoverTurnN: number | null = null;
	private hoverRow: number | null = null;
	private enabled = true;

	updateTurns(turns: readonly TimelineRailTurn[], activeTurnN: number | null): void {
		this.turns = [...turns];
		this.activeTurnN = activeTurnN;
	}

	setHover(row: number | null): boolean {
		if (this.hoverRow !== row) {
			this.hoverRow = row;
			return true;
		}
		return false;
	}

	getHoverRow(): number | null {
		return this.hoverRow;
	}

	setHoverTurnN(turnN: number | null): void {
		this.hoverTurnN = turnN;
	}

	/**
	 * 获取指定行对应的点击目标信息
	 */
	getClickTarget(relRow: number, height: number): TimelineRailClickTarget | null {
		if (height < 3 || this.turns.length === 0) return null;
		if (relRow === 0) return { type: "up", row: 0 };
		if (relRow === height - 1) return { type: "down", row: height - 1 };

		const trackHeight = height - 2;
		const turnCount = this.turns.length;
		if (turnCount === 1) {
			return { type: "tick", turnN: this.turns[0]!.n, row: 1 };
		}

		// 映射 relRow - 1 到对应 turn
		const tickIdx = Math.round(((relRow - 1) / Math.max(1, trackHeight - 1)) * (turnCount - 1));
		const turn = this.turns[tickIdx];
		if (turn) {
			return { type: "tick", turnN: turn.n, row: relRow };
		}
		return null;
	}

	/**
	 * 为转录区的每一行渲染对应的右侧 2 列导航轨，并在悬停时生成左侧迷你预览卡片
	 */
	renderRailRows(height: number): { railGlyphs: string[]; previewCard?: { topRow: number; lines: string[] } } {
		const railGlyphs: string[] = new Array(height).fill("  ");
		if (height < 3 || this.turns.length === 0 || !this.enabled) {
			return { railGlyphs };
		}

		// 1. 顶/底 Chevron 箭头
		railGlyphs[0] = ` ${C.dim}▲${C.reset}`;
		railGlyphs[height - 1] = ` ${C.dim}▼${C.reset}`;

		// 2. 映射中间刻度（Ticks）
		const trackHeight = height - 2;
		const turnCount = this.turns.length;
		let hoveredTurn: TimelineRailTurn | null = null;
		let hoveredTurnRow = -1;

		for (let i = 0; i < turnCount; i++) {
			const turn = this.turns[i]!;
			const r = turnCount === 1
				? 1
				: 1 + Math.round((i / (turnCount - 1)) * (trackHeight - 1));

			const isActive = this.activeTurnN === turn.n;
			const isHovered = this.hoverRow === r || this.hoverTurnN === turn.n;

			if (isHovered) {
				hoveredTurn = turn;
				hoveredTurnRow = r;
			}

			if (isActive) {
				railGlyphs[r] = `${C.bold}${C.glowWhite}━━${C.reset}`;
			} else if (isHovered) {
				railGlyphs[r] = `${C.iceBlue}──${C.reset}`;
			} else {
				railGlyphs[r] = ` ${C.gray}─${C.reset}`;
			}
		}

		// 3. 悬停气泡卡片生成（图一样式：╭────╮\n│ 嗯 │\n╰────╯）
		let previewCard: { topRow: number; lines: string[] } | undefined;
		if (hoveredTurn && hoveredTurnRow >= 0) {
			const rawSnippet = hoveredTurn.userText.replace(/[\r\n]+/g, " ").trim();
			const snippet = truncateToWidth(rawSnippet || "会话", 12, "…");
			const snippetW = visibleWidth(snippet);
			const boxInnerW = Math.max(2, snippetW);
			const padL = Math.floor((boxInnerW - snippetW) / 2);
			const padR = boxInnerW - snippetW - padL;

			const top = `${C.dim}╭${"─".repeat(boxInnerW + 2)}╮${C.reset}`;
			const mid = `${C.dim}│${C.reset} ${" ".repeat(padL)}${C.bold}${snippet}${C.reset}${" ".repeat(padR)} ${C.dim}│${C.reset}`;
			const bot = `${C.dim}╰${"─".repeat(boxInnerW + 2)}╯${C.reset}`;

			const idealTop = Math.max(0, Math.min(height - 3, hoveredTurnRow - 1));
			previewCard = {
				topRow: idealTop,
				lines: [top, mid, bot],
			};
		}

		return { railGlyphs, previewCard };
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {}
}
