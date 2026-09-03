import type { Component } from "../../core/types.js";

export class Spacer implements Component {
	constructor(private readonly lines = 1) {}

	render(_width: number): string[] {
		return new Array(Math.max(0, this.lines)).fill("");
	}

	invalidate(): void {}
}
