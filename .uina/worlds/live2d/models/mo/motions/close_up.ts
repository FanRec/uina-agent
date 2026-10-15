import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline } from "../../../authoring/curves.js";

function smoothstep5(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 物理程序化“贴脸破屏特写”（时长 4600ms）。
 *
 * 核心萌点与动力学架构：
 * 1. 【镜头急推破屏特写 (Camera Slam Push)】：
 *    180~650ms 镜头急剧推满至大头贴 (size: +40, y: -1.7)；
 * 2. 【近景轻柔摇头】：
 *    近距离对视期间以 0.45Hz 轻柔摇头 (Roll: ±3.6°, Yaw: ±2.1°)，收势时保留完整呼吸相位；
 * 3. 【深情宠溺慢眨眼 (Affectionate Slow Blink)】：
 *    在 2100~2400ms 贴近镜头时伴随长达 300ms 的深情宠溺慢眨眼与下垂目光对视；
 * 4. 【治愈呼吸微笑与娇憨收回】：
 *    嘴角绽开甜甜大猫猫笑 (0.96)，微张嘴呼应呼吸，随后舒缓缩回全景。
 */
export const closeUp: ActionAuthoring = (rng) => {
	const gain = 0.96 + rng() * 0.08;

	const durationMs = 4600;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const bodyTime = (t: number): number => t - 100 * 4 * (t / durationMs) * (1 - t / durationMs);
	const breathAt = (t: number): number => Math.sin(((t - 650) / 1000) * 2 * Math.PI * 0.45);

	// 贴脸近景权重包络：180~650ms 推入，保持至 3800ms，随后 3800~4600ms 平滑缩回
	const evaluateNearEnvelope = (t: number): number => {
		if (t < 180) return 0;
		if (t < 650) return smoothstep5(180, 650, t);
		if (t < 3800) return 1.0;
		if (t < durationMs) return 1.0 - smoothstep5(3800, durationMs, t);
		return 0;
	};

	// 1. 头部俯仰：贴脸时微昂头面对镜头 (+5.2°)，贴近期间伴随微小起伏呼吸
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const near = evaluateNearEnvelope(t);
		return (5.2 + 0.45 * breathAt(t)) * near * gain;
	};

	// 2. 近景减小头部扫动，避免镜头放大后显得晃眼。
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const near = evaluateNearEnvelope(t);
		const sway = 3.6 * breathAt(t);
		return sway * near * gain;
	};

	// 3. 头部偏航：轻微侧转错拍配合 (±2.1°)
	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const near = evaluateNearEnvelope(t);
		const sway = 2.1 * Math.sin(((t - 650) / 1000) * 2 * Math.PI * 0.45 - 0.6);
		return sway * near * gain;
	};

	// 4. 躯干保留小幅错拍跟随，抵消同动作的 head-follow，避免头身锁成一块。
	const evaluateTorsoPitch = (t: number): number => {
		return evaluateHeadPitch(bodyTime(t)) * 0.3 - evaluateHeadPitch(t);
	};
	const evaluateTorsoRoll = (t: number): number => {
		return evaluateHeadRoll(bodyTime(t)) * 0.25 - evaluateHeadRoll(t);
	};
	const evaluateTorsoYaw = (t: number): number => {
		return evaluateHeadYaw(bodyTime(t)) * 0.25 - evaluateHeadYaw(t);
	};

	// 5. 近景对视：贴脸时眼神略微下垂直视近处观众 (-0.35)
	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return -0.35 * evaluateNearEnvelope(t);
	};

	// 6. 贴脸期间宠溺深情慢眨眼 (2100~2400ms)
	const evaluateEyeOpen = (t: number): number => {
		if (t < 2100 || t >= 2400) return 0;
		if (t < 2250) {
			const u = smoothstep5(2100, 2250, t);
			return -0.92 * u;
		}
		const u = smoothstep5(2250, 2400, t);
		return -0.92 * (1 - u);
	};

	// 7. 贴脸幸福展颜大笑 (0.96) 与微张嘴呼应 (0.28)
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return 0.96 * evaluateNearEnvelope(t) * gain;
	};
	const evaluateMouthOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const near = evaluateNearEnvelope(t);
		return (0.28 + 0.08 * breathAt(t)) * near * gain;
	};

	return {
		timeline: time,
		channels: {
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
			"mouth.open": offset(during(whole, evaluateMouthOpen)),
		},
		spatial: [
			{ during: { startMs: 0, endMs: 180, durationMs: 180 }, transform: { delta: { size: -3, y: 0.02 } } },
			{
				during: { startMs: 180, endMs: 650, durationMs: 470 },
				transform: { delta: { size: 40, y: -1.7, rotation: 1.5 } },
			},
			{
				during: { startMs: 3800, endMs: 4600, durationMs: 800 },
				transform: { delta: { size: 0, y: 0, rotation: 0 } },
			},
		],
	};
};

export default closeUp;
