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

	/**
	 * Lay every visible overlay out above the editor. Geometry is applied
	 * uniformly (defaults included), so a component can never emit a line wider
	 * than its box, and the built-in overlays exercise the same code path as
	 * extension overlays.
	 *
	 * The stack is ordered top → editor-adjacent; when the combined output
	 * exceeds the budget the rows closest to the input box are kept.
	 */
	renderAbove(width: number, maxHeight: number): string[] {
		const budget = Math.max(0, Math.floor(maxHeight));
		if (budget === 0) return [];
		const lines: string[] = [];
		for (const entry of this.stack) {
			if (entry.hidden) continue;
			const options = entry.options;
			const margin = normalizeMargin(options?.margin);
			const available = Math.max(1, width - margin.left - margin.right);
			const overlayWidth = Math.max(
				1,
				Math.min(
					available,
					Math.max(
						resolveSize(options?.minWidth, available) ?? 1,
						resolveSize(options?.width, available) ?? available,
					),
				),
			);
			// An entry is capped by its own maxHeight only; the shared budget is
			// applied to the whole stack afterwards, so the rows nearest the
			// editor survive instead of every entry being cut to the budget.
			const maxEntryHeight = Math.max(0, resolveSize(options?.maxHeight, budget) ?? Number.MAX_SAFE_INTEGER);
			const rendered = entry.component.render(overlayWidth).slice(0, maxEntryHeight);
			const start =
				overlayStart(options?.anchor ?? "above-editor", width, overlayWidth, margin) + (options?.offsetX ?? 0);

			const block: string[] = [];
			for (let i = 0; i < margin.top; i++) block.push("");
			for (const line of rendered) block.push(compositeTuiLine("", line, Math.max(0, start), overlayWidth, width));
			for (let i = 0; i < margin.bottom; i++) block.push("");
			// offsetY moves the block away from the editor (positive) or trims its
			// bottom (negative), matching the documented contract.
			const offsetY = options?.offsetY ?? 0;
			if (offsetY > 0) for (let i = 0; i < offsetY; i++) block.push("");
			else if (offsetY < 0) block.splice(Math.max(0, block.length + offsetY));

			lines.push(...block);
		}

		if (budget > 0 && lines.length > budget) {
			// Keep the rows nearest the editor, never the far ones.
			return lines.slice(lines.length - budget);
		}
		return lines;
	}
}

function resolveSize(value: number | `${number}%` | undefined, available: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return Math.floor(value);
	const percent = Number.parseFloat(value);
	return Number.isFinite(percent) ? Math.floor(available * percent / 100) : undefined;
}

function normalizeMargin(value: import("./types.js").OverlayMargin | number | undefined): Required<import("./types.js").OverlayMargin> {
	if (typeof value === "number") return { top: value, right: value, bottom: value, left: value };
	return { top: value?.top ?? 0, right: value?.right ?? 0, bottom: value?.bottom ?? 0, left: value?.left ?? 0 };
}

function overlayStart(anchor: NonNullable<OverlayOptions["anchor"]>, width: number, overlayWidth: number, margin: Required<import("./types.js").OverlayMargin>): number {
	if (anchor === "top-right" || anchor === "bottom-right") return width - margin.right - overlayWidth;
	if (anchor === "center" || anchor === "top-center" || anchor === "bottom-center" || anchor === "above-editor") return Math.floor((width - overlayWidth) / 2);
	return margin.left;
}
