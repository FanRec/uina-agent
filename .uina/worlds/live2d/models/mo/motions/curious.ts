import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline, smoothstep } from "../../../authoring/curves.js";

/**
 * 物理程序化“终极萌杀·贴肩猫猫大歪头杀”（时长 3800ms 舒缓拉长，沉浸定格）。
 *
 * 核心 VTuber 萌点与动力学：
 * 1. 【软萌骨折级大倾角 (Head Roll 9.6° 视觉杀伤力拉满)】：
 *    - 摆脱僵硬的小歪头，脑袋软软地深贴在肩窝上（Roll 达到 9.6°，保留 0.4° 极限裕量防 clamp）；
 *    - 躯干晚 100ms 小幅反向支撑（头部幅度的 18%），避免头身整块同时倾倒，
 *      让头部视觉上完美贴合在柔美挺立的香肩上。
 * 2. 【超长 2350ms 甜蜜凝神定格与起伏微呼吸 (Soulful Dwell & Breathing)】：
 *    - 给观众足足 2.3 秒的沉浸萌杀暴击，伴随少女好奇的生理微起伏与发丝垂落微颤；
 * 3. 【灵魂眼神：抬眸探寻 -> 柔和直视对焦 (Camera Eye Lock)】：
 *    - 起势抬眸探寻好奇打量 (+0.72)，随后在定格中温柔锁定镜头观众 (+0.48, Gaze X 反向对焦)；
 * 4. 【暴击双重眨眼 (Melting Flutter Blinks)】：
 *    - 贴肩定格初期伴随一次融化般的水灵慢眨眼 (-0.85)，中后期带有好奇微闪，灵动至极；
 * 5. 【软萌小猫嘴与轻吐微息】：
 *    - 嘴角饱满挑起甜美猫猫大笑 (+0.96)，微启唇瓣 (0.26) 犹如轻声好奇发问。
 */
