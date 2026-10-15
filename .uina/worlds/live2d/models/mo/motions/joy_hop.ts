import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline } from "../../../authoring/curves.js";

function smoothstep5(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 物理程序化“Q弹高能雀跃弹跳”（时长 1350ms）。
 *
 * 核心萌点与动力学架构：
 * 1. 【深蹲蓄力与腾空飞跃 (Squash & Aerial Stretch)】：
 *    深蹲蓄力 (y: -0.02) -> 腾空起飞冲天 (y: +0.10)，仰头大笑 (+7.8°)；
 * 2. 【重力冲击与落地深缓冲 (Impact Landing Deceleration)】：
 *    落地重力惯性促使头部下压扎至 -6.2°，伴随落地侧倾娇憨微晃；
 * 3. 【二阶果冻微弹 (Secondary Jelly Rebound)】：
 *    触底反弹产生可爱的二次果冻微跃 (y: +0.025, pitch: +3.2°)；
 * 4. 【月牙开怀大笑 (Crescent Laugh & Big Open)】：
 *    腾空时双眼闭合笑成弯弯月牙 (-0.75)，嘴巴欢畅大张 (open: 0.65, form: 0.98)。
 */
export const joyHop: ActionAuthoring = (rng) => {
	const gain = 0.96 + rng() * 0.08;
	const rollDir = rng() > 0.5 ? 1 : -1;

	const durationMs = 1350;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const bodyTime = (t: number): number => t - 90 * 4 * (t / durationMs) * (1 - t / durationMs);

	// 1. 头部俯仰：起跳深蓄力 -> 腾空高扬 -> 落地重力冲压 -> 二次微弹 -> 稳稳收正
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		// 0~140ms: 屈膝深蓄力微低头
		if (t < 140) {
			const u = smoothstep5(0, 140, t);
			return -4.5 * gain * u;
		}
		// 140~420ms: 腾空起飞仰头看天 (+7.8°)
		if (t < 420) {
			const u = smoothstep5(140, 420, t);
			return (-4.5 + 12.3 * u) * gain;
		}
		// 420~750ms: 落地重力下压深缓冲 (-6.2°)
		if (t < 750) {
			const u = smoothstep5(420, 750, t);
			return (7.8 - 14.0 * u) * gain;
		}
		// 750~1000ms: 二次果冻小微弹 (+3.2°)
		if (t < 1000) {
			const u = smoothstep5(750, 1000, t);
			return (-6.2 + 9.4 * u) * gain;
		}
		// 1000~1350ms: 稳稳舒缓回正
		const u = smoothstep5(1000, durationMs, t);
		return 3.2 * gain * (1 - u);
	};

	// 2. 头部侧倾：落地重力失衡带来的可爱侧偏微晃 (±3.5°)
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 420) return 0;
		if (t < 750) {
			const u = smoothstep5(420, 750, t);
			return 3.5 * rollDir * gain * u;
		}
		if (t < 1050) {
			const u = smoothstep5(750, 1050, t);
			return 3.5 * rollDir * gain * (1 - 1.5 * u);
		}
		const u = smoothstep5(1050, durationMs, t);
		return -1.75 * rollDir * gain * (1 - u);
	};

	// 3. 身体稍晚承接起跳与落地；offset 抵消本动作的默认 head-follow 后加入支撑。
	const evaluateTorsoPitch = (t: number): number => {
		return evaluateHeadPitch(bodyTime(t)) * 0.32 - evaluateHeadPitch(t);
	};
	const evaluateTorsoRoll = (t: number): number => {
		return evaluateHeadRoll(bodyTime(t)) * 0.28 - evaluateHeadRoll(t);
	};

	// 4. 双眼雀跃月牙笑：起跳与腾空时笑眯成弯弯月牙 (-0.75)
	const evaluateEyeOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 140) return 0;
		if (t < 420) {
			const u = smoothstep5(140, 420, t);
			return -0.75 * gain * u;
		}
		if (t < 850) {
			return -0.75 * gain;
		}
		const u = smoothstep5(850, 1200, t);
		return -0.75 * gain * (1 - u);
	};

	// 5. 雀跃开怀笑容与大张嘴
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 180) {
			const u = smoothstep5(0, 180, t);
			return 0.92 * gain * u;
		}
		if (t < 950) {
			return 0.92 * gain;
		}
		const u = smoothstep5(950, durationMs, t);
		return 0.92 * gain * (1 - u);
	};
	const evaluateMouthOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 160) return 0;
		if (t < 420) {
			const u = smoothstep5(160, 420, t);
			return 0.65 * gain * u;
		}
		if (t < 800) {
			return 0.65 * gain;
		}
		const u = smoothstep5(800, 1150, t);
		return 0.65 * gain * (1 - u);
	};

	return {
		timeline: time,
		channels: {
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
			"mouth.open": offset(during(whole, evaluateMouthOpen)),
		},
		spatial: [
			{ during: { startMs: 0, endMs: 140, durationMs: 140 }, transform: { delta: { y: -0.02 } } },
			{ during: { startMs: 140, endMs: 420, durationMs: 280 }, transform: { delta: { y: 0.1 } } },
			{ during: { startMs: 420, endMs: 750, durationMs: 330 }, transform: { delta: { y: 0 } } },
			{ during: { startMs: 750, endMs: 1000, durationMs: 250 }, transform: { delta: { y: 0.025 } } },
			{ during: { startMs: 1000, endMs: 1350, durationMs: 350 }, transform: { delta: { y: 0 } } },
		],
	};
};

export default joyHop;
