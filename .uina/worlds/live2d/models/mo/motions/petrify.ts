import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline, smoothstep } from "../../../authoring/curves.js";

/**
 * 物理程序化“五雷轰顶石化”（时长 4600ms）。
 *
 * 核心萌点与动力学架构：
 * 1. 【晴天霹雳爆发后仰 (Lightning Shock Recoil)】：
 *    0~150ms 猛然后仰爆发冲至 +9.2°，伴随歪斜侧倒 (-5.5°) 与 -3.8° 侧别。
 * 2. 【全身褪色灰白石雕 (Stone Statue Desaturation)】：
 *    150ms 瞬间挂上冷灰滤镜 (tint 110, 115, 125)，僵死长达 3800ms！
 * 3. 【石雕裂纹高频细震 (Micro-Fracture Tremor)】：
 *    在僵死定格期间注入 16Hz 极高频硬质细微震颤，模拟石雕快要崩裂的戏剧张力！
 * 4. 【破冰苏醒双重眨眼 (Thaw Awakening & Blinks)】：
 *    3950ms 色彩重回，伴随两次可爱的苏醒眨眼，缓缓回正解除石化。
 */
export const petrify: ActionAuthoring = (rng) => {
	const gain = 0.96 + rng() * 0.08;

	const durationMs = 4600;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const crackEnvelope = (t: number): number => smoothstep(150, 260, t) * (1 - smoothstep(3800, 3950, t));

	// 1. 头部俯仰：0~150ms 猛然后仰至 +9.2°，在 150~3950ms 保持石雕僵硬并伴随微裂高频细震，随后回神收正
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 150) {
			const u = smoothstep(0, 150, t);
			return 9.2 * gain * u;
		}
		if (t < 3950) {
			// 石雕微裂高频微震颤 (16Hz)
			const crack = 0.22 * Math.sin(((t - 150) / 1000) * 2 * Math.PI * 16) * crackEnvelope(t);
			return (9.2 + crack) * gain;
		}
		const u = smoothstep(3950, durationMs, t);
		return 9.2 * gain * (1 - u);
	};

	// 2. 头部侧倾：后仰伴随侧歪 (-5.5°) 与高频微震
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 150) {
			const u = smoothstep(0, 150, t);
			return -5.5 * gain * u;
		}
		if (t < 3950) {
			const crack = 0.15 * Math.sin(((t - 150) / 1000) * 2 * Math.PI * 16 + 1.2) * crackEnvelope(t);
			return (-5.5 + crack) * gain;
		}
		const u = smoothstep(3950, durationMs, t);
		return -5.5 * gain * (1 - u);
	};

	// 3. 头部偏航：轻微侧别 (-3.8°)
	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 150) {
			const u = smoothstep(0, 150, t);
			return -3.8 * gain * u;
		}
		if (t < 3950) {
			return -3.8 * gain;
		}
		const u = smoothstep(3950, durationMs, t);
		return -3.8 * gain * (1 - u);
	};

	// 4. 躯干解耦：抵消 88% 的跟随，杜绝身体向后倾倒
	const evaluateTorsoPitch = (t: number): number => {
		return -evaluateHeadPitch(t) * 0.88;
	};
	const evaluateTorsoRoll = (t: number): number => {
		return -evaluateHeadRoll(t) * 0.85;
	};
	const evaluateTorsoYaw = (t: number): number => -evaluateHeadYaw(t) * 0.85;

	// 5. 眼神发直：呆滞仰视空洞 (+0.22)
	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 3950) return 0.22 * smoothstep(0, 120, t);
		const u = smoothstep(3950, durationMs, t);
		return 0.22 * (1 - u);
	};

	// 6. 嘴巴僵硬半张发愣 (0.58)
	const evaluateMouthOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 150) {
			const u = smoothstep(0, 150, t);
			return 0.58 * gain * u;
		}
		if (t < 3950) {
			return 0.58 * gain;
		}
		const u = smoothstep(3950, durationMs, t);
		return 0.58 * gain * (1 - u);
	};

	// 7. 解除石化苏醒双重眨眼 (4050~4220ms, 4300~4470ms)
	const evaluateEyeOpen = (t: number): number => {
		if (t >= 4050 && t < 4220) {
			const u = t < 4135 ? smoothstep(4050, 4135, t) : 1 - smoothstep(4135, 4220, t);
			return -0.85 * u;
		}
		if (t >= 4300 && t < 4470) {
			const u = t < 4385 ? smoothstep(4300, 4385, t) : 1 - smoothstep(4385, 4470, t);
			return -0.85 * u;
		}
		return 0;
	};

	return {
		timeline: time,
		torso: "head-relative",
		channels: {
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"mouth.open": offset(during(whole, evaluateMouthOpen)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
		},
		spatial: [
			{ at: 150, effects: { tint: { r: 110, g: 115, b: 125 } } },
			{ at: 3950, effects: { tint: { r: 255, g: 255, b: 255 } } },
		],
	};
};

export default petrify;
