import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline } from "../../../authoring/curves.js";

function smoothstep5(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 物理程序化“小鸡啄米打瞌睡猛然惊醒”(Sleepy，时长 3400ms)。
 *
 * 核心 VTuber 萌点与动力学：
 * 1. 【沉重垂首与眼皮打架 (Heavy Nod-off)】：
 *    0~1600ms 脑袋如铅坠般一点一点沉重下垂 (-8.8°)，双眼沉沉完全合拢 (-1.0)；
 * 2. 【深睡死寂停顿 (Slumber Dwell)】：
 *    1600~2000ms 彻底睡着，安详微鼾；
 * 3. 【猛然一激灵弹射惊醒 (Jolt Awake Recoil)】：
 *    2000~2250ms 身体一震！头部如触电般猛然从 -8.8° 弹跳后仰至 +7.5°，双眼大睁，微张嘴倒吸凉气！
 * 4. 【揉眼清醒三连眨眼与强打精神】：
 *    2400~3400ms 伴随困惑摇晃与三连快速眨眼，露出不好意思的娇憨害羞微笑。
 */
export const sleepy: ActionAuthoring = (rng) => {
	const gain = 0.96 + rng() * 0.08;

	const durationMs = 3400;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");

	// 1. 头部俯仰：缓慢沉重低垂 -> 惊醒猛跳 -> 困倦微晃收正
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		// 0~1600ms: 沉沉下垂，伴随两次小鸡啄米小磕头
		if (t < 1600) {
			const baseDrop = -7.5 * smoothstep5(0, 1600, t) - 1.3 * smoothstep5(1400, 1600, t);
			const nodWave = -1.3 * Math.sin((t / 1600) * 2 * Math.PI) ** 2;
			return (baseDrop + nodWave) * gain;
		}
		// 1600~2000ms: 沉睡极值 (-8.8°)
		if (t < 2000) {
			return -8.8 * gain;
		}
		// 2000~2250ms: 触电式猛跳战术后仰 (+7.5°)
		if (t < 2250) {
			const u = smoothstep5(2000, 2250, t);
			return (-8.8 + 16.3 * u) * gain;
		}
		// 2250~3400ms: 揉眼醒神缓缓归位
		const u = smoothstep5(2250, durationMs, t);
		return 7.5 * gain * (1 - u);
	};

	// 2. 双眼闭合：0~1600ms 困倦合眼，2000ms 瞬间大睁，2400~3200ms 三重清醒眨眼
	const evaluateEyeOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		// 入睡阶段眼皮合拢
		if (t < 1600) {
			const u = smoothstep5(200, 1400, t);
			return -1.0 * u;
		}
		// 熟睡完全闭合
		if (t < 2000) {
			return -1.0;
		}
		// 惊醒疾速大睁 (2000~2120ms 触电式睁眼，随后保持清醒睁大)
		if (t < 2120) {
			const u = smoothstep5(2000, 2120, t);
			return -1.0 * (1 - u);
		}
		// 惊醒瞬间眼睛大睁 (offset = 0 即 neutral 1.0)
		if (t < 2350) {
			return 0;
		}
		// 2350~3200ms 清醒三连眨眼
		if (t >= 2400 && t < 2600) {
			const u = t < 2500 ? smoothstep5(2400, 2500, t) : 1 - smoothstep5(2500, 2600, t);
			return -0.85 * u;
		}
		if (t >= 2700 && t < 2900) {
			const u = t < 2800 ? smoothstep5(2700, 2800, t) : 1 - smoothstep5(2800, 2900, t);
			return -0.85 * u;
		}
		if (t >= 3000 && t < 3200) {
			const u = t < 3100 ? smoothstep5(3000, 3100, t) : 1 - smoothstep5(3100, 3200, t);
			return -0.85 * u;
		}
		return 0;
	};

	// 3. 头部侧倾：打瞌睡时的轻微侧倒 (-3.5°) 与惊醒后的轻摇
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 2000) {
			const u = smoothstep5(400, 1600, t);
			return -3.5 * u * gain;
		}
		if (t < 2300) {
			const u = smoothstep5(2000, 2300, t);
			return -3.5 * (1 - u) * gain;
		}
		// 惊醒后清醒小摇晃
		const shakeTime = (t - 2300) / 1000;
		const attack = smoothstep5(2300, 2400, t);
		const decay = 1 - smoothstep5(2300, durationMs, t);
		return 2.5 * Math.sin(shakeTime * 2 * Math.PI * 2.0) * attack * decay * gain;
	};

	// 4. 头部偏航：轻度配合侧倾
	const evaluateHeadYaw = (t: number): number => evaluateHeadRoll(t) * 0.45;

	// 5. 躯干解耦
	const evaluateTorsoPitch = (t: number): number => -evaluateHeadPitch(t) * 0.88;
	const evaluateTorsoRoll = (t: number): number => -evaluateHeadRoll(t) * 0.85;

	// 6. 视线下垂与直视
	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 2000) return -0.45 * smoothstep5(200, 1500, t);
		if (t < 2150) {
			const u = smoothstep5(2000, 2150, t);
			return -0.45 + (0.25 - -0.45) * u;
		}
		if (t < 2350) return 0.25; // 惊醒看天花板
		const u = smoothstep5(2350, durationMs, t);
		return 0.25 * (1 - u);
	};

	// 7. 嘴巴表情：睡觉微张呼吸 (0.12) -> 惊醒大张倒吸气 (0.55) -> 不好意思甜笑 (0.68)
	const evaluateMouthOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 2000) return 0.12 * smoothstep5(300, 1200, t) * gain;
		if (t < 2400) {
			const u = smoothstep5(2000, 2150, t);
			const decay = 1 - smoothstep5(2250, 2400, t);
			return (0.12 + 0.43 * u) * decay * gain;
		}
		return 0;
	};

	const evaluateMouthForm = (t: number): number => {
		if (t < 2300 || t >= durationMs) return 0;
		const attack = smoothstep5(2300, 2600, t);
		const decay = 1 - smoothstep5(3100, durationMs, t);
		return 0.68 * attack * decay * gain;
	};

	return {
		timeline: time,
		channels: {
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"mouth.open": offset(during(whole, evaluateMouthOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

export default sleepy;
