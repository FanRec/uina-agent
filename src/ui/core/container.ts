/**
 * 组合容器组件（对齐 Pi 风格的 Container 组合模式）。
 * 负责子组件数组的挂载、卸载、清空、渲染拼接与缓存失效传播。
 */

import type { Component } from "./types.js";

export class Container implements Component {
	readonly children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children.length = 0;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			for (let i = 0; i < childLines.length; i++) {
				lines.push(childLines[i]!);
			}
		}
		return lines;
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}
}
