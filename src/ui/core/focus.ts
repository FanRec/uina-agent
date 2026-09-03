/**
 * 焦点管理器（FocusManager）。
 * 负责追踪当前活跃组件的焦点状态、向获取焦点的组件传播输入事件，
 * 并处理 CURSOR_MARKER 定位以保障 IME 输入法候选框位置。
 */

import { CURSOR_MARKER, isFocusable, type Component } from "./types.js";
import { visibleWidth } from "./utils.js";
import type { CursorPosition } from "./renderer.js";

export type { CursorPosition };

export class FocusManager {
	private currentFocused: Component | null = null;

	getFocused(): Component | null {
		return this.currentFocused;
	}

	setFocus(component: Component | null): void {
		if (this.currentFocused === component) return;

		// 释放旧组件焦点
		if (this.currentFocused && isFocusable(this.currentFocused)) {
			this.currentFocused.focused = false;
		}

		this.currentFocused = component;

		// 赋予新组件焦点
		if (this.currentFocused && isFocusable(this.currentFocused)) {
			this.currentFocused.focused = true;
		}
	}

	handleInput(data: string): boolean {
		if (this.currentFocused?.handleInput) {
			this.currentFocused.handleInput(data);
			return true;
		}
		return false;
	}

	/**
	 * 在渲染好的行数组中检索 CURSOR_MARKER，提取物理光标行列位置并返回清洗后的文本行
	 */
	extractCursor(lines: readonly string[]): { cleanLines: string[]; cursor: CursorPosition | null } {
		let cursor: CursorPosition | null = null;
		const cleanLines: string[] = [];

		for (let row = 0; row < lines.length; row++) {
			const line = lines[row]!;
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker) + 1;
				cursor = { row, col };
				cleanLines.push(line.replace(CURSOR_MARKER, ""));
			} else {
				cleanLines.push(line);
			}
		}

		return { cleanLines, cursor };
	}
}