export const curious: ActionAuthoring = (rng) => {
	const gain = 0.97 + rng() * 0.05;
	const sideDir = rng() > 0.5 ? 1 : -1;

	const durationMs = 3800;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const dwellBreath = (t: number): number => Math.sin(((t - 550) / 1000) * 2 * Math.PI * 0.8) * smoothstep(550, 800, t) * (1 - smoothstep(2650, 2900, t));

	// 1. 眼睛视线：0~550ms 抬眸探寻 (+0.72)，随后深情锁定镜头观众 (+0.48)
	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 550) {
			const u = smoothstep(0, 500, t);
			return 0.72 * u;
		}
		if (t < 1100) {
			const u = smoothstep(550, 1100, t);
			return 0.72 - 0.24 * u; // 0.72 -> 0.48
		}
		if (t < 2900) {
			const wander = 0.03 * Math.sin(((t - 1100) / 1000) * 2 * Math.PI * 0.75) * smoothstep(1100, 1300, t) * (1 - smoothstep(2650, 2900, t));
			return 0.48 + wander;
		}
		const u = smoothstep(2900, durationMs, t);
		return 0.48 * (1 - u);
	};

	const evaluateGazeX = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		// 歪头时视线反向微调锁定观众直视对焦
		if (t < 2900) {
			return -0.32 * sideDir * smoothstep(0, 600, t);
		}
		const u = smoothstep(2900, durationMs, t);
		return -0.32 * sideDir * (1 - u);
	};

	// 2. 头部侧倾 (Roll)：9.4° 终极软萌深倒贴肩！
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		// 0~550ms: 软软地向肩膀深倒过去
		if (t < 550) {
			const u = smoothstep(70, 550, t);
			return 9.4 * sideDir * gain * u;
		}
		// 550~2900ms: 核心超长软萌贴肩定格 (长达 2.35秒)，伴随微小起伏呼吸
		if (t < 2900) {
			const breath = 0.18 * dwellBreath(t);
			return (9.4 + breath) * sideDir * gain;
		}
		// 2900~3800ms: 慢悠悠依依不舍舒缓回正
		const u = smoothstep(2900, durationMs, t);
		return 9.4 * sideDir * gain * (1 - u);
	};

	// 3. 头部俯仰 (Pitch)：轻巧微收小下颌 (-1.8°)，娇俏抬眸探头
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 550) {
			const u = smoothstep(90, 550, t);
			return -1.8 * u * gain;
		}
		if (t < 2900) {
			const breath = 0.15 * dwellBreath(t);
			return (-1.8 + breath) * gain;
		}
		const u = smoothstep(2900, durationMs, t);
		return -1.8 * gain * (1 - u);
	};

	// 4. 头部偏航 (Yaw)：微微正向偏转迎向观众 (+2.4°)
	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 550) {
			const u = smoothstep(110, 550, t);
			return 2.4 * sideDir * u * gain;
		}
		if (t < 2900) {
			return (2.4 + 0.12 * dwellBreath(t)) * sideDir * gain;
		}
		const u = smoothstep(2900, durationMs, t);
		return 2.4 * sideDir * gain * (1 - u);
	};

	// 5. 身体晚100ms轻轻反向支撑；offset 必须扣掉本动作已写入的 head-follow。
	const bodyReturn = (t: number): number => 1 - smoothstep(3550, durationMs, t);
	const evaluateTorsoRoll = (t: number): number => {
		return -evaluateHeadRoll(t - 100) * 0.18 * bodyReturn(t) - evaluateHeadRoll(t);
	};
	const evaluateTorsoPitch = (t: number): number => {
		return evaluateHeadPitch(t - 100) * 0.18 * bodyReturn(t) - evaluateHeadPitch(t);
	};
	const evaluateTorsoYaw = (t: number): number => {
		return evaluateHeadYaw(t - 100) * 0.15 * bodyReturn(t) - evaluateHeadYaw(t);
	};

	// 6. 暴击双重眨眼：贴肩初期融化慢眨眼 (-0.85)，后期好奇微眨 (-0.35)
	const evaluateEyeOpen = (t: number): number => {
		if (t >= 950 && t < 1350) {
			const u = t < 1150 ? smoothstep(950, 1150, t) : 1 - smoothstep(1150, 1350, t);
			return -0.85 * u;
		}
		if (t >= 2000 && t < 2300) {
			const u = t < 2150 ? smoothstep(2000, 2150, t) : 1 - smoothstep(2150, 2300, t);
			return -0.35 * u;
		}
		return 0;
	};

	// 7. 嘴角表情：甜美大猫猫微笑挑起 (+0.96) 与微张嘴轻吐息 (+0.26)
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 500) {
			const u = smoothstep(0, 500, t);
			return 0.96 * u * gain;
		}
		if (t < 3000) {
			return 0.96 * gain;
		}
		const u = smoothstep(3000, durationMs, t);
		return 0.96 * gain * (1 - u);
	};

	const evaluateMouthOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 550) {
			const u = smoothstep(0, 550, t);
			return 0.26 * u * gain;
		}
		if (t < 2900) {
			return 0.26 * gain;
		}
		const u = smoothstep(2900, durationMs, t);
		return 0.26 * gain * (1 - u);
	};

	return {
		timeline: time,
		torso: "head-relative",
		channels: {
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
			"mouth.open": offset(during(whole, evaluateMouthOpen)),
		},
	};
};

/**
 * 变体：【双重好奇大歪头杀】(Double Tilt Curious Variant，时长 3600ms)
 * 经典日漫与 VTuber 终极萌杀：
 * 先向一侧轻柔歪头打量 -> 眨眨大眼睛慢悠悠换向另一侧重重倒贴肩，眼神探究直视镜头！
 */
