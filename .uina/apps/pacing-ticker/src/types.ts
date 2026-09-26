/**
 * 自主节拍器私有领域类型定义
 */

/**
 * 架构常量与退避规则
 */
export const HUMAN_COOLDOWN_MS = 30_000;

export interface BackoffRule {
	readonly idleAfterMs: number;
	readonly minIntervalMs: number;
}

export const BACKOFF_RULES: readonly BackoffRule[] = [
	{ idleAfterMs: 15 * 60_000, minIntervalMs: 10 * 60_000 },
	{ idleAfterMs: 60 * 60_000, minIntervalMs: 30 * 60_000 },
] as const;

/**
 * 人类资源护栏 (物理安全网)
 */
export interface TickerGuardrails {
	/** 每日自主唤醒最大次数 (null 或 undefined 表示不设上限) */
	readonly maxDailyWakes?: number | null;
}

/**
 * 主体持久状态 (跨重启落盘保留)
 */
export interface TickerDurableState {
	/** 基准唤醒间隔 (毫秒) */
	baseIntervalMs: number;
	/** 挂起截止时间 (绝对 Wall-Clock 毫秒，null 表示未挂起) */
	pausedUntilEpochMs: number | null;
	/** 每日唤醒用量统计 */
	dailyWakeUsage: {
		date: string;
		count: number;
	};
}

/**
 * 宿主活动事件
 */
export interface ActivityEvent {
	readonly origin: "human" | "external" | "runtime";
}

/**
 * 宿主接入契约 (依赖注入接口)
 */
export interface TickerHostPort {
	/** 探测主脑是否正在执行推理或工具链 */
	isBusy(): boolean;
	/** 向主脑投递自主认知机会 */
	submitOpportunity(text: string): Promise<void>;
	/** 保存持久状态 */
	saveDurableState(state: TickerDurableState): Promise<void>;
}

/**
 * 状态快照
 */
export interface TickerStatusSnapshot {
	readonly baseIntervalMinutes: number;
	readonly idleMinutes: number;
	readonly effectiveIntervalMinutes: number;
	readonly remainingSeconds: number;
	readonly isPaused: boolean;
	readonly dailyWakesUsed: number;
	readonly dailyWakesLimit: number | null;
}
