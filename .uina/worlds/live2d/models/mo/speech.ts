/**
 * MO 口型映射配置（P3-2 先行移植，P5 作者会话逐点重制并登记 evidence）。
 *
 * points 来自 legacy `models/mo`（rms → 口型开度分段线性标定）；
 * legacy 的 attackMs/releaseMs **不迁移**——包络形态由引擎管道统一持有
 * （规范 §4.2-5：快攻、暂停 50ms 释放），世界层只做失联守卫与映射。
 */
import type { SpeechConfig } from "../../speech-level.js";

export const MO_SPEECH: SpeechConfig = {
	points: [
		[0, 0],
		[0.004, 0],
		[0.02, 0.25],
		[0.06, 0.7],
		[0.15, 1],
		[1, 1],
	],
	staleMs: 120,
};
