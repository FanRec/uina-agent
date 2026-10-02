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
		{ name: "ParamBrowLY", mult: -0.35, additive: true },
		{ name: "ParamBrowRY", mult: -0.35, additive: true },
		{ name: "ParamEyeLOpen", mult: 0.75, fixed: true },
		{ name: "ParamEyeROpen", mult: 0.75, fixed: true },
		{ name: "ParamEyeLSmile", mult: 0.7, additive: true },
		{ name: "ParamEyeRSmile", mult: 0.7, additive: true },
		{ name: "ParamMouthForm", mult: 0.3, fixed: true },
	],
	smug: [
		{ name: "ParamBrowRY", mult: 0.7, additive: true },
		{ name: "ParamBrowLY", mult: -0.25, additive: true },
		{ name: "ParamEyeROpen", mult: 0.85, fixed: true },
		{ name: "ParamEyeLOpen", mult: 0.75, fixed: true },
		{ name: "ParamEyeRSmile", mult: 0.9, additive: true },
		{ name: "ParamEyeLSmile", mult: 0.35, additive: true },
		{ name: "ParamMouthForm", mult: 0.9 },
	],
	pout: [
		{ name: "ParamBrowLY", mult: -0.65, additive: true },
		{ name: "ParamBrowRY", mult: -0.65, additive: true },
		{ name: "ParamEyeLOpen", mult: 0.82, fixed: true },
		{ name: "ParamEyeROpen", mult: 0.82, fixed: true },
		{ name: "ParamMouthForm", mult: -0.9 },
		{ name: "ParamCheek", mult: 0.9, additive: true },
	],
	sparkle: [
		{ name: "ParamBrowLY", mult: 0.75, additive: true },
		{ name: "ParamBrowRY", mult: 0.75, additive: true },
		{ name: "ParamEyeLOpen", mult: 1.35, fixed: true },
		{ name: "ParamEyeROpen", mult: 1.35, fixed: true },
		{ name: "ParamEyeLSmile", mult: 0.8, additive: true },
		{ name: "ParamEyeRSmile", mult: 0.8, additive: true },
		{ name: "ParamCheek", mult: 0.6, additive: true },
		{ name: "ParamMouthForm", mult: 0.8 },
	],
	shocked: [
		{ name: "ParamEyeLOpen", mult: 1.4, fixed: true },
		{ name: "ParamEyeROpen", mult: 1.4, fixed: true },
		{ name: "ParamMouthOpenY", mult: 0.85 },
		{ name: "ParamBrowLY", mult: 0.9, additive: true },
		{ name: "ParamBrowRY", mult: 0.9, additive: true },
	],
	tender_smile: [
		{ name: "ParamEyeLSmile", mult: 0.95, additive: true },
		{ name: "ParamEyeRSmile", mult: 0.95, additive: true },
		{ name: "ParamBrowLY", mult: 0.35, additive: true },
		{ name: "ParamBrowRY", mult: 0.35, additive: true },
		{ name: "ParamEyeLOpen", mult: 0.88, fixed: true },
		{ name: "ParamEyeROpen", mult: 0.88, fixed: true },
		{ name: "ParamMouthForm", mult: 0.85 },
		{ name: "ParamCheek", mult: 0.4, additive: true },
	],
	laugh: [
		{ name: "ParamBrowLY", mult: 0.55, additive: true },
		{ name: "ParamBrowRY", mult: 0.55, additive: true },
		{ name: "ParamEyeLOpen", mult: 0.05, fixed: true },
		{ name: "ParamEyeROpen", mult: 0.05, fixed: true },
		{ name: "ParamEyeLSmile", mult: 1.0, fixed: true },
		{ name: "ParamEyeRSmile", mult: 1.0, fixed: true },
		{ name: "ParamMouthOpenY", mult: 0.75 },
		{ name: "ParamMouthForm", mult: 1.0, fixed: true },
		{ name: "ParamCheek", mult: 0.6, additive: true },
	],
	winking: [
		{ name: "ParamBrowLY", mult: 0.45, additive: true },
		{ name: "ParamBrowRY", mult: -0.25, additive: true },
		{ name: "ParamEyeROpen", mult: 0.05, fixed: true },
		{ name: "ParamEyeLOpen", mult: 1.15, fixed: true },
		{ name: "ParamEyeRSmile", mult: 1.0, fixed: true },
		{ name: "ParamEyeLSmile", mult: 0.5, additive: true },
		{ name: "ParamMouthForm", mult: 0.8 },
		{ name: "ParamCheek", mult: 0.5, additive: true },
	],
	smug_grin: [
		{ name: "ParamBrowRY", mult: 0.75, additive: true },
		{ name: "ParamBrowLY", mult: -0.3, additive: true },
		{ name: "ParamEyeROpen", mult: 0.85, fixed: true },
		{ name: "ParamEyeLOpen", mult: 0.75, fixed: true },
		{ name: "ParamEyeRSmile", mult: 0.95, additive: true },
		{ name: "ParamEyeLSmile", mult: 0.35, additive: true },
		{ name: "ParamEyeBallY", mult: -0.2 },
		{ name: "ParamMouthForm", mult: 1.0 },
	],
	sleepy_yawn: [
		{ name: "ParamBrowLY", mult: -0.4, additive: true },
		{ name: "ParamBrowRY", mult: -0.4, additive: true },
		{ name: "ParamEyeLOpen", mult: 0.2, fixed: true },
		{ name: "ParamEyeROpen", mult: 0.2, fixed: true },
		{ name: "ParamMouthOpenY", mult: 0.9 },
	],
};

