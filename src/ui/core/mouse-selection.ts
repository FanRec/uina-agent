/**
 * 终端 SGR 鼠标选区与滚轮跟踪器（复刻 dsh-TUI 选中即复制与平滑滚动）。
 * 特性：
 * 1. 准确解析 CSI < btn;col;row M/m 扩展鼠标序列；
 * 2. 滚轮事件（btn=64/65）直接路由为视口滚动，杜绝污染输入框；
 * 3. 拖拽鼠标高亮选区，松开鼠标（Mouse Up）自动提取纯文本并触发复制回调；
 * 4. 实时反色/高亮渲染选区文字。
 */

import { stripAnsi, visibleWidth, charWidth, extractAnsiCode } from "./utils.js";

export interface Point {
	col: number; // 0-indexed 列坐标
	row: number; // 0-indexed 行坐标
}

export interface MouseEventResult {
	handled: boolean;
	wheelDelta?: number; // 负数向上滚动，正数向下滚动
	needRender?: boolean;
}

export class MouseSelectionTracker {
	private anchor: Point | null = null;
	private focus: Point | null = null;
	private isDragging = false;

	hasSelection(): boolean {
		if (!this.anchor || !this.focus) return false;
		return this.anchor.row !== this.focus.row || this.anchor.col !== this.focus.col;
	}

	clear(): void {
		this.anchor = null;
		this.focus = null;
		this.isDragging = false;
	}

	/**
	 * 解析终端输入流中的 SGR 鼠标事件（CSI < btn;col;row M/m）
	 */
	handleInput(
		data: string,
		rows: readonly string[],
		onCopy?: (text: string) => void,
	): MouseEventResult {
		// SGR 格式：\x1b[<btn;col;row(M|m)
		const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
		if (!match) return { handled: false };

		const btn = parseInt(match[1]!, 10);
		const col = parseInt(match[2]!, 10) - 1; // 转为 0 索引
		const row = parseInt(match[3]!, 10) - 1;
		const action = match[4]!; // M: 按下/移动/滚轮, m: 释放

		// 1. 滚轮事件处理（64: 向上, 65: 向下）
		if (btn === 64 && action === "M") {
			return { handled: true, wheelDelta: -3 };
		}
		if (btn === 65 && action === "M") {
			return { handled: true, wheelDelta: 3 };
		}

		// 2. 左键按下（btn 0, action 'M'）
		if (btn === 0 && action === "M") {
			this.anchor = { col, row };
			this.focus = { col, row };
			this.isDragging = true;
			return { handled: true, needRender: true };
		}

		// 3. 左键拖拽（btn 32, action 'M'）
		if ((btn === 32 || btn === 0) && action === "M" && this.isDragging) {
			this.focus = { col, row };
			return { handled: true, needRender: true };
		}

		// 4. 左键释放（action 'm'）
		if (action === "m" && this.isDragging) {
			this.focus = { col, row };
			this.isDragging = false;

			if (this.hasSelection() && onCopy) {
				const selectedText = this.extractSelectedText(rows);
				if (selectedText && selectedText.trim()) {
					onCopy(selectedText);
				}
			}
			this.clear();
			return { handled: true, needRender: true };
		}

		return { handled: true };
	}

	/**
	 * 从当前终端全屏帧中提取选中范围内的纯文本
	 */
	extractSelectedText(rows: readonly string[]): string {
		if (!this.anchor || !this.focus) return "";

		const [start, end] = this.getNormalizedSpan();
		const extractedLines: string[] = [];

		for (let r = start.row; r <= end.row && r < rows.length; r++) {
			if (r < 0) continue;
			const rawLine = rows[r] ?? "";
			const cleanLine = stripAnsi(rawLine);

			const rowStartCol = r === start.row ? start.col : 0;
			const rowEndCol = r === end.row ? end.col : cleanLine.length;

			const minCol = Math.max(0, Math.min(rowStartCol, rowEndCol));
			const maxCol = Math.max(0, Math.max(rowStartCol, rowEndCol));

			// 基于字符可视列宽提取对应切片
			let curWidth = 0;
			let lineSlice = "";
			for (const char of cleanLine) {
				const w = charWidth(char);
				if (curWidth >= minCol && curWidth < maxCol) {
					lineSlice += char;
				}
				curWidth += w;
				if (curWidth >= maxCol) break;
			}
			extractedLines.push(lineSlice.trimEnd());
		}

		return extractedLines.join("\n");
	}

	/**
	 * 将选区高亮渲染叠加入全屏帧（使用 \x1b[7m 反色样式）
	 */
	applyHighlight(rows: readonly string[]): string[] {
		if (!this.hasSelection() || !this.anchor || !this.focus) {
			return [...rows];
		}

		const [start, end] = this.getNormalizedSpan();
		const result: string[] = [];

		for (let r = 0; r < rows.length; r++) {
			const line = rows[r]!;
			if (r < start.row || r > end.row) {
				result.push(line);
				continue;
			}

			const rowStartCol = r === start.row ? start.col : 0;
			const clean = stripAnsi(line);
			const rowEndCol = r === end.row ? end.col : visibleWidth(clean);

			const minCol = Math.max(0, Math.min(rowStartCol, rowEndCol));
			const maxCol = Math.max(0, Math.max(rowStartCol, rowEndCol));

			if (minCol >= maxCol) {
				result.push(line);
				continue;
			}

			// 在列范围 [minCol, maxCol) 注入反色高亮
			result.push(this.highlightLineSegment(line, minCol, maxCol));
		}

		return result;
	}

	private highlightLineSegment(line: string, startCol: number, endCol: number): string {
		let curWidth = 0;
		let out = "";
		let inHighlight = false;
		let i = 0;

		while (i < line.length) {
			const ansi = extractAnsiCode(line, i);
			if (ansi) {
				out += ansi.code;
				i += ansi.length;
				continue;
			}

			const char = line[i]!;
			const w = charWidth(char);

			if (curWidth >= startCol && curWidth < endCol) {
				if (!inHighlight) {
					out += "\x1b[7m"; // 启用反色高亮
					inHighlight = true;
				}
			} else {
				if (inHighlight) {
					out += "\x1b[27m"; // 退出反色高亮
					inHighlight = false;
				}
			}

			out += char;
			curWidth += w;
			i++;
		}

		if (inHighlight) {
			out += "\x1b[27m";
		}
		return out;
	}

	private getNormalizedSpan(): [Point, Point] {
		const a = this.anchor!;
		const f = this.focus!;
		if (a.row < f.row || (a.row === f.row && a.col <= f.col)) {
			return [a, f];
		}
		return [f, a];
	}
}
