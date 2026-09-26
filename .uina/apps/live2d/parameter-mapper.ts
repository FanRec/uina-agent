import {
	type ExpressBeat,
	type FaceExpression,
	type GazeDirection,
	type HeadPose,
	type Live2DChannel,
	type Live2DParamTarget,
	PARAM_CHANNEL_MAP,
} from "./types.js";

/**
 * 将大模型输入的即兴动作/节拍转换为 Live2D Cubism 目标参数
 */
interface ParamWeight {
	name: string;
	mult: number;
	fixed?: boolean;
	additive?: boolean;
}

// 1. 视线声明式映射表
const GAZE_TABLE: Record<GazeDirection, ParamWeight[]> = {
	side_peek: [
		{ name: "ParamEyeBallX", mult: 0.85 },
		{ name: "ParamEyeBallY", mult: -0.2 },
	],
	away_right: [{ name: "ParamEyeBallX", mult: 0.95 }],
	away_left: [{ name: "ParamEyeBallX", mult: -0.95 }],
	down: [{ name: "ParamEyeBallY", mult: -0.85 }],
	user: [
		{ name: "ParamEyeBallX", mult: 0 },
		{ name: "ParamEyeBallY", mult: 0 },
	],
};

// 2. 头部姿态声明式映射表 (增强 VTuber 辨识度的大倾角与元气节奏，相对基准姿态增量叠加)
const HEAD_TABLE: Record<HeadPose, ParamWeight[]> = {
	tilt_left: [{ name: "ParamAngleZ", mult: 18.0, additive: true }],
	tilt_right: [{ name: "ParamAngleZ", mult: -18.0, additive: true }],
	nod: [{ name: "ParamAngleY", mult: -20.0, additive: true }],
	shake: [{ name: "ParamAngleX", mult: 18.0, additive: true }],
	lowered: [{ name: "ParamAngleY", mult: -16.0, additive: true }],
	lifted: [{ name: "ParamAngleY", mult: 16.0, additive: true }],
};