/**
 * 三个映射表的键集合（单一事实来源派生）：
 * 工具 schema 的 enum、错误提示的可用值列表都必须从这里取，
 * 防止 schema 手抄一份后与映射表漂移（曾出现 schema 只声明 7 个表情、表里却有 10 个）。
 */
export const GAZE_DIRECTIONS: readonly string[] = Object.freeze(Object.keys(GAZE_TABLE));
export const HEAD_POSES: readonly string[] = Object.freeze(Object.keys(HEAD_TABLE));
export const FACE_EXPRESSIONS: readonly string[] = Object.freeze(Object.keys(FACE_TABLE));

/**
 * 校验节拍字段：返回无法识别或缺失内容的描述（空数组 = 全部合法可执行）。
 * 未知字段不得静默无操作——那会让执行方谎报成功。
 */
export function validateBeats(beats: readonly ExpressBeat[]): string[] {
	const invalid: string[] = [];
	for (const beat of beats) {
		if (beat.head === undefined && beat.gaze === undefined && beat.face === undefined) {
			invalid.push("空节拍（缺少 head/gaze/face 任一动作内容）");
			continue;
		}
		if (beat.head !== undefined && !HEAD_TABLE[beat.head as HeadPose]) invalid.push(`head="${beat.head}"`);
		if (beat.gaze !== undefined && !GAZE_TABLE[beat.gaze as GazeDirection]) invalid.push(`gaze="${beat.gaze}"`);
		if (beat.face !== undefined && !FACE_TABLE[beat.face as FaceExpression]) invalid.push(`face="${beat.face}"`);
	}
	return invalid;
}

// 4. 语义 Cue 到 ExpressBeat 声明式映射表 (生动立体的组合微动作)
const CUE_BEAT_TABLE: Record<string, ExpressBeat[]> = {
	warm_smile: [{ face: "tender_smile", head: "tilt_left", gaze: "user", hold_ms: 1200 }],
	happy_laugh: [
		{ head: "lifted", face: "laugh", gaze: "user", hold_ms: 450 },
		{ head: "nod", face: "sparkle", gaze: "user", hold_ms: 650 },
	],
	curious_tilt: [{ head: "tilt_right", face: "tender_smile", gaze: "user", hold_ms: 1200 }],
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
	sparkle: [{ face: "sparkle", gaze: "user", hold_ms: 1000 }],
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
	sparkle: "sparkle",
	star_eyes: "sparkle",
	excited: "sparkle",
});

/**
 * 规范 cue id 的单一事实来源：由 CUE_BEAT_TABLE 键派生。
 * 任何"该身体能响应哪些 cue"的对外声明（如宿主提示词的 affordance）都必须从这里取，
 * 而不是在别处再写一份 id 列表——否则声明与解析两个来源一旦漂移，
 * 模型按提示词用了 cue、派发层却解析不到，正是本项目 2026-09-21 的缺陷类型。
 */
export const CANONICAL_CUE_IDS: readonly string[] = Object.freeze(Object.keys(CUE_BEAT_TABLE));

/**
 * 规范 cue 的一行说明（注入提示词的 prose 事实字典）。
 */
