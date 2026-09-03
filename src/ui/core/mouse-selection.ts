/**
 * 终端 SGR 鼠标选区、滚轮、点击目标与 Hover 跟踪器（复刻 dsh-TUI 工业级交互规范）。
 * 特性：
 * 1. 准确解析 CSI < btn;col;row M/m，支持 1000h/1002h/1003h 全协议；
 * 2. 滚轮事件（btn=64/65）直接路由为视口滚动，杜绝污染输入框；
 * 3. 拖拽鼠标高亮选区，松开鼠标（Mouse Up）自动提取纯文本并触发复制；
 * 4. noSelect 保护：智能剥离 ●、❯、✦ 图标，并隔离输入框外框 │；
 * 5. 交互热区引擎：精确区分原地 Click 与拖拽 Drag，支持 Hover 悬停探测。
 */

import { stripAnsi, visibleWidth, charWidth, extractAnsiCode } from "./utils.js";

export interface Point {
	col: number; // 0-indexed 列坐标
	row: number; // 0-indexed 行坐标
}

export interface InteractiveTarget {
	id: string;
	row: number;
	colStart: number;
	colEnd: number;
	type?: string;
	onClick?: () => void;
}

export interface MouseEventResult {
	handled: boolean;
	wheelDelta?: number; // 负数向上滚动，正数向下滚动
	needRender?: boolean;
	hoverTargetId?: string | null;
	clickedTargetId?: string;
}

export class MouseSelectionTracker {
	private anchor: Point | null = null;
	private focus: Point | null = null;
	private isDragging = false;
	private mouseDownPos: Point | null = null;
	private mouseDownTime = 0;

	private targets: InteractiveTarget[] = [];
	private currentHoverTargetId: string | null = null;

	setTargets(targets: readonly InteractiveTarget[]): void {
		this.targets = [...targets];
	}

	clearTargets(): void {
		this.targets.length = 0;
	}

	getHoverTargetId(): string | null {
		return this.currentHoverTargetId;
	}

	hasSelection(): boolean {
		if (!this.anchor || !this.focus) return false;
		return this.anchor.row !== this.focus.row || Math.abs(this.anchor.col - this.focus.col) > 1;
	}

	clear(): void {
		this.anchor = null;
		this.focus = null;
		this.isDragging = false;
		this.mouseDownPos = null;
	}

	/**
	 * 解析终端输入流中的 SGR 鼠标事件（CSI < btn;col;row M/m）
	 */
	handleInput(
		data: string,
		rows: readonly string[],
		onCopy?: (text: string) => void,
	): MouseEventResult {
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
			this.mouseDownPos = { col, row };
			this.mouseDownTime = Date.now();
			this.isDragging = true;
			return { handled: true, needRender: true };
		}

		// 3. 左键拖拽（btn 32, action 'M' 且已处于拖拽态）
		if ((btn === 32 || btn === 0) && action === "M" && this.isDragging) {
			this.focus = { col, row };
			return { handled: true, needRender: true };
		}

		// 4. 移动悬停（Hover 探测：btn 35 或无按键移动）
		if (btn === 35 && action === "M" && !this.isDragging) {
			const target = this.targets.find(
				(t) => t.row === row && col >= t.colStart && col <= t.colEnd,
			);
			const newId = target ? target.id : null;
			if (newId !== this.currentHoverTargetId) {
				this.currentHoverTargetId = newId;
				return { handled: true, hoverTargetId: newId, needRender: true };
			}
			return { handled: true };
		}

		// 5. 左键释放（action 'm'）
		if (action === "m") {
			const startPos = this.mouseDownPos;
			const isClick =
				startPos &&
				Math.abs(startPos.col - col) <= 1 &&
				Math.abs(startPos.row - row) === 0 &&
				Date.now() - this.mouseDownTime < 350 &&
				!this.hasSelection();

			this.focus = { col, row };
			this.isDragging = false;

			// 如果判定为点击（Click）动作，检查是否命中交互热区
			if (isClick) {
				const target = this.targets.find(
					(t) => t.row === row && col >= t.colStart && col <= t.colEnd,
				);
				this.clear();
				if (target) {
					target.onClick?.();
					return { handled: true, clickedTargetId: target.id, needRender: true };
				}
				return { handled: true, needRender: true };
			}

			// 如果判定为拖拽选择（Drag Selection），提取纯文本并触发复制
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
	 * 从全屏帧中提取选中文字，严格执行 noSelect 隔离：
	 * 1. 剥离 ●、❯、✦ 图标；
	 * 2. 剥离输入框外边框 │、╭、╰；
	 * 3. 剥离右侧导航轨。
	 */
	extractSelectedText(rows: readonly string[]): string {
		if (!this.anchor || !this.focus) return "";

		const [start, end] = this.getNormalizedSpan();
		const extractedLines: string[] = [];

		for (let r = start.row; r <= end.row && r < rows.length; r++) {
			if (r < 0) continue;
			const rawLine = rows[r] ?? "";
			const cleanLine = stripAnsi(rawLine);
			const lineLen = visibleWidth(cleanLine);

			let rowStartCol = r === start.row ? start.col : 0;
			let rowEndCol = r === end.row ? end.col : lineLen;

			// 若行尾包含时间线导航轨（最右 2 列），排除导航轨
			if (lineLen >= 30) {
				rowEndCol = Math.min(rowEndCol, lineLen - 2);
			}

			// 若行包含输入框边框 │，排除第 0 列与最右列
			if (cleanLine.startsWith("│") && cleanLine.endsWith("│")) {
				rowStartCol = Math.max(rowStartCol, 1);
				rowEndCol = Math.min(rowEndCol, lineLen - 1);
			}

			const minCol = Math.max(0, Math.min(rowStartCol, rowEndCol));
			const maxCol = Math.max(0, Math.max(rowStartCol, rowEndCol));

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

			// noSelect 智能清洗：剥离行首的标记符号
			let trimmed = lineSlice.trimEnd();
			if (trimmed.startsWith("● ")) {
				trimmed = trimmed.slice(2);
			} else if (trimmed.startsWith("❯ ")) {
				trimmed = trimmed.slice(2);
			} else if (trimmed.startsWith("✦ ")) {
				trimmed = trimmed.slice(2);
			} else if (trimmed.startsWith("• ")) {
				trimmed = trimmed.slice(2);
			}

			extractedLines.push(trimmed);
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
