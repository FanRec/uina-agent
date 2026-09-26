/**
 * Uina 声音系统事件与声学接缝契约。
 *
 * 归属说明：voice 拥有"声学事实"的词汇表。生产者（tts/桥）与消费者（具身外壳）都从这里取类型，
 * 而不是各自定义一套——一个接缝两个定义必然漂移。
 */

/**
 * 声学电平事件：播放侧对当前音频包络的测量值。
 *
 * 刻意只承载**测量**，不承载包络形态：攻击/释放的平滑由消费者按自己的渲染节拍做
 * （如 Live2D 的 AudioObserver 在 60Hz tick 中以 80ms 半衰期衰减）。
 * 生产者不应替消费者决定"口型该多快张开、多快合上"。
 */
export interface VoiceLevelEvent {
	readonly traceId: string;
	readonly rms: number; // 0.0 ~ 1.0，最近一段音频的均方根
	readonly peak: number; // 0.0 ~ 1.0，最近一段音频的峰值
	readonly timestamp: number;
}

/**
 * 电平接收端在宿主同进程共享表中的登记名前缀。
 *
 * 具备口型能力的身体外壳（如 Live2D App）用
 * `ctx.expose(VOICE_LEVEL_SINK_EXPOSED_PREFIX + bodyId, sink)` 暴露自己；
 * 声学生产者（tts）用 `pi.shared(APP_EXPOSED_SHARED_NAME)` 拉取并按此前缀筛选后推送。
 *
 * 方向是**生产者推、消费者只提供接收端**：消费者不必知道音频从哪来，
 * 也不因此获得读取生产者内部状态的能力。
 */
export const VOICE_LEVEL_SINK_EXPOSED_PREFIX = "voice.levelSink:";

/** 电平接收端契约：身体外壳实现它，声学生产者调用它。 */
export interface VoiceLevelSink {
	/** 投递一次电平测量；实现方负责平滑与衰减。 */
	processLevel(level: { rms: number; peak?: number }): void;
	/**
	 * 立即把口型/包络复位（音频结束、打断、或生产者消失时调用）。
	 * 这是"说话结束后不得永久张嘴"的兜底，实现方必须立即归零而非缓慢衰减。
	 */
	reset(): void;
}

/** 结构校验：共享表里的值必须真的具备电平接收端契约。 */
export function isVoiceLevelSink(value: unknown): value is VoiceLevelSink {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.processLevel === "function" && typeof candidate.reset === "function";
}
