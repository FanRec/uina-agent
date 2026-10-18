import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline, smoothstep } from "../../../authoring/curves.js";

/**
 * =========================================================================
 * 模式 1：【经典悠扬大摇摆 (Sway Classic - Organic Pendulum)】
 * =========================================================================
 * 彻底消除非人鬼畜与骨骼畸变拉扯，严格遵循真人 VTuber 镜头交互体态：
 * 1. 【黄金慢速节拍 (0.556Hz)】：
 *    - 3600ms 完成 2 个完整往复大摇荡，单向倾倒历时整整 900ms，从容、悠闲、优雅、软糯。
 * 2. 【严密精确的解耦与真实体态】：
 *    - 期望合成姿态：身体侧倾 ±3.6°，头部侧倾 ±5.4°（头部可爱微歪略大于身躯）；
 *    - 基于引擎 Head-Follow 机制，Torso Offset = DesiredTorso - DesiredHead，杜绝超界与僵硬叠角！
 * 3. 【端正迎人与极微随动】：
 *    - 脸蛋完全正对观众镜头，Head Yaw 仅保留 ±0.8° 的微弱生理随动，绝不疯狂甩头。
 * 4. 【轻柔 Q 弹升沉】：
 *    - 过中点自然直立挺拔 (+1.0°)，两翼微沉 (-0.4°)，落差仅 1.4°，温润有弹性。
 * 5. 【清澈专注前庭眼反射 (VOR)】：
 *    - Gaze X 柔和反向微补偿镜头 (±0.22)，眼神温柔聚焦注视观众，绝不翻白眼。
 * 6. 【治愈元气甜美浅笑】：
 *    - 嘴角保持温和甜美的自然微笑 (0.52)，微张呼吸 (0.04)。
 */
export const swayClassic: ActionAuthoring = (rng) => {
	const gain = 0.98 + rng() * 0.04;
	const dir = rng() > 0.5 ? 1 : -1;

	const durationMs = 3600;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");

	// 黄金真人节律：0.556Hz（3600ms 完成 2 个完整往复大摇荡，单向约 900ms，极其悠闲舒适）
	const frequencyHz = 2 / 3.6;
	const omega = 2 * Math.PI * frequencyHz;

	// 1. 期望最终头部侧倾：±5.4°
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const tSec = t / 1000;
		const attack = smoothstep(0, 350, t);
		const decay = 1 - smoothstep(2950, 3550, t);
		const baseAmp = 5.4 * dir * gain;
		return baseAmp * attack * decay * Math.sin(omega * tSec);
	};

	// 2. 期望最终躯干侧倾：±3.6°（稍微滞后 80ms 呈现柔和身体传导）
	// 根据引擎规则 frame[torso] = frame[head] + torsoOffset，故 torsoOffset = desiredTorso - desiredHead
	const evaluateTorsoRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const tSec = t / 1000;
		const attack = smoothstep(0, 350, t);
		const decay = 1 - smoothstep(2950, 3550, t);
		const desiredTorso = 3.6 * dir * gain * attack * decay * Math.sin(omega * (tSec - 0.08));
		return desiredTorso - evaluateHeadRoll(t);
	};

	// 3. 头部与躯干偏航 (Yaw)：脸蛋端正迎人，绝不狂甩头
	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return (evaluateHeadRoll(t) / 5.4) * 0.8;
	};

	const evaluateTorsoYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const desiredTorsoYaw = (evaluateHeadRoll(t) / 5.4) * 1.2;
		return desiredTorsoYaw - evaluateHeadYaw(t);
	};

	// 4. 垂直弹性升沉 (Pitch)：中点直立微挺 (+1.0°)，两翼微沉 (-0.4°)，落差仅 1.4°
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const tSec = t / 1000;
		const attack = smoothstep(0, 300, t);
		const decay = 1 - smoothstep(3000, 3550, t);
		const bob = 0.7 * (Math.cos(2 * omega * tSec) - 1) + 1.0 * Math.sin((omega * tSec) / 2) ** 2;
		return bob * attack * decay * gain;
	};

	const evaluateTorsoPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const desiredTorsoPitch = evaluateHeadPitch(t) * 0.65;
		return desiredTorsoPitch - evaluateHeadPitch(t);
	};

	// 5. 视线控制：柔和反向微补偿锁定镜头 (±0.22)，清澈自然，不翻白眼
	const evaluateGazeX = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const roll = evaluateHeadRoll(t);
		return -(roll / 5.4) * 0.22;
	};

	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const attack = smoothstep(0, 300, t);
		const decay = 1 - smoothstep(3000, 3550, t);
		return 0.12 * attack * decay;
	};

	// 6. 嘴角甜美治愈浅笑 (0.52)，带轻柔呼吸微漾
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const attack = smoothstep(0, 350, t);
		const decay = 1 - smoothstep(3000, durationMs, t);
		const ripple = 0.08 * Math.sin(2 * omega * (t / 1000));
		return (0.52 + ripple) * gain * attack * decay;
	};

	const evaluateMouthOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const attack = smoothstep(0, 350, t);
		const decay = 1 - smoothstep(3000, durationMs, t);
		return 0.04 * gain * attack * decay;
	};

	return {
		timeline: time,
		torso: "head-relative",
		channels: {
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
			"mouth.open": offset(during(whole, evaluateMouthOpen)),
		},
	};
};