export const CUE_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
	warm_smile: "温暖友善的微笑",
	happy_laugh: "开心地眯眼大笑",
	curious_tilt: "好奇探寻地歪头",
	affirmative_nod: "肯定点头赞同",
	double_nod: "用力连续点头两次，强烈赞成",
	shake_head: "拨浪鼓式连连摇头",
	shrug: "无奈耸肩叹气",
	head_bop: "随说话节奏轻快点晃头",
	playful_pout: "傲娇嘟嘴偏头",
	surprised_gasp: "惊讶睁大眼睛倒吸气",
	shy: "害羞脸红偏头避开视线",
	look_away: "尴尬移开视线望向别处",
	peek_back: "移开视线后又悄悄偷看回用户",
	thinking_deep: "歪头托腮陷入深思",
	winking: "调皮单眼眨眼",
	smug_grin: "得意坏笑歪嘴",
	sleepy_yawn: "犯困打哈欠微仰头",
	sparkle: "眼眸闪烁兴奋发光",
});

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
 * 反射持续状态的声明式姿态表。
 * 区别于 CUE_BEAT_TABLE 的一次性节拍：这是"状态期间持续维持"的目标。
 * 与 GAZE/HEAD/FACE 表同属单一事实来源——反射层只引用键名，不再内联魔法数。
 * （此前"思考歪头"在反射层内联 ParamAngleZ=10.0，与表里 thinking_deep 引用的
 * tilt_right(-18.0) 方向相反，同一概念两处定义且数值矛盾。）
 */
export type ReflexStateKey = "thinking";

export const REFLEX_POSES: Readonly<Record<ReflexStateKey, readonly Live2DParamTarget[]>> = Object.freeze({
	// 歪头 14°（加深）+ 微低头 -5°（nod=-20 同方向）：沉思的立体姿态语言。
	// 视线斜上方打底由 compose 层的 thinking 游移与 VOR 让位配合生效（见 motion-director）。
	thinking: Object.freeze([
		{ name: "ParamAngleZ", value: 14.0 },
		{ name: "ParamAngleY", value: -5.0 },
		{ name: "ParamEyeBallY", value: 0.6 },
		{ name: "ParamEyeBallX", value: -0.4 },
	]),
});

/** 反射状态姿态占用的参数名集合（供复位时精确回归基准）。 */
export const REFLEX_POSE_PARAMS: readonly string[] = Object.freeze(
	Array.from(new Set(Object.values(REFLEX_POSES).flatMap((targets) => targets.map((t) => t.name)))),
);

/**
 * 默认即兴表情与动作表现强度基准 (0.1 ~ 1.0)。
 * 1.0 = 映射表标定的满幅值；cue 通道恒为满幅，express 缺省同口径，
 * 需要收敛时由调用方显式降档（如 0.6）。
 */
export const DEFAULT_EXPRESSIVE_INTENSITY = 1.0;

/**
 * 将大模型输入的即兴动作/节拍转换为 Live2D Cubism 目标参数
 */
