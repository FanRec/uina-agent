import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline } from "../../../authoring/curves.js";

function smoothstep5(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 物理程序化“边缘探头偷看”（时长 4800ms）。
 *
 * 核心萌点与动力学架构：
 * 1. 【身体大倾斜屏外侧藏 (Offscreen Peeking Angle)】：
 *    身体大斜角 24° 侧藏在屏幕外边缘 (x: -0.78, y: -0.16)；
 * 2. 【高张力反向探头探脑 (Head Craning Roll & Yaw)】：
 *    为了把小脑袋探入舞台中央，头部反向侧偏达到 -9.2°，偏航大幅探出 +8.2°，缩颈 -3.8°；
 * 3. 【多轴眼神搜寻 (Curious Saccadic Scanning)】：
 *    视线横向深探 (gaze.x: 0.96)，纵向伴随好奇打量起伏 (gaze.y: ±0.25)；
 * 4. 【双重灵动眨眼与狡黠猫猫笑】：
 *    1850ms 与 3250ms 两次清脆可爱的双眨眼，猫猫嘴角狡黠挑起 (0.58)。
 */
export const edgePeek: ActionAuthoring = (rng) => {
	const gain = 0.96 + rng() * 0.08;

	const durationMs = 4800;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const bodyTime = (t: number): number => t - 100 * 4 * (t / durationMs) * (1 - t / durationMs);

	// 眼神先观察，头部晚 100ms 探出；保持期间仍有很轻的打量动作。
	const evaluatePeekEnvelope = (t: number): number => {
		if (t < 580) return smoothstep5(100, 580, t);
		if (t < 4000) return 1.0;
		if (t < durationMs) return 1.0 - smoothstep5(4000, durationMs, t);
		return 0;
	};
	const evaluateLookEnvelope = (t: number): number => smoothstep5(0, 320, t) * (1 - smoothstep5(3900, 4500, t));

	// 1. 头部侧倾：因身体倾斜 24°，头部强力反向侧偏 (-9.2°) 探出
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return (-8.8 + 0.25 * Math.sin(((t - 580) / 1000) * 2 * Math.PI * 0.35)) * evaluatePeekEnvelope(t) * gain;
	};

	// 2. 头部偏航：头部向画面中央强力探转 (+8.2°)
	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return (7.8 + 0.3 * Math.sin(((t - 580) / 1000) * 2 * Math.PI * 0.3)) * evaluatePeekEnvelope(t) * gain;
	};

	// 3. 头部俯仰：缩颈警惕微收下巴 (-3.8°)
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return -3.8 * evaluatePeekEnvelope(t) * gain;
	};

	// 4. 让身体小幅、稍晚承接探头，保留全模型侧藏的构图。
	const evaluateTorsoRoll = (t: number): number => {
		return evaluateHeadRoll(bodyTime(t)) * 0.24 - evaluateHeadRoll(t);
	};
	const evaluateTorsoYaw = (t: number): number => {
		return evaluateHeadYaw(bodyTime(t)) * 0.24 - evaluateHeadYaw(t);
	};
	const evaluateTorsoPitch = (t: number): number => {
		return evaluateHeadPitch(bodyTime(t)) * 0.24 - evaluateHeadPitch(t);
	};

	// 5. 视线甩向画面中央打量 (gaze.x: 0.90) 且上下好奇寻视 (gaze.y)
	const evaluateGazeX = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return 0.8 * evaluateLookEnvelope(t);
	};
	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const scan = 0.16 * Math.sin(((t - 580) / 1000) * 2 * Math.PI * 0.5);
		return (0.12 + scan) * evaluateLookEnvelope(t) * gain;
	};

	// 6. 探头窥视期间灵动轻快双眨眼 (1800~2000ms, 3200~3400ms)
	const evaluateEyeOpen = (t: number): number => {
		if (t >= 1800 && t < 2000) {
			const u = t < 1900 ? smoothstep5(1800, 1900, t) : 1 - smoothstep5(1900, 2000, t);
			return -0.85 * u;
		}
		if (t >= 3200 && t < 3400) {
			const u = t < 3300 ? smoothstep5(3200, 3300, t) : 1 - smoothstep5(3300, 3400, t);
			return -0.85 * u;
		}
		return 0;
	};

	// 7. 狡黠探头猫猫微笑 (0.58)
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return 0.58 * evaluatePeekEnvelope(t) * gain;
	};

	return {
		timeline: time,
		channels: {
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
		spatial: [
			{
				during: { startMs: 0, endMs: 580, durationMs: 580 },
				transform: { delta: { x: -0.78, y: -0.16, rotation: 24 } },
			},
			{
				during: { startMs: 4000, endMs: 4800, durationMs: 800 },
				transform: { delta: { x: 0, y: 0, rotation: 0 } },
			},
		],
	};
};

export default edgePeek;
