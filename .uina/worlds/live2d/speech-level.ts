/**
 * 声学电平输入（P3-2，边界规范 §4 契约三）。
 *
 * 职责链：TTS/voice 扩展按播放位置 20ms 窗投递 RMS → 本类做失联守卫与**作者标定映射**
 * （rms → 口型开度目标）→ director.setSpeechLevel。包络形态（快攻 / 50ms 释放）由引擎
 * 管道统一持有（规范 §4.2-5），本类不做二次平滑——legacy 的 attackMs/releaseMs 不迁移。
 *
 * - 失联守卫：超过 staleMs 未收到新测量 → 视为暂停（目标 0，经引擎包络平滑回零）；
 * - reset()：声学输入状态立即清零（level=0、age=∞）→ 口型经引擎 50ms 释放回零；
 *   急停（safeStop/interrupt）不经此路径，P4-8 打断语义直接清 director 侧状态；
 * - 暂停（paused，P4-6/safeStop）与未发布期间收到的电平由 runtime 侧丢弃，不进本类。
 */
import type { VoiceLevelSink } from "../../../src/extensions/world-framework/seams.js";
import { scaleWithClamp } from "./adapter/rig.js";
import type { MotionDirector } from "./director/director.js";

/** 模型作者标定的口型映射（P5 作者会话逐点重制并登记 evidence）。 */
export interface SpeechConfig {
	/** [rms, 口型开度] 分段线性映射，rms 单调递增，开度域 [0,1]。 */
	points: readonly (readonly [number, number])[];
	/** 失联守卫：超过此时长（ms）无新测量即视为静音。 */
	staleMs: number;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export class SpeechInput implements VoiceLevelSink {
	private level = 0;
	private ageMs = Infinity;

	constructor(
		private readonly config: SpeechConfig,
		private readonly director: MotionDirector,
	) {}

	processLevel(level: { rms: number; peak?: number }): void {
		// 测量不承载包络形态（seams 契约）：只取 rms 标量，非法值按静音处理。
		this.level = Number.isFinite(level.rms) ? clamp01(level.rms) : 0;
		this.ageMs = 0;
	}

	/** 声学输入状态立即清零；口型回零由引擎包络的 50ms 释放完成。 */
	reset(): void {
		this.level = 0;
		this.ageMs = Infinity;
	}

	/** 每合成帧推进：失联守卫 → 作者映射 → 引擎包络目标。 */
	tick(dtMs: number): void {
		this.ageMs += dtMs;
		const rms = this.ageMs > this.config.staleMs ? 0 : this.level;
		this.director.setSpeechLevel(scaleWithClamp(this.config.points, rms));
	}
}
