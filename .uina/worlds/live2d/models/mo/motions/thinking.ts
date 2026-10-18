import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline, smoothstep } from "../../../authoring/curves.js";

/**
 * 物理程序化“高频耐看专注倾听思考 Thinking”（时长 4000ms 循环）。
 *
 * 针对每轮频繁触发与长时间推理事件的设计法则：
 * 1. 【克制优雅的高频耐受性 (High-Frequency Ergonomics)】：
 *    - 杜绝一切突兀的大幅度剧烈晃动或抽搐动作，避免对话交互时的视觉轰炸与烦躁感。
 *    - 核心体态呈现极具少女感的好奇倾听与沉思姿态：
 *      头部微扬抬颌 (+1.8°)、娇俏侧偏 (+4.2°)、微侧颜探寻 (+2.4°)。
 * 2. 【灵动思考眼神 (Cognitive Thinking Gaze)】：
 *    - 经典二次元“检索思绪”眼神：视线柔和上扬微挑 (Gaze Y: +0.32, Gaze X: +0.26)；
 *    - 双眼轻微凝神微敛专注 (Eyes Open: -0.18，保持约 0.82 的专注清澈大眼，神采奕奕而不呆滞)；
 *    - 嘴角微抿好奇挑动 (Mouth Form: +0.24)。
 * 3. 【无缝循环的沉浸心流呼吸波 (Cognitive Flow Loop)】：
 *    - 4000ms 循环周期内伴随 0.25Hz 极柔和沉思微呼吸波 (Pitch ±0.35°, Roll ±0.3°)，
 *      视线在思索中带有微细浮动寻觅感，生动逼真，久看不腻。
 * 4. 【多轮交互方向多态 (Multi-Turn Variation)】：
 *    - rng() 决定本轮思考偏向左侧还是右侧，多次连续对话不会僵化机械。
 * 5. 【躯干函数式解耦 (Torso Decoupling)】：
 *    - 抵消 88% 的侧倾与后仰跟随，坐姿挺拔优雅。
 */

export const cuteThinking: ActionAuthoring = (rng) => {
	const gain = 0.95 + rng() * 0.1;
	const sideDir = rng() > 0.5 ? 1 : -1;
	const pitchGain = 0.92 + rng() * 0.16;

	const durationMs = 4000;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const omega0 = (2 * Math.PI) / durationMs;

	// C2 连续平滑出入包络窗：消除首尾瞬间阶跃，保持 600~3400ms 完整思考姿态
	const envelope = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 600) return smoothstep(0, 600, t);
		if (t > 3400) return 1 - smoothstep(3400, durationMs, t);
		return 1.0;
	};

	// 1. 头部俯仰：自信微昂抬下巴思索 (+1.8°)，伴随 4s 沉吟微呼吸波 (±0.35°)
	const evaluateHeadPitch = (t: number): number => {
		const env = envelope(t);
		if (env === 0) return 0;
		const osc = 0.35 * Math.sin(omega0 * t);
		return (1.8 + osc) * gain * pitchGain * env;
	};

	// 2. 头部侧倾：娇俏偏头沉思 (+4.2°)，伴随思考微晃 (±0.3°)
	const evaluateHeadRoll = (t: number): number => {
		const env = envelope(t);
		if (env === 0) return 0;
		const osc = 0.3 * Math.sin(omega0 * t + Math.PI / 4);
		return (4.2 + osc) * gain * sideDir * env;
	};

	// 3. 头部偏航：侧颜探寻倾听 (+2.4°)，伴随微小错拍 (±0.2°)
	const evaluateHeadYaw = (t: number): number => {
		const env = envelope(t);
		if (env === 0) return 0;
		const osc = 0.2 * Math.cos(omega0 * t);
		return (2.4 + osc) * gain * sideDir * env;
	};

	// 4. 躯干解耦：抵消 88% 的跟随，保持优雅直立
	const evaluateTorsoPitch = (t: number): number => {
		return -evaluateHeadPitch(t) * 0.88;
	};
	const evaluateTorsoRoll = (t: number): number => {
		return -evaluateHeadRoll(t) * 0.88;
	};
	const evaluateTorsoYaw = (t: number): number => {
		return -evaluateHeadYaw(t) * 0.88;
	};

	// 5. 思考神态视线：斜上方搜寻思绪 (Gaze Y +0.32, Gaze X +0.26)
	const evaluateGazeY = (t: number): number => {
		const env = envelope(t);
		if (env === 0) return 0;
		const wander = 0.035 * Math.sin(omega0 * t);
		return (0.32 + wander) * gain * env;
	};
	const evaluateGazeX = (t: number): number => {
		const env = envelope(t);
		if (env === 0) return 0;
		const wander = 0.035 * Math.cos(omega0 * t);
		return (0.26 + wander) * gain * sideDir * env;
	};

	// 6. 双眼专注微敛 (-0.18)，眼裂保持在 0.82 左右专注清澈
	const evaluateEyeOpen = (t: number): number => {
		const env = envelope(t);
		if (env === 0) return 0;
		const blinkRipple = 0.02 * Math.sin(omega0 * t);
		return (-0.18 + blinkRipple) * gain * env;
	};

	// 7. 嘴角微抿好奇小猫嘴 (+0.24)
	const evaluateMouthForm = (t: number): number => {
		const env = envelope(t);
		if (env === 0) return 0;
		const ripple = 0.03 * Math.sin(omega0 * t);
		return (0.24 + ripple) * gain * env;
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
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

export default cuteThinking;
