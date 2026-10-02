import {
	BACKOFF_RULES,
	HUMAN_COOLDOWN_MS,
	type ActivityEvent,
	type TickerDurableState,
	type TickerGuardrails,
	type TickerHostPort,
	type TickerStatusSnapshot,
} from "./types.js";

/**
 * 可插拔时钟接口 (用于单元测试时间旅行与精准控制)
 */
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

export class TickerEngine {
	private readonly guardrails: TickerGuardrails;
	private durableState: TickerDurableState;
	private readonly clock: ClockSource;
	private timer: NodeJS.Timeout | null = null;
	private generation = 0;
	private started = false;
	private tickInFlight = false;
	private persistTail: Promise<void> = Promise.resolve();

	// 运行时瞬态 (单调毫秒)
	private lastExternalActivityMonoMs: number;
	private lastHumanInteractionMonoMs = 0;
	private nextWakeMonoMs = 0;
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
		this.durableState = {
			baseIntervalMs: initialDurableState?.baseIntervalMs ?? 180_000,
			pausedUntilEpochMs: initialDurableState?.pausedUntilEpochMs ?? null,
			dailyAttempts:
				initialDurableState?.dailyAttempts?.date === today
					? { ...initialDurableState.dailyAttempts }
					: { date: today, count: 0 },
		};

