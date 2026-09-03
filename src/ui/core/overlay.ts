/**
 * 通用覆盖层管理体系（OverlayStack & OverlayHandle）。
 * 遵循 Uina 的 OverlayAbove 哲学：输入框固定吸底，浮层在输入框正上方向上堆叠与渲染，
 * 同时支持 ANSI 字符级复合渲染 compositeTuiLine。
 */

import type { Component, OverlayHandle, OverlayOptions } from "./types.js";
import type { FocusManager } from "./focus.js";
import { visibleWidth, truncateToWidth } from "./utils.js";

/**
 * 将浮层行合并到底层背景行指定的列位置
 */
export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	_totalWidth = 80,
): string {
	const before = truncateToWidth(baseLine, startCol);
	const beforeW = visibleWidth(before);
	const padBefore = Math.max(0, startCol - beforeW);
	const middle = truncateToWidth(overlayLine, overlayWidth);
	const midW = visibleWidth(middle);
	const padMid = Math.max(0, overlayWidth - midW);
	return before + " ".repeat(padBefore) + middle + " ".repeat(padMid);
}

export interface OverlayStackEntry {
	component: Component;
	options?: OverlayOptions;
	hidden: boolean;
	preFocus: Component | null;
	dispose?: () => void;
}

export class OverlayStack {
	private readonly stack: OverlayStackEntry[] = [];

	constructor(
		private readonly focusManager: FocusManager,
		private readonly onRequestRender: () => void,
	) {}

	get entries(): readonly OverlayStackEntry[] {
		return this.stack;
	}

	get hasVisible(): boolean {
		return this.stack.some((e) => !e.hidden);
	}

	get topCapturing(): OverlayStackEntry | null {
		for (let i = this.stack.length - 1; i >= 0; i--) {
			const entry = this.stack[i]!;
			if (!entry.hidden && !entry.options?.nonCapturing) {
				return entry;
			}
		}
		return null;
	}

	showOverlay(component: Component, options?: OverlayOptions, dispose?: () => void): OverlayHandle {
		const preFocus = this.focusManager.getFocused();
		const entry: OverlayStackEntry = {
			component,
			options,
			hidden: false,
			preFocus,
			dispose,
		};

		this.stack.push(entry);

		// 若未明确设置 nonCapturing，默认捕获焦点
		if (!options?.nonCapturing) {
			this.focusManager.setFocus(component);
		}

		this.onRequestRender();

		const handle: OverlayHandle = {
			hide: () => {
				this.removeEntry(entry);
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				if (hidden && this.focusManager.getFocused() === component) {
					// 隐藏时退还焦点
					this.restoreFocus(entry);
				} else if (!hidden && !options?.nonCapturing) {
					this.focusManager.setFocus(component);
				}
				this.onRequestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!entry.hidden) {
					this.focusManager.setFocus(component);
					this.onRequestRender();
				}
			},
			unfocus: () => {
				if (this.focusManager.getFocused() === component) {
					this.restoreFocus(entry);
					this.onRequestRender();
				}
			},
			isFocused: () => this.focusManager.getFocused() === component,
		};

		return handle;
	}

	hideTopOverlay(): boolean {
		const top = this.stack.at(-1);
		if (!top) return false;
		this.removeEntry(top);
		return true;
	}

	clear(): void {
		while (this.stack.length > 0) {
			const top = this.stack.pop()!;
			try {
				top.dispose?.();
			} catch {}
		}
		this.onRequestRender();
	}

	private removeEntry(entry: OverlayStackEntry): void {
		const index = this.stack.indexOf(entry);
		if (index === -1) return;

		this.stack.splice(index, 1);

		if (this.focusManager.getFocused() === entry.component) {
			this.restoreFocus(entry);
		}

		try {
			entry.dispose?.();
		} catch {}

		this.onRequestRender();
	}

	private restoreFocus(entry: OverlayStackEntry): void {
		const next = this.topCapturing;
		if (next) {
			this.focusManager.setFocus(next.component);
		} else {
			this.focusManager.setFocus(entry.preFocus);
		}
	}

	renderAbove(width: number, maxHeight: number): string[] {
		const lines: string[] = [];
		for (const entry of this.stack) {
			if (entry.hidden) continue;
			const entryLines = entry.component.render(width);
			for (const line of entryLines) {
				lines.push(line);
			}
		}

		if (maxHeight > 0 && lines.length > maxHeight) {
			return lines.slice(lines.length - maxHeight);
		}
		return lines;
	}
}
