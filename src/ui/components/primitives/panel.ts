/**
 * 居中面板（Dashboard / Overlay）共享的框线与列表原语。
 *
 * 之前边框、滑动窗口、尾部分片在 task-dashboard、subagent-dashboard、trajectory-scene
 * 等 7 处各自手写，宽度魔数与补空规则逐份漂移。这里只有一套几何：
 * 所有函数保证输出逐字节与原实现一致，调用方只提供内容与数据。
 */

import { C, visibleWidth, truncateToWidth } from "../../core/utils.js";

export interface PanelGeometry {
	boxWidth: number;
	innerW: number;
	borderCol: string;
}

/** 统一的居中面板几何：54–96 列夹取，内宽 = 盒宽 - 4（两侧 "│ " 与 " │"）。 */
export function panelGeometry(terminalWidth: number): PanelGeometry {
	const boxWidth = Math.max(54, Math.min(terminalWidth - 6, 96));
	return { boxWidth, innerW: boxWidth - 4, borderCol: C.gray };
}

/** 顶边框：╭─ 标题 ───╮（titleTag 形如 "─ 标题 (统计) "，由调用方组装语义） */
export function panelTopLine(geo: PanelGeometry, titleTag: string): string {
	const fill = Math.max(1, geo.boxWidth - 2 - visibleWidth(titleTag));
	return `  ${geo.borderCol}╭${titleTag}${"─".repeat(fill)}╮${C.reset}`;
}

/** 内容行：│ 文本 补空 │。与原实现一致：超宽不截断（截断由调用方负责），补空取 0。 */
export function panelRow(geo: PanelGeometry, content: string): string {
	const pad = Math.max(0, geo.innerW - visibleWidth(content));
	return `  ${geo.borderCol}│${C.reset} ${content}${" ".repeat(pad)} ${geo.borderCol}│${C.reset}`;
}

/** 分割线：├────┤；带标签时 ├─ 标签 ──┤ */
export function panelDivider(geo: PanelGeometry, tag?: string): string {
	if (tag === undefined) {
		return `  ${geo.borderCol}├${"─".repeat(geo.boxWidth - 2)}┤${C.reset}`;
	}
	const fill = Math.max(1, geo.boxWidth - 2 - visibleWidth(tag));
	return `  ${geo.borderCol}├${tag}${"─".repeat(fill)}┤${C.reset}`;
}

/** 空态面板：顶框（带标题）+ 一行说明 + 底框。 */
export function panelEmpty(geo: PanelGeometry, titleTag: string, emptyText: string): string[] {
	return [
		panelTopLine(geo, titleTag),
		panelRow(geo, emptyText),
		`  ${geo.borderCol}╰${"─".repeat(geo.boxWidth - 2)}╯${C.reset}`,
	];
}

/** 底边框：╰─ 提示 ──╯ */
export function panelBottomLine(geo: PanelGeometry, hint: string): string {
	const fill = Math.max(1, geo.boxWidth - 2 - visibleWidth(hint) - 2);
	return `  ${geo.borderCol}╰─ ${C.dim}${hint}${C.reset} ${geo.borderCol}${"─".repeat(fill)}╯${C.reset}`;
}

/**
 * 列表滑动窗口：选中项尽量居中，窗口不越界。
 * 同一公式原先在 4 处独立维护。
 */
export function panelWindow(length: number, selectedIndex: number, maxVisible: number): { start: number; end: number } {
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), Math.max(0, length - maxVisible)));
	return { start, end: Math.min(length, start + maxVisible) };
}

/**
 * 日志/输出尾部切片：从末尾按 scrollOffset 上卷，不足 maxRows 补空行。
 * maxWidth 给定时逐行截断（与原 sliceLogs 一致）。
 */
export function panelTailSlice(lines: string[], maxRows: number, scrollOffset: number, maxWidth?: number): string[] {
	if (lines.length === 0) {
		return [`${C.dim}(暂无输出日志)${C.reset}`];
	}
	const end = Math.max(0, lines.length - scrollOffset);
	const start = Math.max(0, end - maxRows);
	const sliced = lines.slice(start, end);
	while (sliced.length < maxRows) {
		sliced.push("");
	}
	return maxWidth === undefined ? sliced : sliced.map((l) => truncateToWidth(l, maxWidth));
}
