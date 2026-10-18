import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline, smoothstep } from "../../../authoring/curves.js";

/**
 * 物理程序化“歪头灵动放电 Wink”（时长 1500ms）。
 *
 * 核心萌点与动力学架构：
 * 1. 【饱满清晰的定格时长 (Peak Hold)】：
 *    单眼在 180~300ms 快速闭合后，在 300~580ms 拥有足足 280ms 的饱满定格期，
 *    确保观众能清清楚楚看清电眼细节，绝无一闪而过或抽搐感！
 * 2. 【娇俏歪头与动态阻尼回弹 (Head Roll Damped Physics)】：
 *    闭眼的同时，头部向侧面娇俏歪倒 (Roll 达 4.8°~5.2°)，下巴微扬 (+2.0°)；
 *    睁眼后由物理阻尼振子 (Damped Oscillator, ζ=0.34) 产生如果冻般的弹性微晃余韵，
 *    秀发随之轻柔摇曳后优雅收正。
 * 3. 【躯干函数式解耦 (Torso Decoupling)】：
 *    身体小幅滞后跟随四分之一侧倾，扣除头部底动，保留放松的体态传导。
 * 4. 【神采飞扬的眼神直视与灿烂微笑】：
 *    歪头时目光反向微调，牢牢锁定观众直视放电；嘴角绽开大大的治愈微笑 (0.85)。
 */
