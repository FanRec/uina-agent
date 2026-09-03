import type { Component } from "../../core/types.js";

export class Text implements Component {
	constructor(private text: string) {}

	setText(text: string): void {
		this.text = text;
	}

	render(_width: number): string[] {
		return [this.text];
	}

	invalidate(): void {}
}
