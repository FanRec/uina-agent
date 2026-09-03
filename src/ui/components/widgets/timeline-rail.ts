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

export interface TimelineRailGeometry {
	windowStart: number;
	windowEnd: number;
	shown: number;
	upRow: number;
	tickTop: number;
	downRow: number;
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

	getHoverTurnN(): number | null {
		return this.hoverTurnN;
	}

	getGeometry(height: number, atBottom = true): TimelineRailGeometry | null {
		if (height < 3 || this.turns.length === 0 || !this.enabled) return null;
		const turnCount = this.turns.length;
		const maxTicks = Math.max(1, height - 2);
		const shown = Math.min(turnCount, maxTicks);

		// 对标 dsh-TUI computeRailGeometry 动态滑动窗口：
		// 当轮次数超过可用刻度行时，窗口锚定在当前活跃轮次附近（如果在底部则偏向尾部）
		let start = 0;
		if (turnCount > maxTicks) {
			const tailStart = turnCount - maxTicks;
			const activeIdx = this.activeTurnN !== null
				? this.turns.findIndex((t) => t.n === this.activeTurnN)
				: -1;
			const anchor = activeIdx >= 0 ? activeIdx : turnCount - 1;
			start = atBottom
				? Math.min(anchor, tailStart)
				: Math.min(Math.max(0, anchor - Math.floor(maxTicks / 2)), tailStart);
		}

		// 对标 dsh-TUI：将 ▲ + Ticks + ▼ 居中悬浮于视口垂直中央
		const blockTop = Math.max(0, Math.floor((height - (shown + 2)) / 2));
		return {
			windowStart: start,
			windowEnd: start + shown,
			shown,
			upRow: blockTop,
			tickTop: blockTop + 1,
			downRow: blockTop + 1 + shown,
		};
	}

	/**
	 * 获取指定行对应的点击目标信息
	 */
	getClickTarget(relRow: number, height: number): TimelineRailClickTarget | null {
		const geo = this.getGeometry(height);
		if (!geo) return null;
		if (relRow === geo.upRow) return { type: "up", row: geo.upRow };
		if (relRow === geo.downRow) return { type: "down", row: geo.downRow };
		if (relRow >= geo.tickTop && relRow < geo.downRow) {
			const idx = relRow - geo.tickTop;
			const turn = this.turns[geo.windowStart + idx];
			if (turn) {
				return { type: "tick", turnN: turn.n, row: relRow };
			}
		}
		return null;
	}

	/**
	 * 为转录区的每一行渲染对应的右侧 2 列导航轨，并在悬停时生成左侧迷你预览卡片
	 * 视觉规范 100% 严格对标 dsh-TUI (src/components/TimelineRail.tsx):
	 *   - CHEVRON_UP = ' ▴', CHEVRON_DOWN = ' ▾'
	 *   - TICK_ACTIVE = '━━', TICK_HOVER = '──', TICK_IDLE = ' ─'
	 *   - 颜色：活跃/悬停 = C.text (#E8E6E0), 闲置刻度 = C.inactive (#8D95A6),
	 *          Chevron 启用 = C.inactive / 禁用 = C.subtle / 悬停 = C.text
	 */
	renderRailRows(height: number, atBottom = true): { railGlyphs: string[]; previewCard?: { topRow: number; lines: string[] } } {
		const railGlyphs: string[] = new Array(height).fill("  ");
		const geo = this.getGeometry(height, atBottom);
		if (!geo) {
			return { railGlyphs };
		}

		// 顶/底 Chevron 箭头（始终清晰可见，不再因暗色导致黑成一片看不到）
		const isUpHovered = this.hoverRow === geo.upRow;
		const isDownHovered = this.hoverRow === geo.downRow;
		const upColor = isUpHovered ? `${C.bold}${C.text}` : C.inactive;
		const downColor = isDownHovered ? `${C.bold}${C.text}` : C.inactive;
		railGlyphs[geo.upRow] = `${upColor} ▴${C.reset}`;
		railGlyphs[geo.downRow] = `${downColor} ▾${C.reset}`;

		// 2. 映射中间刻度（Ticks）
		let hoveredTurn: TimelineRailTurn | null = null;
		let hoveredTurnRow = -1;

		for (let k = 0; k < geo.shown; k++) {
			const index = geo.windowStart + k;
			const turn = this.turns[index]!;
			const r = geo.tickTop + k;

			const isActive = this.activeTurnN === turn.n;
			const isHovered = this.hoverRow === r || this.hoverTurnN === turn.n;

			if (isHovered) {
				hoveredTurn = turn;
				hoveredTurnRow = r;
			}

			if (isActive) {
				// 活跃刻度：'━━'，颜色为 text (#E8E6E0)，醒目明亮（对标 dsh-TUI TICK_ACTIVE）
				railGlyphs[r] = `${C.text}━━${C.reset}`;
			} else if (isHovered) {
				// 悬停刻度：'──'，颜色为 suggestion 冰蓝高亮（对标 dsh-TUI TICK_HOVER）
				railGlyphs[r] = `${C.suggestion}──${C.reset}`;
			} else {
				// 闲置刻度：' ─'，右对齐短横线，颜色为 inactive (#8D95A6)，清晰柔和（对标 dsh-TUI TICK_IDLE）
				railGlyphs[r] = `${C.inactive} ─${C.reset}`;
			}
		}

		// 3. 悬停气泡卡片生成（严格对标 dsh-TUI：圆角边框、柔和白字、舒适内边距）
		let previewCard: { topRow: number; lines: string[] } | undefined;
		if (hoveredTurn && hoveredTurnRow >= 0) {
			const rawSnippet = hoveredTurn.userText.replace(/[\r\n]+/g, " ").trim();
			const snippet = truncateToWidth(rawSnippet || `轮次 ${hoveredTurn.n}`, 24, "…");
			const snippetW = visibleWidth(snippet);
			const boxInnerW = Math.max(4, snippetW);
			const padL = Math.floor((boxInnerW - snippetW) / 2);
			const padR = boxInnerW - snippetW - padL;

			const bCol = C.promptBorder;
			const top = `${bCol}╭${"─".repeat(boxInnerW + 2)}╮${C.reset}`;
			const mid = `${bCol}│${C.reset} ${" ".repeat(padL)}${C.text}${snippet}${C.reset}${" ".repeat(padR)} ${bCol}│${C.reset}`;
			const bot = `${bCol}╰${"─".repeat(boxInnerW + 2)}╯${C.reset}`;

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
