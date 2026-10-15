import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline } from "../../../authoring/curves.js";

function smoothstep5(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 物理程序化“华丽自转一圈”（时长 2800ms）。
 *
 * 核心萌点与动力学架构：
 * 1. 【深蹲蓄力与腾空起飞 (Deep Windup & Lift-off)】：
 *    0~220ms 屈膝下蹲蓄力 (y: -0.025, pitch: -4.5°) -> 220~420ms 弹跃起飞 (y: +0.06, pitch: +7.5°)；
 * 2. 【逐帧 359° 离心力飞旋 (Centrifugal Aerial Spin)】：
 *    在空中完成足足 1380ms 的 359° 华丽自转！伴随离心力产生的头部 3D 波浪起伏 (Roll: ±5.5°, Pitch: +3.5°~+5.5°)；
 * 3. 【闭眼沉醉飞翔与开怀大笑 (Blissful Closed Eyes & Big Smile)】：
 *    飞旋时双眼幸福微闭享受飞翔感 (-0.92)，嘴角绽开灿烂大笑 (form: 0.98, open: 0.55)；
 * 4. 【落地吸收与二次微弹定格 (Landing Cushion & Settle)】：
 *    1800ms 落地吸收重力冲压，随后轻巧回弹站定，神采奕奕睁眼收正。
 */
export const spin: ActionAuthoring = (rng) => {
	const gain = 0.96 + rng() * 0.08;

	const durationMs = 2800;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const bodyTime = (t: number): number => t - 90 * 4 * (t / durationMs) * (1 - t / durationMs);

	// 1. 头部俯仰：蓄力低头 -> 腾空扬起 -> 旋转中轻盈离心波 -> 落地缓冲回弹 -> 站定
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		// 0~220ms: 蓄力微低头 (-4.5°)
		if (t < 220) {
			const u = smoothstep5(0, 220, t);
			return -4.5 * gain * u;
		}
		// 220~420ms: 腾空扬起至 +5.0°
		if (t < 420) {
			const u = smoothstep5(220, 420, t);
			return (-4.5 + 9.5 * u) * gain;
		}
		// 420~1800ms: 旋转过程中优雅离心起伏 (首尾连续衔接 +5.0° -> -4.0°)
		if (t < 1800) {
			const p = (t - 420) / 1380;
			const travel = 5.0 + (-4.0 - 5.0) * smoothstep5(0, 1, p);
			const wave = 2.4 * Math.sin(p * 2 * Math.PI) * Math.sin(p * Math.PI) ** 2;
			return (travel + wave) * gain;
		}
		// 1800~2250ms: 落地吸收缓冲 (-4.0°) 并回弹至站立 (+1.2°)
		if (t < 2250) {
			const u = smoothstep5(1800, 2250, t);
			return (-4.0 + 5.2 * u) * gain;
		}
		// 2250~2800ms: 站定回正归零
		const u = smoothstep5(2250, durationMs, t);
		return 1.2 * gain * (1 - u);
	};

	// 2. 头部侧倾：旋转离心力波浪摆动 (±5.5°)
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 420) return 0;
		if (t < 1800) {
			const spinProgress = (t - 420) / 1380;
			return 5.5 * Math.sin(spinProgress * 2 * Math.PI * 2.0) * Math.sin(spinProgress * Math.PI) ** 2 * gain;
		}
		if (t < 2400) {
			const u = smoothstep5(1800, 2400, t);
			return 2.2 * Math.sin(u * Math.PI) * gain;
		}
		return 0;
	};

	// 3. 身体以小幅、滞后的姿态承接旋转与落地。
	const evaluateTorsoPitch = (t: number): number => {
		return evaluateHeadPitch(bodyTime(t)) * 0.3 - evaluateHeadPitch(t);
	};
	const evaluateTorsoRoll = (t: number): number => {
		return evaluateHeadRoll(bodyTime(t)) * 0.25 - evaluateHeadRoll(t);
	};

	// 4. 双眼表情：起跳与高速旋转中幸福眯眼享用飞翔感 (-0.92)，落地后神采奕奕睁开
	const evaluateEyeOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 240) return 0;
		if (t < 420) {
			const u = smoothstep5(240, 420, t);
			return -0.92 * gain * u;
		}
		if (t < 1700) {
			return -0.92 * gain;
		}
		if (t < 2050) {
			const u = smoothstep5(1700, 2050, t);
			return -0.92 * gain * (1 - u);
		}
		return 0;
	};

	// 5. 华丽展颜大笑 (form: 0.92, open: 0.55)
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 280) {
			const u = smoothstep5(0, 280, t);
			return 0.92 * gain * u;
		}
		if (t < 2100) {
			return 0.92 * gain;
		}
		const u = smoothstep5(2100, durationMs, t);
		return 0.92 * gain * (1 - u);
	};
	const evaluateMouthOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 350) return 0;
		if (t < 550) {
			const u = smoothstep5(350, 550, t);
			return 0.55 * gain * u;
		}
		if (t < 1750) {
			return 0.55 * gain;
		}
		const u = smoothstep5(1750, 2150, t);
		return 0.55 * gain * (1 - u);
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
			{ during: { startMs: 0, endMs: 220, durationMs: 220 }, transform: { delta: { y: -0.025 } } },
			{ during: { startMs: 220, endMs: 420, durationMs: 200 }, transform: { delta: { y: 0.06 } } },
			{ during: { startMs: 420, endMs: 1800, durationMs: 1380 }, transform: { relativeRotation: 359 } },
			{ during: { startMs: 1800, endMs: 2250, durationMs: 450 }, transform: { delta: { y: 0, rotation: 0 } } },
			{ during: { startMs: 2250, endMs: 2800, durationMs: 550 }, transform: { delta: { y: 0, rotation: 0 } } },
		],
	};
};

export default spin;
