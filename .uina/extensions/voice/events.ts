/**
 * Uina 声音系统事件与声学接缝契约。
 *
 * 归属说明：voice 拥有"声学事实"的词汇表。生产者（tts/桥）与消费者（具身外壳）都从这里取类型，
 * 而不是各自定义一套——一个接缝两个定义必然漂移。
 *
 * 跨 World ↔ Extension 边界的接缝词汇（VoiceLevelSink 与前缀常量）已单源化到
 * `src/extensions/world-framework/seams.ts`，此处 re-export 以维持既有 import 路径；
 * 本文件只保留 voice 内部词汇（VoiceLevelEvent）与消费方结构校验。
 */
export { VOICE_LEVEL_SINK_EXPOSED_PREFIX, type VoiceLevelSink } from "../../../src/extensions/world-framework/seams.js";
import type { VoiceLevelSink } from "../../../src/extensions/world-framework/seams.js";

/**
 * 声学电平事件：播放侧对当前音频包络的测量值。
 *
 * 刻意只承载**测量**，不承载包络形态：攻击/释放的平滑由消费者按自己的渲染节拍做
 * （如 Live2D 的口型观察器在 60Hz tick 中平滑衰减）。
 * 生产者不应替消费者决定"口型该多快张开、多快合上"。
 */
export interface VoiceLevelEvent {
	readonly traceId: string;
	readonly rms: number; // 0.0 ~ 1.0，最近一段音频的均方根
	readonly peak: number; // 0.0 ~ 1.0，最近一段音频的峰值
	readonly timestamp: number;
}

/** 结构校验：共享表里的值必须真的具备电平接收端契约。 */
export function isVoiceLevelSink(value: unknown): value is VoiceLevelSink {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.processLevel === "function" && typeof candidate.reset === "function";
}