// 3. 面部表情声明式映射表 (二次元灵动微表情，区分固定覆盖与增量叠加)
const FACE_TABLE: Record<FaceExpression, ParamWeight[]> = {
	shy: [
		{ name: "ParamCheek", mult: 0.95, additive: true },
		{ name: "ParamMouthForm", mult: 0.3, fixed: true },
		{ name: "ParamEyeLSmile", mult: 0.5, additive: true },
		{ name: "ParamEyeRSmile", mult: 0.5, additive: true },
	],
	smug: [
		{ name: "ParamMouthForm", mult: 0.9 },
		{ name: "ParamEyeRSmile", mult: 0.9, additive: true },
		{ name: "ParamEyeLSmile", mult: 0.3, additive: true },
		{ name: "ParamBrowRY", mult: 0.5, additive: true },
	],
	pout: [
		{ name: "ParamMouthForm", mult: -0.8 },
		{ name: "ParamCheek", mult: 0.9, additive: true },
		{ name: "ParamBrowLY", mult: -0.4, additive: true },
		{ name: "ParamBrowRY", mult: -0.4, additive: true },
	],
	sparkle: [
		{ name: "ParamEyeLOpen", mult: 1.35, fixed: true },
		{ name: "ParamEyeROpen", mult: 1.35, fixed: true },
		{ name: "ParamEyeLSmile", mult: 0.7, additive: true },
		{ name: "ParamEyeRSmile", mult: 0.7, additive: true },
		{ name: "ParamCheek", mult: 0.6, additive: true },
	],
	shocked: [
		{ name: "ParamEyeLOpen", mult: 1.4, fixed: true },
		{ name: "ParamEyeROpen", mult: 1.4, fixed: true },
		{ name: "ParamMouthOpenY", mult: 0.85 },
		{ name: "ParamBrowLY", mult: 0.9, additive: true },
		{ name: "ParamBrowRY", mult: 0.9, additive: true },
	],
	tender_smile: [
		{ name: "ParamEyeLSmile", mult: 0.85, additive: true },
		{ name: "ParamEyeRSmile", mult: 0.85, additive: true },
		{ name: "ParamMouthForm", mult: 0.85 },
		{ name: "ParamCheek", mult: 0.4, additive: true },
	],
	laugh: [
		{ name: "ParamEyeLOpen", mult: 0.05, fixed: true },
		{ name: "ParamEyeROpen", mult: 0.05, fixed: true },
		{ name: "ParamEyeLSmile", mult: 1.0, fixed: true },
		{ name: "ParamEyeRSmile", mult: 1.0, fixed: true },
		{ name: "ParamMouthOpenY", mult: 0.75 },
		{ name: "ParamMouthForm", mult: 1.0, fixed: true },
		{ name: "ParamCheek", mult: 0.6, additive: true },
	],
	winking: [
		{ name: "ParamEyeROpen", mult: 0.05, fixed: true },
		{ name: "ParamEyeLOpen", mult: 1.15, fixed: true },
		{ name: "ParamEyeRSmile", mult: 1.0, fixed: true },
		{ name: "ParamEyeLSmile", mult: 0.4, additive: true },
		{ name: "ParamMouthForm", mult: 0.8 },
		{ name: "ParamCheek", mult: 0.5, additive: true },
	],
	smug_grin: [
		{ name: "ParamMouthForm", mult: 1.0 },
		{ name: "ParamEyeRSmile", mult: 0.9, additive: true },
		{ name: "ParamEyeLSmile", mult: 0.3, additive: true },
		{ name: "ParamBrowRY", mult: 0.6, additive: true },
		{ name: "ParamEyeBallY", mult: -0.2 },
	],
	sleepy_yawn: [
		{ name: "ParamEyeLOpen", mult: 0.15, fixed: true },
		{ name: "ParamEyeROpen", mult: 0.15, fixed: true },
		{ name: "ParamMouthOpenY", mult: 0.9 },
		{ name: "ParamBrowLY", mult: -0.3, additive: true },
		{ name: "ParamBrowRY", mult: -0.3, additive: true },
	],
};

// 4. 语义 Cue 到 ExpressBeat 声明式映射表 (生动立体的组合微动作)
const CUE_BEAT_TABLE: Record<string, ExpressBeat[]> = {
	warm_smile: [{ face: "tender_smile", head: "tilt_left", gaze: "user", hold_ms: 1200 }],
	happy_laugh: [
		{ head: "lifted", face: "laugh", gaze: "user", hold_ms: 450 },
		{ head: "nod", face: "sparkle", gaze: "user", hold_ms: 650 },
	],
	curious_tilt: [{ head: "tilt_right", face: "tender_smile", gaze: "side_peek", hold_ms: 1200 }],
	affirmative_nod: [
		{ head: "nod", face: "tender_smile", gaze: "user", hold_ms: 300 },
		{ head: "lifted", face: "tender_smile", gaze: "user", hold_ms: 400 },
	],
	double_nod: [
		{ head: "nod", face: "tender_smile", gaze: "user", hold_ms: 220 },
		{ head: "nod", face: "sparkle", gaze: "user", hold_ms: 380 },
	],
	shake_head: [
		{ head: "shake", face: "tender_smile", gaze: "away_right", hold_ms: 250 },
		{ head: "tilt_left", face: "tender_smile", gaze: "user", hold_ms: 350 },
	],
	shrug: [
		{ head: "lifted", face: "smug", gaze: "away_left", hold_ms: 450 },
		{ head: "lowered", face: "tender_smile", gaze: "user", hold_ms: 600 },
	],
	head_bop: [
		{ head: "tilt_left", face: "tender_smile", gaze: "user", hold_ms: 260 },
		{ head: "tilt_right", face: "sparkle", gaze: "user", hold_ms: 260 },
	],
	playful_pout: [{ face: "pout", head: "shake", gaze: "away_right", hold_ms: 1200 }],
	surprised_gasp: [{ face: "shocked", head: "lifted", gaze: "user", hold_ms: 1000 }],
	shy: [{ face: "tender_smile", head: "tilt_left", gaze: "away_left", hold_ms: 1200 }],
	look_away: [{ head: "shake", gaze: "away_right", face: "tender_smile", hold_ms: 800 }],
	peek_back: [
		{ head: "shake", gaze: "away_right", face: "tender_smile", hold_ms: 400 },
		{ head: "tilt_left", gaze: "side_peek", face: "shy", hold_ms: 850 },
	],
	thinking_deep: [{ head: "tilt_right", gaze: "away_right", face: "smug", hold_ms: 1200 }],
	winking: [{ head: "tilt_right", face: "winking", gaze: "user", hold_ms: 900 }],
	smug_grin: [{ head: "lifted", face: "smug_grin", gaze: "user", hold_ms: 1000 }],
	sleepy_yawn: [
		{ head: "lifted", face: "sleepy_yawn", gaze: "down", hold_ms: 700 },
		{ head: "lowered", face: "tender_smile", gaze: "user", hold_ms: 600 },
	],
};

