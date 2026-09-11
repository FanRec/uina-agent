import { describe, expect, it } from "vitest";
import {
	TaskOutputBuffer,
	TaskWaiters,
	countLines,
} from "../src/runtime/task-handle.js";

describe("countLines", () => {
	it("returns 0 for empty strings and line count for delimited strings", () => {
		expect(countLines("")).toBe(0);
		expect(countLines("hello")).toBe(1);
		expect(countLines("hello\nworld")).toBe(2);
		expect(countLines("a\nb\nc\n")).toBe(4);
	});
});

describe("TaskOutputBuffer", () => {
	it("assigns incrementing cursors and slices output correctly", () => {
		const buffer = new TaskOutputBuffer<{ text: string }>();
		expect(buffer.currentCursor).toBe(0);

		buffer.append({ text: "first" });
		buffer.append({ text: "second" });
		buffer.append({ text: "third" });

		expect(buffer.currentCursor).toBe(3);
		const readAll = buffer.read(0);
		expect(readAll.cursor).toBe(3);
		expect(readAll.outputLost).toBe(false);
		expect(readAll.chunks.map((c) => c.text)).toEqual(["first", "second", "third"]);
		expect(readAll.chunks.map((c) => c.cursor)).toEqual([1, 2, 3]);

		const readPartial = buffer.read(2);
		expect(readPartial.chunks.map((c) => c.text)).toEqual(["third"]);
		expect(readPartial.outputLost).toBe(false);

		expect(() => buffer.read(-1)).toThrow("cursor 无效");
		expect(() => buffer.read(Number.NaN)).toThrow("cursor 无效");
	});

	it("enforces byte budget by evicting oldest chunks and flagging outputLost", () => {
		const buffer = new TaskOutputBuffer<{ text: string }>({ maxBytes: 20 });
		buffer.append({ text: "1234567890" }); // 10 bytes, cursor 1
		buffer.append({ text: "abcdefghij" }); // 10 bytes, cursor 2; total 20 bytes
		expect(buffer.read(0).outputLost).toBe(false);

		buffer.append({ text: "xyz" }); // 3 bytes, total 23 > 20 -> cursor 1 evicted
		expect(buffer.bytes).toBe(13);

		const readFromZero = buffer.read(0);
		expect(readFromZero.outputLost).toBe(true);
		expect(readFromZero.chunks.map((c) => c.cursor)).toEqual([2, 3]);

		const readFromOne = buffer.read(1);
		// cursor 1 is not strictly less than first(2) - 1, so outputLost is false
		expect(readFromOne.outputLost).toBe(false);
		expect(readFromOne.chunks.map((c) => c.cursor)).toEqual([2, 3]);
	});

	it("enforces line budget by evicting oldest chunks", () => {
		const buffer = new TaskOutputBuffer<{ text: string }>({ maxLines: 5 });
		buffer.append({ text: "line1\nline2\nline3" }); // 3 lines, cursor 1
		expect(buffer.lines).toBe(3);

		buffer.append({ text: "line4\nline5\nline6" }); // 3 lines, cursor 2 -> 6 lines > 5 -> cursor 1 evicted
		expect(buffer.lines).toBe(3);
		expect(buffer.read(0).outputLost).toBe(true);
		expect(buffer.read(0).chunks.map((c) => c.cursor)).toEqual([2]);
	});

	it("resets counters on clear but preserves lastCursor", () => {
		const buffer = new TaskOutputBuffer<{ text: string }>();
		buffer.append({ text: "abc" });
		buffer.append({ text: "def" });
		expect(buffer.currentCursor).toBe(2);
		expect(buffer.bytes).toBe(6);

		buffer.clear();
		expect(buffer.bytes).toBe(0);
		expect(buffer.lines).toBe(0);
		expect(buffer.currentCursor).toBe(2);

		const read = buffer.read(0);
		expect(read.outputLost).toBe(true);
		expect(read.cursor).toBe(2);
		expect(read.chunks).toEqual([]);
	});
});

describe("TaskWaiters", () => {
	it("resolves immediately when condition is met", async () => {
		const waiters = new TaskWaiters();
		await expect(waiters.wait(() => true, 1000)).resolves.toBeUndefined();
	});

	it("rejects invalid timeout values", async () => {
		const waiters = new TaskWaiters();
		await expect(waiters.wait(() => false, 0)).rejects.toThrow("等待时间无效");
		await expect(waiters.wait(() => false, -10)).rejects.toThrow("等待时间无效");
		await expect(waiters.wait(() => false, Number.NaN)).rejects.toThrow("等待时间无效");
	});

	it("wakes up and resolves when notify satisfies the condition", async () => {
		const waiters = new TaskWaiters();
		let ready = false;

		const waitPromise = waiters.wait(() => ready, 2000);
		expect(ready).toBe(false);

		ready = true;
		waiters.notify();
		await expect(waitPromise).resolves.toBeUndefined();
	});

	it("resolves on timeout even if condition is false", async () => {
		const waiters = new TaskWaiters();
		await expect(waiters.wait(() => false, 10)).resolves.toBeUndefined();
	});

	it("rejects when abort signal is triggered before or during wait", async () => {
		const waiters = new TaskWaiters();

		// Already aborted
		const preAborted = new AbortController();
		preAborted.abort();
		await expect(waiters.wait(() => false, 1000, preAborted.signal)).rejects.toThrow("等待已取消");

		// Aborted during wait
		const liveController = new AbortController();
		const waitingPromise = waiters.wait(() => false, 1000, liveController.signal);
		liveController.abort();
		await expect(waitingPromise).rejects.toThrow("等待已取消");
	});
});
