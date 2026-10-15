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
 * 物理程序化“Q弹大深呼吸点头”（时长 1950ms）。
 *
 * 采用纯连续数学与物理动力学（Procedural Physics Dynamics）生成，完全摆脱手 K 关键帧的生硬：
 * 1. 【起势吸气波 (Anticipation Inhale)】：
 *    利用高阶光滑钟形脉冲产生 +3.2° 的舒缓仰头蓄力，在 320ms 形成张力凝滞（Tension Hang）。
 * 2. 【深潜冲击与驻留 (Deep Drop & Dwell)】：
 *    势能急速释放，下潜至 -9.5° 并保持 100ms 驻留，克服 Director 二阶弹簧滤波截断，真切下扎到底！
 * 3. 【阻尼谐振子回弹 (Underdamped Spring Bounce)】：
 *    触底后由物理阻尼振子 (Damped Harmonic Oscillator, f=1.38Hz, ζ=0.28) 驱动强力 Q 弹反弹！
 *    驻留后以连续速度释放回弹，随后小幅确认微颔并自然衰减。
 * 4. 【多轴运动学动力耦合 (Kinematic Coupling)】：
 *    - 躯干只小幅滞后跟随，三轴均扣除头部默认底动，避免整身随头一起被压或侧倒；
 *    - 头部歪头 (Roll) 由低头深度与侧向惯性动力学联动，达到 4.8°~5.2° 的娇憨倾斜；
 *    - 眼睑由头部深度非线性传递函数驱动，下潜越深自动笑眯成弯弯月牙缝 (仅剩 0.08)，弹起自如睁大；
 *    - 嘴角由动作情绪包络程序化驱动灿烂治愈微笑 (0.88)。
 */