export const curiousDoubleTiltVariant: ActionAuthoring = (rng) => {
	const gain = 0.97 + rng() * 0.05;
	const firstDir = rng() > 0.5 ? 1 : -1;

	const durationMs = 3600;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");

	// 1. 头部侧倾：第一阶段偏向 firstDir (-8.8°)，中间换向，第二阶段深倒贴肩 (+9.6°)
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		// 0~1400ms: 第一段歪头打量 (-8.8°)
		if (t < 1400) {
			if (t < 450) {
				const u = smoothstep(70, 450, t);
				return -8.8 * firstDir * gain * u;
			}
			const p = smoothstep(450, 1400, t);
			return (-8.8 + 0.3 * p) * firstDir * gain;
		}
		// 1400~2000ms: 极度丝滑换向过渡
		if (t < 2000) {
			const u = smoothstep(1400, 2000, t);
			return (-8.5 * (1 - u) + 9.4 * u) * firstDir * gain;
		}
		// 2000~2900ms: 第二段深倒贴肩定格 (+9.4°)
		if (t < 2900) {
			const breath = 0.18 * Math.sin(((t - 2000) / 1000) * 2 * Math.PI) * smoothstep(2000, 2200, t) * (1 - smoothstep(2700, 2900, t));
			return (9.4 + breath) * firstDir * gain;
		}
		// 2900~3600ms: 舒缓收正
		const u = smoothstep(2900, durationMs, t);
		return 9.4 * firstDir * gain * (1 - u);
	};

	// 2. 头部俯仰：两次歪头均伴随低颌收小下巴 (-2.0°)
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 1400) {
			const attack = smoothstep(90, 400, t);
			return -1.8 * gain * attack;
		}
		if (t < 2000) {
			const u = smoothstep(1400, 2000, t);
			return (-1.8 + -0.4 * u) * gain;
		}
		if (t < 2900) {
			return -2.2 * gain;
		}
		const u = smoothstep(2900, durationMs, t);
		return -2.2 * gain * (1 - u);
	};

	// 3. 头部偏航：配合侧倾错开
	const evaluateHeadYaw = (t: number): number => {
		const roll = evaluateHeadRoll(t);
		return roll * 0.25;
	};

	// 4. 换肩时身体晚一步轻轻支撑；先从offset中抵消本动作的头部跟随。
	const bodyReturn = (t: number): number => 1 - smoothstep(3350, durationMs, t);
	const evaluateTorsoRoll = (t: number): number => -evaluateHeadRoll(t - 100) * 0.18 * bodyReturn(t) - evaluateHeadRoll(t);
	const evaluateTorsoPitch = (t: number): number => evaluateHeadPitch(t - 100) * 0.18 * bodyReturn(t) - evaluateHeadPitch(t);
	const evaluateTorsoYaw = (t: number): number => evaluateHeadYaw(t - 100) * 0.15 * bodyReturn(t) - evaluateHeadYaw(t);

	// 5. 眼神抬眸与微动
	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 2900) {
			const u = smoothstep(0, 300, t);
			return 0.55 * u;
		}
		const u = smoothstep(2900, durationMs, t);
		return 0.55 * (1 - u);
	};

	const evaluateGazeX = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const roll = evaluateHeadRoll(t);
		return -roll * 0.035;
	};

	// 6. 换向瞬间的可爱双眨眼 (1500~1800ms)
	const evaluateEyeOpen = (t: number): number => {
		if (t >= 1500 && t < 1800) {
			const u = t < 1650 ? smoothstep(1500, 1650, t) : 1 - smoothstep(1650, 1800, t);
			return -0.88 * u;
		}
		return 0;
	};

	// 7. 嘴角甜笑与微张
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 400) {
			const u = smoothstep(0, 400, t);
			return 0.96 * gain * u;
		}
		if (t < 3000) {
			return 0.96 * gain;
		}
		const u = smoothstep(3000, durationMs, t);
		return 0.96 * gain * (1 - u);
	};

	const evaluateMouthOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 2900) return (0.18 + 0.08 * smoothstep(1850, 2150, t)) * smoothstep(0, 400, t) * gain;
		const u = smoothstep(2900, durationMs, t);
		return 0.26 * gain * (1 - u);
	};

	return {
		timeline: time,
		torso: "head-relative",
		channels: {
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
			"mouth.open": offset(during(whole, evaluateMouthOpen)),
		},
	};
};

export default curious;