		// 跨重启恢复 pause 状态
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
		const nowMono = this.clock.nowMono();
		const initialDelay =
			this.pauseUntilMonoMs > nowMono
				? this.pauseUntilMonoMs - nowMono
				: this.calculateNextInterval();
		this.scheduleNext(initialDelay, generation);
	}

	stop(): void {
		this.started = false;
		this.generation++;
		if (this.timer) {
			this.clock.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/**
	 * 宿主通用活动事件到达 (仅消费 origin 为 human 或 external 的真实外部事实)
	 */
	notifyActivity(event: ActivityEvent): void {
		if (event.origin === "runtime") return; // 忽略主体自身内部活动

		const now = this.clock.nowMono();
		this.lastExternalActivityMonoMs = now;
		if (event.origin === "human") {
			this.lastHumanInteractionMonoMs = now;
		}

		// 外部活动到达，若未处于 pause：
		// 只有当已排定的唤醒时间比基准周期还晚（处于长退避中）时才提前重置；
		// 若已在基准周期之内，绝不往后推迟（防范高频事件风暴导致的 Timer 抖动与饥饿）
		if (now >= this.pauseUntilMonoMs) {
			const remainingMs = this.nextWakeMonoMs - now;
			if (remainingMs > this.durableState.baseIntervalMs) {
				this.scheduleNext(this.durableState.baseIntervalMs);
			}
		}
	}

	async setInterval(minutes: number): Promise<void> {
		if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) throw new Error("节拍周期必须是 1 到 120 之间的有限数字");
		await this.saveChange((state) => ({ ...state, baseIntervalMs: minutes * 60_000 }));
		if (this.clock.nowMono() >= this.pauseUntilMonoMs) {
			this.scheduleNext(this.calculateNextInterval());
		}
	}

	async pause(minutes: number): Promise<void> {
		if (!Number.isFinite(minutes) || minutes < 1) throw new Error("暂停时长必须是有限的正数");
		const deadline = this.clock.nowEpoch() + minutes * 60_000;
		if (!Number.isFinite(deadline)) throw new Error("暂停截止时间无效");
		await this.saveChange((state) => ({ ...state, pausedUntilEpochMs: deadline }));
		this.pauseUntilMonoMs = this.clock.nowMono() + Math.max(0, deadline - this.clock.nowEpoch());
		this.scheduleNext(this.pauseUntilMonoMs - this.clock.nowMono());
	}

	async resume(): Promise<void> {
		await this.saveChange((state) => ({ ...state, pausedUntilEpochMs: null }));
		this.pauseUntilMonoMs = 0;
		this.scheduleNext(1000);
	}

	/**
	 * 基于外部空闲时长的自适应唤醒间隔计算 (退避只能降频，绝不覆盖更慢的主动设置)
	 */
	calculateNextInterval(): number {
		const idleDuration = this.clock.nowMono() - this.lastExternalActivityMonoMs;
		let minInterval = this.durableState.baseIntervalMs;

		for (const rule of BACKOFF_RULES) {
			if (idleDuration > rule.idleAfterMs) {
				minInterval = Math.max(minInterval, rule.minIntervalMs);
			}
		}
		return minInterval;
	}

	private scheduleNext(delayMs: number, generation = this.generation): void {
		if (!this.started || generation !== this.generation) return;
		if (this.timer) this.clock.clearTimeout(this.timer);
		const safeDelay = Math.max(0, delayMs);
		this.nextWakeMonoMs = this.clock.nowMono() + safeDelay;
		this.timer = this.clock.setTimeout(() => {
			this.timer = null;
			if (this.started && generation === this.generation && !this.tickInFlight) void this.onTick(generation);
		}, Math.min(safeDelay, MAX_TIMER_DELAY_MS));
	}

	/**
	 * 节拍时钟触发处理 (包涵 Deadline 检查、配额护栏、礼貌避让与脉冲投递)
	 */
	async onTick(generation = this.generation): Promise<void> {
		if (!this.started || generation !== this.generation) return;
		if (this.tickInFlight) return;
		this.tickInFlight = true;
		try {
			await this.runTick(generation);
		} finally {
			this.tickInFlight = false;
		}
	}

	private async runTick(generation: number): Promise<void> {
		const nowMono = this.clock.nowMono();

		// 1. 精确 Deadline 检查
		if (nowMono < this.pauseUntilMonoMs) {
			this.scheduleNext(this.pauseUntilMonoMs - nowMono, generation);
			return;
		}
		// 2. 物理资源熔断护栏检查 (日唤醒限额，跨重启持久计数)
		const today = new Date(this.clock.nowEpoch()).toDateString();
		const usedToday = today === this.durableState.dailyAttempts.date ? this.durableState.dailyAttempts.count : 0;
		if (
			this.guardrails.maxDailyAttempts !== null &&
			this.guardrails.maxDailyAttempts !== undefined &&
			usedToday >= this.guardrails.maxDailyAttempts
		) {
			// 达到人类设定的物理硬限额，退避至 1 小时后再次探测
			this.scheduleNext(3600_000, generation);
			return;
		}

		// 3. 礼貌避让检查：主脑忙碌 或 人类刚交互不久
		const isBusy = this.host.isBusy();
		const humanElapsed = nowMono - this.lastHumanInteractionMonoMs;
		const isHumanRecent =
			this.lastHumanInteractionMonoMs > 0 && humanElapsed < HUMAN_COOLDOWN_MS;

		if (isBusy || isHumanRecent) {
			// 若人类刚交互，精准避让到 30s 冷却结束（最少 5s）；若仅主脑忙碌，15s 后重试探测
			const retryDelay = isHumanRecent
				? Math.max(5000, HUMAN_COOLDOWN_MS - humanElapsed)
				: 15_000;
			this.scheduleNext(retryDelay, generation);
			return;
		}

		// 4. 投递唤醒机会 (Opportunity)
		const idleMinutes = Math.round((nowMono - this.lastExternalActivityMonoMs) / 60_000);
		const timeStr = new Date(this.clock.nowEpoch()).toLocaleTimeString("zh-CN", {
			hour: "2-digit",
			minute: "2-digit",
		});
		const opportunityText = `[时钟节拍: ${timeStr} | 距上个外部活动已过去 ${idleMinutes > 0 ? `${idleMinutes}m` : "片刻"}]`;

		try {
			await this.saveChange((state) => {
				const count = state.dailyAttempts.date === today ? state.dailyAttempts.count : 0;
				return { ...state, pausedUntilEpochMs: null, dailyAttempts: { date: today, count: count + 1 } };
			});
		} catch {
			if (this.started && generation === this.generation) this.scheduleNext(15_000, generation);
			return;
		}
		if (!this.started || generation !== this.generation) return;

		try {
			await this.host.submitOpportunity(opportunityText);
		} catch {
			// 投递失败不崩溃，也不把未送达的机会计入日配额。
			try {
				await this.saveChange((state) => {
					const count = state.dailyAttempts.date === today ? state.dailyAttempts.count : 0;
					return { ...state, dailyAttempts: { date: today, count: Math.max(0, count - 1) } };
				});
			} catch {
				// 保留当前已持久化状态；下一次 status 会暴露仍然消耗的尝试。
			}
		}

		// 5. 调度下一次自适应节拍
		if (this.started && generation === this.generation) {
			this.scheduleNext(this.calculateNextInterval(), generation);
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