export const cuteNod: ActionAuthoring = (rng) => {
	// Bake 阶段摄取细微随机性
	const gain = 0.97 + rng() * 0.06;
	const rollDir = rng() > 0.4 ? 1 : -1;
	const rollScale = (0.92 + rng() * 0.16) * rollDir;

	const durationMs = 1950;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const bodyTime = (t: number): number => t - 70 * 4 * (t / durationMs) * (1 - t / durationMs);

	// --- 1. 核心头部俯仰动力学方程 (Procedural Head Pitch) ---
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;

		// A. 0~320ms: 起势微仰吸气波 (Inhale Wave, 升至 +3.2°)
		if (t < 320) {
			const phase = t / 320;
			return 3.2 * gain * Math.sin((Math.PI / 2) * phase) ** 2;
		}

		// B. 320~700ms: 深潜下沉与驻留 (Deep Drop to -9.4° with Bottom Dwell)
		if (t < 700) {
			if (t < 620) {
				// 320~620ms 急速下潜
				const u = smoothstep5(320, 620, t);
				return (3.2 + (-9.4 - 3.2) * u) * gain;
			}
			// 620~700ms 底谷驻留 (充足时间让外部物理弹簧吃满行程)
			const dwellProgress = smoothstep5(620, 700, t);
			return (-9.4 + 0.3 * dwellProgress) * gain;
		}

		// C. 700~1950ms: 阻尼谐振子回弹 (Underdamped Harmonic Oscillator)
		// 触底后由物理弹性振动方程驱动：f=1.36Hz, 周期约 735ms
		const bounceTimeSec = (t - 700) / 1000;
		const totalBounceSec = (durationMs - 700) / 1000;
		const frequencyHz = 1.36;
		const omega = 2 * Math.PI * frequencyHz;
		const dampingRatio = 0.28; // 欠阻尼软糖 Q 弹
		const decay = Math.exp(-dampingRatio * omega * bounceTimeSec);

		// 从驻留末端的零速度释放，避免触底处突然改变角速度。
		const initialVelocity = 0;
		const amplitude = -9.1;
		const oscillation = decay * (amplitude * Math.cos(omega * bounceTimeSec) + ((initialVelocity + dampingRatio * omega * amplitude) / omega) * Math.sin(omega * bounceTimeSec));

		// 终点加五次窗平滑淡出归零
		const window = 1 - smoothstep5(0.7, 1.0, bounceTimeSec / totalBounceSec);
		return oscillation * window * gain;
	};

	// --- 2. 躯干反向抗压支撑耦合 (Torso Decoupling) ---
	// Director 会将 head.pitch 加到 torso.pitch；
	// 身体小幅滞后跟随，支撑随低头深度连续展开，避免阈值阶跃。
	const evaluateTorsoPitch = (t: number): number => {
		const head = evaluateHeadPitch(t);
		// 身体保持稳定支撑，甚至在头用力深扎时提供反向微耸挺立
		return evaluateHeadPitch(bodyTime(t)) * 0.18 + 0.3 * smoothstep5(-3, -6, head) - head;
	};

	// --- 3. 头部倾斜萌态耦合 (Head Roll Coupling) ---
	// 低头越深，歪头自然越明显，回弹时保留可爱的侧倾微晃
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const head = evaluateHeadPitch(t);
		const deepLean = Math.max(0, -head) * 0.48; // 低头产生的主侧倾 (达 4.5° 左右)
		const dynamicSway = (head > 0 ? head * 0.35 : 0) * Math.cos((Math.PI * t) / 900);
		const window = 1 - smoothstep5(1500, durationMs, t);
		const accent = 0.6 * smoothstep5(140, 280, t) * (1 - smoothstep5(1320, 1500, t));
		return (deepLean + dynamicSway + accent) * rollScale * window;
	};

	// --- 4. 头部偏航立体耦合 (Head Yaw Coupling) ---
	const evaluateHeadYaw = (t: number): number => {
		return evaluateHeadRoll(t) * 0.38;
	};

	// --- 5. 视线逆向锁定与顺从微垂 (Gaze Y Coupling) ---
	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const head = evaluateHeadPitch(t);
		// 头仰视线下压 (-0.25)，头深低目光顺从微垂 (+0.30)，回弹重新直视
		const target = head > 0 ? -head * 0.075 : -head * 0.033;
		const window = 1 - smoothstep5(1600, durationMs, t);
		return target * gain * window;
	};

	// --- 6. 眼睑治愈月牙眯眼传递函数 (Eyelid Smile Squint Transfer Function) ---
	const evaluateEyeOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const head = evaluateHeadPitch(t);
		// 头部下潜越深，眼睛自然被笑肌挤压成弯弯月牙 (最深处 offset 达 -0.92，仅剩 0.08)
		const squintIntensity = smoothstep5(1.0, -8.5, head);
		// 二次小点头时 (1250~1450ms) 附加一次可爱的轻眨眼点缀
		const secondWink = t > 1250 && t < 1450 ? 0.35 * Math.sin(((t - 1250) / 200) * Math.PI) ** 2 : 0;
		const totalSquint = Math.min(0.93, squintIntensity * 0.92 + secondWink);
		return -totalSquint * gain * smoothstep5(0, 120, t) * (1 - smoothstep5(durationMs - 200, durationMs, t));
	};

	// --- 7. 嘴角笑容程序化包络 (Mouth Form Envelope) ---
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const attack = smoothstep5(0, 600, t); // 快速展颜微笑
		const decay = 1 - smoothstep5(1400, durationMs, t); // 舒缓淡出
		return 0.88 * gain * attack * decay;
	};

	return {
		timeline: time,
		channels: {
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.roll": offset(during(whole, (t) => evaluateHeadRoll(bodyTime(t)) * 0.22 - evaluateHeadRoll(t))),
			"torso.yaw": offset(during(whole, (t) => evaluateHeadYaw(bodyTime(t)) * 0.22 - evaluateHeadYaw(t))),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

/**
 * 变体：高频超弹元气款 (Procedural Cheerful Spring Nod，时长 1880ms)
 * 采用更高的固有频率 (f=1.52Hz) 与稍小阻尼，弹跳感与二次回弹更加元气跃动。
 */
export const cuteNodCheerfulVariant: ActionAuthoring = (rng) => {
	const gain = 0.98 + rng() * 0.05;
	const rollDir = rng() > 0.5 ? -1 : 1;
	const rollScale = (0.95 + rng() * 0.15) * rollDir;

	const durationMs = 1880;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const bodyTime = (t: number): number => t - 70 * 4 * (t / durationMs) * (1 - t / durationMs);

	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 280) {
			return 3.5 * gain * Math.sin((Math.PI / 2) * (t / 280)) ** 2;
		}
		if (t < 640) {
			if (t < 560) {
				const u = smoothstep5(280, 560, t);
				return (3.5 + (-9.6 - 3.5) * u) * gain;
			}
			return (-9.6 + 0.3 * smoothstep5(560, 640, t)) * gain;
		}
		const bounceTimeSec = (t - 640) / 1000;
		const totalBounceSec = (durationMs - 640) / 1000;
		const omega = 2 * Math.PI * 1.52;
		const dampingRatio = 0.26;
		const decay = Math.exp(-dampingRatio * omega * bounceTimeSec);
		const initialVelocity = 0;
		const amplitude = -9.3;
		const oscillation = decay * (amplitude * Math.cos(omega * bounceTimeSec) + ((initialVelocity + dampingRatio * omega * amplitude) / omega) * Math.sin(omega * bounceTimeSec));
		const window = 1 - smoothstep5(0.72, 1.0, bounceTimeSec / totalBounceSec);
		return oscillation * window * gain;
	};

	const evaluateTorsoPitch = (t: number): number => {
		const head = evaluateHeadPitch(t);
		return evaluateHeadPitch(bodyTime(t)) * 0.18 + 0.35 * smoothstep5(-3, -6, head) - head;
	};

	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const head = evaluateHeadPitch(t);
		const deepLean = Math.max(0, -head) * 0.52;
		const dynamicSway = (head > 0 ? head * 0.38 : 0) * Math.cos((Math.PI * t) / 800);
		const window = 1 - smoothstep5(1400, durationMs, t);
		const accent = 0.7 * smoothstep5(120, 250, t) * (1 - smoothstep5(1220, 1400, t));
		return (deepLean + dynamicSway + accent) * rollScale * window;
	};

	const evaluateHeadYaw = (t: number): number => evaluateHeadRoll(t) * 0.38;

	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const head = evaluateHeadPitch(t);
		const target = head > 0 ? -head * 0.08 : -head * 0.035;
		const window = 1 - smoothstep5(1500, durationMs, t);
		return target * gain * window;
	};

	const evaluateEyeOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const head = evaluateHeadPitch(t);
		const squint = smoothstep5(1.0, -8.5, head) * 0.94;
		const secondWink = t > 1150 && t < 1350 ? 0.38 * Math.sin(((t - 1150) / 200) * Math.PI) ** 2 : 0;
		return -Math.min(0.94, squint + secondWink) * gain * smoothstep5(0, 120, t) * (1 - smoothstep5(durationMs - 200, durationMs, t));
	};

	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const attack = smoothstep5(0, 520, t);
		const decay = 1 - smoothstep5(1350, durationMs, t);
		return 0.92 * gain * attack * decay;
	};

	return {
		timeline: time,
		channels: {
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.roll": offset(during(whole, (t) => evaluateHeadRoll(bodyTime(t)) * 0.22 - evaluateHeadRoll(t))),
			"torso.yaw": offset(during(whole, (t) => evaluateHeadYaw(bodyTime(t)) * 0.22 - evaluateHeadYaw(t))),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

export default cuteNod;
