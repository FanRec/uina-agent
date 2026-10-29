import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../.uina/worlds/bilibili-live/src/config.js";
import { DanmakuWindow } from "../.uina/worlds/bilibili-live/src/danmaku.js";
import type { WorldEvent } from "../src/extensions/world-framework/types.js";

const event = (uid: number, uname: string, text: string) => ({
	kind: "danmaku" as const,
	eventId: `${uid}-${text}`,
	uid,
	uname,
	text,
	occurredAtMs: 0,
});

function createHarness(maxItems = 16) {
	const events: WorldEvent[] = [];
	const listeners: Array<(event: { readonly type: string; readonly [key: string]: unknown }) => void> = [];
	const config = loadConfig({
		defaultRoomId: 123,
		buffer: { maxItems },
		storage: { dataDir: "./tmp-danmaku-test" },
	});
	const window = new DanmakuWindow(config);
	window.start({
		signal: new AbortController().signal,
		emitEvent: async (item) => {
			events.push(item);
		},
		onHostEvent: (listener) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
	});
	window.reset(123);
	window.setEnabled(true);
	const emit = (event: { readonly type: string; readonly [key: string]: unknown }) => {
		for (const listener of listeners) listener(event);
	};
	type Settlement =
		| { readonly outcome: "committed" }
		| {
				readonly outcome: "retired";
				readonly reason: "empty_render" | "claimed" | "already_recorded" | "missing_render";
		  };
	const settle = (inputId: string, settlement: Settlement = { outcome: "committed" }) => {
		emit({ type: "input_settled", inputId, ...settlement });
	};
	const accepted = (inputId: string) => emit({ type: "input_accepted", inputId });
	return { window, events, accepted, settle };
}

describe("DanmakuWindow", () => {
	it("keeps capacity in raw messages and reports covered messages", () => {
		vi.useFakeTimers();
		try {
			const h = createHarness(2);
			h.window.add(event(1, "Alice", "one"), 0);
			h.window.add(event(2, "Bob", "two"), 1);
			h.window.add(event(3, "Carol", "three"), 2);
			vi.advanceTimersByTime(2000);
			expect(h.events).toHaveLength(1);
			const body = h.events[0]!.render!() as string;
			expect(body).toContain("覆盖1条");
			expect(body).toContain("Bob");
			expect(body).toContain("Carol");
			expect(body).not.toContain("Alice");
			h.accepted(h.events[0]!.id);
			h.settle(h.events[0]!.id);
			h.window.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not create another input while the current one is unsettled, and renders later arrivals together", () => {
		vi.useFakeTimers();
		try {
			const h = createHarness();
			h.window.add(event(1, "Alice", "hello"), 0);
			vi.advanceTimersByTime(2000);
			const first = h.events[0]!;
			h.window.add(event(2, "Bob", "today?"), 3);
			h.window.add(event(3, "Carol", "ready"), 4);
			vi.advanceTimersByTime(10000);
			expect(h.events).toHaveLength(1);
			const body = first.render!() as string;
			expect(body).toContain("Alice");
			expect(body).toContain("Bob");
			expect(body).toContain("Carol");
			h.accepted(first.id);
			h.settle(first.id);
			h.window.add(event(4, "Dave", "next"), 5);
			vi.advanceTimersByTime(2000);
			expect(h.events).toHaveLength(2);
			h.window.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the room identity captured when delivery was created", () => {
		vi.useFakeTimers();
		try {
			const h = createHarness();
			h.window.add(event(1, "Alice", "first"), 0);
			vi.advanceTimersByTime(2000);
			h.window.resolveRoom(456);
			const body = h.events[0]!.render!() as string;
			expect(body).toContain("房间123");
			expect(body).not.toContain("房间456");
			expect(h.events[0]!.data).toEqual({ roomId: 123, epoch: 2 });
			h.window.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("freezes the first rendered body so retries cannot mix later messages", () => {
		vi.useFakeTimers();
		try {
			const h = createHarness();
			h.window.add(event(1, "Alice", "first"), 0);
			vi.advanceTimersByTime(2000);
			const first = h.events[0]!;
			const body = first.render!() as string;
			h.window.add(event(2, "Bob", "later"), 1);
			expect(first.render!()).toBe(body);
			h.accepted(first.id);
			h.settle(first.id);
			h.window.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not carry ordinary messages across disable/re-enable or room reset", () => {
		vi.useFakeTimers();
		try {
			const h = createHarness();
			h.window.setEnabled(false);
			h.window.add(event(1, "Alice", "muted"), 0);
			vi.advanceTimersByTime(3000);
			expect(h.events).toHaveLength(0);
			h.window.setEnabled(true);
			h.window.add(event(2, "Bob", "new"), 4000);
			vi.advanceTimersByTime(2000);
			expect(h.events).toHaveLength(1);
			const old = h.events[0]!;
			h.window.reset(456);
			expect(old.render!()).toBeNull();
			h.settle(old.id, { outcome: "retired", reason: "empty_render" });
			h.window.add(event(3, "Carol", "room456"), 7000);
			vi.advanceTimersByTime(2000);
			expect(h.events).toHaveLength(2);
			expect(h.events[1]!.render!() as string).toContain("房间456");
			h.window.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("compresses only adjacent same-user same-text messages", () => {
		vi.useFakeTimers();
		try {
			const h = createHarness();
			h.window.add(event(1, "Alice", "same"), 0);
			h.window.add(event(1, "Alice", "same"), 1);
			h.window.add(event(2, "Bob", "same"), 2);
			h.window.add(event(1, "Alice", "same"), 3);
			vi.advanceTimersByTime(2000);
			const body = h.events[0]!.render!() as string;
			expect(body).toContain("Alice");
			expect(body).toContain("×2");
			expect(body).toContain("Bob");
			expect(body.split("×2")).toHaveLength(2);
			h.window.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});
