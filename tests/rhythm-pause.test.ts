import { describe, expect, it } from "vitest";
import { type ClockSource, RhythmEngine } from "../.uina/worlds/rhythm/src/engine.js";

class Clock implements ClockSource {
	now = 0;
	timers = new Map<number, { due: number; fn: () => void }>();
	next = 1;
	nowMono() {
		return this.now;
	}
	nowEpoch() {
		return 1_700_000_000_000 + this.now;
	}
	setTimeout(fn: () => void, delay: number) {
		const id = this.next++;
		this.timers.set(id, { due: this.now + delay, fn });
		return id as unknown as NodeJS.Timeout;
	}
	clearTimeout(timer: NodeJS.Timeout) {
		this.timers.delete(Number(timer));
	}
	async advance(ms: number) {
		this.now += ms;
		for (const [id, timer] of [...this.timers]) {
			if (timer.due <= this.now) {
				this.timers.delete(id);
				timer.fn();
			}
		}
		await Promise.resolve();
	}
}

describe("rhythm state boundaries", () => {
	it("rejects non-finite pauses", async () => {
		const clock = new Clock();
		const engine = new RhythmEngine(
			{
				isBusy: () => false,
				submitOpportunity: async () => {},
				submitReminder: async () => {},
				saveDurableState: async () => {},
			},
			undefined,
			undefined,
			clock,
		);
		await expect(engine.pause(Infinity)).rejects.toThrow();
	});

	it("does not reschedule after stop while an opportunity is in flight", async () => {
		const clock = new Clock();
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let submitted = 0;
		const engine = new RhythmEngine(
			{
				isBusy: () => false,
				submitOpportunity: async () => {
					submitted++;
					await pending;
				},
				submitReminder: async () => {},
				saveDurableState: async () => {},
			},
			{ baseIntervalMs: 1 },
			undefined,
			clock,
		);
		engine.start();
		await clock.advance(60_000);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(submitted).toBe(1);
		engine.stop();
		release();
		await Promise.resolve();
		await clock.advance(60_000);
		expect(submitted).toBe(1);
	});
});
