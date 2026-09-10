/**
 * 视口比例滚动条组件（严格复刻 dsh-TUI ScrollbarGutter 规范）。
 *
 * 特性：
 * 1. 占转录区最右侧 2 列宽；
 * 2. 拇指滑块（Thumb）以实心 '██' 字符显示当前可见视口在整个内容中的位置与大小：
 *    - thumbH = max(2, round(viewport² / content))
 *    - trackH = max(1, viewport - thumbH)
 *    - thumbTop = round((scrollTop / maxScroll) * trackH)
 * 3. 单击轨道任意行快速定位跳转：点击行映射回 scrollTop 并平滑滚动；
 * 4. 悬停防抖气泡片（Position Chip）：指针在滚动条停留约 250ms 时向左侧浮现
 *    '62% · 340/540' 位置提示卡片；
 * 5. 纯净 ANSI 渲染与 noSelect 保护：与 MouseSelectionTracker 结合，划词复制绝不拾取滚动条。
 */

import type { Component } from "../../core/types.js";
import { C } from "../../core/utils.js";

export type ScrollbarThumbStyle = "slim" | "block" | "wide";

export const SCROLLBAR_THUMB_GLYPHS: Record<ScrollbarThumbStyle, string> = {
	slim: " ▐", // 精致纤细现代风（宽 0.5 列，紧贴终端右边沿，雅致内敛绝不碍眼）
	block: " █", // 单列紧凑实心方块（宽 1 列）
	wide: "██", // 双列宽幅实心方块（宽 2 列，dsh-TUI 原始粗方块）
};

export const SCROLLBAR_THUMB = " ▐";
export const SCROLLBAR_DWELL_MS = 250;

export interface ScrollbarGeometry {
	viewport: number;
	content: number;
	maxScroll: number;
	thumbH: number;
	trackH: number;
	thumbTop: number;
	thumbBottom: number;
}

export interface ScrollbarChip {
	topRow: number;
	lines: string[];
}

export class ScrollbarGutterComponent implements Component {
	private hoverRow: number | null = null;
	private chipRow: number | null = null;
	private dwellTimer: NodeJS.Timeout | null = null;
	private enabled = true;
	private thumbStyle: ScrollbarThumbStyle = "slim";

	setThumbStyle(style: ScrollbarThumbStyle): void {
		this.thumbStyle = style;
	}

	getThumbStyle(): ScrollbarThumbStyle {
		return this.thumbStyle;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	setHover(row: number | null): boolean {
		if (this.hoverRow === row) return false;
		this.hoverRow = row;

		if (this.dwellTimer) {
			clearTimeout(this.dwellTimer);
			this.dwellTimer = null;
		}

		if (row !== null) {
			if (this.chipRow !== null) {
				// 已经开启气泡，随鼠标立即滑动更新
				this.chipRow = row;
			} else {
				// 防抖 250ms 后弹出气泡，防止扫过时闪烁
				this.dwellTimer = setTimeout(() => {
					this.chipRow = this.hoverRow;
				}, SCROLLBAR_DWELL_MS);
			}
		} else {
			this.chipRow = null;
		}

		return true;
	}

	getHoverRow(): number | null {
		return this.hoverRow;
	}

	clearHover(): void {
		if (this.dwellTimer) {
			clearTimeout(this.dwellTimer);
			this.dwellTimer = null;
		}
		this.hoverRow = null;
		this.chipRow = null;
	}

	/**
	 * 计算滚动条几何数据（视口、内容总量、滑块位置与尺寸）
	 */
	computeGeometry(viewport: number, content: number, contentScrollTop: number): ScrollbarGeometry | null {
		if (viewport < 2 || content <= viewport || !this.enabled) return null;

		const maxScroll = Math.max(1, content - viewport);
		const safeTop = Math.max(0, Math.min(maxScroll, contentScrollTop));

		// 视口在全量内容中的映射高度（至少 2 行以保证始终可见易点）
		const thumbH = Math.max(2, Math.min(viewport, Math.round((viewport * viewport) / content)));
		const trackH = Math.max(1, viewport - thumbH);
		const thumbTop = Math.round((safeTop / maxScroll) * trackH);
		const thumbBottom = Math.min(viewport, thumbTop + thumbH);

		return {
			viewport,
			content,
			maxScroll,
			thumbH,
			trackH,
			thumbTop,
			thumbBottom,
		};
	}

	/**
	 * 讲点击的行映射回 contentScrollTop
	 */
	mapRowToScrollTop(y: number, geo: ScrollbarGeometry): number {
		if (y <= 0) return 0;
		if (y >= geo.trackH) return geo.maxScroll;
		return Math.round((y / geo.trackH) * geo.maxScroll);
	}

	/**
	 * 渲染整列滚动条行（2列宽）及悬浮位置气泡卡片
	 */
	renderGutterRows(
		viewport: number,
		content: number,
		contentScrollTop: number,
	): { gutterGlyphs: string[]; hoverChip?: ScrollbarChip } {
		const glyphs: string[] = new Array(viewport).fill("  ");
		const geo = this.computeGeometry(viewport, content, contentScrollTop);
		if (!geo) {
			return { gutterGlyphs: glyphs };
		}

		for (let y = 0; y < viewport; y++) {
			const inThumb = y >= geo.thumbTop && y < geo.thumbBottom;
			if (inThumb) {
				const isHovered = this.hoverRow !== null && this.hoverRow >= geo.thumbTop && this.hoverRow < geo.thumbBottom;
				// 闲置时使用 subtle 适度弱化的蓝灰，绝不突兀碍眼；悬停时点亮 claude 雾蓝
				const thumbColor = isHovered ? C.claude : C.subtle;
				const glyph = SCROLLBAR_THUMB_GLYPHS[this.thumbStyle] ?? SCROLLBAR_THUMB;
				glyphs[y] = `${thumbColor}${glyph}${C.reset}`;
			} else {
				glyphs[y] = "  ";
			}
		}

		// 悬停气泡片（Position Chip）：严格对标 dsh-TUI 悬浮徽标
		let hoverChip: ScrollbarChip | undefined;
		const activeChipRow = this.chipRow ?? (this.hoverRow !== null ? this.hoverRow : null);
		if (activeChipRow !== null && geo.maxScroll > 0 && activeChipRow >= 0 && activeChipRow < viewport) {
			const jumpTop = this.mapRowToScrollTop(activeChipRow, geo);
			const pct = Math.round((jumpTop / geo.maxScroll) * 100);
			const line = Math.min(content, jumpTop + 1);
			const label = `${pct}% · ${line}/${content}`;

			// 采用精美 1 行内嵌卡片底色（对标 dsh-TUI Box toolCardBackgroundDim）
			const chipLine = `${C.toolCardBackgroundDim}${C.text} ${label} ${C.reset}`;
			hoverChip = {
				topRow: activeChipRow,
				lines: [chipLine],
			};
		}

		return { gutterGlyphs: glyphs, hoverChip };
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {}
}
