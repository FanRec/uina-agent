/** A query-bound invalidation hint, shared by current and committed history sources. */
import { createHash } from "node:crypto";
import { callFailure, type JsonValue, type ObservationCursor } from "../contracts/values.js";
import type { WorldChange, WorldWatch } from "../contracts/world.js";

function canonical(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((k) => JSON.stringify(k) + ":" + canonical(value[k]!))
			.join(",")}}`;
	return JSON.stringify(value);
}
export function queryStream(ref: string, input: JsonValue, source: string): string {
	return createHash("sha256")
		.update(canonical([ref, input, source]))
		.digest("hex");
}
export function watchFailure(code: string, message: string): Error {
	return callFailure({ code, message, source: "world", dispatch: "not_sent", effects: [], recoverable: false });
}
export function checkCursor(value: ObservationCursor): void {
	if (
		!value ||
		typeof value.stream !== "string" ||
		typeof value.epoch !== "string" ||
		!Number.isSafeInteger(value.sequence) ||
		value.sequence < 0
	)
		throw watchFailure("INVALID_INPUT", "invalid observation version");
}
type Waiter = {
	after: ObservationCursor;
	signal: AbortSignal;
	abort(): void;
	resolve(change: WorldChange): void;
	reject(error: Error): void;
};
export class ObservationWatch implements WorldWatch {
	private closed = false;
	private waiters = new Set<Waiter>();
	constructor(
		private current: ObservationCursor,
		private dispose: () => void,
		private checkpoint?: () => ObservationCursor,
	) {}
	update(cursor: ObservationCursor): void {
		if (this.closed) return;
		// Late hints from the same source cannot move an invalidation watermark backwards.
		if (
			cursor.stream === this.current.stream &&
			cursor.epoch === this.current.epoch &&
			cursor.sequence < this.current.sequence
		)
			return;
		this.current = { ...cursor };
		for (const waiter of [...this.waiters]) {
			const change = this.compare(waiter.after);
			if (change) {
				this.remove(waiter);
				waiter.resolve(change);
			}
		}
	}
	private compare(after: ObservationCursor): WorldChange | null {
		const cursor = { ...this.current };
		if (after.stream !== cursor.stream) return { kind: "reset", reason: "stream_changed", cursor };
		if (after.epoch !== cursor.epoch) return { kind: "reset", reason: "epoch_changed", cursor };
		if (after.sequence > cursor.sequence) return { kind: "reset", reason: "cursor_expired", cursor };
		return after.sequence < cursor.sequence ? { kind: "changed", cursor, changed: [] } : null;
	}
	async next(after: ObservationCursor, signal: AbortSignal): Promise<WorldChange> {
		checkCursor(after);
		if (this.closed) throw watchFailure("INTERRUPTED", "world watch is closed");
		signal.throwIfAborted();
		const known = this.compare(after);
		if (known) return known;
		if (this.checkpoint) this.update(this.checkpoint());
		const change = this.compare(after);
		if (change) return change;
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				after: { ...after },
				signal,
				resolve,
				reject,
				abort: () => {
					this.remove(waiter);
					reject(signal.reason);
				},
			};
			this.waiters.add(waiter);
			signal.addEventListener("abort", waiter.abort, { once: true });
		});
	}
	private remove(waiter: Waiter): void {
		this.waiters.delete(waiter);
		waiter.signal.removeEventListener("abort", waiter.abort);
	}
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		for (const waiter of [...this.waiters]) {
			this.remove(waiter);
			waiter.reject(watchFailure("INTERRUPTED", "world watch closed while waiting"));
		}
	}
}
