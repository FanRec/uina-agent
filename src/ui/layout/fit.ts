/**
 * TUI Surface 唯一的显示宽度截断与折行入口。
 *
 * 组件不得自行实现"把一行放进 N 列"：截断、折行、省略、测量全部走本模块。
 * 布局是终端几何，只属于 Surface——Presentation Core 不提供也不复用这些函数。
 */

import { C, CELL_ANSI, CELL_TAB, scanCells, visibleWidth } from "../core/utils.js";

/** 截断策略：ellipsis 带省略号；clip 精确裁切不加标记；middle-ellipsis 两端保留。 */
export type FitPolicy = "ellipsis" | "clip" | "middle-ellipsis";

function tabAdvance(currentColumn: number): number {
	return 8 - (currentColumn % 8);
}

/** 当前活跃的 SGR 代码集合：换行与截断后续接样式时按序重放。 */
type SgrState = string[];

function applySgr(code: string, active: SgrState): void {
	if (code === C.reset) {
		active.length = 0;
		return;
	}
	if (code.endsWith("m")) {
		const index = active.indexOf(code);
		if (index >= 0) active.splice(index, 1);
		active.push(code);
	}
}

function replaySgr(active: SgrState): string {
	return active.join("");
}

/**
 * 唯一允许的显示宽度截断入口；输出宽度 <= width，SGR 序列完整保留。
 * 省略号继承被截断处仍活跃的 SGR，不再"省略号前 reset"丢色。
 */
export function fitLine(line: string, width: number, policy: FitPolicy = "ellipsis"): string {
	if (width <= 0) return "";
	if (!line || visibleWidth(line) <= width) return line;
	switch (policy) {
		case "clip":
			return cutToWidth(line, width, "", "");
		case "ellipsis":
			return cutToWidth(line, width, "…", replaySgr(activeSgrAtCut(line, width)));
		case "middle-ellipsis":
			return middleEllipsis(line, width);
	}
}

/** 两端保留、中段省略：用于 cwd、长 ID 等首尾都有信息量的文本。 */
export function middleEllipsis(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const ellipsis = "…";
	const budget = width - visibleWidth(ellipsis);
	if (budget < 2) return cutToWidth(text, width, "", "");

	const headBudget = Math.ceil(budget / 2);
	const tailBudget = budget - headBudget;

	const active: SgrState = [];
	let headCut = 0;
	let col = 0;
	scanCells(text, (start, end, w) => {
		if (w === CELL_ANSI) {
			applySgr(text.slice(start, end), active);
			headCut = end;
			return;
		}
		const cw = w === CELL_TAB ? tabAdvance(col) : w;
		if (col + cw > headBudget) return false;
		col += cw;
		headCut = end;
	});

	// 尾段从右往左找满足 tailBudget 的切割点
	const tailStart = findTailStart(text, tailBudget);
	const head = text.slice(0, headCut);
	const tail = tailStart < text.length ? text.slice(tailStart) : "";
	return `${head}${replaySgr(active)}${ellipsis}${C.reset}${tail}`;
}

function findTailStart(text: string, budget: number): number {
	let col = 0;
	let lastFitted = text.length;
	const cuts: { index: number; col: number }[] = [];
	scanCells(text, (_start, end, w) => {
		if (w === CELL_ANSI) return;
		cuts.push({ index: end, col: col + w });
		col += w === CELL_TAB ? tabAdvance(col) : w;
	});
	for (let i = cuts.length - 1; i >= 0; i--) {
		const total = col - cuts[i]!.col;
		if (total <= budget) {
			lastFitted = cuts[i]!.index;
			break;
		}
	}
	return lastFitted;
}

/** 截断到 width：marker 为空即 clip；style 是截断点处需续接的 SGR（省略号继承用）。 */
function cutToWidth(text: string, width: number, marker: string, style: string): string {
	const markerW = marker ? visibleWidth(marker) : 0;
	if (width < markerW) return cutToWidth(text, width, "", "");
	const target = width - markerW;

	let cut = 0;
	let curWidth = 0;
	scanCells(text, (_start, end, w) => {
		if (w === CELL_ANSI) {
			cut = end;
			return;
		}
		const cw = w === CELL_TAB ? tabAdvance(curWidth) : w;
		if (curWidth + cw > target) return false;
		curWidth += cw;
		cut = end;
	});
	const styleTail = marker && style ? style : "";
	// clip 也要闭合 SGR：截断点前若开过样式，残留会让同行后续内容（补位、rail）继承染色。
	const balance = !marker && text.slice(0, cut).includes("\x1b") ? C.reset : "";
	return `${text.slice(0, cut)}${styleTail}${marker}${marker || balance ? C.reset : ""}`;
}

/** 截断点处仍活跃的 SGR 集合（供省略号继承）。 */
function activeSgrAtCut(text: string, width: number): SgrState {
	const active: SgrState = [];
	const ellW = visibleWidth("…");
	const target = Math.max(0, width - ellW);
	let curWidth = 0;
	scanCells(text, (start, end, w) => {
		if (w === CELL_ANSI) {
			applySgr(text.slice(start, end), active);
			return;
		}
		const cw = w === CELL_TAB ? tabAdvance(curWidth) : w;
		if (curWidth + cw > target) return false;
		curWidth += cw;
	});
	return active;
}

/**
 * ANSI 安全折行：按显示宽度折成多行，行间续接全部活跃 SGR（旧实现只保留最后一个
 * SGR，粗体+着色会在换行点掉一半样式）。续接行的宽度同样 <= maxWidth。
 */
export function wrapLine(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [text];
	const lines = text.split("\n");
	const output: string[] = [];

	let active: SgrState = [];

	const push = (content: string, withStyle: boolean): void => {
		const styled = withStyle && active.length > 0 ? `${replaySgr(active)}${content}` : content;
		output.push(active.length > 0 && !styled.endsWith(C.reset) ? `${styled}${C.reset}` : styled);
	};

	for (const rawLine of lines) {
		if (visibleWidth(rawLine) <= maxWidth) {
			push(rawLine, true);
			scanCells(rawLine, (start, end, w) => {
				if (w === CELL_ANSI) applySgr(rawLine.slice(start, end), active);
			});
			continue;
		}

		let lineStart = 0;
		let curWidth = 0;
		scanCells(rawLine, (start, end, w) => {
			if (w === CELL_ANSI) {
				applySgr(rawLine.slice(start, end), active);
				return;
			}
			const cw = w === CELL_TAB ? tabAdvance(curWidth) : w;
			if (curWidth + cw > maxWidth) {
				push(rawLine.slice(lineStart, start), true);
				// 折断单元作为新行首单元计入预算，新行宽度同样 <= maxWidth
				lineStart = start;
				curWidth = cw;
				return;
			}
			curWidth += cw;
		});
		if (lineStart < rawLine.length) push(rawLine.slice(lineStart), true);
	}

	return output;
}

/** 显示宽度测量：fit/wrap 的配对读数，组件统一从这里取宽度口径。 */
export function measure(line: string): number {
	return visibleWidth(line);
}
