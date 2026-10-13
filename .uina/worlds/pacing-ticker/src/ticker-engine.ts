import {
	BACKOFF_RULES,
	HUMAN_COOLDOWN_MS,
	type ActivityEvent,
	type TickerDurableState,
	type TickerGuardrails,
	type TickerHostPort,
	type TickerReminder,
	type TickerStatusSnapshot,
} from "./types.js";

/** 可插拔时钟接口，用于测试时间和调度。 */
export interface ClockSource {
	nowMono(): number;
	nowEpoch(): number;
	setTimeout(fn: () => void, delayMs: number): NodeJS.Timeout;
	clearTimeout(timer: NodeJS.Timeout): void;
}

const DEFAULT_CLOCK: ClockSource = {
	nowMono: () => performance.now(),
	nowEpoch: () => Date.now(),
	setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
	clearTimeout: (timer) => clearTimeout(timer),
};
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const REMINDER_RETRY_MS = 15_000;

export class TickerEngine {
	private readonly guardrails: TickerGuardrails;
	private durableState: TickerDurableState;
	private readonly clock: ClockSource;
	private timer: NodeJS.Timeout | null = null;
	private generation = 0;
	private started = false;
	private tickInFlight = false;
	private activeTick: Promise<void> | null = null;
	// Keep an expired wake if it fires while a previous tick is still settling.
	private pendingWakeGeneration: number | null = null;
	private persistTail: Promise<void> = Promise.resolve();
	private pauseTail: Promise<void> = Promise.resolve();
	private readonly reminderRetryAtMonoMs = new Map<string, number>();
	private readonly inFlightReminderRefs = new Set<string>();
	private readonly queuedReminderRefs = new Set<string>();
	private readonly cancellingReminderRefs = new Set<string>();

	// Runtime times use the monotonic clock; reminder deadlines remain wall-clock facts on disk.
	private lastExternalActivityMonoMs: number;
	private lastHumanInteractionMonoMs = 0;
	private nextWakeMonoMs = 0;
	private nextPacingWakeMonoMs = 0;
	private pauseUntilMonoMs = 0;

	constructor(
		private readonly host: TickerHostPort,
		initialDurableState?: Partial<TickerDurableState>,
		guardrails?: TickerGuardrails,
		clock: ClockSource = DEFAULT_CLOCK,
	) {
		this.clock = clock;
		this.lastExternalActivityMonoMs = this.clock.nowMono();
		this.guardrails = {
			maxDailyAttempts: guardrails?.maxDailyAttempts ?? null,
		};

		const today = new Date(this.clock.nowEpoch()).toDateString();
		const reminders = (initialDurableState?.reminders ?? []).map((reminder) => ({ ...reminder }));
		const nextSequence = initialDurableState?.nextReminderSequence ?? nextReminderSequence(reminders);
		if (!Number.isSafeInteger(nextSequence) || nextSequence < nextReminderSequence(reminders)) {
			throw new Error("Ticker 下一个提醒引用序号无效");
		}
		this.durableState = {
			baseIntervalMs: initialDurableState?.baseIntervalMs ?? 180_000,
			pausedUntilEpochMs: initialDurableState?.pausedUntilEpochMs ?? null,
			dailyAttempts:
				initialDurableState?.dailyAttempts?.date === today
					? { ...initialDurableState.dailyAttempts }
					: { date: today, count: 0 },
			reminders,
			nextReminderSequence: nextSequence,
		};

		// 跨重启恢复 pause 状态。
		if (this.durableState.pausedUntilEpochMs !== null) {
			const remainingWallMs = this.durableState.pausedUntilEpochMs - this.clock.nowEpoch();
			if (remainingWallMs > 0) {
				this.pauseUntilMonoMs = this.clock.nowMono() + remainingWallMs;
			} else {
				this.durableState.pausedUntilEpochMs = null;
			}
		}
	}

	start(): void {
		this.started = true;
		const generation = ++this.generation;
		const now = this.clock.nowMono();
		this.nextPacingWakeMonoMs = this.pauseUntilMonoMs > now
			? this.pauseUntilMonoMs
			: now + this.calculateNextInterval();
		this.scheduleNextWake(generation);
	}

