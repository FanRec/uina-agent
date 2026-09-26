/**
 * 焦点管理器（FocusManager）。
 * 负责追踪当前活跃组件的焦点状态、向获取焦点的组件传播输入事件，
 * 并处理 CURSOR_MARKER 定位以保障 IME 输入法候选框位置。
 */

import { isFocusable, type Component } from "./types.js";

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

}