/**
 * 常见语义别名映射表（兼容大模型与用户的简写、直觉标签，如 smile -> warm_smile）
 */
export const CUE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	smile: "warm_smile",
	tender_smile: "warm_smile",
	nod: "affirmative_nod",
	doublenod: "double_nod",
	shake: "shake_head",
	shrug: "shrug",
	bop: "head_bop",
	headbop: "head_bop",
	laugh: "happy_laugh",
	giggle: "happy_laugh",
	tilt: "curious_tilt",
	curious: "curious_tilt",
	pout: "playful_pout",
	shock: "surprised_gasp",
	gasp: "surprised_gasp",
	surprised: "surprised_gasp",
	shy: "shy",
	lookaway: "look_away",
	peek: "peek_back",
	peekback: "peek_back",
	thinking: "thinking_deep",
	wink: "winking",
	smug: "smug_grin",
	yawn: "sleepy_yawn",
});

/**
 * 规范 cue id 的单一事实来源：由 CUE_BEAT_TABLE 键派生。
 * 任何"该身体能响应哪些 cue"的对外声明（如宿主提示词的 affordance）都必须从这里取，
 * 而不是在别处再写一份 id 列表——否则声明与解析两个来源一旦漂移，
 * 模型按提示词用了 cue、派发层却解析不到，正是本项目 2026-09-21 的缺陷类型。
 */
export const CANONICAL_CUE_IDS: readonly string[] = Object.freeze(Object.keys(CUE_BEAT_TABLE));

/**
 * 求某规范 cue 的别名集合（反向 CUE_ALIASES）。
 * 过滤掉与规范 id 相同的恒等项（如 shrug: "shrug"），使声明保持干净。
 * 供宿主提示词能力声明与解析端共享同一份别名事实。
 */
export function getCueAliases(canonicalId: string): readonly string[] {
	const aliases: string[] = [];
	for (const [alias, target] of Object.entries(CUE_ALIASES)) {
		if (target === canonicalId && alias !== target) aliases.push(alias);
	}
	return aliases;
}

/**
 * 默认即兴表情与动作表现强度基准 (0.1 ~ 1.0)
 */
export const DEFAULT_EXPRESSIVE_INTENSITY = 0.6;

/**
 * 将大模型输入的即兴动作/节拍转换为 Live2D Cubism 目标参数
 */
