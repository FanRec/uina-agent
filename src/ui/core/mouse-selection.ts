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
	row: number; // 0-indexed 屏幕行坐标
	contentRow?: number; // 全局内容行坐标（仅当在 transcript 区域时有效）
}

export interface InteractiveTarget {
	id: string;
	row: number;
	colStart: number;
	colEnd: number;
	type?: string;
	onClick?: (col?: number) => void;
}

export interface MouseEventResult {
	handled: boolean;
	wheelDelta?: number; // 负数向上滚动，正数向下滚动
	needRender?: boolean;
	hoverTargetId?: string | null;
	clickedTargetId?: string;
	dragEdge?: "top" | "bottom" | null; // 拖拽触碰的边界方向
}

/**
 * 提取单行终端文本的真实内容列宽：
 * 1. 兼容旧版输入框边框行（│ ... │），保留完整宽度；新版 dsh-tui
 *    输入行没有左右竖边，由 input 区域的专用几何处理；
 * 2. 若整行宽度达到终端屏幕列宽（>= 30 列），剥离最右侧 2 列导航轨（TimelineRail）；
 * 3. 对去除导航轨后的文本执行 trimEnd()，剔除右侧全部留白空格；
 * 4. 返回实际文本内容的精确可视列宽，防止划词高亮越界渲染整屏实心蓝块。
 */
export function getLineContentWidth(cleanLine: string): number {
	const fullLen = visibleWidth(cleanLine);
	const trimmed = cleanLine.trimEnd();
	if (trimmed.startsWith("│") && trimmed.endsWith("│")) {
		return fullLen;
	}
	if (fullLen < 30) {
		return visibleWidth(trimmed);
	}
	let col = 0;
	let contentWithoutRail = "";
	for (const char of cleanLine) {
		const w = charWidth(char);
		if (col + w > fullLen - 2) break;
		contentWithoutRail += char;
		col += w;
	}
	return visibleWidth(contentWithoutRail.trimEnd());
}

export interface SelectableRegion {
	id: "transcript" | "input";
	startRow: number;
	endRow: number;
	colStart: number;
	colEnd: number;
}

export class MouseSelectionTracker {
	private anchor: Point | null = null;
	private focus: Point | null = null;
	private isDragging = false;
	private mouseDownPos: Point | null = null;
	private mouseDownTime = 0;

	private targets: InteractiveTarget[] = [];
	private currentHoverTargetId: string | null = null;

	private regions: SelectableRegion[] = [
		{
			id: "transcript",
			startRow: 0,
			endRow: Infinity,
			colStart: 0,
			colEnd: Infinity,
		},
	];
	private activeRegion: SelectableRegion | null = null;
	private currentScrollStart = 0;

	setScrollContext(scrollStart: number, _chatAreaH?: number): void {
		this.currentScrollStart = scrollStart;
	}

	updateFocusContent(contentRow: number, screenRow: number, col?: number): void {
		if (!this.isDragging || !this.activeRegion || this.activeRegion.id !== "transcript") return;
		const currentCol = col ?? (this.focus ? this.focus.col : 0);
		const clampedCol = Math.max(
			this.activeRegion.colStart,
			Math.min(currentCol, this.activeRegion.colEnd),
		);
		const clampedRow = Math.max(
			this.activeRegion.startRow,
			Math.min(screenRow, this.activeRegion.endRow),
		);
		this.focus = { col: clampedCol, row: clampedRow, contentRow };
	}

	setSelectableRegions(regions: readonly SelectableRegion[]): void {
		this.regions = [...regions];
	}

	setSelectableRowRange(min: number, max: number): void {
		this.regions = [
			{
				id: "transcript",
				startRow: Math.max(0, min),
				endRow: Math.max(0, max),
				colStart: 0,
				colEnd: Infinity,
			},
		];
	}

	setTargets(targets: readonly InteractiveTarget[]): void {
		this.targets = [...targets];
	}

	getTarget(id: string): InteractiveTarget | undefined {
		return this.targets.find((t) => t.id === id);
	}

	clearTargets(): void {
		this.targets.length = 0;
	}

	hasSelection(): boolean {
		if (!this.anchor || !this.focus) return false;
		if (this.anchor.contentRow !== undefined && this.focus.contentRow !== undefined) {
			return this.anchor.contentRow !== this.focus.contentRow || Math.abs(this.anchor.col - this.focus.col) > 1;
		}
		return this.anchor.row !== this.focus.row || Math.abs(this.anchor.col - this.focus.col) > 1;
	}