/**
 * =========================================================================
 * 模式 2：【温和侧倚好奇探看 (Corner Peek - Gentle Side Lean)】
 * =========================================================================
 * 真人主播面对侧面弹幕时的自然好奇倾倚，绝无脖子折断与翻白眼：
 * - 身体向侧方自然倚倾支撑 (期望合成 Torso Roll: ±3.2°)；
 * - 头部可爱微歪打量 (Head Roll: ±4.8°, Pitch: +1.8°, Yaw: ±2.0°)；
 * - 视线自然向侧上方好奇探看 (Gaze X: 0.32, Gaze Y: 0.18)，清澈生动；
 * - 探看期间带有 1.4 秒的自然呼吸微动，随后舒缓回正。
 */
export const swayCornerPeekVariant: ActionAuthoring = (rng) => {
	const gain = 0.98 + rng() * 0.04;
	const peekDir = rng() > 0.5 ? 1 : -1;

	const durationMs = 3600;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const headTime = (t: number): number => (Math.max(0, t - 90) * durationMs) / (durationMs - 90);
	const bodyTime = (t: number): number => (Math.max(0, t - 160) * durationMs) / (durationMs - 160);
	const breath = (t: number): number => 0.25 * Math.sin(((t - 600) * 2 * Math.PI) / 1800) * smoothstep(600, 850, t) * (1 - smoothstep(2150, 2400, t));

	// 先看再倾倚，头部与身体错开进入；停留中呼吸轻动，末段舒缓回正。
	const evaluatePeekEnvelope = (t: number): number => {
		if (t < 600) return smoothstep(0, 600, t);
		if (t < 2400) return 1.0;
		if (t < durationMs) return 1.0 - smoothstep(2400, durationMs, t);
		return 0;
	};

	// 1. 视线向斜上方好奇关注 (Gaze X +0.32, Gaze Y +0.18)
	const evaluateGazeX = (t: number): number => {
		return 0.32 * evaluatePeekEnvelope(t) * peekDir;
	};
	const evaluateGazeY = (t: number): number => {
		return 0.18 * evaluatePeekEnvelope(t);
	};

	// 2. 头部侧偏探看 (Roll +4.8°, Pitch +1.8°, Yaw +2.0°)
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const env = evaluatePeekEnvelope(headTime(t));
		return (4.8 * env + breath(t)) * peekDir * gain;
	};

	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const env = evaluatePeekEnvelope(headTime(t));
		return (1.8 * env + breath(t)) * gain;
	};

	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return 2.0 * evaluatePeekEnvelope(headTime(t)) * peekDir * gain;
	};

	// 3. 躯干自然侧倾支撑 (期望合成值为 +3.2°，故 offset = 3.2° - 4.8° = -1.6°)
	const evaluateTorsoRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const desiredTorso = 3.2 * evaluatePeekEnvelope(bodyTime(t)) * peekDir * gain;
		return desiredTorso - evaluateHeadRoll(t);
	};
	const evaluateTorsoPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const desiredTorsoPitch = 0.8 * evaluatePeekEnvelope(bodyTime(t)) * gain;
		return desiredTorsoPitch - evaluateHeadPitch(t);
	};
	const evaluateTorsoYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const desiredTorsoYaw = 1.4 * evaluatePeekEnvelope(bodyTime(t)) * peekDir * gain;
		return desiredTorsoYaw - evaluateHeadYaw(t);
	};

	// 4. 甜美浅笑微抿 (0.55)
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return 0.55 * evaluatePeekEnvelope(t) * gain;
	};

	return {
		timeline: time,
		torso: "head-relative",
		channels: {
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

/**
 * =========================================================================
 * 模式 3：【欢快活泼元气摇摆 (Bouncy Sway - Cheerful Pop)】
 * =========================================================================
 * 稍轻快的元气节拍 (0.65Hz)，充满少女听歌晃脑的可爱活力，绝无突发抽风急甩：
 * - 身体与头部跟随欢快节拍自然往复 (期望合成 Torso Roll: ±3.8°, Head Roll: ±5.6°)；
 * - 伴随轻盈的微弹性双倍小起伏，嘴角微笑元气展颜 (0.65)。
 */
export const swayChaoticBouncyVariant: ActionAuthoring = (rng) => {
	const gain = 0.98 + rng() * 0.04;
	const sideDir = rng() > 0.5 ? 1 : -1;

	const durationMs = 3600;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");

	// 欢快节拍 0.65Hz（单向约 770ms，轻快元气，绝不抽风）
	const frequencyHz = 0.65;
	const omega = 2 * Math.PI * frequencyHz;

	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const tSec = t / 1000;
		const attack = smoothstep(0, 260, t);
		const decay = 1 - smoothstep(3000, durationMs, t);
		return 5.6 * sideDir * gain * attack * decay * Math.sin(omega * tSec);
	};

	const evaluateTorsoRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const tSec = t / 1000;
		const attack = smoothstep(0, 260, t);
		const decay = 1 - smoothstep(3000, durationMs, t);
		const desiredTorso = 3.8 * sideDir * gain * attack * decay * Math.sin(omega * (tSec - 0.08));
		return desiredTorso - evaluateHeadRoll(t);
	};

	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return (evaluateHeadRoll(t) / 5.6) * 0.8;
	};
	const evaluateTorsoYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const desiredTorsoYaw = (evaluateHeadRoll(t) / 5.6) * 1.2;
		return desiredTorsoYaw - evaluateHeadYaw(t);
	};

	// 欢快轻弹升沉（落差 1.8°）
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const tSec = t / 1000;
		const attack = smoothstep(0, 260, t);
		const decay = 1 - smoothstep(3000, durationMs, t);
		const bounce = 0.9 * (Math.cos(2 * omega * tSec) - 1);
		return bounce * attack * decay * gain;
	};
	const evaluateTorsoPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const desiredTorsoPitch = evaluateHeadPitch(t) * 0.65;
		return desiredTorsoPitch - evaluateHeadPitch(t);
	};

	// 视线柔和反向微补偿
	const evaluateGazeX = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return -(evaluateHeadRoll(t) / 5.6) * 0.22;
	};

	// 元气微笑
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const attack = smoothstep(0, 300, t);
		const decay = 1 - smoothstep(3000, durationMs, t);
		return 0.65 * gain * attack * decay;
	};

	return {
		timeline: time,
		torso: "head-relative",
		channels: {
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

/**
 * =========================================================================
 * 模式 4：【柔和秋千 V 型大摇摆 (V-Flow Sway - Swing Glide)】
 * =========================================================================
 * 彻底消除跳楼机磕头感，回归秋千般舒缓流动的重力自然韵律：
 * - 0.556Hz 黄金慢速节拍，两侧大舒展摇荡 (期望合成 Torso Roll: ±3.6°, Head Roll: ±5.6°)；
 * - 升沉落差温和控制在 2.4°，过谷微低头沉思浅笑 (-1.2°)，两翼挺胸迎风高扬 (+1.2°)；
 * - 过谷低头瞬间眼眸自然“抬眸仰视关注镜头”(+0.18)，两翼平视，眼神极具情感拉扯！
 */
export const swayVShapeVariant: ActionAuthoring = (rng) => {
	const gain = 0.98 + rng() * 0.04;
	const dir = rng() > 0.5 ? 1 : -1;

	const durationMs = 3600;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");

	// 舒缓节拍 0.556Hz（每个半周期 900ms，为秋千般舒缓沉浮留出充足物理重力流）
	const frequencyHz = 2 / 3.6;
	const omega = 2 * Math.PI * frequencyHz;

	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const tSec = t / 1000;
		const attack = smoothstep(0, 300, t);
		const decay = 1 - smoothstep(3000, 3550, t);
		return 5.6 * dir * gain * attack * decay * Math.sin(omega * tSec);
	};

	const evaluateTorsoRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const tSec = t / 1000;
		const attack = smoothstep(0, 300, t);
		const decay = 1 - smoothstep(3000, 3550, t);
		const desiredTorso = 3.6 * dir * gain * attack * decay * Math.sin(omega * (tSec - 0.08));
		return desiredTorso - evaluateHeadRoll(t);
	};

	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return (evaluateHeadRoll(t) / 5.6) * 0.8;
	};
	const evaluateTorsoYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const desiredTorsoYaw = (evaluateHeadRoll(t) / 5.6) * 1.2;
		return desiredTorsoYaw - evaluateHeadYaw(t);
	};

	// V 字形柔和秋千沉浮（落差温和控制在 2.4°，过谷微颔 -1.2°，冲顶微昂 +1.2°）
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const tSec = t / 1000;
		const attack = smoothstep(0, 300, t);
		const decay = 1 - smoothstep(3000, 3550, t);
		const sinVal = Math.sin(omega * tSec);
		const pitchWave = 1.2 * (2 * (sinVal * sinVal) - 1);
		return pitchWave * attack * decay * gain;
	};

	const evaluateTorsoPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const desiredTorsoPitch = evaluateHeadPitch(t) * 0.65;
		return desiredTorsoPitch - evaluateHeadPitch(t);
	};

	// 视线控制：过中点微颔时自然“抬眸仰视关注镜头”(+0.18)，两端平视
	const evaluateGazeX = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return -(evaluateHeadRoll(t) / 5.6) * 0.22;
	};

	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const tSec = t / 1000;
		const attack = smoothstep(0, 300, t);
		const decay = 1 - smoothstep(3000, 3550, t);
		const sinVal = Math.abs(Math.sin(omega * tSec));
		return (0.18 * (1 - sinVal) + 0.05 * sinVal) * attack * decay;
	};

	// 舒展大方微笑
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const attack = smoothstep(0, 350, t);
		const decay = 1 - smoothstep(3000, durationMs, t);
		return 0.55 * gain * attack * decay;
	};

	return {
		timeline: time,
		torso: "head-relative",
		channels: {
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

export default swayClassic;
