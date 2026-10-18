import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline, smoothstep } from "../../../authoring/curves.js";

/**
 * 物理程序化“圈圈眼慌张打转 / 拨浪鼓小摇头”(Panic / Dizzy，时长 2200ms)。
 *
 * 核心 VTuber 萌点与动力学：
 * 1. 【经典漫画式圈圈眼打转 (Swirling Spiral Eyes)】：
 *    视线 Gaze X 与 Gaze Y 以 3.2Hz 正交极速做圆周运动（半径 0.62），生动还原动漫“圈圈眼”！
 * 2. 【拨浪鼓高频慌乱微摇头 (Rattle Wobble)】：
 *    头部偏航 (Yaw ±4.5°) 与侧倾 (Roll ±3.2°) 以 3.2Hz 椭圆混频颤动，犹如受惊仓鼠；
 * 3. 【慌张小波浪嘴与急促眨眼】：
 *    嘴巴呈受惊微张的小波浪形 (open: 0.42, form: 0.20)，双眼伴随慌乱颤抖频繁微眨；
 * 4. 【晕乎乎回神平复】：
 *    尾段眼球螺旋收紧归中，头部阻尼衰减收正，长舒一口气。
 */
export const panic: ActionAuthoring = (rng) => {
	const gain = 0.96 + rng() * 0.08;

	const durationMs = 2200;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");

	// 慌乱核心包络：150~1750ms 处于高频慌乱爆发期，1750~2200ms 晕乎乎平复
	const evaluatePanicEnvelope = (t: number): number => {
		if (t < 150) return smoothstep(0, 150, t);
		if (t < 1750) return 1.0;
		if (t < durationMs) return 1.0 - smoothstep(1750, durationMs, t);
		return 0;
	};

	// 1. 视线圆周回旋 (圈圈眼效果)：Gaze X (cos), Gaze Y (sin), f=3.2Hz
	const evaluateGazeX = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const env = evaluatePanicEnvelope(t);
		const phase = ((t - 150) / 1000) * 2 * Math.PI * 3.2;
		return 0.62 * Math.cos(phase) * env * gain;
	};

	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const env = evaluatePanicEnvelope(t);
		const phase = ((t - 150) / 1000) * 2 * Math.PI * 3.2;
		return 0.62 * Math.sin(phase) * env * gain;
	};

	// 2. 头部高频拨浪鼓式小摇晃 (Yaw: ±4.5°, f=3.2Hz)
	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const env = evaluatePanicEnvelope(t);
		const phase = ((t - 150) / 1000) * 2 * Math.PI * 3.2;
		return 4.5 * Math.sin(phase) * env * gain;
	};

	// 3. 头部侧倾椭圆微晃 (Roll: ±3.2°)
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const env = evaluatePanicEnvelope(t);
		const phase = ((t - 150) / 1000) * 2 * Math.PI * 3.2 + 0.8;
		return 3.2 * Math.sin(phase) * env * gain;
	};

	// 4. 头部俯仰：慌张微低头收缩 (-2.5°)
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const env = evaluatePanicEnvelope(t);
		return -2.5 * env * gain;
	};

	// 5. 躯干解耦：抵消 88%
	const evaluateTorsoYaw = (t: number): number => -evaluateHeadYaw(t) * 0.88;
	const evaluateTorsoRoll = (t: number): number => -evaluateHeadRoll(t) * 0.85;
	const evaluateTorsoPitch = (t: number): number => -evaluateHeadPitch(t) * 0.88;

	// 6. 慌乱急促微眨眼 (在慌乱期间以 3.2Hz 快速抽眨)
	const evaluateEyeOpen = (t: number): number => {
		if (t < 200 || t >= 1750) return 0;
		const blinkWave = Math.sin(((t - 200) / 1000) * 2 * Math.PI * 3.2);
		return blinkWave > 0.4 ? -0.75 * (blinkWave - 0.4) * 1.6 : 0;
	};

	// 7. 慌乱波浪嘴 (mouth.open: 0.42, form: 0.20)
	const evaluateMouthOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const env = evaluatePanicEnvelope(t);
		const jitter = 0.08 * env * Math.sin(((t - 150) / 1000) * 2 * Math.PI * 6.4);
		return Math.max(0, (0.42 * env + jitter) * gain);
	};

	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return 0.2 * evaluatePanicEnvelope(t) * gain;
	};

	return {
		timeline: time,
		torso: "head-relative",
		channels: {
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.open": offset(during(whole, evaluateMouthOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

export default panic;
