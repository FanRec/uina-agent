import { appendFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2000;
const TAIL_BUFFER_BYTES = MAX_OUTPUT_BYTES * 2;

export interface OutputSnapshot {
	content: string;
	totalBytes: number;
	totalLines: number;
	truncated: boolean;
	truncatedBy: "bytes" | "lines" | null;
	fullOutputPath?: string;
}

/** Keeps a bounded UTF-8 tail and writes the complete stream after truncation starts. */
export class OutputCollector {
	private readonly decoder = createByteDecoder();
	private tail = "";
	private prefix = "";
	private totalBytes = 0;
	private completedLines = 0;
	private openLine = false;
	private fullOutputPath?: string;

	push(chunk: Buffer): string {
		const text = this.decoder.push(chunk);
		if (!text) return "";
		this.totalBytes += Buffer.byteLength(text, "utf8");
		this.completedLines += countNewlines(text);
		this.openLine = !text.endsWith("\n");
		if (!this.fullOutputPath) {
			this.prefix += text;
			if (this.isTruncated()) {
				this.createFullOutput(this.prefix);
				this.prefix = "";
			}
		} else {
			appendFileSync(this.fullOutputPath, text, "utf8");
		}
		this.tail += text;
		this.tail = trimTailToBytes(this.tail, TAIL_BUFFER_BYTES);
		return text;
	}

	finish(): void {
		const text = this.decoder.flush();
		if (text) this.push(Buffer.from(text, "utf8"));
		if (!this.fullOutputPath && this.isTruncated()) {
			this.createFullOutput(this.prefix);
			this.prefix = "";
		}
	}

	snapshot(): OutputSnapshot {
		const totalLines = this.totalLines();
		const truncated = totalLines > MAX_OUTPUT_LINES || this.totalBytes > MAX_OUTPUT_BYTES;
		const truncatedBy = truncated
			? this.totalBytes > MAX_OUTPUT_BYTES
				? "bytes"
				: "lines"
			: null;
		return {
			content: truncated ? truncateTail(this.tail) : this.tail,
			totalBytes: this.totalBytes,
			totalLines,
			truncated,
			truncatedBy,
			fullOutputPath: this.fullOutputPath,
		};
	}

	private isTruncated(): boolean {
		return this.totalBytes > MAX_OUTPUT_BYTES || this.totalLines() > MAX_OUTPUT_LINES;
	}

	private totalLines(): number {
		return this.totalBytes === 0 ? 0 : this.completedLines + (this.openLine ? 1 : 0);
	}

	private createFullOutput(content: string): void {
		if (this.fullOutputPath) return;
		this.fullOutputPath = join(
			tmpdir(),
			`uina-exec-${Date.now()}-${randomBytes(6).toString("hex")}.out.txt`,
		);
		writeFileSync(this.fullOutputPath, content, "utf8");
	}
}

function trimTailToBytes(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

function truncateTail(value: string): string {
	const lines = value.split("\n");
	let bytes = 0;
	const kept: string[] = [];
	for (let i = lines.length - 1; i >= 0; i--) {
		if (kept.length >= MAX_OUTPUT_LINES) break;
		const lineBytes = Buffer.byteLength(lines[i], "utf8") + (kept.length > 0 ? 1 : 0);
		if (bytes + lineBytes > MAX_OUTPUT_BYTES) {
			if (kept.length === 0) kept.unshift(trimTailToBytes(lines[i], MAX_OUTPUT_BYTES));
			break;
		}
		kept.unshift(lines[i]);
		bytes += lineBytes;
	}
	return kept.join("\n");
}

function countNewlines(value: string): number {
	let count = 0;
	for (const char of value) if (char === "\n") count++;
	return count;
}

/** UTF-8 decoder that preserves split code points and uses latin1 for bad chunks. */
export function createByteDecoder(): { push(buf: Buffer): string; flush(): string } {
	let pending: number[] = [];
	return {
		push(buf: Buffer): string {
			pending.push(...buf);
			return drain(false);
		},
		flush(): string {
			return drain(true);
		},
	};

	function drain(flush: boolean): string {
		let output = "";
		let offset = 0;
		while (offset < pending.length) {
			const first = pending[offset];
			const width = utf8Width(first);
			if (width === 1) {
				output += String.fromCharCode(first);
				offset++;
				continue;
			}
			if (width === 0) {
				output += String.fromCharCode(first);
				offset++;
				continue;
			}
			if (pending.length - offset < width) {
				if (!flush) break;
				for (; offset < pending.length; offset++) {
					output += String.fromCharCode(pending[offset]);
				}
				break;
			}
			const bytes = pending.slice(offset, offset + width);
			if (!isValidUtf8Sequence(bytes)) {
				output += String.fromCharCode(first);
				offset++;
				continue;
			}
			output += Buffer.from(bytes).toString("utf8");
			offset += width;
		}
		pending = pending.slice(offset);
		return output;
	}
}

function utf8Width(first: number): number {
	if (first <= 0x7f) return 1;
	if (first >= 0xc2 && first <= 0xdf) return 2;
	if (first >= 0xe0 && first <= 0xef) return 3;
	if (first >= 0xf0 && first <= 0xf4) return 4;
	return 0;
}

function isValidUtf8Sequence(bytes: number[]): boolean {
	const first = bytes[0];
	if (bytes.slice(1).some((byte) => byte < 0x80 || byte > 0xbf)) return false;
	if (bytes.length === 2) return true;
	const second = bytes[1];
	if (bytes.length === 3) {
		if (first === 0xe0) return second >= 0xa0;
		if (first === 0xed) return second <= 0x9f;
		return true;
	}
	if (first === 0xf0) return second >= 0x90;
	if (first === 0xf4) return second <= 0x8f;
	return true;
}