export function resolveBeatToParams(
	beat: ExpressBeat,
	intensity = DEFAULT_EXPRESSIVE_INTENSITY,
): Live2DParamTarget[] {
	const targets: Live2DParamTarget[] = [];
	const clampedIntensity = Math.max(0.1, Math.min(1.0, intensity));

	const applyTable = (weights?: ParamWeight[]) => {
		if (!weights) return;
		for (const w of weights) {
			const isAdditive = w.additive ?? (
				!w.fixed && (w.name.startsWith("ParamAngle") || w.name.startsWith("ParamBodyAngle"))
			);
			targets.push({
				name: w.name,
				value: w.fixed ? w.mult : w.mult * clampedIntensity,
				...(isAdditive ? { additive: true } : {}),
			});
		}
	};

	if (beat.gaze) applyTable(GAZE_TABLE[beat.gaze as GazeDirection]);
	if (beat.head) applyTable(HEAD_TABLE[beat.head as HeadPose]);
	if (beat.face) applyTable(FACE_TABLE[beat.face as FaceExpression]);

	return targets;
}

/**
 * 将语义 Cue 映射为对应的 ExpressBeat 节拍序列（支持别名映射与模糊容错）
 */
export function resolveCueToBeat(cueId: string): ExpressBeat[] | null {
	if (!cueId) return null;
	const normalized = cueId.toLowerCase().trim().replace(/[\s-]+/g, "_");

	// 1. 直接精确匹配
	if (CUE_BEAT_TABLE[normalized]) {
		return CUE_BEAT_TABLE[normalized]!;
	}

	// 2. 别名表映射 (如 smile -> warm_smile, nod -> affirmative_nod)
	const aliased = CUE_ALIASES[normalized];
	if (aliased && CUE_BEAT_TABLE[aliased]) {
		return CUE_BEAT_TABLE[aliased]!;
	}

	// 3. 去除下划线后的归一化匹配 (如 warmsmile, affirmativenod)
	const stripped = normalized.replace(/_/g, "");
	for (const [key, beats] of Object.entries(CUE_BEAT_TABLE)) {
		if (key.replace(/_/g, "") === stripped) {
			return beats;
		}
	}
	for (const [aliasKey, targetKey] of Object.entries(CUE_ALIASES)) {
		if (aliasKey.replace(/_/g, "") === stripped && CUE_BEAT_TABLE[targetKey]) {
			return CUE_BEAT_TABLE[targetKey]!;
		}
	}

	return null;
}

// 预先静态映射每个微表情所占据的通道集合（消除 60Hz / 频繁调用时的重复计算与数组分配）
const FACE_CHANNELS_MAP: Readonly<Record<FaceExpression, readonly Live2DChannel[]>> = Object.freeze({
	shy: ["eyes", "mouth"],
	smug: ["eyes", "mouth"],
	pout: ["eyes", "mouth"],
	sparkle: ["eyes"],
	shocked: ["eyes", "mouth"],
	tender_smile: ["eyes", "mouth"],
	laugh: ["eyes", "mouth"],
	winking: ["eyes", "mouth"],
	smug_grin: ["eyes", "mouth", "gaze"],
	sleepy_yawn: ["eyes", "mouth"],
});

/**
 * 根据节拍序列推导需要锁定的物理通道集合（最小特权原则）
 */
export function getChannelsForBeats(beats: readonly ExpressBeat[]): Live2DChannel[] {
	const channels = new Set<Live2DChannel>();
	for (const beat of beats) {
		if (beat.head) channels.add("head");
		if (beat.gaze) channels.add("gaze");
		if (beat.face) {
			const faceChannels = FACE_CHANNELS_MAP[beat.face as FaceExpression];
			if (faceChannels) {
				for (const ch of faceChannels) channels.add(ch);
			} else {
				// 未知表情回退安全检查
				const targets = resolveBeatToParams({ face: beat.face });
				for (const t of targets) {
					const ch = PARAM_CHANNEL_MAP[t.name];
					if (ch) channels.add(ch);
				}
			}
		}
	}
	if (channels.size === 0) {
		channels.add("head");
		channels.add("gaze");
		channels.add("eyes");
	}
	return Array.from(channels);
}
