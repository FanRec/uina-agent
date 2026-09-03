/**
 * 小部件插槽管理器（WidgetSlots）。
 * 支持扩展或外部模块向 aboveEditor 和 belowEditor 挂载/卸载自定义视觉部件。
 */

import type { Component, WidgetItem, WidgetPlacement } from "./types.js";

export class WidgetSlots {
	private widgets = new Map<string, WidgetItem>();

	constructor(private readonly onRequestRender: () => void) {}

	setWidget(
		id: string,
		component: Component | undefined,
		placement: WidgetPlacement = "aboveEditor",
		priority = 100,
	): void {
		if (!component) {
			this.removeWidget(id);
			return;
		}

		this.widgets.set(id, { id, component, placement, priority });
		this.onRequestRender();
	}

	removeWidget(id: string): void {
		if (this.widgets.delete(id)) {
			this.onRequestRender();
		}
	}

	hasWidget(id: string): boolean {
		return this.widgets.has(id);
	}

	clear(): void {
		this.widgets.clear();
		this.onRequestRender();
	}

	getWidgets(placement: WidgetPlacement): WidgetItem[] {
		return Array.from(this.widgets.values())
			.filter((w) => w.placement === placement)
			.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
	}

	render(placement: WidgetPlacement, width: number): string[] {
		const list = this.getWidgets(placement);
		const lines: string[] = [];
		for (const item of list) {
			const itemLines = item.component.render(width);
			for (const line of itemLines) {
				lines.push(line);
			}
		}
		return lines;
	}

	invalidate(): void {
		for (const item of this.widgets.values()) {
			item.component.invalidate?.();
		}
	}
}