export const cuteWink: ActionAuthoring = (rng) => {
	const gain = 0.96 + rng() * 0.08;
	const rollScale = 0.94 + rng() * 0.12;

	const durationMs = 1500;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const bodyTime = (t: number): number => t - 60 * 4 * (t / durationMs) * (1 - t / durationMs);

	// --- 1. 单眼 Wink 闭合与睁开动力学曲线 (Left Eye Target) ---
	const evaluateLeftEyeOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;

		// 0~180ms: 睁眼起势准备
		if (t < 180) return 0;

		// 180~300ms: 轻快闭合 (120ms 迅速闭合至 0)
		if (t < 300) {
			const u = smoothstep(180, 300, t);
			return -1.0 * u;
		}

		// 300~580ms: 核心电眼饱满定格期 (足足 280ms 充分留存供观众看清！)
		if (t < 580) {
			return -1.0;
		}

		// 580~780ms: 轻快弹开睁大 (200ms 快速弹开)
		if (t < 780) {
			const u = smoothstep(580, 780, t);
			return -1.0 * (1 - u);
		}

		return 0;
	};

	// 右眼保持完全大睁 (严格不超过 1.0 防 clamp)
	const evaluateRightEyeOpen = (_t: number): number => 0;

	// --- 3. 头部倾斜阻尼振子 (Head Roll Damped Physics) ---
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;

		// A. 0~320ms: 向侧面快速娇俏倾斜 (冲到 5.0°)
		if (t < 320) {
			const u = smoothstep(0, 320, t);
			return 5.0 * rollScale * gain * u;
		}

		// B. 320~620ms: Wink 核心展示定格期 (保持在 4.6°~4.8° 的甜美歪头)
		if (t < 620) {
			const p = smoothstep(320, 620, t);
			return (5.0 - 0.3 * p) * rollScale * gain;
		}

		// C. 620~1500ms: 物理阻尼回弹 (Damped Harmonic Oscillator)
		const settleTimeSec = (t - 620) / 1000;
		const totalSettleSec = (durationMs - 620) / 1000;
		const omega = 2 * Math.PI * 1.8;
		const dampingRatio = 0.34;
		const decay = Math.exp(-dampingRatio * omega * settleTimeSec);
		const initialAngle = 4.7 * rollScale * gain;
		const oscillation = initialAngle * decay * (Math.cos(omega * settleTimeSec) + dampingRatio * Math.sin(omega * settleTimeSec));

		const window = 1 - smoothstep(0.7, 1.0, settleTimeSec / totalSettleSec);
		return oscillation * window;
	};

	// --- 4. 头部俯仰下巴微扬 (Head Pitch) ---
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const attack = smoothstep(0, 350, t);
		const decay = 1 - smoothstep(600, 1300, t);
		return 2.0 * gain * attack * decay;
	};

	// --- 5. 头部偏航立体微角 (Head Yaw) ---
	const evaluateHeadYaw = (t: number): number => {
		return evaluateHeadRoll(t) * 0.28;
	};

	// --- 6. 躯干解耦支撑 (Torso Decoupling) ---
	const evaluateTorsoRoll = (t: number): number => {
		return evaluateHeadRoll(bodyTime(t)) * 0.25 - evaluateHeadRoll(t);
	};

	// --- 7. 视线逆向锁定与电眼直视 (Gaze X & Y) ---
	const evaluateGazeX = (t: number): number => {
		return -evaluateHeadYaw(t) * 0.04;
	};
	const evaluateGazeY = (t: number): number => {
		return -evaluateHeadPitch(t) * 0.05;
	};

	// --- 8. 灿烂甜美微笑包络 (Mouth Form Envelope) ---
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const attack = smoothstep(100, 360, t);
		const decay = 1 - smoothstep(750, 1450, t);
		return 0.85 * gain * attack * decay;
	};

	return {
		timeline: time,
		torso: "head-relative",
		channels: {
			"eyes.left.open": offset(during(whole, evaluateLeftEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateRightEyeOpen)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

/**
 * 变体：右眼元气放电款 (Right Eye Playful Wink，时长 1420ms)
 * 右单眼放电，头向右侧倾斜，起手更迅捷灵动，回弹频率稍高。
 */
export const cuteWinkCheerfulVariant: ActionAuthoring = (rng) => {
	const gain = 0.98 + rng() * 0.06;
	const rollScale = 0.95 + rng() * 0.12;

	const durationMs = 1420;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const bodyTime = (t: number): number => t - 60 * 4 * (t / durationMs) * (1 - t / durationMs);

	// 右眼 Wink
	const evaluateRightEyeOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 150) return 0;
		if (t < 260) {
			const u = smoothstep(150, 260, t);
			return -1.0 * u;
		}
		if (t < 520) return -1.0; // 260ms 饱满定格
		if (t < 700) {
			const u = smoothstep(520, 700, t);
			return -1.0 * (1 - u);
		}
		return 0;
	};

	const evaluateLeftEyeOpen = (_t: number): number => 0;

	// 头向右偏 (roll < 0)
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 280) {
			const u = smoothstep(0, 280, t);
			return -5.2 * rollScale * gain * u;
		}
		if (t < 560) {
			const p = smoothstep(280, 560, t);
			return (-5.2 + 0.3 * p) * rollScale * gain;
		}
		const settleTimeSec = (t - 560) / 1000;
		const totalSettleSec = (durationMs - 560) / 1000;
		const omega = 2 * Math.PI * 2.0;
		const dampingRatio = 0.32;
		const decay = Math.exp(-dampingRatio * omega * settleTimeSec);
		const initialAngle = -4.9 * rollScale * gain;
		const oscillation = initialAngle * decay * (Math.cos(omega * settleTimeSec) + dampingRatio * Math.sin(omega * settleTimeSec));
		const window = 1 - smoothstep(0.72, 1.0, settleTimeSec / totalSettleSec);
		return oscillation * window;
	};

	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const attack = smoothstep(0, 300, t);
		const decay = 1 - smoothstep(540, 1250, t);
		return 2.2 * gain * attack * decay;
	};

	const evaluateHeadYaw = (t: number): number => evaluateHeadRoll(t) * 0.28;
	const evaluateTorsoRoll = (t: number): number => evaluateHeadRoll(bodyTime(t)) * 0.25 - evaluateHeadRoll(t);
	const evaluateGazeX = (t: number): number => -evaluateHeadYaw(t) * 0.04;
	const evaluateGazeY = (t: number): number => -evaluateHeadPitch(t) * 0.05;

	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const attack = smoothstep(80, 320, t);
		const decay = 1 - smoothstep(700, 1380, t);
		return 0.88 * gain * attack * decay;
	};

	return {
		timeline: time,
		torso: "head-relative",
		channels: {
			"eyes.left.open": offset(during(whole, evaluateLeftEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateRightEyeOpen)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

/**
 * 变体：连环双电眼款 (Sequential Double Wink，时长 2000ms)
 * 经典 VTuber 连环卖萌：先右眼俏皮轻眨电一下，紧接着头部向反侧大幅歪倒，左眼饱满大放电！
 */
export const cuteWinkDoubleVariant: ActionAuthoring = (rng) => {
	const gain = 0.96 + rng() * 0.08;

	const durationMs = 2000;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const bodyTime = (t: number): number => t - 60 * 4 * (t / durationMs) * (1 - t / durationMs);

	// 1. 右眼在 150~450ms 俏皮轻电
	const evaluateRightEyeOpen = (t: number): number => {
		if (t < 150 || t >= 500) return 0;
		if (t < 250) {
			const u = smoothstep(150, 250, t);
			return -1.0 * u;
		}
		if (t < 380) return -1.0;
		const u = smoothstep(380, 500, t);
		return -1.0 * (1 - u);
	};

	// 2. 左眼在 700~1350ms 饱满大放电
	const evaluateLeftEyeOpen = (t: number): number => {
		if (t < 700 || t >= 1400) return 0;
		if (t < 820) {
			const u = smoothstep(700, 820, t);
			return -1.0 * u;
		}
		if (t < 1180) return -1.0; // 360ms 极长定格电眼！
		const u = smoothstep(1180, 1400, t);
		return -1.0 * (1 - u);
	};

	// 3. 头部侧倾：先微向右侧偏 (-3.2°)，随后大幅反向倒向左侧 (+5.8°)，最后果冻阻尼收正
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		// 0~550ms: 第一段轻偏
		if (t < 550) {
			const attack = smoothstep(0, 250, t);
			const decay = 1 - smoothstep(380, 550, t);
			return -3.2 * gain * attack * decay;
		}
		// 550~1400ms: 第二段深倾大歪头 (+5.8°)
		if (t < 1400) {
			if (t < 850) {
				const u = smoothstep(550, 850, t);
				return 5.8 * gain * u;
			}
			const p = smoothstep(850, 1400, t);
			return (5.8 - 0.4 * p) * gain;
		}
		// 1400~2000ms: 阻尼平滑收正
		const settleSec = (t - 1400) / 1000;
		const decay = Math.exp(-0.35 * 2 * Math.PI * 1.8 * settleSec);
		const wave = Math.cos(2 * Math.PI * 1.8 * settleSec) + 0.35 * Math.sin(2 * Math.PI * 1.8 * settleSec);
		const window = 1 - smoothstep(1400, durationMs, t);
		return 5.4 * gain * decay * wave * window;
	};

	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const wave1 = smoothstep(50, 250, t) * (1 - smoothstep(350, 550, t)) * 1.5;
		const wave2 = smoothstep(650, 900, t) * (1 - smoothstep(1200, 1850, t)) * 2.8;
		return (wave1 + wave2) * gain;
	};

	const evaluateHeadYaw = (t: number): number => evaluateHeadRoll(t) * 0.28;
	const evaluateTorsoRoll = (t: number): number => evaluateHeadRoll(bodyTime(t)) * 0.25 - evaluateHeadRoll(t);
	const evaluateGazeX = (t: number): number => -evaluateHeadYaw(t) * 0.05;
	const evaluateGazeY = (t: number): number => -evaluateHeadPitch(t) * 0.05;

	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const attack = smoothstep(100, 400, t);
		const decay = 1 - smoothstep(1300, durationMs, t);
		return 0.88 * gain * attack * decay;
	};

	return {
		timeline: time,
		torso: "head-relative",
		channels: {
			"eyes.left.open": offset(during(whole, evaluateLeftEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateRightEyeOpen)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

export default cuteWink;