	clear(): void {
		this.anchor = null;
		this.focus = null;
		this.isDragging = false;
		this.mouseDownPos = null;
		this.activeRegion = null;
	}

	/**
	 * 解析终端输入流中的 SGR 鼠标事件（CSI < btn;col;row M/m）
	 */
	handleInput(
		data: string,
		rows: readonly string[],
		onCopy?: (text: string) => void,
		permanentLines?: readonly string[],
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
			this.mouseDownPos = { col, row };
			this.mouseDownTime = Date.now();
			// 查找落点落在哪个合法划选区域内（转录区或输入框内容行）
			const matched = this.regions.find(
				(r) => row >= r.startRow && row <= r.endRow && col >= r.colStart && col <= r.colEnd,
			);
			if (matched) {
				this.activeRegion = matched;
				const contentRow = matched.id === "transcript"
					? this.currentScrollStart + (row - matched.startRow)
					: undefined;
				this.anchor = { col, row, contentRow };
				this.focus = { col, row, contentRow };
				this.isDragging = true;
				return { handled: true, needRender: true };
			}
			this.activeRegion = null;
			this.anchor = null;
			this.focus = null;
			this.isDragging = false;
			return { handled: true };
		}

		// 3. 左键拖拽（btn 32, action 'M' 且已处于拖拽态）
		if ((btn === 32 || btn === 0) && action === "M" && this.isDragging && this.activeRegion) {
			const clampedRow = Math.max(
				this.activeRegion.startRow,
				Math.min(row, this.activeRegion.endRow),
			);
			const clampedCol = Math.max(
				this.activeRegion.colStart,
				Math.min(col, this.activeRegion.colEnd),
			);
			const contentRow = this.activeRegion.id === "transcript"
				? this.currentScrollStart + (clampedRow - this.activeRegion.startRow)
				: undefined;
			this.focus = { col: clampedCol, row: clampedRow, contentRow };

			let dragEdge: "top" | "bottom" | null = null;
			if (this.activeRegion.id === "transcript") {
				if (row <= this.activeRegion.startRow + 1) {
					dragEdge = "top";
				} else if (row >= this.activeRegion.endRow - 1) {
					dragEdge = "bottom";
				}
			}

			return { handled: true, needRender: true, dragEdge };
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

			const contentRow = this.activeRegion?.id === "transcript"
				? this.currentScrollStart + (Math.max(this.activeRegion.startRow, Math.min(row, this.activeRegion.endRow)) - this.activeRegion.startRow)
				: undefined;
			this.focus = { col, row, contentRow };
			this.isDragging = false;

			// 如果判定为点击（Click）动作，检查是否命中交互热区
			if (isClick) {
				const target = this.targets.find(
					(t) => t.row === row && col >= t.colStart && col <= t.colEnd,
				);
				this.clear();
				if (target) {
					target.onClick?.(col);
					return { handled: true, clickedTargetId: target.id, needRender: true };
				}
				return { handled: true, needRender: true };
			}

			// 如果判定为拖拽选择（Drag Selection），优先从全量永久内容提取，支持跨屏无损拷贝
			if (this.hasSelection() && onCopy) {
				const selectedText = (permanentLines ? this.extractSelectedContentText(permanentLines) : "") || this.extractSelectedText(rows);
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
	 * 从屏幕帧缓冲中提取选区内的纯文本：
	 * 1. 严格基于当前活动区域 activeRegion（转录区或输入框）隔离提取；
	 * 2. 剥离 ●、❯、✦ 图标；
	 * 3. 兼容剥离旧版输入框外边框 │；
	 * 4. 彻底排除非可选区域的任何残留内容。
	 */
	extractSelectedText(rows: readonly string[]): string {
		if (!this.anchor || !this.focus || !this.activeRegion) return "";

		const [start, end] = this.getNormalizedSpan();
		const extractedLines: string[] = [];

		for (let r = start.row; r <= end.row && r < rows.length; r++) {
			if (r < this.activeRegion.startRow || r > this.activeRegion.endRow || r < 0) continue;
			const rawLine = rows[r] ?? "";
			const cleanLine = stripAnsi(rawLine);
			let contentLen = getLineContentWidth(cleanLine);

			if (this.activeRegion.id === "input") {
				const trimmed = cleanLine.trimEnd();
				const fullW = visibleWidth(trimmed);
				// 输入框行排除末尾的边框 │
				contentLen = trimmed.endsWith("│") ? Math.max(this.activeRegion.colStart, fullW - 1) : fullW;
			}

			if (contentLen === 0) {
				if (r > start.row && r < end.row) {
					extractedLines.push("");
				}
				continue;
			}

			let rowStartCol = r === start.row ? Math.max(this.activeRegion.colStart, Math.min(start.col, contentLen)) : this.activeRegion.colStart;
			let rowEndCol = r === end.row ? Math.min(end.col, contentLen) : contentLen;

			const trimmedContent = cleanLine.trimEnd();
			// 若行包含输入框边框 │，排除边框字符
			if (trimmedContent.startsWith("│")) {
				rowStartCol = Math.max(rowStartCol, 1);
				if (trimmedContent.endsWith("│")) {
					rowEndCol = Math.min(rowEndCol, contentLen - 1);
				}
			}

			const minCol = Math.max(0, Math.min(rowStartCol, rowEndCol));
			const maxCol = Math.max(0, Math.max(rowStartCol, rowEndCol));

			if (minCol >= maxCol) {
				continue;
			}

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

			// noSelect 智能清洗：剥离输入框边框 │ 与行首标记
			let trimmed = lineSlice.trimEnd();
			if (trimmed.startsWith("│")) {
				trimmed = trimmed.replace(/^│+\s*/, "");
			}
			if (trimmed.endsWith("│")) {
				trimmed = trimmed.replace(/\s*│+$/, "");
			}
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
	 * 从全量永久内容缓冲中完整提取选区内的纯文本（支持无损跨屏提取）
	 */
	extractSelectedContentText(permanentLines: readonly string[]): string {
		if (
			!this.anchor ||
			!this.focus ||
			!this.activeRegion ||
			this.activeRegion.id !== "transcript" ||
			this.anchor.contentRow === undefined ||
			this.focus.contentRow === undefined
		) {
			return "";
		}

		const isForward =
			this.anchor.contentRow < this.focus.contentRow ||
			(this.anchor.contentRow === this.focus.contentRow && this.anchor.col <= this.focus.col);
		const start = isForward ? this.anchor : this.focus;
		const end = isForward ? this.focus : this.anchor;
		const minContent = Math.max(0, start.contentRow!);
		const maxContent = Math.min(permanentLines.length - 1, end.contentRow!);

		const extractedLines: string[] = [];

		for (let c = minContent; c <= maxContent && c < permanentLines.length; c++) {
			const rawLine = permanentLines[c] ?? "";
			const cleanLine = stripAnsi(rawLine);
			const contentLen = visibleWidth(cleanLine.trimEnd());

			if (contentLen === 0) {
				if (c > minContent && c < maxContent) {
					extractedLines.push("");
				}
				continue;
			}

			let rowStartCol = this.activeRegion.colStart;
			let rowEndCol = contentLen;

			if (minContent === maxContent) {
				rowStartCol = Math.max(this.activeRegion.colStart, Math.min(start.col, contentLen));
				rowEndCol = Math.min(end.col, contentLen);
			} else if (c === minContent) {
				rowStartCol = Math.max(this.activeRegion.colStart, Math.min(start.col, contentLen));
				rowEndCol = contentLen;
			} else if (c === maxContent) {
				rowStartCol = this.activeRegion.colStart;
				rowEndCol = Math.min(end.col, contentLen);
			}

			const minCol = Math.max(0, Math.min(rowStartCol, rowEndCol));
			const maxCol = Math.max(0, Math.max(rowStartCol, rowEndCol));

			if (minCol >= maxCol) {
				continue;
			}

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
	 * 将选区高亮渲染叠加入全屏帧（使用 dsh-TUI 雾蓝选区背景色 #3B4A66）
	 */
	applyHighlight(rows: readonly string[], scrollStart?: number): string[] {
		if (!this.hasSelection() || !this.anchor || !this.focus || !this.activeRegion) {
			return [...rows];
		}

		// 如果处于 transcript 区域且具备全局内容行号，基于 contentRow 进行精确跨屏高亮
		if (
			this.activeRegion.id === "transcript" &&
			this.anchor.contentRow !== undefined &&
			this.focus.contentRow !== undefined &&
			scrollStart !== undefined
		) {
			const isForward =
				this.anchor.contentRow < this.focus.contentRow ||
				(this.anchor.contentRow === this.focus.contentRow && this.anchor.col <= this.focus.col);
			const start = isForward ? this.anchor : this.focus;
			const end = isForward ? this.focus : this.anchor;
			const minContent = start.contentRow!;
			const maxContent = end.contentRow!;

			const result: string[] = [];
			for (let r = 0; r < rows.length; r++) {
				const line = rows[r]!;
				if (r < this.activeRegion.startRow || r > this.activeRegion.endRow) {
					result.push(line);
					continue;
				}

				const contentRow = scrollStart + (r - this.activeRegion.startRow);
				if (contentRow < minContent || contentRow > maxContent) {
					result.push(line);
					continue;
				}

				const clean = stripAnsi(line);
				const contentLen = getLineContentWidth(clean);
				if (contentLen === 0) {
					result.push(line);
					continue;
				}

				let rowStartCol = this.activeRegion.colStart;
				let rowEndCol = contentLen;

				if (minContent === maxContent) {
					rowStartCol = Math.max(this.activeRegion.colStart, Math.min(start.col, contentLen));
					rowEndCol = Math.min(end.col, contentLen);
				} else if (contentRow === minContent) {
					rowStartCol = Math.max(this.activeRegion.colStart, Math.min(start.col, contentLen));
					rowEndCol = contentLen;
				} else if (contentRow === maxContent) {
					rowStartCol = this.activeRegion.colStart;
					rowEndCol = Math.min(end.col, contentLen);
				}

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

		// 否则回退为基于屏幕行号的高亮（如输入框划选）
		const [start, end] = this.getNormalizedSpan();
		const result: string[] = [];

		for (let r = 0; r < rows.length; r++) {
			const line = rows[r]!;
			if (
				r < start.row ||
				r > end.row ||
				r < this.activeRegion.startRow ||
				r > this.activeRegion.endRow
			) {
				result.push(line);
				continue;
			}

			const clean = stripAnsi(line);
			let contentLen = getLineContentWidth(clean);

			if (this.activeRegion.id === "input") {
				const trimmed = clean.trimEnd();
				const fullW = visibleWidth(trimmed);
				contentLen = trimmed.endsWith("│") ? Math.max(this.activeRegion.colStart, fullW - 1) : fullW;
			}

			if (contentLen === 0) {
				result.push(line);
				continue;
			}

			let rowStartCol = r === start.row ? Math.max(this.activeRegion.colStart, Math.min(start.col, contentLen)) : this.activeRegion.colStart;
			let rowEndCol = r === end.row ? Math.min(end.col, contentLen) : contentLen;

			const trimmedContent = clean.trimEnd();
			if (trimmedContent.startsWith("│")) {
				rowStartCol = Math.max(rowStartCol, 1);
				if (trimmedContent.endsWith("│")) {
					rowEndCol = Math.min(rowEndCol, contentLen - 1);
				}
			}

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
				// 如果在选区内遇到了样式重置或背景变动，立即重新附加雾蓝背景，杜绝选区断层或转为黑底
				if (
					inHighlight &&
					(ansi.code === "\x1b[0m" || ansi.code.includes("49m") || ansi.code.includes("48;"))
				) {
					out += "\x1b[48;2;59;74;102m";
				}
				i += ansi.length;
				continue;
			}

			const char = line[i]!;
			const w = charWidth(char);

			if (curWidth >= startCol && curWidth < endCol) {
				if (!inHighlight) {
					out += "\x1b[48;2;59;74;102m"; // dsh-TUI selectionBg: #3B4A66 雾蓝选区底色
					inHighlight = true;
				}
			} else {
				if (inHighlight) {
					out += "\x1b[49m"; // 退出背景色
					inHighlight = false;
				}
			}

			out += char;
			curWidth += w;
			i++;
		}

		if (inHighlight) {
			out += "\x1b[49m";
		}
		return out;
	}

	private getNormalizedSpan(): [Point, Point] {
		const a = this.anchor!;
		const f = this.focus!;
		if (a.contentRow !== undefined && f.contentRow !== undefined) {
			if (a.contentRow < f.contentRow || (a.contentRow === f.contentRow && a.col <= f.col)) {
				return [a, f];
			}
			return [f, a];
		}
		if (a.row < f.row || (a.row === f.row && a.col <= f.col)) {
			return [a, f];
		}
		return [f, a];
	}
}
