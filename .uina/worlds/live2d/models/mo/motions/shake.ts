import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline } from "../../../authoring/curves.js";

/**
 * 五次光滑阶跃函数 (Hermite Quintic S-Curve)
 * 具有连续的一阶与二阶导数 (C2 连续)，在端点处速度与加速度均为零。
 */
function smoothstep5(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 物理程序化“超大幅度·大周期三维立体萌态大摇头”（时长 2600ms）。
 *
 * 核心 VTuber 萌点与动力学架构：
 * 1. 【超大行程与低频大周期惯性摆动 (Grand Amplitude & Expanded Period)】：
 *    - 周期显著拉长：单摆频率从原先急促的 2.35Hz 放缓扩展至 1.45Hz ~ 1.05Hz（单摆往返周期 700~950ms，舒展从容、极具身体惯性）；
 *    - 幅度大幅强化：Yaw 主摆幅峰值达到 ±10.6°（保留 1.4° 极限防 clamp 裕量，视觉冲击力极强）；
 * 2. 【三维空间立体 8 字轨迹 (3D Saddle Figure-8 Orbit)】：
 *    - Yaw 左右大开大合甩动时，Roll 同步产生 ±4.2° 的反向正交波浪，激发秀发与呆毛飞舞；
 *    - Pitch 在转到两侧极值时微扬 (+2.2°)、穿过中线时微低头沉冲 (-1.8°)，形成鲜活的三维立体环形；
 * 3. 【躯干小幅滞后支撑】：
 *    - 三轴均按期望身体姿态减去头部底动，身体保留约两成随动，避免整身拧转；
 * 4. 【眼神逆向强锁定与定格甜笑 (Gaze Lock & Tilt Settle)】：
 *    - 摆动时眼神反向拉扯强锁定镜头 (±0.48)，甩头期间娇嗔微眯 (0.55)；
 *    - 后半段摇晃平息，顺势沉入娇憨的歪头定格 (Roll: 5.2°)，嘴角绽开灿烂治愈笑容 (+0.85)。
 */
export const cuteShake: ActionAuthoring = (rng) => {
	const gain = 0.98 + rng() * 0.02;
	const startDir = rng() > 0.5 ? 1 : -1;
	const settleRollDir = rng() > 0.4 ? 1 : -1;
	const rollScale = (0.92 + rng() * 0.16) * settleRollDir;

	const durationMs = 2600;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const bodyTime = (t: number): number => t - 60 * 4 * (t / durationMs) * (1 - t / durationMs);

	// --- 1. 核心头部偏航动力学方程 (Procedural Head Yaw) ---
	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const tSec = t / 1000;
		const totalSec = durationMs / 1000;

		// 频率从 1.40Hz 柔和过渡到 1.10Hz (周期约 710~900ms，大周期惯性舒展)
		const frequencyHz = 1.4 - 0.3 * (tSec / totalSec);
		const omega = 2 * Math.PI * frequencyHz;
		const dampingRatio = 0.22;

		// 平滑起势展开 (130ms 极速启动展开)
		const attack = smoothstep5(0, 130, t);
		// 前 750ms 让前两个超大半周期（来回大甩）都完全吃满极限振幅！
		const decayTime = Math.max(0, tSec - 0.75);
		const decay = Math.exp(-dampingRatio * omega * decayTime);
		// 终末平滑窗收正归零
		const window = 1 - smoothstep5(1600, 2300, t);

		// 超大摆幅振荡，峰值达到 ±11.65°（极限接近 12.0° 极限且严格留出安全裕量）
		const baseAmplitude = 11.65 * startDir * gain;
		return baseAmplitude * attack * decay * Math.sin(omega * tSec) * window;
	};

	// --- 2. 躯干反向解耦 (Torso Decoupling) ---
	const evaluateTorsoYaw = (t: number): number => {
		const headYaw = evaluateHeadYaw(t);
		return evaluateHeadYaw(bodyTime(t)) * 0.22 - headYaw;
	};

	// --- 3. 头部倾斜立体波浪耦合 (Head Roll Coupling) ---
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const headYaw = evaluateHeadYaw(t);

		// 摇动期间的侧向代偿正交波 (峰值 ±5.6°)
		const dynamicWave = -headYaw * 0.48;

		// 动作后半段 (1150~2000ms，在主剧烈摇晃平息后) 浮现的治愈系娇憨大歪头 (5.0° 左右)
		const settleTiltEnvelope = smoothstep5(1150, 1500, t) * (1 - smoothstep5(2000, durationMs, t));
		const settleTilt = 5.0 * rollScale * settleTiltEnvelope;

		const window = 1 - smoothstep5(2300, durationMs, t);
		const totalRoll = (dynamicWave + settleTilt) * window;
		return Math.max(-9.6, Math.min(9.6, totalRoll));
	};

	// --- 4. 头部俯仰立体起伏 (Head Pitch Coupling) ---
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const headYaw = evaluateHeadYaw(t);

		// 0~350ms 起势微仰吸气
		const inhale = 2.4 * gain * smoothstep5(0, 150, t) * (1 - smoothstep5(200, 380, t));

		// 摆动中的三维升沉：转角大时微扬 (+2.4°)，过零点时微俯 (-1.8°)
		const activeFactor = smoothstep5(200, 320, t);
		const saddleRise = 2.4 * Math.min(1, (Math.abs(headYaw) / 8.0) ** 2) * gain;
		const dipFactor = smoothstep5(200, 350, t) * (1 - smoothstep5(1500, 1800, t));
		const saddleDip = -1.8 * (1 - Math.min(1, Math.abs(headYaw) / 3.5)) * dipFactor * gain;

		const window = 1 - smoothstep5(2200, durationMs, t);
		return (inhale + (saddleRise + saddleDip) * activeFactor) * window;
	};

	// --- 5. 视线逆向强锁定与拉扯 (Gaze X Coupling) ---
	const evaluateGazeX = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const headYaw = evaluateHeadYaw(t);
		const window = 1 - smoothstep5(2200, durationMs, t);
		return -headYaw * 0.045 * window;
	};

	// --- 6. 摇晃期间娇嗔微眯 (Vigorous Shake Squint Envelope) ---
	const evaluateEyeOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const squintEnvelope = smoothstep5(200, 380, t) * (1 - smoothstep5(1300, 1750, t));
		return -0.45 * gain * squintEnvelope;
	};

	// --- 7. 嘴角傲娇微嘟与笑容舒展包络 (Mouth Form Envelope) ---
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const smileAttack = smoothstep5(800, 1400, t);
		const smileDecay = 1 - smoothstep5(2100, durationMs, t);
		return 0.85 * gain * smileAttack * smileDecay;
	};

	return {
		timeline: time,
		channels: {
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"torso.roll": offset(during(whole, (t) => evaluateHeadRoll(bodyTime(t)) * 0.22 - evaluateHeadRoll(t))),
			"torso.pitch": offset(during(whole, (t) => evaluateHeadPitch(bodyTime(t)) * 0.25 - evaluateHeadPitch(t))),
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

/**
 * 变体：元气拨浪鼓小傲娇摇头 (Procedural Playful Rattle Shake，时长 2200ms)
 * 振动更具弹性韵律 (f 从 1.9Hz 渐进至 1.40Hz)，连续波浪大甩动，呆毛和发丝飞舞。
 */
export const cuteShakePlayfulVariant: ActionAuthoring = (rng) => {
	const gain = 0.98 + rng() * 0.02;
	const startDir = rng() > 0.5 ? -1 : 1;
	const settleRollDir = rng() > 0.5 ? 1 : -1;
	const rollScale = (0.95 + rng() * 0.15) * settleRollDir;

	const durationMs = 2200;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const bodyTime = (t: number): number => t - 60 * 4 * (t / durationMs) * (1 - t / durationMs);

	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const tSec = t / 1000;
		const totalSec = durationMs / 1000;
		const frequencyHz = 1.9 - 0.5 * (tSec / totalSec);
		const omega = 2 * Math.PI * frequencyHz;
		const dampingRatio = 0.22;
		const attack = smoothstep5(0, 120, t);
		const decayTime = Math.max(0, tSec - 0.65);
		const decay = Math.exp(-dampingRatio * omega * decayTime);
		const window = 1 - smoothstep5(1400, 2000, t);
		const baseAmplitude = 11.65 * startDir * gain;
		return baseAmplitude * attack * decay * Math.sin(omega * tSec) * window;
	};

	const evaluateTorsoYaw = (t: number): number => evaluateHeadYaw(bodyTime(t)) * 0.22 - evaluateHeadYaw(t);

	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const headYaw = evaluateHeadYaw(t);
		const dynamicWave = -headYaw * 0.48;
		const settleTilt = 4.8 * rollScale * smoothstep5(900, 1250, t) * (1 - smoothstep5(1800, durationMs, t));
		const window = 1 - smoothstep5(2000, durationMs, t);
		const total = (dynamicWave + settleTilt) * window;
		return Math.max(-9.5, Math.min(9.5, total));
	};

	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const headYaw = evaluateHeadYaw(t);
		const inhale = 2.4 * gain * smoothstep5(0, 150, t) * (1 - smoothstep5(180, 360, t));
		const activeFactor = smoothstep5(180, 280, t);
		const saddleRise = 2.0 * Math.min(1, (Math.abs(headYaw) / 8.0) ** 2) * gain;
		const dipFactor = smoothstep5(180, 300, t) * (1 - smoothstep5(1300, 1600, t));
		const saddleDip = -1.6 * (1 - Math.min(1, Math.abs(headYaw) / 3.5)) * dipFactor * gain;
		const window = 1 - smoothstep5(1900, durationMs, t);
		return (inhale + (saddleRise + saddleDip) * activeFactor) * window;
	};

	const evaluateGazeX = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const headYaw = evaluateHeadYaw(t);
		return -headYaw * 0.045 * (1 - smoothstep5(1900, durationMs, t));
	};

	const evaluateEyeOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const squintEnvelope = smoothstep5(160, 320, t) * (1 - smoothstep5(1100, 1550, t));
		return -0.45 * gain * squintEnvelope;
	};

	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const attack = smoothstep5(600, 1200, t);
		const decay = 1 - smoothstep5(1800, durationMs, t);
		return 0.85 * gain * attack * decay;
	};

	return {
		timeline: time,
		channels: {
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"torso.roll": offset(during(whole, (t) => evaluateHeadRoll(bodyTime(t)) * 0.22 - evaluateHeadRoll(t))),
			"torso.pitch": offset(during(whole, (t) => evaluateHeadPitch(bodyTime(t)) * 0.25 - evaluateHeadPitch(t))),
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

export default cuteShake;