	async stop(): Promise<void> {
		this.started = false;
		this.generation++;
		if (this.timer) {
			this.clock.clearTimeout(this.timer);
			this.timer = null;
		}
		const activeTick = this.activeTick;
		if (activeTick) await activeTick;
		await this.pauseTail;
		await this.persistTail;
	}

	/** 宿主通用活动事件到达；忽略主体自身内部活动。 */
	notifyActivity(event: ActivityEvent): void {
		if (event.origin === "runtime") return;

		const now = this.clock.nowMono();
		this.lastExternalActivityMonoMs = now;
		if (event.origin === "human") this.lastHumanInteractionMonoMs = now;

		// 仅在周期节拍已经进入长退避时提前重置；不因高频活动持续推迟机会。
		if (now >= this.pauseUntilMonoMs) {
			const remainingMs = this.nextPacingWakeMonoMs - now;
			if (remainingMs > this.durableState.baseIntervalMs) {
				this.nextPacingWakeMonoMs = now + this.durableState.baseIntervalMs;
				this.scheduleNextWake();
			}
		}
	}

	async setInterval(minutes: number): Promise<void> {
		if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) throw new Error("节拍周期必须是 1 到 120 之间的有限数字");
		await this.saveChange((state) => ({ ...state, baseIntervalMs: minutes * 60_000 }));
		if (this.clock.nowMono() >= this.pauseUntilMonoMs) {
			this.nextPacingWakeMonoMs = this.clock.nowMono() + this.calculateNextInterval();
			this.scheduleNextWake();
		}
	}

	async setReminder(afterSeconds: number, message: string): Promise<TickerReminder> {
		if (!Number.isSafeInteger(afterSeconds) || afterSeconds < 1) throw new Error("提醒时长必须是至少 1 秒的安全整数");
		if (typeof message !== "string" || message.trim().length === 0) throw new Error("提醒内容不能为空");
		const dueAtEpochMs = this.clock.nowEpoch() + afterSeconds * 1000;
		if (!Number.isSafeInteger(dueAtEpochMs) || new Date(dueAtEpochMs).getTime() !== dueAtEpochMs) throw new Error("提醒截止时间无效");

		let created!: TickerReminder;
		await this.saveChange((state) => {
			const sequence = state.nextReminderSequence;
			if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) {
				throw new Error("Ticker 提醒引用序号已超出可用范围");
			}
			created = { reminderRef: `r${sequence}`, message, dueAtEpochMs };
			return {
				...state,
				reminders: [...state.reminders, created],
				nextReminderSequence: sequence + 1,
			};
		});
		this.scheduleNextWake();
		return { ...created };
	}

	listReminders(): TickerReminder[] {
		return this.durableState.reminders
			.map((reminder) => ({ ...reminder }))
			.sort((a, b) => a.dueAtEpochMs - b.dueAtEpochMs || referenceSequence(a.reminderRef) - referenceSequence(b.reminderRef));
	}

	private isReminderAlreadyDue(reminderRef: string): boolean {
		const reminder = this.durableState.reminders.find((candidate) => candidate.reminderRef === reminderRef);
		return this.inFlightReminderRefs.has(reminderRef) ||
			this.queuedReminderRefs.has(reminderRef) ||
			(reminder !== undefined && reminder.dueAtEpochMs <= this.clock.nowEpoch());
	}

	async cancelReminder(reminderRef: string): Promise<"cancelled" | "not_found" | "already_due"> {
		if (!/^r[1-9]\d*$/.test(reminderRef)) throw new Error("提醒引用无效");
		if (this.isReminderAlreadyDue(reminderRef)) return "already_due";
		this.cancellingReminderRefs.add(reminderRef);
		try {
			await this.persistTail;
			if (this.isReminderAlreadyDue(reminderRef)) return "already_due";
			if (!this.durableState.reminders.some((reminder) => reminder.reminderRef === reminderRef)) return "not_found";
			await this.saveChange((state) => ({
				...state,
				reminders: state.reminders.filter((reminder) => reminder.reminderRef !== reminderRef),
			}));
			this.reminderRetryAtMonoMs.delete(reminderRef);
			return "cancelled";
		} finally {
			this.cancellingReminderRefs.delete(reminderRef);
			this.scheduleNextWake();
		}
	}

	async pause(minutes: number): Promise<void> {
		if (!Number.isFinite(minutes) || minutes < 1) throw new Error("暂停时长必须是有限的正数");
		const operation = this.pauseTail.then(() => this.applyPause(minutes));
		this.pauseTail = operation.then(() => {}, () => {});
		return operation;
	}

	private async applyPause(minutes: number): Promise<void> {
		const deadline = Math.ceil(this.clock.nowEpoch() + minutes * 60_000);
		if (!Number.isSafeInteger(deadline) || deadline < 0) throw new Error("暂停截止时间无效");

		const previousNextPacingWake = this.nextPacingWakeMonoMs;
		const previousPauseUntil = this.pauseUntilMonoMs;
		if (this.timer) {
			this.clock.clearTimeout(this.timer);
			this.timer = null;
		}
		const generation = ++this.generation;
		const nowMono = this.clock.nowMono();
		this.pauseUntilMonoMs = nowMono + Math.max(0, deadline - this.clock.nowEpoch());
		this.nextPacingWakeMonoMs = this.pauseUntilMonoMs;
		this.scheduleNextWake(generation);

		try {
			await this.saveChange((state) => ({ ...state, pausedUntilEpochMs: deadline }));
		} catch (error) {
			if (this.started && generation === this.generation) {
				this.pauseUntilMonoMs = previousPauseUntil;
				this.nextPacingWakeMonoMs = previousNextPacingWake;
				this.scheduleNextWake(generation);
			}
			throw error;
		}

		const persistedDeadline = this.durableState.pausedUntilEpochMs;
		this.pauseUntilMonoMs = persistedDeadline === null
			? 0
			: this.clock.nowMono() + Math.max(0, persistedDeadline - this.clock.nowEpoch());
		this.nextPacingWakeMonoMs = this.pauseUntilMonoMs;
		this.scheduleNextWake(generation);
	}

	async resume(): Promise<void> {
		const operation = this.pauseTail.then(async () => {
			await this.saveChange((state) => ({ ...state, pausedUntilEpochMs: null }));
			this.pauseUntilMonoMs = 0;
			this.nextPacingWakeMonoMs = this.clock.nowMono() + 1000;
			this.scheduleNextWake();
		});
		this.pauseTail = operation.then(() => {}, () => {});
		return operation;
	}

	/** 基于外部空闲时长计算周期节拍退避。 */
	calculateNextInterval(): number {
		const idleDuration = this.clock.nowMono() - this.lastExternalActivityMonoMs;
		let minInterval = this.durableState.baseIntervalMs;
		for (const rule of BACKOFF_RULES) {
			if (idleDuration > rule.idleAfterMs) minInterval = Math.max(minInterval, rule.minIntervalMs);
		}
		return minInterval;
	}

	private scheduleNextWake(generation = this.generation): void {
		if (!this.started || generation !== this.generation) return;
		if (this.timer) this.clock.clearTimeout(this.timer);
		const targetMonoMs = Math.min(this.nextPacingWakeMonoMs, this.nextReminderWakeMonoMs());
		const now = this.clock.nowMono();
		const delayMs = Math.max(targetMonoMs - now, 0);
		this.nextWakeMonoMs = now + delayMs;
		this.timer = this.clock.setTimeout(() => {
			this.timer = null;
			if (!this.started || generation !== this.generation) return;
			if (this.tickInFlight) {
				this.pendingWakeGeneration = generation;
				return;
			}
			const activeTick = this.onTick(generation);
			this.activeTick = activeTick;
			void activeTick.finally(() => {
				if (this.activeTick === activeTick) this.activeTick = null;
			}).catch(() => {});
		}, Math.min(delayMs, MAX_TIMER_DELAY_MS));
	}

	private nextReminderWakeMonoMs(): number {
		const nowMono = this.clock.nowMono();
		const nowEpoch = this.clock.nowEpoch();
		let next = Number.POSITIVE_INFINITY;
		for (const reminder of this.durableState.reminders) {
			if (this.inFlightReminderRefs.has(reminder.reminderRef) || this.cancellingReminderRefs.has(reminder.reminderRef)) continue;
			const dueMono = nowMono + Math.max(0, reminder.dueAtEpochMs - nowEpoch);
			const retryAt = this.reminderRetryAtMonoMs.get(reminder.reminderRef) ?? 0;
			next = Math.min(next, Math.max(dueMono, retryAt));
		}
		return next;
	}

	/** Wake dispatcher: due reminders are independent from the periodic opportunity policy. */
	async onTick(generation = this.generation): Promise<void> {
		if (!this.started || generation !== this.generation || this.tickInFlight) return;
		this.tickInFlight = true;
		try {
			await this.runWake(generation);
		} catch {
			if (this.started && generation === this.generation) {
				this.nextPacingWakeMonoMs = Math.max(this.nextPacingWakeMonoMs, this.clock.nowMono() + 15_000);
				this.scheduleNextWake(generation);
			}
		} finally {
			this.tickInFlight = false;
			const pendingGeneration = this.pendingWakeGeneration;
			this.pendingWakeGeneration = null;
			if (this.started && pendingGeneration === this.generation && !this.timer) {
				this.scheduleNextWake(pendingGeneration);
			}
		}
	}

	private async runWake(generation: number): Promise<void> {
		const reminder = this.findDueReminder();
		if (reminder) {
			await this.deliverReminder(reminder);
			if (this.started && generation === this.generation) this.scheduleNextWake(generation);
			return;
		}

		if (this.clock.nowMono() < this.nextPacingWakeMonoMs) {
			this.scheduleNextWake(generation);
			return;
		}
		await this.runPacingOpportunity(generation);
	}

	private findDueReminder(): TickerReminder | undefined {
		const nowEpoch = this.clock.nowEpoch();
		const nowMono = this.clock.nowMono();
		return this.durableState.reminders
			.filter((reminder) =>
				reminder.dueAtEpochMs <= nowEpoch &&
				(this.reminderRetryAtMonoMs.get(reminder.reminderRef) ?? 0) <= nowMono &&
				!this.inFlightReminderRefs.has(reminder.reminderRef) &&
				!this.cancellingReminderRefs.has(reminder.reminderRef),
			)
			.sort((a, b) => a.dueAtEpochMs - b.dueAtEpochMs || referenceSequence(a.reminderRef) - referenceSequence(b.reminderRef))[0];
	}

	private async deliverReminder(reminder: TickerReminder): Promise<void> {
		this.inFlightReminderRefs.add(reminder.reminderRef);
		try {
			await this.host.submitReminder({ ...reminder });
			this.queuedReminderRefs.add(reminder.reminderRef);
			await this.saveChange((state) => ({
				...state,
				reminders: state.reminders.filter((candidate) => candidate.reminderRef !== reminder.reminderRef),
			}));
			this.queuedReminderRefs.delete(reminder.reminderRef);
			this.reminderRetryAtMonoMs.delete(reminder.reminderRef);
		} catch {
			// Until both queue acceptance and its durable acknowledgement succeed, keep the reminder pending.
			this.reminderRetryAtMonoMs.set(reminder.reminderRef, this.clock.nowMono() + REMINDER_RETRY_MS);
		} finally {
			this.inFlightReminderRefs.delete(reminder.reminderRef);
		}
	}

	private async runPacingOpportunity(generation: number): Promise<void> {
		const nowMono = this.clock.nowMono();

		if (nowMono < this.pauseUntilMonoMs) {
			this.nextPacingWakeMonoMs = this.pauseUntilMonoMs;
			this.scheduleNextWake(generation);
			return;
		}
		const today = new Date(this.clock.nowEpoch()).toDateString();
		const usedToday = today === this.durableState.dailyAttempts.date ? this.durableState.dailyAttempts.count : 0;
		const dailyLimit = this.guardrails.maxDailyAttempts;
		if (dailyLimit != null && usedToday >= dailyLimit) {
			this.nextPacingWakeMonoMs = this.clock.nowMono() + 3600_000;
			this.scheduleNextWake(generation);
			return;
		}

		const isBusy = this.host.isBusy();
		const humanElapsed = nowMono - this.lastHumanInteractionMonoMs;
		const isHumanRecent = this.lastHumanInteractionMonoMs > 0 && humanElapsed < HUMAN_COOLDOWN_MS;
		if (isBusy || isHumanRecent) {
			const retryDelay = isHumanRecent ? Math.max(5000, HUMAN_COOLDOWN_MS - humanElapsed) : 15_000;
			this.nextPacingWakeMonoMs = nowMono + retryDelay;
			this.scheduleNextWake(generation);
			return;
		}

		const idleMinutes = Math.round((nowMono - this.lastExternalActivityMonoMs) / 60_000);
		const timeStr = new Date(this.clock.nowEpoch()).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
		const idleText = idleMinutes > 0 ? `约${idleMinutes}分钟` : "不足1分钟";
		const opportunityText =
			`[自主机会]\n当前时间 ${timeStr}；距上次输入${idleText}。` +
			"你可以留意世界、思考、与世界互动或行动，也可以暂不行动。";

		try {
			await this.saveChange((state) => {
				const count = state.dailyAttempts.date === today ? state.dailyAttempts.count : 0;
				return { ...state, pausedUntilEpochMs: null, dailyAttempts: { date: today, count: count + 1 } };
			});
		} catch {
			if (this.started && generation === this.generation) {
				this.nextPacingWakeMonoMs = this.clock.nowMono() + 15_000;
				this.scheduleNextWake(generation);
			}
			return;
		}
		if (!this.started || generation !== this.generation) return;

		try {
			await this.host.submitOpportunity(opportunityText);
		} catch {
			// Failed delivery must not consume the daily pacing quota.
			try {
				await this.saveChange((state) => {
					const count = state.dailyAttempts.date === today ? state.dailyAttempts.count : 0;
					return { ...state, dailyAttempts: { date: today, count: Math.max(0, count - 1) } };
				});
			} catch {
				// Keep the last durable state; status exposes the count that remains persisted.
			}
		}

		if (this.started && generation === this.generation) {
			this.nextPacingWakeMonoMs = this.clock.nowMono() + this.calculateNextInterval();
			this.scheduleNextWake(generation);
		}
	}

	private saveChange(change: (state: TickerDurableState) => TickerDurableState): Promise<void> {
		const operation = this.persistTail.then(async () => {
			const next = change(this.durableState);
			await this.host.saveDurableState(next);
			this.durableState = next;
		});
		this.persistTail = operation.then(() => {}, () => {});
		return operation;
	}

	getStatus(): TickerStatusSnapshot {
		const now = this.clock.nowMono();
		const today = new Date(this.clock.nowEpoch()).toDateString();
		return {
			baseIntervalMinutes: Math.round(this.durableState.baseIntervalMs / 60_000),
			idleMinutes: Math.round((now - this.lastExternalActivityMonoMs) / 60_000),
			effectiveIntervalMinutes: Math.round(this.calculateNextInterval() / 60_000),
			remainingSeconds: Math.max(0, Math.round((this.nextWakeMonoMs - now) / 1000)),
			isPaused: now < this.pauseUntilMonoMs,
			dailyAttemptsUsed: this.durableState.dailyAttempts.date === today ? this.durableState.dailyAttempts.count : 0,
			dailyAttemptsLimit: this.guardrails.maxDailyAttempts ?? null,
		};
	}
}

function referenceSequence(reminderRef: string): number {
	const match = /^r([1-9]\d*)$/.exec(reminderRef);
	return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function nextReminderSequence(reminders: readonly TickerReminder[]): number {
	let max = 0;
	for (const reminder of reminders) max = Math.max(max, referenceSequence(reminder.reminderRef));
	return max + 1;
}
