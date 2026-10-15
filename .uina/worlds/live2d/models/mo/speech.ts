/**
 * MO 口型映射配置：保留静音死区，提高低中电平的开口幅度。
 *
 * points 只调整语音 RMS → 逻辑开度，不改变 rig 对全部嘴部动作的标定。
 * 包络形态由引擎统一持有（快攻、暂停 50ms 释放），此处不做二次平滑。
 * 数值链路已验证，真实语音与 VTS/MO 开口观感仍待现场验收。
 */
import type { SpeechConfig } from "../../speech-level.js";

export const MO_SPEECH: SpeechConfig = {
	points: [
		[0, 0],
		[0.004, 0],
		[0.01, 0.25],
		[0.02, 0.55],
		[0.04, 0.82],
		[0.08, 1],
		[1, 1],
	],
	staleMs: 120,
};
