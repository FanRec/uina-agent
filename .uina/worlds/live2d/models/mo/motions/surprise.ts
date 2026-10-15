import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline } from "../../../authoring/curves.js";

function smoothstep5(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 物理程序化“战术后仰呆滞惊讶”（时长 2500ms）。
 *
 * 核心萌点与动力学架构：
 * 1. 【战术大后仰爆发 (Tactical Recoil Launch)】：
 *    0~160ms 极速后仰爆发冲至 +8.8°，头颈产生强烈的受惊后坐力。
 * 2. 【躯干支撑】：
 *    offset 抵消大部分头部跟随，身体只保留少量后仰，避免整块向后倒。
 * 3. 【震撼呆滞长定格与微震颤 (Stunned Freeze with Shock Tremor)】：
 *    160~1600ms 足足 1440ms 的超长发愣定格！伴随 12Hz 高频受惊细微震颤；
 *    大张嘴发愣 (mouth.open: 0.78)，眼神发直发空 (gaze.y: +0.42)。
 * 4. 【回神双重快速眨眼与娇羞收正 (Dazed Double-Blink & Relief)】：
 *    1600ms 后缓缓回神，1750~2200ms 伴随两次可爱的懵圈眨眼，随后嘴巴微抿回正。
 */
export const surprise: ActionAuthoring = (rng) => {
	const gain = 0.96 + rng() * 0.08;
	const sideDir = rng() > 0.5 ? 1 : -1;
	const rollScale = (0.92 + rng() * 0.16) * sideDir;

	const durationMs = 2500;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");

	// 1. 头部俯仰：0~160ms 极速后仰至 +8.8°，在 160~1600ms 维持呆滞定格与微震，随后缓和回正
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 160) {
			const u = smoothstep5(0, 160, t);
			return 8.8 * gain * u;
		}
		if (t < 1600) {
			// 定格发愣，12Hz 受惊微颤
			const tremorWindow = smoothstep5(160, 240, t) * (1 - smoothstep5(1460, 1600, t));
			const tremor = 0.12 * Math.sin(((t - 160) / 1000) * 2 * Math.PI * 12) * tremorWindow;
			const p = smoothstep5(160, 1600, t);
			return (8.8 - 0.3 * p + tremor) * gain;
		}
		const u = smoothstep5(1600, durationMs, t);
		return 8.5 * gain * (1 - u);
	};

	// 2. 头部侧倾：后仰时伴随萌态侧歪 (-4.6°)
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const pitch = evaluateHeadPitch(t);
		return -0.52 * pitch * rollScale;
	};

	// 3. 头部偏航：轻微偏向一侧配合
	const evaluateHeadYaw = (t: number): number => {
		const roll = evaluateHeadRoll(t);
		return -0.38 * roll;
	};

	// 4. 躯干解耦：抵消 88% 的后仰跟随，避免身体向后倒
	const evaluateTorsoPitch = (t: number): number => {
		return -evaluateHeadPitch(t) * 0.88;
	};
	const evaluateTorsoRoll = (t: number): number => {
		return -evaluateHeadRoll(t) * 0.85;
	};

	// 5. 眼神发直：惊讶后仰时视线向上发直发愣 (+0.42)
	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const pitch = evaluateHeadPitch(t);
		return (pitch / 8.8) * 0.42;
	};

	// 6. 大张嘴发愣：0~160ms 迅速张开至 0.78，定格至 1600ms，随后回神缓缓闭合
	const evaluateMouthOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 160) {
			const u = smoothstep5(0, 160, t);
			return 0.78 * gain * u;
		}
		if (t < 1600) {
			return 0.78 * gain;
		}
		const u = smoothstep5(1600, 2300, t);
		return 0.78 * gain * (1 - u);
	};

	// 7. 嘴角形态：前期呆滞微张圆嘴 (0.18)，回神后化为娇羞放松微笑 (0.42)
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 1600) {
			const open = evaluateMouthOpen(t);
			return (open / 0.78) * 0.18;
		}
		const smile = smoothstep5(1600, 2000, t);
		const release = 1 - smoothstep5(2250, durationMs, t);
		return (0.18 + 0.24 * smile) * release * gain;
	};

	// 8. 回神双重眨眼 (1750~1920ms, 2020~2190ms)
	const evaluateEyeOpen = (t: number): number => {
		if (t >= 1750 && t < 1920) {
			const u = t < 1835 ? smoothstep5(1750, 1835, t) : 1 - smoothstep5(1835, 1920, t);
			return -0.85 * u;
		}
		if (t >= 2020 && t < 2190) {
			const u = t < 2105 ? smoothstep5(2020, 2105, t) : 1 - smoothstep5(2105, 2190, t);
			return -0.85 * u;
		}
		return 0;
	};

	return {
		timeline: time,
		channels: {
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"mouth.open": offset(during(whole, evaluateMouthOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
		},
	};
};

export default surprise;
