/**
 * 主屏幕差量渲染引擎（完全对齐现代终端标准与历史保护规范）。
 * 核心机制：
 * 1. 绝对保护对话历史：光标仅在活跃区域内部（0 ~ currentCursorRow）移动，严禁盲目上移侵入历史流；
 * 2. 窗口 Resize 完美平滑：使用 \x1b[J（Erase from cursor to end of screen）原子清空活跃区及下方，
 *    既绝不留下缩放残余幽灵阶梯，又绝不吞噬上方已经打印的历史正文；
 * 3. 硬件光标坐标跟踪，保护中文 IME 候选框定位；
 * 4. DEC CSI 2026 原子同步输出，彻底消除高频重绘闪烁。
 */

import { CURSOR_MARKER } from "./types.js";
import { extractAnsiCode, normalizeFrameLine, truncateToWidth, visibleWidth } from "./utils.js";
import type { ProcessTerminal } from "./terminal.js";

export interface CursorPosition {
	row: number; // 相对活跃区域顶部的行号 (0-indexed)
	col: number; // 所在行的显示列号 (1-indexed)
}

export class MainScreenRenderer {
	private previousPhysicalRows: string[] | null = null;
	private previousWidth = 0;
	private previousCursor: CursorPosition | null = null;
	private invalidated = true;

	constructor(private readonly terminal: ProcessTerminal) {}

	/**
	 * 终端尺寸变更响应
	 */
	handleResize(_newWidth?: number): void {
		this.invalidated = true;
	}

	/**
	 * 底部常驻全帧原子渲染（Bottom-Pinned Frame Engine）
	 * 保证 rows 的总高度恒定撑满视口，输入框永远锁定吸附在最底端 [rows.length - inputH, rows.length - 1]
	 */
	renderFrame(rows: string[]): void {
		let cursorPos: CursorPosition | null = null;
		// Every emitted row must fit the terminal, otherwise the terminal wraps it
		// and the whole frame shifts (Pi: tui-main-screen.ts rendered-width check).
		// Tabs are expanded first: a raw HT only moves the cursor without painting the
		// cells it skips, so those cells keep the previous frame's text (looks like an
		// overlap) or the default background (a hole in a card background).
		const width = Math.max(1, this.terminal.columns);

		const physicalRows: string[] = [];
		for (let r = 0; r < rows.length; r++) {
			const line = rows[r]!;
			const markerIndex = line.indexOf(CURSOR_MARKER);
			const cleanLine = markerIndex === -1 ? line : line.replace(CURSOR_MARKER, "");
			if (markerIndex !== -1) {
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker) + 1;
				cursorPos = { row: r, col: Math.min(col, width) };
			}
			// Rows are padded to exactly the terminal width, which leaves the cursor in the
			// "pending wrap" state. Advancing with CR LF from there moves down two rows on
			// hosts that act on the wrap immediately (the classic double-spaced frame), so
			// every row is positioned absolutely instead of relying on line-feed movement.
			// fitToWidth 截断超宽行后光标落在 pending-wrap 边界：此状态下 \x1b[K 在
			// Windows Terminal 会把下一行涂黑（真机黑条）。而正常路径每行已 pad 到
			// 满宽，无需 erase。统一改为截断后重新绝对定位到行尾列再 \x1b[K，
			// 使光标离开 pending-wrap 状态；尾部残留列由 K 以当前 bg 涂刷。
			physicalRows.push(this.fitToWidth(normalizeFrameLine(this.sanitizeRow(cleanLine)), width));
		}

		const fullRender = this.invalidated || this.previousPhysicalRows === null || this.previousWidth !== width;
		let frame = fullRender ? "\x1b[H" : "";
		const changedRows = fullRender
			? physicalRows.map((_row, index) => index)
			: physicalRows.reduce<number[]>((result, row, index) => {
				if (this.previousPhysicalRows?.[index] !== row) result.push(index);
				return result;
			}, []);
		for (const index of changedRows) {
			const fitted = physicalRows[index]!;
			const fittedW = visibleWidth(fitted);
			frame += `\x1b[${index + 1};1H\x1b[0m${fitted}`;
			if (fittedW < width) frame += "\x1b[0m\x1b[K";
			else frame += `\x1b[${index + 1};${width}H\x1b[0m\x1b[K`;
		}
		const clearedTail = Boolean(this.previousPhysicalRows && this.previousPhysicalRows.length > physicalRows.length);
		if (clearedTail) {
			frame += `\x1b[${physicalRows.length + 1};1H\x1b[0m\x1b[J`;
		}

		// 硬件光标精确定位至输入框焦点所在行列，唤起原生系统 IME 候选框
		const cursorChanged = fullRender || !sameCursor(this.previousCursor, cursorPos);
		if (cursorPos && (cursorChanged || fullRender || changedRows.length > 0 || clearedTail)) {
			frame += `\x1b[${cursorPos.row + 1};${cursorPos.col}H\x1b[?25h`;
		} else if (!cursorPos && cursorChanged) {
			frame += "\x1b[?25l";
		}

		if (frame.length > 0) this.terminal.syncWrite(frame);
		const snapshotTerminal = this.terminal as ProcessTerminal & { recordLogicalFrameSnapshot?: (frame: string) => void };
		if (snapshotTerminal.recordLogicalFrameSnapshot) {
			let snapshot = "\x1b[H";
			for (let index = 0; index < physicalRows.length; index++) {
				const row = physicalRows[index]!;
				snapshot += `\x1b[${index + 1};1H\x1b[0m${row}`;
				snapshot += visibleWidth(row) < width ? "\x1b[0m\x1b[K" : `\x1b[${index + 1};${width}H\x1b[0m\x1b[K`;
			}
			snapshot += cursorPos ? `\x1b[${cursorPos.row + 1};${cursorPos.col}H\x1b[?25h` : "\x1b[?25l";
			snapshotTerminal.recordLogicalFrameSnapshot(snapshot);
		}
		this.previousPhysicalRows = physicalRows;
		this.previousWidth = width;
		this.previousCursor = cursorPos;
		this.invalidated = false;
	}

	private sanitizeRow(line: string): string {
		let out = "";
		let index = 0;
		while (index < line.length) {
			const ansi = extractAnsiCode(line, index);
			if (ansi) {
				if (/^\x1b\[[0-9;]*m$/.test(ansi.code)) out += ansi.code;
				index += ansi.length;
				continue;
			}
			if (line[index] === "\x1b") {
				index = skipControlSequence(line, index);
				continue;
			}
			const code = line.charCodeAt(index);
			if (code > 0x1f && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) out += line[index];
			index++;
		}
		return out;
	}

	private fitToWidth(line: string, width: number): string {
		return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
	}
}

function sameCursor(a: CursorPosition | null, b: CursorPosition | null): boolean {
	return a?.row === b?.row && a?.col === b?.col;
}

function skipControlSequence(text: string, start: number): number {
	const introducer = text[start + 1];
	if (introducer === "[") {
		let index = start + 2;
		while (index < text.length) {
			const code = text.charCodeAt(index++);
			if (code >= 0x40 && code <= 0x7e) break;
		}
		return index;
	}
	if (introducer === "]" || introducer === "_" || introducer === "P" || introducer === "^" || introducer === "X") {
		let index = start + 2;
		while (index < text.length) {
			if (text[index] === "\x07") return index + 1;
			if (text[index] === "\x1b" && text[index + 1] === "\\") return index + 2;
			index++;
		}
		return index;
	}
	return Math.min(text.length, start + 2);
}
