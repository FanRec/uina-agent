import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, offset, timeline } from "../../../authoring/curves.js";

function smoothstep5(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 物理程序化“经典大小姐·傲娇小恶魔嚯嚯嚯大笑”(Smug Laugh / Ohohoho，时长 2600ms)。
 *
 * 核心 VTuber 萌点与动力学重塑：
 * 1. 【告别机械与僵硬 (Vibrant Laughter Resonance)】：
 *    - 摆脱原先慢速吞气鱼嘴与僵木偶姿态，采用经典动漫大小姐欢快清脆的 5 段“嚯-嚯-嚯-嚯-嚯！”笑浪节奏 (3.3Hz)；
 * 2. 【大小姐起手式高昂后仰与胸腔共振 (Ojou-sama Posture & Recoil)】：
 *    - 头部向斜上方高傲抬颌 (+7.8°) 并娇蛮侧偏 (+6.2°)，躯干挺胸自信后拱；
 *    - 每一下笑声伴随胸腔与头部的鲜活节奏起伏微震 (Pitch ±1.6°、Roll 娇憨微晃)，生动逼真；
 * 3. 【狐狸月牙眯眼与睥睨视线 (Smiling Eyes & Condescending Gaze)】：
 *    - 双眼得意笑眯成月牙弯缝 (-0.72)，每一下笑声眼角更开心地紧闭颤动 (-0.86)，目光从眼睫毛下居高临下向下睥睨 (-0.38)；
 * 4. 【得逞大笑猫猫嘴角 (Mouth Form 0.95)】与从容优雅收正。
 */
export const smugLaugh: ActionAuthoring = (rng) => {
	const gain = 0.96 + rng() * 0.08;
	const sideDir = rng() > 0.5 ? 1 : -1;

	const durationMs = 2600;
	const time = timeline(durationMs);
	const whole = time.span("start", "end");

	// 1. 头部俯仰：起式高傲昂头 -> 5 段欢快笑浪节奏震颤 -> 优雅缓收
	const evaluateHeadPitch = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 450) {
			const u = smoothstep5(0, 450, t);
			return 7.8 * gain * u;
		}
		if (t < 1950) {
			const u = (t - 450) / 1500;
			// 5 段清脆连环笑浪 (3.33Hz)
			const laughPulse = Math.sin(u * 5 * 2 * Math.PI);
			const env = Math.sin(Math.PI * u);
			return (7.8 + 1.6 * laughPulse * env) * gain;
		}
		const u = smoothstep5(1950, durationMs, t);
		return 7.8 * gain * (1 - u);
	};

	// 2. 头部侧倾：娇蛮高昂侧倒 (+6.2°)，笑声中伴随身体欢快微晃
	const evaluateHeadRoll = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 450) {
			const u = smoothstep5(0, 450, t);
			return 6.2 * sideDir * gain * u;
		}
		if (t < 1950) {
			const u = (t - 450) / 1500;
			const rollWave = 0.8 * Math.sin(u * 2.5 * 2 * Math.PI);
			const env = Math.sin(Math.PI * u);
			return (6.2 + rollWave * env) * sideDir * gain;
		}
		const u = smoothstep5(1950, durationMs, t);
		return 6.2 * sideDir * gain * (1 - u);
	};

	// 3. 头部偏航：轻度偏转配合侧倾
	const evaluateHeadYaw = (t: number): number => evaluateHeadRoll(t) * 0.35;

	// 4. 躯干解耦与呼吸共振：胸腔挺立后拱，随笑浪欢快起伏
	const evaluateTorsoPitch = (t: number): number => -evaluateHeadPitch(t) * 0.82;
	const evaluateTorsoRoll = (t: number): number => -evaluateHeadRoll(t) * 0.78;

	// 5. 睥睨视线：下巴虽高高抬起，眼神居高临下俯视观众 (-0.38)
	const evaluateGazeY = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 450) {
			const u = smoothstep5(0, 450, t);
			return -0.38 * u;
		}
		if (t < 1950) {
			return -0.38;
		}
		const u = smoothstep5(1950, durationMs, t);
		return -0.38 * (1 - u);
	};

	// 6. 得意狐狸月牙眯眼笑 (-0.72 ~ -0.86)
	const evaluateEyeOpen = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 400) {
			const u = smoothstep5(0, 400, t);
			return -0.72 * gain * u;
		}
		if (t < 1950) {
			const u = (t - 400) / 1550;
			// 每一下笑声时眼睑随之轻柔更紧密眯起
			const flutter = 0.14 * Math.max(0, Math.sin(u * 5 * 2 * Math.PI)) * Math.sin(Math.PI * u);
			return (-0.72 - flutter) * gain;
		}
		const u = smoothstep5(1950, durationMs, t);
		return -0.72 * gain * (1 - u);
	};

	// 7. 经典大小姐“嚯—嚯—嚯—嚯—嚯！”节奏笑浪开合 (open: 0~0.60，5段连环清脆开合)
	const evaluateMouthOpen = (t: number): number => {
		if (t < 450 || t >= 1950) return 0;
		const u = (t - 450) / 1500;
		// 5 段活泼连环开合
		const laughWave = Math.sin(u * 5 * 2 * Math.PI);
		const positiveWave = Math.max(0, laughWave) ** 1.4;
		const env = Math.sin(Math.PI * u);
		return (0.08 * env + 0.52 * positiveWave * env) * gain;
	};

	// 8. 得逞大笑嘴角 (+0.95)
	const evaluateMouthForm = (t: number): number => {
		if (t <= 0 || t >= durationMs) return 0;
		if (t < 400) {
			const u = smoothstep5(0, 400, t);
			return 0.95 * gain * u;
		}
		if (t < 2050) {
			return 0.95 * gain;
		}
		const u = smoothstep5(2050, durationMs, t);
		return 0.95 * gain * (1 - u);
	};

	return {
		timeline: time,
		channels: {
			"head.pitch": offset(during(whole, evaluateHeadPitch)),
			"head.roll": offset(during(whole, evaluateHeadRoll)),
			"head.yaw": offset(during(whole, evaluateHeadYaw)),
			"torso.pitch": offset(during(whole, evaluateTorsoPitch)),
			"torso.roll": offset(during(whole, evaluateTorsoRoll)),
			"gaze.y": offset(during(whole, evaluateGazeY)),
			"eyes.left.open": offset(during(whole, evaluateEyeOpen)),
			"eyes.right.open": offset(during(whole, evaluateEyeOpen)),
			"mouth.open": offset(during(whole, evaluateMouthOpen)),
			"mouth.form": offset(during(whole, evaluateMouthForm)),
		},
	};
};

export default smugLaugh;
