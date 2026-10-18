import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline, smoothstep } from "../../../authoring/curves.js";

/**
 * 物理程序化“得意昂头高傲审视”（时长 2700ms 舒缓拉长）。
 *
 * 核心 VTuber 萌点与动力学：
 * 1. 【极致大昂颌 (+9.3° 满格张力)】：下巴高高扬起，小猫咪得意忘形、居高临下；
 * 2. 【俯视傲睨眼神 (Gaze Y -0.78)】：眼神先向下审视，头部与身体随后逐步跟上；
 * 3. 【狐狸月牙眯眼笑 (Eyes Open -0.68)】：双眼眯成得意皎黠月牙弧；
 * 4. 【自得轻哼微颤音】：在 1600ms 的超长峰值定格中伴随轻哼微颤与得逞大笑；
 * 5. 【胸腔挺拔与躯干反相支撑】：挺胸抬头，躯干直立不后倾。
 */
export const chinUp: ActionAuthoring = (rng) => {
	const gain = 0.97 + rng() * 0.05;
	const sideDir = rng() > 0.5 ? 1 : -1;

	const durationMs = 2700;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");
	const humWindow = (t: number): number => smoothstep(420, 650, t) * (1 - smoothstep(1750, 1950, t));

	// 1. 头部俯仰 (Pitch)：高高昂头至 +9.3°
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		// 0~420ms: 扬头起势
		if (t < 420) {
			const u = smoothstep(60, 420, t);
			return 9.3 * gain * u;
		}
		// 420~1950ms: 超长得意自得轻哼定格 (足足 1500ms)
		if (t < 1950) {
			const hum = 0.45 * Math.sin(((t - 420) / 1000) * 2 * Math.PI * 1.5) * humWindow(t);
			return (9.3 + hum) * gain;
		}
		// 1950~2700ms: 缓和收回
		const u = smoothstep(1950, durationMs, t);
		return 9.3 * gain * (1 - u);
	};

	// 2. 头部侧倾 (Roll)：傲气侧偏 (-4.8°)
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const pitch = evaluateHeadPitch(t);
		return -0.52 * pitch * sideDir;
	};

	// 3. 头部偏航 (Yaw)：轻微侧视 (+4.2°)
	const evaluateHeadYaw = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const pitch = evaluateHeadPitch(t);
		return 0.45 * pitch * sideDir;
	};

	// 4. 身体晚80ms轻跟随，offset扣除头部跟随，保持挺胸而非整块后仰。
	const bodyReturn = (t: number): number => 1 - smoothstep(2450, durationMs, t);
	const evaluateTorsoPitch = (t: number): number => {
		return evaluateHeadPitch(t - 80) * 0.18 * bodyReturn(t) - evaluateHeadPitch(t);
	};
	const evaluateTorsoRoll = (t: number): number => {
		return evaluateHeadRoll(t - 80) * 0.15 * bodyReturn(t) - evaluateHeadRoll(t);
	};
	const evaluateTorsoYaw = (t: number): number => {
		return evaluateHeadYaw(t - 80) * 0.15 * bodyReturn(t) - evaluateHeadYaw(t);
	};

	// 5. 眼神先于昂头向下审视，留出眼球边缘余量。
	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		return -0.78 * smoothstep(0, 300, t) * (1 - smoothstep(1900, durationMs, t));
	};

	// 6. 狐狸眯眼笑：双眼笑眯至 0.32 (偏置 -0.68)
	const evaluateEyeOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const pitch = evaluateHeadPitch(t);
		return -(pitch / 9.3) * 0.68 * gain;
	};

	// 7. 嘴角大扬展开展颜得逞大笑 (0.95) 与得瑟轻张嘴 (0.22)
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		const pitch = evaluateHeadPitch(t);
		return Math.min(0.95, (pitch / 9.3) * 0.95);
	};
	const evaluateMouthOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 420) return 0;
		if (t < 1950) {
			const hum = 0.08 * Math.sin(((t - 420) / 1000) * 2 * Math.PI * 1.5) * humWindow(t);
			return Math.max(0, (0.16 + hum) * smoothstep(420, 620, t) * gain);
		}
		const u = smoothstep(1950, 2400, t);
		return 0.16 * gain * (1 - u);
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
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
			"mouth.open": offset(during(whole, evaluateMouthOpen)),
		},
	};
};

export default chinUp;
