/**
 * rhythm World 私有领域类型。
 * 概念约定：节拍（pacing）是主体自身的周期性自主时刻；提醒（reminder）是主体写给未来自己的一次性事件。
 * 机制参照系一律以主体自身状态为准（"已安静""上次醒来"），不以人类在场为参照。
 */

/** 人类交互后的节拍避让窗口（毫秒）。 */
export const HUMAN_COOLDOWN_MS = 30_000;

export interface BackoffRule {
	readonly idleAfterMs: number;
	readonly minIntervalMs: number;
}

/** 安静退避：世界越没动静，自主唤醒越稀疏。只放慢，不反向加速；外界有动静即回落。 */
export const BACKOFF_RULES: readonly BackoffRule[] = [
	{ idleAfterMs: 15 * 60_000, minIntervalMs: 10 * 60_000 },
	{ idleAfterMs: 60 * 60_000, minIntervalMs: 30 * 60_000 },
] as const;

/** 宿主护栏。maxDailyAttempts 为 null/缺省时不设上限，且必须在状态展示中如实呈现。 */
export interface RhythmGuardrails {
	readonly maxDailyAttempts?: number | null;
}

/** 持久状态（跨重启落盘）。deadline 类字段一律为墙钟毫秒；调度运行态另用单调钟。 */
export interface RhythmDurableState {
	baseIntervalMs: number;
	pausedUntilEpochMs: number | null;
	dailyAttempts: {
		date: string;
		count: number;
	};
	reminders: RhythmReminder[];
	nextReminderSequence: number;
}

export interface RhythmReminder {
	readonly reminderRef: string;
	readonly message: string;
	readonly dueAtEpochMs: number;
}

export interface ActivityEvent {
	readonly origin: "human" | "external" | "runtime";
}

/** 下次自主唤醒为何排在这个时刻。归因用于文案，不参与调度判断。 */
export type NextWakeReason =
	| "normal"
	| "backoff"
	| "paused"
	| "daily_limit"
	| "avoiding_busy"
	| "avoiding_recent_input";

/** 宿主接入契约（依赖注入接口）。 */
export interface RhythmHostPort {
	/** 探测主体是否正在推理或执行工具链。 */
	isBusy(): boolean;
	/** 投递一条自主节拍事件（文案由引擎合成）。 */
	submitOpportunity(text: string): Promise<void>;
	/** 将到期提醒作为独立内部事件投递。 */
	submitReminder(reminder: RhythmReminder): Promise<void>;
	/** 串行保存持久状态；写成功前不得视变更已生效。 */
	saveDurableState(state: RhythmDurableState): Promise<void>;
}

/** 状态快照：一切节奏文案（status、写动作回显、推送）唯一的机器事实来源。 */
export interface RhythmStatusSnapshot {
	readonly isPaused: boolean;
	readonly pausedRemainingSeconds: number;
	readonly baseIntervalMinutes: number;
	readonly effectiveIntervalMinutes: number;
	/** 距上次外界动静的分钟数（退避依据）。 */
	readonly quietMinutes: number;
	readonly nextWakeReason: NextWakeReason;
	readonly nextPacingWakeInSeconds: number;
	/** 距上次自主节拍到来的秒数（推送正文用）。 */
	readonly secondsSinceLastWake: number;
	readonly dailyAttemptsUsed: number;
	readonly dailyAttemptsLimit: number | null;
}
