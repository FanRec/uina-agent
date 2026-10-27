import { describe, expect, it } from "vitest";
import { RhythmEngine, type ClockSource } from "../.uina/worlds/rhythm/src/engine.js";
import type { RhythmDurableState } from "../.uina/worlds/rhythm/src/types.js";

interface Reminder {
	readonly reminderRef: string;
	readonly message: string;
	readonly dueAtEpochMs: number;
}

class ReminderClock implements ClockSource {
	mono = 10_000;
	epoch = 1_800_000_000_000;
	private nextTimer = 1;
	private timers = new Map<number, { dueMono: number; run: () => void }>();

	nowMono() {
		return this.mono;
	}

	nowEpoch() {
		return this.epoch;
	}

	setTimeout(run: () => void, delayMs: number) {
		const id = this.nextTimer++;
		this.timers.set(id, { dueMono: this.mono + delayMs, run });
		return id as unknown as NodeJS.Timeout;
	}

	clearTimeout(timer: NodeJS.Timeout) {
		this.timers.delete(Number(timer));
	}

	async advance(ms: number) {
		const targetMono = this.mono + ms;
		this.epoch += ms;
		while (true) {
			let next: [number, { dueMono: number; run: () => void }] | undefined;
			for (const entry of this.timers) {
				if (entry[1].dueMono <= targetMono && (!next || entry[1].dueMono < next[1].dueMono)) next = entry;
			}
			if (!next) break;
			this.timers.delete(next[0]);
			this.mono = next[1].dueMono;
			next[1].run();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		this.mono = targetMono;
	}
}

function createHarness(options: {
	clock: ReminderClock;
	busy?: () => boolean;
	submitReminder?: (reminder: Reminder) => Promise<void>;
	saveState?: (state: RhythmDurableState) => Promise<void>;
	initial?: Partial<RhythmDurableState>;
}) {
	const reminders: Reminder[] = [];
	const saved: RhythmDurableState[] = [];
	const opportunities: string[] = [];
	const engine = new RhythmEngine(
		{
			isBusy: options.busy ?? (() => false),
			submitOpportunity: async (text) => {
				opportunities.push(text);
			},
			submitReminder: async (reminder: Reminder) => {
				await options.submitReminder?.(reminder);
				reminders.push(reminder);
			},
			saveDurableState: async (state) => {
				await options.saveState?.(state);
				saved.push(structuredClone(state));
			},
		},
		options.initial,
		undefined,
		options.clock,
	);
	return { engine, reminders, saved, opportunities };
}

describe("rhythm one-shot reminders", () => {
	it("fires at its due time and removes the reminder after queue acceptance", async () => {
		const clock = new ReminderClock();
		const { engine, reminders, saved } = createHarness({ clock });
		const created = await engine.setReminder(3, "检查烤箱里的面包");

		expect(created).toEqual({
			reminderRef: "r1",
			message: "检查烤箱里的面包",
			dueAtEpochMs: 1_800_000_003_000,
		});
		engine.start();

		await clock.advance(2_999);
		expect(reminders).toEqual([]);
		expect(engine.listReminders()).toHaveLength(1);

		await clock.advance(1);
		expect(reminders).toEqual([created]);
		expect(engine.listReminders()).toEqual([]);
		expect(saved.at(-1)?.reminders).toEqual([]);
		engine.stop();
	});

	it("supports multiple reminders and cancelling one without affecting the other", async () => {
		const clock = new ReminderClock();
		const { engine, reminders } = createHarness({ clock });
		const first = await engine.setReminder(10, "第一条");
		const second = await engine.setReminder(5, "第二条");

		expect(engine.listReminders().map((reminder) => reminder.reminderRef)).toEqual(["r2", "r1"]);
		expect(await engine.cancelReminder(second.reminderRef)).toBe("cancelled");
		engine.start();

		await clock.advance(5_000);
		expect(reminders).toEqual([]);
		await clock.advance(5_000);
		expect(reminders).toEqual([first]);
		engine.stop();
	});

	it("queues multiple reminders that share a due time in reference order", async () => {
		const clock = new ReminderClock();
		const { engine, reminders } = createHarness({ clock });
		const first = await engine.setReminder(3, "先到期的第一条");
		const second = await engine.setReminder(3, "同一时间的第二条");
		engine.start();

		await clock.advance(3_000);

		expect(reminders).toEqual([first, second]);
		expect(engine.listReminders()).toEqual([]);
		engine.stop();
	});

	it("fires an explicit reminder during pause and while the subject is busy without using pacing quota", async () => {
		const clock = new ReminderClock();
		const { engine, reminders, opportunities } = createHarness({ clock, busy: () => true });
		await engine.setReminder(2, "检查一下");
		engine.start();
		await engine.pause(10);

		await clock.advance(2_000);
		expect(reminders).toHaveLength(1);
		expect(opportunities).toEqual([]);
		expect(engine.getStatus().dailyAttemptsUsed).toBe(0);
		engine.stop();
	});

	it("replays a reminder that became due while rhythm was stopped", async () => {
		const clock = new ReminderClock();
		const first = createHarness({ clock });
		const reminder = await first.engine.setReminder(1, "离线期间到期");
		const persisted = first.saved.at(-1)!;
		first.engine.stop();
		await clock.advance(2_000);

		const restored = createHarness({ clock, initial: persisted });
		restored.engine.start();
		await clock.advance(0);
		expect(restored.reminders).toEqual([reminder]);
		restored.engine.stop();
	});

	it("retains a due reminder and retries after event submission fails", async () => {
		const clock = new ReminderClock();
		let attempts = 0;
		const { engine, reminders } = createHarness({
			clock,
			submitReminder: async () => {
				attempts++;
				if (attempts === 1) throw new Error("queue unavailable");
			},
		});
		await engine.setReminder(1, "重试我");
		engine.start();
		await clock.advance(1_000);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(attempts).toBe(1);
		expect(reminders).toEqual([]);
		expect(engine.listReminders()).toHaveLength(1);
		await expect(engine.cancelReminder("r1")).resolves.toBe("already_due");

		await clock.advance(15_000);
		expect(attempts).toBe(2);
		expect(reminders).toHaveLength(1);
		expect(engine.listReminders()).toEqual([]);
		engine.stop();
	});

	it("does not cancel a reminder after an event was queued but its removal save failed", async () => {
		const clock = new ReminderClock();
		let saves = 0;
		const { engine, reminders } = createHarness({
			clock,
			saveState: async () => {
				saves++;
				if (saves === 2) throw new Error("acknowledgement save failed");
			},
		});
		await engine.setReminder(1, "已送达不可撤回");
		engine.start();
		await clock.advance(1_000);

		expect(reminders).toHaveLength(1);
		expect(engine.listReminders()).toHaveLength(1);
		expect(await engine.cancelReminder("r1")).toBe("already_due");
		engine.stop();
	});

	it("waits for an in-flight reminder delivery to settle before stopping", async () => {
		const clock = new ReminderClock();
		let release!: () => void;
		let signalStarted!: () => void;
		const deliveryStarted = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		const deliveryGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { engine, saved } = createHarness({
			clock,
			submitReminder: async () => {
				signalStarted();
				await deliveryGate;
			},
		});
		await engine.setReminder(1, "停用时正在投递");
		engine.start();
		await clock.advance(1_000);
		await deliveryStarted;

		let stopped = false;
		const stopping = engine.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		release();
		await stopping;
		expect(stopped).toBe(true);
		expect(saved.at(-1)?.reminders).toEqual([]);
	});
});
