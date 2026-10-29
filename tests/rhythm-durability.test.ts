import { describe, expect, it } from "vitest";
import { type ClockSource, RhythmEngine } from "../.uina/worlds/rhythm/src/engine.js";
import type { RhythmDurableState, RhythmHostPort } from "../.uina/worlds/rhythm/src/types.js";

class Clock implements ClockSource {
	mono = 1_000;
	epoch = new Date(2026, 8, 28, 23, 59).getTime();
	private timers = new Map<number, { due: number; run: () => void }>();
	private nextId = 1;
	private longestDelay = 0;
	nowMono() {
		return this.mono;
	}
	nowEpoch() {
		return this.epoch;
	}
	setTimeout(run: () => void, delay: number) {
		this.longestDelay = Math.max(this.longestDelay, delay);
		const id = this.nextId++;
		this.timers.set(id, { due: this.mono + delay, run });
		return id as unknown as NodeJS.Timeout;
	}
	clearTimeout(timer: NodeJS.Timeout) {
		this.timers.delete(Number(timer));
	}
	longestTimerDelay() {
		return this.longestDelay;
	}
	async advance(ms: number) {
		this.mono += ms;
		this.epoch += ms;
		for (const [id, timer] of [...this.timers]) {
			if (timer.due <= this.mono) {
				this.timers.delete(id);
				timer.run();
			}
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

const deferred = () => {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

describe("rhythm durable time rules", () => {
	it("does not consume a daily opportunity when delivery fails", async () => {
		const clock = new Clock();
		const host: RhythmHostPort = {
			isBusy: () => false,
			submitOpportunity: async () => {
				throw new Error("delivery failed");
			},
			submitReminder: async () => {},
			saveDurableState: async () => {},
		};
		const engine = new RhythmEngine(host, { baseIntervalMs: 60_000 }, undefined, clock);
		engine.start();
		await clock.advance(60_000);
		expect(engine.getStatus().dailyAttemptsUsed).toBe(0);
		engine.stop();
	});

	it("retries the scheduler after a host busy check throws", async () => {
		const clock = new Clock();
		let busyChecks = 0;
		let submitted = 0;
		const engine = new RhythmEngine(
			{
				isBusy: () => {
					busyChecks++;
					if (busyChecks === 1) throw new Error("host temporarily unavailable");
					return false;
				},
				submitOpportunity: async () => {
					submitted++;
				},
				submitReminder: async () => {},
				saveDurableState: async () => {},
			},
			{ baseIntervalMs: 60_000 },
			undefined,
			clock,
		);
		engine.start();
		await clock.advance(60_000);
		expect(submitted).toBe(0);
		await clock.advance(14_999);
		expect(submitted).toBe(0);
		await clock.advance(1);
		expect(submitted).toBe(1);
		await engine.stop();
	});

	it("serializes consecutive changes and exposes each only after its save", async () => {
		const clock = new Clock();
		const firstSave = deferred();
		const saved: number[] = [];
		const host: RhythmHostPort = {
			isBusy: () => false,
			submitOpportunity: async () => {},
			submitReminder: async () => {},
			saveDurableState: async (state) => {
				saved.push(state.baseIntervalMs);
				if (saved.length === 1) await firstSave.promise;
			},
		};
		const engine = new RhythmEngine(host, undefined, undefined, clock);
		engine.start();
		const first = engine.setInterval(10);
		const second = engine.setInterval(20);
		await Promise.resolve();
		expect(saved).toEqual([600_000]);
		expect(engine.getStatus().baseIntervalMinutes).toBe(3);
		firstSave.resolve();
		await Promise.all([first, second]);
		expect(saved).toEqual([600_000, 1_200_000]);
		expect(engine.getStatus().baseIntervalMinutes).toBe(20);
		engine.stop();
	});

	it("keeps the prior pause when replacing it fails", async () => {
		const clock = new Clock();
		let fail = false;
		const host: RhythmHostPort = {
			isBusy: () => false,
			submitOpportunity: async () => {},
			submitReminder: async () => {},
			saveDurableState: async () => {
				if (fail) throw new Error("disk full");
			},
		};
		const engine = new RhythmEngine(host, undefined, undefined, clock);
		engine.start();
		await engine.pause(10);
		fail = true;
		await expect(engine.pause(20)).rejects.toThrow("disk full");
		expect(engine.getStatus().isPaused).toBe(true);
		await clock.advance(10 * 60_000);
		expect(engine.getStatus().isPaused).toBe(false);
		engine.stop();
	});

	it("keeps the pause when resume cannot be saved", async () => {
		const clock = new Clock();
		let fail = false;
		const host: RhythmHostPort = {
			isBusy: () => false,
			submitOpportunity: async () => {},
			submitReminder: async () => {},
			saveDurableState: async () => {
				if (fail) throw new Error("disk full");
			},
		};
		const engine = new RhythmEngine(host, undefined, undefined, clock);
		engine.start();
		await engine.pause(10);
		fail = true;
		await expect(engine.resume()).rejects.toThrow("disk full");
		expect(engine.getStatus().isPaused).toBe(true);
		engine.stop();
	});

	it("does not retain a temporary pause when concurrent pause writes all fail", async () => {
		const clock = new Clock();
		const engine = new RhythmEngine(
			{
				isBusy: () => false,
				submitOpportunity: async () => {},
				submitReminder: async () => {},
				saveDurableState: async () => {
					throw new Error("disk full");
				},
			},
			undefined,
			undefined,
			clock,
		);
		engine.start();
		const pauses = await Promise.allSettled([engine.pause(10), engine.pause(20)]);
		expect(pauses.every((result) => result.status === "rejected")).toBe(true);
		expect(engine.getStatus().isPaused).toBe(false);
		engine.stop();
	});

	it("does not submit an opportunity when the day reset cannot be saved", async () => {
		const clock = new Clock();
		const submitted: string[] = [];
		const today = new Date(clock.epoch).toDateString();
		const initial: RhythmDurableState = {
			baseIntervalMs: 60_000,
			pausedUntilEpochMs: null,
			dailyAttempts: { date: today, count: 1 },
			reminders: [],
			nextReminderSequence: 1,
		};
		const host: RhythmHostPort = {
			isBusy: () => false,
			submitOpportunity: async (text) => {
				submitted.push(text);
			},
			submitReminder: async () => {},
			saveDurableState: async () => {
				throw new Error("disk full");
			},
		};
		const engine = new RhythmEngine(host, initial, { maxDailyAttempts: 1 }, clock);
		engine.start();
		await clock.advance(60_000);
		expect(submitted).toEqual([]);
		expect(engine.getStatus().dailyAttemptsUsed).toBe(0);
		engine.stop();
	});

	it("keeps long pauses scheduled within the timer limit", async () => {
		const clock = new Clock();
		const submitted: string[] = [];
		const host: RhythmHostPort = {
			isBusy: () => false,
			submitOpportunity: async (text) => {
				submitted.push(text);
			},
			submitReminder: async () => {},
			saveDurableState: async () => {},
		};
		const engine = new RhythmEngine(host, undefined, undefined, clock);
		engine.start();
		await engine.pause(50_000);
		// Node coerces delays above 2^31 - 1 ms to 1 ms.
		expect(clock.longestTimerDelay()).toBeLessThanOrEqual(2_147_483_647);
		await clock.advance(2_147_483_647);
		expect(submitted).toEqual([]);
		expect(engine.getStatus().isPaused).toBe(true);
		engine.stop();
	});

	it("reports zero usage after local midnight before the next tick", async () => {
		const clock = new Clock();
		const host: RhythmHostPort = {
			isBusy: () => false,
			submitOpportunity: async () => {},
			submitReminder: async () => {},
			saveDurableState: async () => {},
		};
		const engine = new RhythmEngine(
			host,
			{
				baseIntervalMs: 120_000,
				pausedUntilEpochMs: null,
				dailyAttempts: { date: new Date(clock.epoch).toDateString(), count: 3 },
			},
			undefined,
			clock,
		);
		engine.start();
		await clock.advance(60_000);
		expect(engine.getStatus().dailyAttemptsUsed).toBe(0);
		engine.stop();
	});
});
