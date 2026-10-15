import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline } from "../../../authoring/curves.js";

function smoothstep5(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 物理程序化“气鼓鼓嘟嘴 / 鼓腮帮”(Pout，时长 2800ms)。
 *
 * 核心 VTuber 萌点与动力学：
 * 1. 【挺胸叉腰体态 (Puffed Chest)】：躯干挺拔微后仰 (+3.6°)，塑造娇蛮叉腰体态；
 * 2. 【赌气侧转昂头】：头部向一侧别过脸 (-6.8°)，下颌微微翘起 (+3.8°)；
 * 3. 【经典小雀喙嘟嘴 (Pouting Beak)】：嘴唇紧缩微张圆噘起 (mouth.open: 0.15, form: 0.18)；
 * 4. 【娇嗔侧眸斜睨 (Sullen Glare)】：别着头时侧眸看向观众 (gaze.x: +0.75)，眼睑微眯 (-0.35)；
 * 5. 【气急了胸脯起伏 (Pouting Breath)】：在超长 1650ms 定格中，伴随 1.1Hz 急促可爱的气鼓鼓呼吸波。
 */
export const pout: ActionAuthoring = (rng) => {
	const gain = 0.96 + rng() * 0.08;
	const poutDir = rng() > 0.5 ? 1 : -1;

	const durationMs = 2800;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const dwellBreath = (t: number): number => Math.sin(((t - 450) / 1000) * 2 * Math.PI * 1.1) * smoothstep5(550, 800, t) * (1 - smoothstep5(1850, 2100, t));

	// 1. 头部偏航：气呼呼别过脸 (-6.8°)
	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 450) {
			const u = smoothstep5(60, 450, t);
			return -6.8 * poutDir * gain * u;
		}
		if (t < 2100) {
			const breath = 0.18 * dwellBreath(t);
			return (-6.8 + breath) * poutDir * gain;
		}
		const u = smoothstep5(2100, durationMs, t);
		return -6.8 * poutDir * gain * (1 - u);
	};

	// 2. 头部俯仰：赌气扬起下巴 (+3.8°)
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 450) {
			const u = smoothstep5(80, 450, t);
			return 3.8 * gain * u;
		}
		if (t < 2100) {
			const breath = 0.22 * dwellBreath(t);
			return (3.8 + breath) * gain;
		}
		const u = smoothstep5(2100, durationMs, t);
		return 3.8 * gain * (1 - u);
	};

	// 3. 头部侧倾：娇蛮侧倾 (-4.2°)
	const evaluateHeadRoll = (t: number): number => {
		const yaw = evaluateHeadYaw(t);
		return yaw * 0.62;
	};

	// 4. 躯干挺拔叉腰体态 (Torso Pitch 反常微挺，模拟挺胸赌气)
	const desiredTorsoPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 550) {
			const u = smoothstep5(130, 550, t);
			return 3.2 * gain * u;
		}
		if (t < 2100) {
			const breath = 0.25 * dwellBreath(t);
			return (3.2 + breath) * gain;
		}
		const u = smoothstep5(2100, durationMs, t);
		return 3.2 * gain * (1 - u);
	};

	// 作者值是头部跟随后的目标体态，不能把挺胸量再次叠到昂头量上。
	const evaluateTorsoPitch = (t: number): number => desiredTorsoPitch(t) - evaluateHeadPitch(t);
	const bodyReturn = (t: number): number => 1 - smoothstep5(2550, durationMs, t);
	const evaluateTorsoYaw = (t: number): number => evaluateHeadYaw(t - 90) * 0.12 * bodyReturn(t) - evaluateHeadYaw(t);
	const evaluateTorsoRoll = (t: number): number => evaluateHeadRoll(t - 90) * 0.15 * bodyReturn(t) - evaluateHeadRoll(t);

	// 5. 眼神先反向斜睨，头部随后别开。
	const evaluateGazeX = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 450) {
			const u = smoothstep5(0, 300, t);
			return 0.75 * poutDir * u;
		}
		if (t < 2100) {
			return 0.75 * poutDir;
		}
		const u = smoothstep5(2100, durationMs, t);
		return 0.75 * poutDir * (1 - u);
	};

	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 2100) return -0.15 * smoothstep5(0, 450, t);
		const u = smoothstep5(2100, durationMs, t);
		return -0.15 * (1 - u);
	};

	// 6. 娇嗔半眯眼 (-0.35)
	const evaluateEyeOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 450) {
			const u = smoothstep5(0, 450, t);
			return -0.35 * gain * u;
		}
		if (t < 2100) {
			return -0.35 * gain;
		}
		const u = smoothstep5(2100, durationMs, t);
		return -0.35 * gain * (1 - u);
	};

	// 7. 经典雀喙小嘟嘴 (mouth.open: 0.15, form: 0.18)
	const evaluateMouthOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 400) {
			const u = smoothstep5(0, 400, t);
			return 0.15 * gain * u;
		}
		if (t < 2150) {
			return 0.15 * gain;
		}
		const u = smoothstep5(2150, durationMs, t);
		return 0.15 * gain * (1 - u);
	};

	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 400) {
			const u = smoothstep5(0, 400, t);
			return 0.18 * gain * u;
		}
		if (t < 2150) {
			return 0.18 * gain;
		}
		const u = smoothstep5(2150, durationMs, t);
		return 0.18 * gain * (1 - u);
	};

	return {
		timeline: time,
		channels: {
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.open": offset(during(whole, evaluateMouthOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

export default pout;
