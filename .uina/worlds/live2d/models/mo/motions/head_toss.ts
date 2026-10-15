import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline } from "../../../authoring/curves.js";

function smoothstep5(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 物理程序化“爆发式干脆超大甩头 赌气定格 偷瞄抓包 傲娇回正”（时长 3000ms）。
 *
 * 核心 VTuber 萌点与动力学：
 * 1. 【爆发式极限超大甩头 (135ms 瞬态过冲 11.75°，干脆回弹定格 11.35°)】：
 *    “哼！才不理你呢！”—瞬间在 135ms 内极速爆发甩头至 11.75° 峰值（接近 12° 物理极限），
 *    随后在 135~190ms 像打到机械止动一样干脆阻尼过冲回弹并死死定格在 11.35°，打击感与干脆度拉满！
 * 2. 【超大幅傲娇下巴高昂 (+7.8°) 与极限侧头贴肩 (+9.6°)】：
 *    甩头瞬间头颈侧倒贴肩 (Roll 9.6°)，下巴高高扬起 (Pitch 7.8°)，傲慢与娇嗔张力拉满；
 * 3. 【身体滞后的轻微反扭 (Torso Yaw 约 -1.8°)】：
 *    身体晚 70ms 支撑甩头，保留头颈转向的辨识度；
 * 4. 【核心灵魂：反向偷瞄抓包 (Gaze X -0.82)】：
 *    在 1120~1850ms 头部依然傲娇别着，但眼珠闪电溜过来偷看观众！被抓包瞬间惊慌微眨眼，嘴角微抿羞恼紧绷；
 * 5. 【慢悠悠傲娇收正】：
 *    假装若无其事地慢吞吞回正中立。
 */
export const headToss: ActionAuthoring = (rng) => {
	const gain = 0.98 + rng() * 0.02;
	const turnDir = rng() > 0.5 ? 1 : -1;

	const durationMs = 3000;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");

	// 1. 头部偏航 (Head Yaw)：0~135ms 极速猛甩至 11.75°，135~190ms 干脆回弹定格至 11.35°，190~1950ms 别头定格，1950~3000ms 傲娇缓收
	const peakYaw = 11.75 * turnDir * gain;
	const holdYaw = 11.35 * turnDir * gain;
	const settleYaw = 10.8 * turnDir * gain;

	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 135) {
			const u = smoothstep5(0, 135, t);
			return peakYaw * u;
		}
		if (t < 190) {
			const v = smoothstep5(135, 190, t);
			return peakYaw - (peakYaw - holdYaw) * v;
		}
		if (t < 1950) {
			const p = smoothstep5(190, 1950, t);
			return holdYaw - (holdYaw - settleYaw) * p;
		}
		const u = smoothstep5(1950, durationMs, t);
		return settleYaw * (1 - u);
	};

	// 2. 头部俯仰 (Pitch)：甩头时下巴极高傲慢昂起 (+7.8° 峰值，+7.2° 定格)
	const peakPitch = 7.8 * gain;
	const holdPitch = 7.2 * gain;
	const settlePitch = 6.6 * gain;

	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 135) {
			const u = smoothstep5(0, 135, t);
			return peakPitch * u;
		}
		if (t < 190) {
			const v = smoothstep5(135, 190, t);
			return peakPitch - (peakPitch - holdPitch) * v;
		}
		if (t < 1950) {
			const p = smoothstep5(190, 1950, t);
			return holdPitch - (holdPitch - settlePitch) * p;
		}
		const u = smoothstep5(1950, durationMs, t);
		return settlePitch * (1 - u);
	};

	// 3. 头部侧倾 (Roll)：甩头时伴随超大幅娇蛮侧偏 (+9.6° 峰值，贴肩侧头，傲娇感满格)
	const peakRoll = 9.6 * turnDir * gain;
	const holdRoll = 9.2 * turnDir * gain;
	const settleRoll = 8.6 * turnDir * gain;

	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 135) {
			const u = smoothstep5(0, 135, t);
			return peakRoll * u;
		}
		if (t < 190) {
			const v = smoothstep5(135, 190, t);
			return peakRoll - (peakRoll - holdRoll) * v;
		}
		if (t < 1950) {
			const p = smoothstep5(190, 1950, t);
			return holdRoll - (holdRoll - settleRoll) * p;
		}
		const u = smoothstep5(1950, durationMs, t);
		return settleRoll * (1 - u);
	};

	// 4. 身体晚70ms轻轻反扭，保留甩头力度但不把整个上身一起甩出去。
	const bodyReturn = (t: number): number => 1 - smoothstep5(2750, durationMs, t);
	const evaluateTorsoYaw = (t: number): number => {
		return -evaluateHeadYaw(t - 70) * 0.16 * bodyReturn(t) - evaluateHeadYaw(t);
	};
	const evaluateTorsoRoll = (t: number): number => {
		return -evaluateHeadRoll(t - 70) * 0.12 * bodyReturn(t) - evaluateHeadRoll(t);
	};
	const evaluateTorsoPitch = (t: number): number => {
		return evaluateHeadPitch(t - 70) * 0.14 * bodyReturn(t) - evaluateHeadPitch(t);
	};

	// 5. 头部依然别着，视线反向偷看；不把眼球持续推到边缘。
	const evaluateGazeX = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		// 眼睛先在90ms内甩开，头部随后到达峰值。
		if (t < 950) {
			const u = smoothstep5(0, 90, t);
			return 0.82 * turnDir * u;
		}
		// 950~1120ms 眼球闪电眼跳反转抓包观众！
		if (t < 1120) {
			const u = smoothstep5(950, 1120, t);
			return (0.82 + (-0.82 - 0.82) * u) * turnDir;
		}
		// 1120~1850ms 偷瞄观众。
		if (t < 1850) {
			return -0.82 * turnDir;
		}
		// 1850~2100ms 视线快速回中
		if (t < 2100) {
			const u = smoothstep5(1850, 2100, t);
			return -0.82 * turnDir * (1 - u);
		}
		return 0;
	};

	// 6. 偷瞄被抓包瞬间的惊慌小眨眼 (1350~1550ms)
	const evaluateEyeOpen = (t: number): number => {
		if (t >= 1350 && t < 1550) {
			const u = t < 1450 ? smoothstep5(1350, 1450, t) : 1 - smoothstep5(1450, 1550, t);
			return -0.75 * u;
		}
		return 0;
	};

	// 7. 嘴角表情：前期傲娇嘟嘴，偷瞄抓包时羞恼紧绷 (0.42)，收正时淡出
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 1100) return 0.22 * gain * smoothstep5(0, 180, t);
		if (t < 2000) {
			const p = smoothstep5(1100, 1300, t) * (1 - smoothstep5(1800, 2000, t));
			return (0.22 + 0.42 * p) * gain;
		}
		const u = smoothstep5(2000, durationMs, t);
		return 0.22 * gain * (1 - u);
	};

	return {
		timeline: time,
		channels: {
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

/**
 * 变体：【娇蛮气鼓鼓甩头款】(Pouting Tsundere Head Toss Variant，时长 3000ms)
 * 伴随气鼓鼓小撅嘴 (mouth.open: 0.14, form: 0.18) 与耸肩体态，气呼呼猛甩头别过脸！
 */
export const headTossPoutVariant: ActionAuthoring = (rng) => {
	const gain = 0.98 + rng() * 0.02;
	const turnDir = rng() > 0.5 ? -1 : 1; // 默认向另一侧甩

	const durationMs = 3000;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");

	const peakYaw = 11.75 * turnDir * gain;
	const holdYaw = 11.35 * turnDir * gain;
	const settleYaw = 10.8 * turnDir * gain;

	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 135) {
			const u = smoothstep5(0, 135, t);
			return peakYaw * u;
		}
		if (t < 190) {
			const v = smoothstep5(135, 190, t);
			return peakYaw - (peakYaw - holdYaw) * v;
		}
		if (t < 1850) {
			const p = smoothstep5(190, 1850, t);
			return holdYaw - (holdYaw - settleYaw) * p;
		}
		const u = smoothstep5(1850, durationMs, t);
		return settleYaw * (1 - u);
	};

	const peakPitch = 7.5 * gain;
	const holdPitch = 7.0 * gain;
	const settlePitch = 6.4 * gain;

	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 135) {
			const u = smoothstep5(0, 135, t);
			return peakPitch * u;
		}
		if (t < 190) {
			const v = smoothstep5(135, 190, t);
			return peakPitch - (peakPitch - holdPitch) * v;
		}
		if (t < 1850) {
			const p = smoothstep5(190, 1850, t);
			return holdPitch - (holdPitch - settlePitch) * p;
		}
		const u = smoothstep5(1850, durationMs, t);
		return settlePitch * (1 - u);
	};

	const peakRoll = 9.5 * turnDir * gain;
	const holdRoll = 9.1 * turnDir * gain;
	const settleRoll = 8.5 * turnDir * gain;

	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 135) {
			const u = smoothstep5(0, 135, t);
			return peakRoll * u;
		}
		if (t < 190) {
			const v = smoothstep5(135, 190, t);
			return peakRoll - (peakRoll - holdRoll) * v;
		}
		if (t < 1850) {
			const p = smoothstep5(190, 1850, t);
			return holdRoll - (holdRoll - settleRoll) * p;
		}
		const u = smoothstep5(1850, durationMs, t);
		return settleRoll * (1 - u);
	};

	const bodyReturn = (t: number): number => 1 - smoothstep5(2750, durationMs, t);
	const evaluateTorsoYaw = (t: number): number => -evaluateHeadYaw(t - 70) * 0.16 * bodyReturn(t) - evaluateHeadYaw(t);
	const evaluateTorsoRoll = (t: number): number => -evaluateHeadRoll(t - 70) * 0.12 * bodyReturn(t) - evaluateHeadRoll(t);
	const evaluateTorsoPitch = (t: number): number => evaluateHeadPitch(t - 70) * 0.14 * bodyReturn(t) - evaluateHeadPitch(t);

	const evaluateGazeX = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 950) {
			const u = smoothstep5(0, 90, t);
			return 0.82 * turnDir * u;
		}
		if (t < 1120) {
			const u = smoothstep5(950, 1120, t);
			return (0.82 + (-0.82 - 0.82) * u) * turnDir;
		}
		if (t < 1850) {
			return -0.82 * turnDir;
		}
		if (t < 2100) {
			const u = smoothstep5(1850, 2100, t);
			return -0.82 * turnDir * (1 - u);
		}
		return 0;
	};

	const evaluateEyeOpen = (t: number): number => {
		if (t >= 1350 && t < 1550) {
			const u = t < 1450 ? smoothstep5(1350, 1450, t) : 1 - smoothstep5(1450, 1550, t);
			return -0.75 * u;
		}
		return 0;
	};

	// 气鼓鼓小撅嘴
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 1850) return 0.18 * gain * smoothstep5(0, 180, t);
		const u = smoothstep5(1850, durationMs, t);
		return 0.18 * gain * (1 - u);
	};

	const evaluateMouthOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 1850) {
			const u = smoothstep5(0, 135, t);
			return 0.14 * gain * u;
		}
		const u = smoothstep5(1850, durationMs, t);
		return 0.14 * gain * (1 - u);
	};

	return {
		timeline: time,
		channels: {
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"torso.yaw": offset(during(whole, evaluateTorsoYaw)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"gaze.x": offset(during(whole, evaluateGazeX)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
			"mouth.open": offset(during(whole, evaluateMouthOpen)),
		},
	};
};

export default headToss;