export function resolveBeatToParams(
	beat: ExpressBeat,
	defaultIntensity = DEFAULT_EXPRESSIVE_INTENSITY,
): Live2DParamTarget[] {
	const targets: Live2DParamTarget[] = [];
	const rawIntensity = beat.intensity !== undefined ? beat.intensity : defaultIntensity;
	const clampedIntensity = Math.max(0.1, Math.min(1.0, rawIntensity));

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
 * 前庭-动眼反射 (VOR, Vestibulo-Ocular Reflex) 动态几何代偿计算:
 * 当头部发生空间转动偏角 (Yaw / Pitch / Roll) 时，眼球局部坐标系产生反向代偿，
 * 维持视线对镜头/观众 (0, 0) 的精准锁定，消除二次元角色的“歪头即散瞳”感。
 */
export function computeVORCompensation(
	headAngleX = 0,
	headAngleY = 0,
	headAngleZ = 0,
): { vorX: number; vorY: number } {
	// headAngleX [-30, 30]: 水平转头反向代偿 (头向右转，眼球左移看镜头)
	// headAngleZ [-30, 30]: 侧倾歪头向心代偿
	// headAngleY [-30, 30]: 俯仰点头反向代偿 (低头形成动人上目线看镜头)
	const rawX = -0.65 * (headAngleX / 30.0) - 0.30 * (headAngleZ / 30.0);
	const rawY = -0.70 * (headAngleY / 30.0);
	const vorX = rawX === 0 ? 0 : rawX;
	const vorY = rawY === 0 ? 0 : rawY;
	return {
		vorX: Math.max(-0.6, Math.min(0.6, vorX)),
		vorY: Math.max(-0.6, Math.min(0.6, vorY)),
	};
}

function findBaseBeats(name: string): readonly ExpressBeat[] | null {
	// 两级解析：规范表 → 别名表。不做去下划线模糊匹配——
	// 调用方（LLM）的可用词表由 affordance 声明，模糊层只会制造"看不懂为何触发"的行为。
	const normalized = name.toLowerCase().replace(/[\s-]+/g, "_");
	if (CUE_BEAT_TABLE[normalized]) return CUE_BEAT_TABLE[normalized]!;
	const aliased = CUE_ALIASES[normalized];
	if (aliased && CUE_BEAT_TABLE[aliased]) return CUE_BEAT_TABLE[aliased]!;
	return null;
}

function parseCueSegment(segment: string): {
	head?: HeadPose;
	face?: FaceExpression;
	gaze?: GazeDirection;
	hold_ms?: number;
	intensity?: number;
	latch?: boolean;
	rawName?: string;
} {
	const sepIdx = segment.indexOf("=");
	const colonIdx = segment.indexOf(":");
	let key: string | undefined;
	let val: string = segment;

	if (sepIdx !== -1) {
		key = segment.slice(0, sepIdx).trim().toLowerCase();
		val = segment.slice(sepIdx + 1).trim();
	} else if (colonIdx !== -1) {
		const candidateKey = segment.slice(0, colonIdx).trim().toLowerCase();
		if (["head", "face", "gaze", "hold", "hold_ms", "intensity", "latch"].includes(candidateKey)) {
			key = candidateKey;
			val = segment.slice(colonIdx + 1).trim();
		}
	}

	if (key) {
		const lowerVal = val.toLowerCase();
		if (key === "head" && HEAD_TABLE[lowerVal as HeadPose]) return { head: lowerVal as HeadPose };
		if (key === "face" && FACE_TABLE[lowerVal as FaceExpression]) return { face: lowerVal as FaceExpression };
		if (key === "gaze" && GAZE_TABLE[lowerVal as GazeDirection]) return { gaze: lowerVal as GazeDirection };
		if (key === "hold" || key === "hold_ms") {
			const n = parseInt(val, 10);
			if (!isNaN(n)) return { hold_ms: n };
		}
		if (key === "intensity") {
			const n = parseFloat(val);
			if (!isNaN(n)) return { intensity: n };
		}
		if (key === "latch") {
			return { latch: lowerVal === "true" || lowerVal === "1" };
		}
	}

	// 无键段可携带冒号修饰（与单 cue 语法一致）：smile:0.8 / warm_smile:1500。
	// 此前复合表达式里的修饰段被静默丢弃——"tilt_left, smile:0.8" 的第二段解析不出，真 bug。
	if (colonIdx !== -1 && !key) {
		const parts = segment.split(":").map((p) => p.trim()).filter(Boolean);
		const out: { rawName?: string; intensity?: number; hold_ms?: number } = {
			rawName: parts[0]!.toLowerCase().replace(/[\s-]+/g, "_"),
		};
		for (let i = 1; i < parts.length; i++) {
			const n = parseFloat(parts[i]!);
			if (isNaN(n)) continue;
			if (n > 0 && n <= 1.0) out.intensity = n;
			else if (n >= 50) out.hold_ms = Math.round(n);
		}
		return out;
	}

	// 无键裸段：只作为动作名解析（规范 cue / 别名 / 原子姿态）。
	// 不再按数量级猜语义（裸 0.5 → intensity、裸 200 → hold_ms）——
	// 数值修饰必须键控（intensity=0.5 / hold=200）或走冒号修饰（smile:0.8）。
	return { rawName: segment.toLowerCase().replace(/[\s-]+/g, "_") };
}

/**
 * 将语义 Cue 映射为对应的 ExpressBeat 节拍序列（支持别名映射、参数修饰、原子组合与模糊容错）
 */
export function resolveCueToBeat(cueId: string): ExpressBeat[] | null {
	if (!cueId) return null;
	const trimmed = cueId.trim();
	if (!trimmed) return null;

	// 1. 如果包含多段分隔符 (逗号, 分号, 和号, 加号)，作为多属性复合表达式解析
	const hasMultiPart = /[,;&+]/.test(trimmed);
	if (hasMultiPart) {
		const parts = trimmed.split(/[,;&+]/).map((p) => p.trim()).filter(Boolean);
		const beat: ExpressBeat = {};
		for (const part of parts) {
			const parsed = parseCueSegment(part);
			if (parsed.head && HEAD_TABLE[parsed.head]) beat.head = parsed.head;
			if (parsed.gaze && GAZE_TABLE[parsed.gaze]) beat.gaze = parsed.gaze;
			if (parsed.face && FACE_TABLE[parsed.face]) beat.face = parsed.face;
			if (parsed.hold_ms !== undefined) beat.hold_ms = parsed.hold_ms;
			if (parsed.intensity !== undefined) beat.intensity = parsed.intensity;
			if (parsed.latch !== undefined) beat.latch = parsed.latch;

			// 若子段直接对应别名/完整微表情（如 tilt_left, smile 中的 smile）
			if (!parsed.head && !parsed.face && !parsed.gaze && parsed.rawName) {
				const subBeats = findBaseBeats(parsed.rawName);
				if (subBeats && subBeats.length > 0) {
					const first = subBeats[0]!;
					if (first.head && !beat.head) beat.head = first.head;
					if (first.face && !beat.face) beat.face = first.face;
					if (first.gaze && !beat.gaze) beat.gaze = first.gaze;
				} else if (HEAD_TABLE[parsed.rawName as HeadPose]) {
					beat.head = parsed.rawName as HeadPose;
				} else if (FACE_TABLE[parsed.rawName as FaceExpression]) {
					beat.face = parsed.rawName as FaceExpression;
				} else if (GAZE_TABLE[parsed.rawName as GazeDirection]) {
					beat.gaze = parsed.rawName as GazeDirection;
				}
			}
		}

		if (beat.head || beat.face || beat.gaze) {
			if (!beat.gaze && beat.head) beat.gaze = "user";
			if (!beat.hold_ms) beat.hold_ms = 1000;
			return [beat];
		}
	}

	// 2. 单动作表达式（支持冒号修饰如 smile:0.8 或 warm_smile:1500 或 tilt_right:1200）
	const colonParts = trimmed.split(":").map((s) => s.trim()).filter(Boolean);
	const rawName = colonParts[0] ?? "";
	let customHoldMs: number | undefined;
	let customIntensity: number | undefined;

	for (let i = 1; i < colonParts.length; i++) {
		const seg = colonParts[i]!;
		const num = parseFloat(seg);
		if (!isNaN(num)) {
			if (num > 0 && num <= 1.0) {
				customIntensity = num;
			} else if (num >= 50) {
				customHoldMs = Math.round(num);
			}
		}
	}

	const applyModifiers = (beats: readonly ExpressBeat[]): ExpressBeat[] => {
		return beats.map((b) => ({
			...b,
			...(customHoldMs !== undefined ? { hold_ms: customHoldMs } : {}),
			...(customIntensity !== undefined ? { intensity: customIntensity } : {}),
		}));
	};

	// 2.1 检查完整标准 Cue 或别名
	const baseBeats = findBaseBeats(rawName);
	if (baseBeats) {
		return applyModifiers(baseBeats);
	}

	// 2.2 检查原子动作快捷入口 (头部、面部、视线)
	const norm = rawName.toLowerCase().replace(/[\s-]+/g, "_");
	if (HEAD_TABLE[norm as HeadPose]) {
		return applyModifiers([{ head: norm as HeadPose, gaze: "user", hold_ms: 1000 }]);
	}
	if (FACE_TABLE[norm as FaceExpression]) {
		return applyModifiers([{ face: norm as FaceExpression, gaze: "user", hold_ms: 1000 }]);
	}
	if (GAZE_TABLE[norm as GazeDirection]) {
		return applyModifiers([{ gaze: norm as GazeDirection, hold_ms: 1000 }]);
	}

	return null;
}

/**
 * 根据节拍序列推导需要锁定的物理通道集合（最小特权原则）。
 * 单一事实来源：face 通道由 FACE_TABLE 映射目标派生——此前另有静态 FACE_CHANNELS_MAP
 * 手抄一份，表情表一改即静默漂移。调用方（express/cue）均已通过 validateBeats
 * 或内部可信表保证节拍有内容，无内容时返回空数组——claim([]) 会得到空租约而非谎占通道空转。
 */
export function getChannelsForBeats(beats: readonly ExpressBeat[]): Live2DChannel[] {
	const channels = new Set<Live2DChannel>();
	for (const beat of beats) {
		if (beat.head) channels.add("head");
		if (beat.gaze) channels.add("gaze");
		if (beat.face) {
			for (const target of resolveBeatToParams({ face: beat.face })) {
				const ch = PARAM_CHANNEL_MAP[target.name];
				if (ch) channels.add(ch);
			}
		}
	}
	return Array.from(channels);
}

