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
import { visibleWidth } from "./utils.js";
import type { ProcessTerminal } from "./terminal.js";

export interface CursorPosition {
	row: number; // 相对活跃区域顶部的行号 (0-indexed)
	col: number; // 所在行的显示列号 (1-indexed)
}

export class MainScreenRenderer {
	private previousActiveLines: string[] = [];
	private currentCursorRow = 0; // 当前硬件光标在活跃区域内的相对行号 (0-indexed)

	constructor(private readonly terminal: ProcessTerminal) {}

	/**
	 * 永久性追加文本行到历史滚动流中（正文/已完成的消息/已折叠的工具等）
	 */
	appendPermanentLines(lines: string[]): void {
		if (lines.length === 0) return;
		let frame = "";

		// 1. 如果有活跃区，将光标回到活跃区首行并清空活跃区，为历史流让路
		if (this.previousActiveLines.length > 0) {
			if (this.currentCursorRow > 0) {
				frame += `\x1b[${this.currentCursorRow}A\r`;
			} else {
				frame += "\r";
			}
			frame += "\x1b[J";
		}

		// 2. 写入永久历史内容
		for (const line of lines) {
			frame += `${line}\r\n`;
		}

		this.terminal.syncWrite(frame);
		this.previousActiveLines = [];
		this.currentCursorRow = 0;
	}

	/**
	 * 全量视口重排渲染（窗口 Resize / 动态重排时调用，彻底消除残留重影并使历史对话自然回流）
	 */
	fullRedraw(permanentLines: string[], activeLines: string[]): void {
		let frame = "";
		// 1. 同步清屏、光标归位左上角并清除终端历史残留（彻底消灭旧边框重影）
		frame += "\x1b[2J\x1b[H\x1b[3J";

		// 2. 写入重新按新列宽排版后的历史正文
		for (const line of permanentLines) {
			frame += `${line}\r\n`;
		}

		// 3. 扫描 CURSOR_MARKER 并渲染输入框
		let cursorPos: CursorPosition | null = null;
		const cleanLines: string[] = [];

		for (let row = 0; row < activeLines.length; row++) {
			const line = activeLines[row]!;
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker) + 1;
				cursorPos = { row, col };
				cleanLines.push(line.replace(CURSOR_MARKER, ""));
			} else {
				cleanLines.push(line);
			}
		}

		for (let i = 0; i < cleanLines.length; i++) {
			if (i > 0) frame += "\r\n";
			frame += cleanLines[i];
		}

		const finalBottomRow = Math.max(0, cleanLines.length - 1);
		this.currentCursorRow = finalBottomRow;

		if (cursorPos) {
			const upDelta = finalBottomRow - cursorPos.row;
			if (upDelta > 0) {
				frame += `\x1b[${upDelta}A`;
			}
			frame += `\r\x1b[${cursorPos.col - 1}C`;
			frame += "\x1b[?25h";
			this.currentCursorRow = cursorPos.row;
		} else {
			frame += "\x1b[?25l";
		}

		this.terminal.syncWrite(frame);
		this.previousActiveLines = cleanLines;
	}

	/**
	 * 终端尺寸变更处理
	 */
	handleResize(_newWidth?: number): void {
		// 保持状态，直接由下一次 requestRender 执行原子视口清空与重绘，绝不侵入历史
	}

	/**
	 * 清除当前底部的活跃区域（Widgets + Editor）
	 */
	clearActiveArea(): void {
		if (this.previousActiveLines.length === 0) return;
		let frame = "";

		if (this.currentCursorRow > 0) {
			frame += `\x1b[${this.currentCursorRow}A\r`;
		} else {
			frame += "\r";
		}
		// \x1b[J 原子清空光标所在行及屏幕下方全部内容，绝不向上触碰历史正文
		frame += "\x1b[J";

		this.terminal.syncWrite(frame);
		this.previousActiveLines = [];
		this.currentCursorRow = 0;
	}

	/**
	 * 渲染底部的活跃区域（包含 aboveEditor 小部件、输入行、belowEditor 状态）
	 */
	renderActiveArea(rawLines: string[]): void {
		// 1. 扫描 CURSOR_MARKER 标记并提取光标相对位置
		let cursorPos: CursorPosition | null = null;
		const cleanLines: string[] = [];

		for (let row = 0; row < rawLines.length; row++) {
			const line = rawLines[row]!;
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker) + 1;
				cursorPos = { row, col };
				cleanLines.push(line.replace(CURSOR_MARKER, ""));
			} else {
				cleanLines.push(line);
			}
		}

		let frame = "";

		// 2. 精准复位：移动到活跃区顶部 (Row 0)，并向下清除旧行与因缩小窗口产生的多余幽灵折行
		if (this.previousActiveLines.length > 0) {
			if (this.currentCursorRow > 0) {
				frame += `\x1b[${this.currentCursorRow}A\r`;
			} else {
				frame += "\r";
			}
			// \x1b[J 清空从当前行（活跃区首行）到屏幕最底部的全部内容
			// 彻底杜绝幽灵阶梯行残留，同时因未上移任何一行，上方历史正文 100% 毫发无损！
			frame += "\x1b[J";
		}

		// 3. 逐行输出当前活跃区域内容
		for (let i = 0; i < cleanLines.length; i++) {
			if (i > 0) frame += "\r\n";
			frame += cleanLines[i];
		}

		// 4. 当前硬件光标位于活跃区域的最后一行
		const finalBottomRow = Math.max(0, cleanLines.length - 1);
		this.currentCursorRow = finalBottomRow;

		// 5. 将硬件物理光标定位到 CURSOR_MARKER 所在行与列
		if (cursorPos) {
			const upDelta = finalBottomRow - cursorPos.row;
			if (upDelta > 0) {
				frame += `\x1b[${upDelta}A`;
			}
			frame += `\r\x1b[${cursorPos.col - 1}C`;
			frame += "\x1b[?25h"; // 开启光标供输入法定位
			this.currentCursorRow = cursorPos.row;
		} else {
			frame += "\x1b[?25l"; // 无光标时隐藏
		}

		this.terminal.syncWrite(frame);
		this.previousActiveLines = cleanLines;
	}

	/**
	 * 底部常驻全帧原子渲染（Bottom-Pinned Frame Engine）
	 * 保证 rows 的总高度恒定撑满视口，输入框永远锁定吸附在最底端 [rows.length - inputH, rows.length - 1]
	 */
	renderFrame(rows: string[]): void {
		let frame = "\x1b[H"; // 硬件光标绝对归位至视口左上角 (1, 1)
		let cursorPos: CursorPosition | null = null;

		for (let r = 0; r < rows.length; r++) {
			const line = rows[r]!;
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker) + 1;
				cursorPos = { row: r, col };
				const cleanLine = line.replace(CURSOR_MARKER, "");
				if (r > 0) frame += "\r\n";
				frame += cleanLine + "\x1b[K";
			} else {
				if (r > 0) frame += "\r\n";
				frame += line + "\x1b[K";
			}
		}

		// 硬件光标精确定位至输入框焦点所在行列，唤起原生系统 IME 候选框
		if (cursorPos) {
			frame += `\x1b[${cursorPos.row + 1};${cursorPos.col}H\x1b[?25h`;
			this.currentCursorRow = cursorPos.row;
		} else {
			frame += "\x1b[?25l";
		}

		this.terminal.syncWrite(frame);
		this.previousActiveLines = rows;
	}
}
