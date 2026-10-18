/**
 * 外部动作的时序与容差参数。
 *
 * 这些数不是"设计常量"，而是待真机标定的观测值：`MIN_USEFUL_MOVE_MS` 之类的注释自己就写着
 * "requires later live-VTS calibration"。它们一旦和真机不符，表现是"动作偶尔判 unknown"而不是崩溃，
 * 所以必须能改、能看、能测——而不是散落在 500 行函数里当字面量。
 *
 * 变更方式：
 * - 代码内：`createLive2DRuntime({ timing })`（测试和预览用）。
 * - 现场标定：`UINA_LIVE2D_TIMING='{"minUsefulMoveMs":60}'`（world 装配时读取，非法值直接失败）。
 * - 生效值可通过 `status(detail=true).timing` 查看，不会出现"改了但没生效"的沉默状态。
 */
export interface TimingProfile {
	/** ACK 之后首次回读的等待：VTS 插值结算有滞后。 */
	readonly settleMarginMs: number;
	/** 回读不匹配时的重试次数。 */
	readonly settleRetries: number;
	/** 每次重试前的等待。 */
	readonly settleRetryMs: number;
	/** 位姿归位动画时长（秒）。 */
	readonly restoreSeconds: number;
	/** 相对旋转的逐帧驱动节拍（≈60fps 渲染帧率）。 */
	readonly driveIntervalMs: number;
	/** 逐帧驱动的最小角度变化（°）：低于它不发空转请求。 */
	readonly driveMinDeltaDeg: number;
	/** 单次相对旋转请求的上限（°）：防止慢 ACK 后最短弧绕行。 */
	readonly maxRelativeStepDeg: number;
	/** 端点残差上限（°）：超过它判定作者给的窗口已被错过。 */
	readonly maxEndpointResidualDeg: number;
	/** 可用移动窗口下限（毫秒）。2026-10-18 仍是保守初值，未经真机标定。 */
	readonly minUsefulMoveMs: number;
}

export const DEFAULT_TIMING: TimingProfile = Object.freeze({
	settleMarginMs: 60,
	settleRetries: 2,
	settleRetryMs: 250,
	restoreSeconds: 0.25,
	driveIntervalMs: 16,
	driveMinDeltaDeg: 0.01,
	maxRelativeStepDeg: 90,
	maxEndpointResidualDeg: 2,
	minUsefulMoveMs: 100,
});

/** 每个参数的合法区间：容差可以调，但不能调成"永不确认"或"每帧都判错"。 */
const BOUNDS: Readonly<Record<keyof TimingProfile, readonly [min: number, max: number]>> = Object.freeze({
	settleMarginMs: [0, 2000],
	settleRetries: [0, 10],
	settleRetryMs: [0, 5000],
	restoreSeconds: [0, 5],
	driveIntervalMs: [1, 100],
	driveMinDeltaDeg: [0, 5],
	maxRelativeStepDeg: [1, 360],
	maxEndpointResidualDeg: [0, 45],
	minUsefulMoveMs: [0, 2000],
});

const KEYS = Object.keys(BOUNDS) as (keyof TimingProfile)[];

const check = (key: keyof TimingProfile, value: unknown): number => {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new TypeError(`Live2D timing.${key} 必须是有限数字，收到 ${String(value)}`);
	const [min, max] = BOUNDS[key];
	if (value < min || value > max) throw new RangeError(`Live2D timing.${key}=${value} 超出 [${min}, ${max}]`);
	return value;
};

/** 合并并校验覆盖值；未知键直接报错，避免"写错名字 → 静默用默认值"。 */
export function resolveTiming(override: Partial<TimingProfile> = {}): TimingProfile {
	const merged: { -readonly [K in keyof TimingProfile]: TimingProfile[K] } = { ...DEFAULT_TIMING };
	for (const [key, value] of Object.entries(override)) {
		const name = key as keyof TimingProfile;
		if (!KEYS.includes(name)) throw new TypeError(`Live2D timing 未知参数 "${key}"；可用参数：${KEYS.join(", ")}`);
		merged[name] = check(name, value);
	}
	return Object.freeze(merged);
}

/** 现场标定入口：从环境变量 JSON 解析覆盖值；空值表示不覆盖。 */
export function timingFromEnvironment(raw: string | undefined): Partial<TimingProfile> {
	if (!raw || raw.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new TypeError(
			`UINA_LIVE2D_TIMING 不是合法 JSON：${error instanceof Error ? error.message : String(error)}；收到 ${raw}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new TypeError(`UINA_LIVE2D_TIMING 必须是对象，收到 ${raw}`);
	return parsed as Partial<TimingProfile>;
}
