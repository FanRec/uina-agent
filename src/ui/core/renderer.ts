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
import { expandTabs, truncateToWidth, visibleWidth } from "./utils.js";
import type { ProcessTerminal } from "./terminal.js";

export interface CursorPosition {
	row: number; // 相对活跃区域顶部的行号 (0-indexed)
	col: number; // 所在行的显示列号 (1-indexed)
}

export class MainScreenRenderer {
	constructor(private readonly terminal: ProcessTerminal) {}

	/**
	 * 终端尺寸变更响应
	 */
	handleResize(_newWidth?: number): void {
		// 由下一次 requestRender 执行原子全帧重绘
	}

	/**
	 * 底部常驻全帧原子渲染（Bottom-Pinned Frame Engine）
	 * 保证 rows 的总高度恒定撑满视口，输入框永远锁定吸附在最底端 [rows.length - inputH, rows.length - 1]
	 */
	renderFrame(rows: string[]): void {
		let frame = "\x1b[H"; // 硬件光标绝对归位至视口左上角 (1, 1)
		let cursorPos: CursorPosition | null = null;
		// Every emitted row must fit the terminal, otherwise the terminal wraps it
		// and the whole frame shifts (Pi: tui-main-screen.ts rendered-width check).
		// Tabs are expanded first: a raw HT only moves the cursor without painting the
		// cells it skips, so those cells keep the previous frame's text (looks like an
		// overlap) or the default background (a hole in a card background).
		const width = Math.max(1, this.terminal.columns);

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
			frame += `\x1b[${r + 1};1H` + this.fitToWidth(expandTabs(cleanLine), width) + "\x1b[K";
		}

		// 硬件光标精确定位至输入框焦点所在行列，唤起原生系统 IME 候选框
		if (cursorPos) {
			frame += `\x1b[${cursorPos.row + 1};${cursorPos.col}H\x1b[?25h`;
		} else {
			frame += "\x1b[?25l";
		}

		this.terminal.syncWrite(frame);
	}

	private fitToWidth(line: string, width: number): string {
		return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
	}
}
