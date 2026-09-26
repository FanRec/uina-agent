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

export class TickerEngine {
	private readonly guardrails: TickerGuardrails;
	private readonly durableState: TickerDurableState;
	private readonly clock: ClockSource;
	private timer: NodeJS.Timeout | null = null;

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
			maxDailyWakes: guardrails?.maxDailyWakes ?? null,
		};

		const today = new Date(this.clock.nowEpoch()).toDateString();
		this.durableState = {
			baseIntervalMs: initialDurableState?.baseIntervalMs ?? 180_000,
			pausedUntilEpochMs: initialDurableState?.pausedUntilEpochMs ?? null,
			dailyWakeUsage:
				initialDurableState?.dailyWakeUsage?.date === today
					? { ...initialDurableState.dailyWakeUsage }
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
		const nowMono = this.clock.nowMono();
		const initialDelay =
			this.pauseUntilMonoMs > nowMono
				? this.pauseUntilMonoMs - nowMono
				: this.calculateNextInterval();
		this.scheduleNext(initialDelay);
	}

	stop(): void {
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
		this.durableState.baseIntervalMs = Math.max(1, Math.min(120, minutes)) * 60_000;
		await this.persist();
		if (this.clock.nowMono() >= this.pauseUntilMonoMs) {
			this.scheduleNext(this.calculateNextInterval());
		}
	}

	async pause(minutes: number): Promise<void> {
		const durationMs = Math.max(1, minutes) * 60_000;
		this.pauseUntilMonoMs = this.clock.nowMono() + durationMs;
		this.durableState.pausedUntilEpochMs = this.clock.nowEpoch() + durationMs;
		await this.persist();
		// 立即重新调度瞄准 pause deadline
		this.scheduleNext(durationMs);
	}

	async resume(): Promise<void> {
		this.pauseUntilMonoMs = 0;
		this.durableState.pausedUntilEpochMs = null;
		await this.persist();
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

	private scheduleNext(delayMs: number): void {
		if (this.timer) this.clock.clearTimeout(this.timer);
		const safeDelay = Math.max(0, delayMs);
		this.nextWakeMonoMs = this.clock.nowMono() + safeDelay;
		this.timer = this.clock.setTimeout(() => void this.onTick(), safeDelay);
	}

	/**
	 * 节拍时钟触发处理 (包涵 Deadline 检查、配额护栏、礼貌避让与脉冲投递)
	 */
	async onTick(): Promise<void> {
		const nowMono = this.clock.nowMono();

		// 1. 精确 Deadline 检查
		if (nowMono < this.pauseUntilMonoMs) {
			this.scheduleNext(this.pauseUntilMonoMs - nowMono);
			return;
		}
		if (this.durableState.pausedUntilEpochMs !== null) {
			this.durableState.pausedUntilEpochMs = null;
			void this.persist();
		}

		// 2. 物理资源熔断护栏检查 (日唤醒限额，跨重启持久计数)
		const today = new Date(this.clock.nowEpoch()).toDateString();
		if (today !== this.durableState.dailyWakeUsage.date) {
			this.durableState.dailyWakeUsage = { date: today, count: 0 };
			void this.persist();
		}
		if (
			this.guardrails.maxDailyWakes !== null &&
			this.guardrails.maxDailyWakes !== undefined &&
			this.durableState.dailyWakeUsage.count >= this.guardrails.maxDailyWakes
		) {
			// 达到人类设定的物理硬限额，退避至 1 小时后再次探测
			this.scheduleNext(3600_000);
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
			this.scheduleNext(retryDelay);
			return;
		}

		// 4. 投递唤醒机会 (Opportunity)
		const idleMinutes = Math.round((nowMono - this.lastExternalActivityMonoMs) / 60_000);
		const timeStr = new Date(this.clock.nowEpoch()).toLocaleTimeString("zh-CN", {
			hour: "2-digit",
			minute: "2-digit",
		});
		const opportunityText = `[时钟节拍: ${timeStr} | 距上个外部活动已过去 ${idleMinutes > 0 ? `${idleMinutes}m` : "片刻"}]`;

		this.durableState.dailyWakeUsage.count++;
		void this.persist();

		try {
			await this.host.submitOpportunity(opportunityText);
		} catch {
			// 容错：投递失败不崩溃
		}

		// 5. 调度下一次自适应节拍
		this.scheduleNext(this.calculateNextInterval());
	}

	private persistTail: Promise<void> = Promise.resolve();

	private persist(): Promise<void> {
		const snapshot: TickerDurableState = {
			baseIntervalMs: this.durableState.baseIntervalMs,
			pausedUntilEpochMs: this.durableState.pausedUntilEpochMs,
			dailyWakeUsage: { ...this.durableState.dailyWakeUsage },
		};

		this.persistTail = this.persistTail
			.then(() => this.host.saveDurableState(snapshot))
			.catch(() => {
				// 容错：落盘失败不阻断主逻辑，tail 保持可用向下流动
			});

		return this.persistTail;
	}

	getStatus(): TickerStatusSnapshot {
		const now = this.clock.nowMono();
		return {
			baseIntervalMinutes: Math.round(this.durableState.baseIntervalMs / 60_000),
			idleMinutes: Math.round((now - this.lastExternalActivityMonoMs) / 60_000),
			effectiveIntervalMinutes: Math.round(this.calculateNextInterval() / 60_000),
			remainingSeconds: Math.max(0, Math.round((this.nextWakeMonoMs - now) / 1000)),
			isPaused: now < this.pauseUntilMonoMs,
			dailyWakesUsed: this.durableState.dailyWakeUsage.count,
			dailyWakesLimit: this.guardrails.maxDailyWakes ?? null,
		};
	}
}
