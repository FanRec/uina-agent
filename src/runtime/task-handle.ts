/**
 * Universal Asynchronous Task Output Buffer & Wait Synchronization.
 *
 * Core runtime layer: provides common output ring-buffering with cursor-based
 * pagination and budget eviction, as well as condition-based waiting.
 * Domain-specific policies, statuses, and life-cycles remain fully independent
 * in their respective extensions (e.g. Jobs and Subagents).
 */

export interface TaskOutputBufferOptions {
	/** Maximum accumulated UTF-8 bytes to retain in the buffer before evicting oldest chunks. */
	readonly maxBytes?: number;
	/** Maximum accumulated newline-delimited lines to retain. */
	readonly maxLines?: number;
}

export interface TaskBufferRead<TChunk> {
	readonly cursor: number;
	readonly chunks: TChunk[];
	readonly outputLost: boolean;
}

/**
 * High-performance, cursor-indexed ring buffer for streaming output chunks.
 * Enforces byte and line capacity budgets, automatically drops oldest chunks,
 * and accurately calculates whether output was lost relative to any requested cursor.
 */
export class TaskOutputBuffer<TChunk extends { text: string }> {
	private readonly items: Array<TChunk & { cursor: number }> = [];
	private readonly waiters = new TaskWaiters();
	private nextCursor = 1;
	private lastCursor = 0;
	private outputBytes = 0;
	private outputLines = 0;

	constructor(private readonly options: TaskOutputBufferOptions = {}) {}

	append(chunk: TChunk, byteLength?: number, lineCount?: number): TChunk & { cursor: number } {
		const cursor = this.nextCursor++;
		this.lastCursor = cursor;
		const item = { ...chunk, cursor };
		this.items.push(item);
		this.outputBytes += byteLength ?? Buffer.byteLength(chunk.text, "utf8");
		if (lineCount !== undefined) {
			this.outputLines += lineCount;
		} else if (this.options.maxLines !== undefined) {
			this.outputLines += countLines(chunk.text);
		}
		this.evict();
		this.waiters.notify();
		return item;
	}

	notify(): void {
		this.waiters.notify();
	}

	wait(condition: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		return this.waiters.wait(condition, timeoutMs, signal);
	}

	private evict(): void {
		const maxBytes = this.options.maxBytes;
		const maxLines = this.options.maxLines;
		while (
			this.items.length > 0 &&
			((maxBytes !== undefined && this.outputBytes > maxBytes) ||
				(maxLines !== undefined && this.outputLines > maxLines))
		) {
			const removed = this.items.shift()!;
			this.outputBytes -= Buffer.byteLength(removed.text, "utf8");
			if (maxLines !== undefined) {
				this.outputLines -= countLines(removed.text);
			}
		}
		if (this.items.length === 0) {
			this.outputBytes = 0;
			this.outputLines = 0;
		}
	}

	read(cursor = 0): TaskBufferRead<TChunk & { cursor: number }> {
		if (!Number.isSafeInteger(cursor) || cursor < 0) {
			throw new Error("cursor 无效");
		}
		const first = this.items[0]?.cursor ?? this.nextCursor;
		const outputLost = cursor < first - 1;
		const chunks = this.items.filter((item) => item.cursor > cursor);
		return {
			cursor: this.items.at(-1)?.cursor ?? this.lastCursor,
			chunks,
			outputLost,
		};
	}

	clear(): void {
		this.items.length = 0;
		this.outputBytes = 0;
		this.outputLines = 0;
	}

	get bytes(): number {
		return this.outputBytes;
	}

	get lines(): number {
		return this.outputLines;
	}

	get currentCursor(): number {
		return this.lastCursor;
	}

	get rawItems(): ReadonlyArray<TChunk & { cursor: number }> {
		return this.items;
	}
}

export function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

/**
 * Lightweight listener coordinator for asynchronous event waiting.
 * Allows callers to suspend execution until a condition is fulfilled,
 * a timeout expires, or an abort signal is triggered.
 */
export class TaskWaiters {
	private readonly listeners = new Set<() => void>();

	notify(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				/* Listener errors must not disrupt notification loop */
			}
		}
	}

	async wait(
		condition: () => boolean,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new Error("等待时间无效");
		}
		if (condition()) return;
		if (signal?.aborted) throw new Error("等待已取消");

		await new Promise<void>((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			function cleanup(): void {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
			function done(): void {
				cleanup();
				resolve();
			}
			const onAbort = (): void => {
				cleanup();
				this.listeners.delete(onChange);
				reject(new Error("等待已取消"));
			};
			const onChange = (): void => {
				if (condition()) {
					this.listeners.delete(onChange);
					done();
				}
			};

			timer = setTimeout(() => {
				this.listeners.delete(onChange);
				done();
			}, timeoutMs);
			this.listeners.add(onChange);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}

