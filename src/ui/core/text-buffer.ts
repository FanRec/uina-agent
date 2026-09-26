import { getNextGraphemeIndex, getPrevGraphemeIndex, graphemeSegmenter } from "./utils.js";

/** Minimal grapheme-aware editor state shared by prompt and editor inputs. */
export class TextBuffer {
	private value = "";
	private position = 0;

	get text(): string { return this.value; }
	get cursor(): number { return this.position; }
	get cursorGrapheme(): string {
		for (const segment of graphemeSegmenter.segment(this.value.slice(this.position))) return segment.segment;
		return "";
	}

	setText(text: string): void {
		this.value = text;
		this.position = text.length;
	}

	setCursor(cursor: number): void {
		const clamped = Math.max(0, Math.min(cursor, this.value.length));
		this.position = clamped;
		for (const segment of graphemeSegmenter.segment(this.value)) {
			const end = segment.index + segment.segment.length;
			if (clamped === segment.index || clamped === end) return;
			if (clamped > segment.index && clamped < end) {
				this.position = segment.index;
				return;
			}
		}
	}

	insert(text: string): void {
		this.value = this.value.slice(0, this.position) + text + this.value.slice(this.position);
		this.position += text.length;
	}

	deleteBackward(): void {
		if (this.position === 0) return;
		const start = getPrevGraphemeIndex(this.value, this.position);
		this.value = this.value.slice(0, start) + this.value.slice(this.position);
		this.position = start;
	}

	deleteForward(): void {
		if (this.position >= this.value.length) return;
		const end = getNextGraphemeIndex(this.value, this.position);
		this.value = this.value.slice(0, this.position) + this.value.slice(end);
	}

	moveLeft(): void { this.position = getPrevGraphemeIndex(this.value, this.position); }
	moveRight(): void { this.position = getNextGraphemeIndex(this.value, this.position); }
	moveHome(): void { this.position = 0; }
	moveEnd(): void { this.position = this.value.length; }
}
