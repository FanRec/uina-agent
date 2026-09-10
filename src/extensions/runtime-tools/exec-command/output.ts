import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { finished } from "node:stream/promises";
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

/**
 * Keeps a bounded UTF-8 tail and streams the complete output to a temp file once
 * truncation starts. Mirrors Pi's OutputAccumulator: a streaming TextDecoder
 * (no hand-rolled byte walker) and an async WriteStream (no sync I/O in the
 * stdout/stderr callbacks). The temp file is an intentional artifact: it is the
 * only way to read output that no longer fits the returned tail, and its path is
 * part of the tool result.
 */
export class OutputCollector {
	private readonly decoder = new TextDecoder("utf-8");
	private tail = "";
	private rawChunks: Buffer[] = [];
	private ended = false;
	private failure?: Error;
	private totalBytes = 0;
	private completedLines = 0;
	private openLine = false;
	private fullOutputPath?: string;
	private tempStream?: WriteStream;

	constructor(private readonly onError?: (error: Error) => void) {}

	push(chunk: Buffer): string {
		if (this.failure) throw this.failure;
		if (this.ended) throw new Error("输出收集器已结束");
		const text = this.decoder.decode(chunk, { stream: true });
		this.appendText(text);
		// The artifact contains original bytes, independently of decoder buffering.
		if (!this.tempStream && this.isTruncated()) this.openTempFile();
		if (this.tempStream) this.tempStream.write(chunk);
		else this.rawChunks.push(chunk);
		return text;
	}

	finish(): void {
		if (this.ended) return;
		this.ended = true;
		this.appendText(this.decoder.decode());
		if (!this.tempStream && this.isTruncated()) this.openTempFile();
	}

	/** Close even after an asynchronous stream failure; never publish a path
	 * as complete before the stream has finished and closed. */
	async close(): Promise<void> {
		this.finish();
		const stream = this.tempStream;
		if (stream) {
			try {
				const closed = finished(stream, { cleanup: true });
				stream.end();
				await closed;
			} catch (error) {
				this.fail(error as Error);
			}
		}
		if (this.failure) throw this.failure;
	}

	private appendText(text: string): void {
		if (!text) return;
		this.totalBytes += Buffer.byteLength(text, "utf8");
		this.completedLines += countNewlines(text);
		this.openLine = !text.endsWith("\n");
		this.tail = trimTailToBytes(this.tail + text, TAIL_BUFFER_BYTES);
	}

	private fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		this.onError?.(error);
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

	private openTempFile(): void {
		if (this.tempStream) return;
		this.fullOutputPath = join(
			tmpdir(),
			`uina-exec-${Date.now()}-${randomBytes(6).toString("hex")}.out.txt`,
		);
		this.tempStream = createWriteStream(this.fullOutputPath);
		this.tempStream.on("error", (error) => this.fail(error));
		for (const chunk of this.rawChunks) this.tempStream.write(chunk);
		this.rawChunks = [];
	}
}

function trimTailToBytes(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

function truncateTail(value: string): string {
	const lines = value.split("\n");
	let bytes = 0;
	const kept: string[] = [];
	for (let i = lines.length - 1; i >= 0; i--) {
		if (kept.length >= MAX_OUTPUT_LINES) break;
		const lineBytes = Buffer.byteLength(lines[i]!, "utf8") + (kept.length > 0 ? 1 : 0);
		if (bytes + lineBytes > MAX_OUTPUT_BYTES) {
			if (kept.length === 0) kept.unshift(trimTailToBytes(lines[i]!, MAX_OUTPUT_BYTES));
			break;
		}
		kept.unshift(lines[i]!);
		bytes += lineBytes;
	}
	return kept.join("\n");
}

function countNewlines(value: string): number {
	let count = 0;
	for (let i = value.indexOf("\n"); i !== -1; i = value.indexOf("\n", i + 1)) count++;
	return count;
}
