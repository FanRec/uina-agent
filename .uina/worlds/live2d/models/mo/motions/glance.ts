import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline, smoothstep } from "../../../authoring/curves.js";

/**
 * 物理程序化“眼动先行暗中斜睨偷瞄”（时长 1200ms）。
 *
 * 核心萌点与动力学架构：
 * 1. 【眼动先行因果链 (Saccadic Lead Chain)】：
 *    视线在 0~80ms 内先行侧瞥 (gaze.x: 0.82)，保留眼角余量；
 *    头部在 60ms 滞后启动，形成绝对逼真的生物注视物理因果链！
 * 2. 【缩颈与立体微倾 (Sly Craning & Tilt)】：
 *    头部不仅侧转 (+4.8°)，更向下收颌缩颈 (-4.5°) 并侧偏 (-3.8°)，
 *    完美塑造做贼心虚、暗中窥视的灵动微表情。
 * 3. 【饱满斜睨定格 (Peak Gaze Dwell)】：
 *    240~850ms 足足 610ms 的超长斜睨定格！双眼微眯 (-0.32)，嘴角挑起狡黠微笑 (0.58)。
 * 4. 【做贼心虚狡黠滑回】：
 *    850ms 视线先行溜回，头部随后缓和归中。
 */
export const glance: ActionAuthoring = (rng) => {
	const gain = 0.96 + rng() * 0.08;
	const sideDir = rng() > 0.5 ? 1 : -1;

	const durationMs = 1200;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");

	// 1. 视线先行侧瞥至0.82，随后狡黠滑回。
	const evaluateGazeX = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 80) {
			const u = smoothstep(0, 80, t);
			return 0.82 * sideDir * u;
		}
		if (t < 850) {
			return 0.82 * sideDir;
		}
		const u = smoothstep(850, 1100, t);
		return 0.82 * sideDir * (1 - u);
	};

	// 2. 视线纵向微挑：斜睨时眼神微挑 (+0.25)
	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const gaze = Math.abs(evaluateGazeX(t));
		return (gaze / 0.82) * 0.25;
	};

	// 3. 头部俯仰：滞后于眼动 (60ms 启动)，缩颈微低头形成暗中窥探感 (-4.5°)
	const evaluateHeadPitch = (t: number): number => {
		if (t < 60 || t >= durationMs) return 0;
		if (t < 240) {
			const u = smoothstep(60, 240, t);
			return -4.5 * gain * u;
		}
		if (t < 850) {
			return -4.5 * gain;
		}
		const u = smoothstep(850, durationMs, t);
		return -4.5 * gain * (1 - u);
	};

	// 4. 头部偏航：滞后跟随视线转动 (+4.8°)
	const evaluateHeadYaw = (t: number): number => {
		if (t < 60 || t >= durationMs) return 0;
		if (t < 240) {
			const u = smoothstep(60, 240, t);
			return 4.8 * sideDir * gain * u;
		}
		if (t < 850) {
			return 4.8 * sideDir * gain;
		}
		const u = smoothstep(850, durationMs, t);
		return 4.8 * sideDir * gain * (1 - u);
	};

	// 5. 头部侧倾：微向反向倾斜增加娇俏感 (-3.8°)
	const evaluateHeadRoll = (t: number): number => {
		const yaw = evaluateHeadYaw(t);
		return -yaw * 0.79;
	};

	// 6. 眼睛先行、头部跟上之后，身体再晚80ms小幅跟随。
	const bodyReturn = (t: number): number => 1 - smoothstep(1000, durationMs, t);
	const evaluateTorsoYaw = (t: number): number => {
		return evaluateHeadYaw(t - 80) * 0.12 * bodyReturn(t) - evaluateHeadYaw(t);
	};
	const evaluateTorsoPitch = (t: number): number => {
		return evaluateHeadPitch(t - 80) * 0.12 * bodyReturn(t) - evaluateHeadPitch(t);
	};
	const evaluateTorsoRoll = (t: number): number => {
		return evaluateHeadRoll(t - 80) * 0.15 * bodyReturn(t) - evaluateHeadRoll(t);
	};

	// 7. 斜睨时双眼微眯 (-0.32)
	const evaluateEyeOpen = (t: number): number => {
		if (t < 100 || t >= 1050) return 0;
		if (t < 250) {
			const u = smoothstep(100, 250, t);
			return -0.32 * gain * u;
		}
		if (t < 850) {
			return -0.32 * gain;
		}
		const u = smoothstep(850, 1050, t);
		return -0.32 * gain * (1 - u);
	};

	// 8. 嘴角微抿狡黠笑 (0.58)
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const gaze = Math.abs(evaluateGazeX(t));
		return (gaze / 0.82) * 0.58 * gain;
	};

	return {
		timeline: time,
		torso: "head-relative",
		channels: {
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

/**
 * 变体：【经典二连惊醒偷瞄】(Classic Double-Take Variant，时长 2400ms)
 * 经典日漫二次元喜剧表现：
 * 先随意偷瞥一眼 -> 若无其事收回视线回正 -> 猛然意识到不对劲，闪电甩头定格死锁抓包！-> 做贼心虚娇羞收正。
 */
export const glanceDoubleTakeVariant: ActionAuthoring = (rng) => {
	const gain = 0.96 + rng() * 0.08;
	const sideDir = rng() > 0.5 ? 1 : -1;

	const durationMs = 2400;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");

	// 1. 视线二连：先偷看(0.75)，回中，再更明显地回看(0.82)。
	const evaluateGazeX = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		// 第一次随性偷看
		if (t < 350) {
			const u = smoothstep(0, 150, t);
			return 0.75 * sideDir * u;
		}
		// 若无其事溜回中线
		if (t < 750) {
			const u = smoothstep(350, 650, t);
			return 0.75 * sideDir * (1 - u);
		}
		if (t < 850) return 0;
		// 第二次猛然双重回看 (Double Take!) 极速甩满
		if (t < 1000) {
			const u = smoothstep(850, 1000, t);
			return 0.82 * sideDir * u;
		}
		if (t < 1750) {
			return 0.82 * sideDir;
		}
		const u = smoothstep(1750, 2200, t);
		return 0.82 * sideDir * (1 - u);
	};

	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const gaze = Math.abs(evaluateGazeX(t));
		return (gaze / 0.82) * 0.22;
	};

	// 2. 头部偏航：第一次微转 (+2.8°)，第二次强烈转头抓包 (+7.2°)
	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 750) {
			const attack = smoothstep(50, 220, t);
			const decay = 1 - smoothstep(400, 700, t);
			return 2.8 * sideDir * gain * attack * decay;
		}
		if (t < 880) return 0;
		if (t < 1120) {
			const u = smoothstep(880, 1120, t);
			return 7.2 * sideDir * gain * u;
		}
		if (t < 1750) {
			return 7.2 * sideDir * gain;
		}
		const u = smoothstep(1750, durationMs, t);
		return 7.2 * sideDir * gain * (1 - u);
	};

	// 3. 头部俯仰：缩颈 (-3.8°)
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 750) return -2.0 * gain * smoothstep(50, 220, t) * (1 - smoothstep(400, 700, t));
		if (t < 880) return 0;
		if (t < 1120) return -3.8 * gain * smoothstep(880, 1120, t);
		if (t < 1750) return -3.8 * gain;
		const u = smoothstep(1750, durationMs, t);
		return -3.8 * gain * (1 - u);
	};

	// 4. 头部侧倾
	const evaluateHeadRoll = (t: number): number => -evaluateHeadYaw(t) * 0.72;

	// 5. 两次回看都保留身体相对头部的80ms迟滞。
	const bodyReturn = (t: number): number => 1 - smoothstep(2200, durationMs, t);
	const evaluateTorsoYaw = (t: number): number => evaluateHeadYaw(t - 80) * 0.12 * bodyReturn(t) - evaluateHeadYaw(t);
	const evaluateTorsoPitch = (t: number): number => evaluateHeadPitch(t - 80) * 0.12 * bodyReturn(t) - evaluateHeadPitch(t);
	const evaluateTorsoRoll = (t: number): number => evaluateHeadRoll(t - 80) * 0.15 * bodyReturn(t) - evaluateHeadRoll(t);

	// 6. 双眼表情：第二次抓包后心虚眨眼 (1800~2050ms)
	const evaluateEyeOpen = (t: number): number => {
		if (t >= 1800 && t < 2050) {
			const u = t < 1925 ? smoothstep(1800, 1925, t) : 1 - smoothstep(1925, 2050, t);
			return -0.85 * u;
		}
		return 0;
	};

	// 7. 嘴角表情：前期狡黠微抿，抓包后羞涩微笑
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 750) return 0.35 * gain * smoothstep(50, 250, t) * (1 - smoothstep(400, 700, t));
		if (t < 880) return 0;
		if (t < 1750) return 0.52 * gain * smoothstep(880, 1150, t);
		const u = smoothstep(1750, durationMs, t);
		return 0.52 * gain * (1 - u);
	};

	return {
		timeline: time,
		torso: "head-relative",
		channels: {
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

export default glance;
