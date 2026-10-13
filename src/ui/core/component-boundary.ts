import type { Component } from "./types.js";
import { C, truncateToWidth } from "./utils.js";

type Operation = "render" | "input";

/** Isolates a faulty UI extension component from the rest of a frame/input chain. */
export class ComponentBoundary {
	private readonly reported = new WeakMap<Component, Set<string>>();

	constructor(private readonly report: (component: Component, operation: Operation, error: unknown) => void) {}

	render(component: Component, width: number, height?: number): string[] {
		try {
			return component.render(width, height);
		} catch (error) {
			this.reportOnce(component, "render", error);
			const label = componentName(component);
			return [truncateToWidth(`${C.error}[${label}] 渲染失败${C.reset}`, Math.max(0, width), "")];
		}
	}

	handleInput(component: Component, data: string): boolean {
		if (!component.handleInput) return false;
		try {
			component.handleInput(data);
			return true;
		} catch (error) {
			this.reportOnce(component, "input", error);
			return false;
		}
	}

	private reportOnce(component: Component, operation: Operation, error: unknown): void {
		let operations = this.reported.get(component);
		if (!operations) {
			operations = new Set();
			this.reported.set(component, operations);
		}
		const signature = `${operation}:${error instanceof Error ? error.message : String(error)}`;
		if (operations.has(signature)) return;
		operations.add(signature);
		this.report(component, operation, error);
	}
}

function componentName(component: Component): string {
	return component.constructor?.name || "TUI 组件";
}
