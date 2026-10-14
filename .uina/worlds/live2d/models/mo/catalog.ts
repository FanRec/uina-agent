import type { ModelRig } from "../../adapter/rig.js";
import type { CatalogSnapshot, CatalogSource } from "../../authoring/catalog.js";
import { compileCatalog } from "../../authoring/catalog.js";
import { absolute, elastic, keys, motion, offset, smooth, type Channel, type Curve } from "../../authoring/motion.js";
import { MO_MODEL_ID } from "../rig-loader.js";

/**
 * MO 动作目录：运动连续段由公式、回弹和共享相位参数生成；表情节奏、眼睑和需要精确落点的视线仍用关键点。
 * 相关头身轴共享 bake 参数，避免随机变化拆散同一个动作的协调关系。
 */

type Pts = readonly (readonly [number, number])[];
type ChannelTuple = readonly [string, Channel];

const variation = (rng: () => number, spread = 0.06): number => 1 + (rng() * 2 - 1) * spread;
const phaseWave = (t: number, durationMs: number, cycles: number, phase = 0): number => Math.sin((2 * Math.PI * cycles * t) / durationMs + phase);
const windowedOscillation = (t: number, durationMs: number, cycles: number, phase = 0, decay = 0.6): number => {
	const u = Math.max(0, Math.min(1, t / durationMs));
	const attack = smooth(u / 0.08);
	const release = 1 - smooth((u - 0.78) / 0.22);
	return attack * release * phaseWave(u, 1, cycles, phase) * Math.exp(-decay * u);
};
const pose =
	(value: number, startMs: number, attackMs: number, holdMs: number, releaseMs: number): Curve =>
	(t) =>
		value * smooth((t - startMs) / attackMs) * (1 - smooth((t - startMs - attackMs - holdMs) / releaseMs));

/** 关键点速记：扁平 x/y 对 → 点表，留给眨眼、视线拐点等需要精确标定的通道。 */
const pts = (...flat: readonly number[]): Pts => {
	if (flat.length < 4 || flat.length % 2 !== 0) throw new Error(`关键帧速记需要成对的 x/y（至少两对）: ${flat.length}`);
	const points: [number, number][] = [];
	for (let index = 0; index < flat.length; index += 2) {
		const [x, y] = [flat[index]!, flat[index + 1]!];
		if (![x, y].every(Number.isFinite)) throw new Error(`非法关键点: pts[${index / 2}]`);
		points.push([x, y]);
	}
	return points;
};

/** bake 期幅度纹理：offset 通道按 (1±spread) 随机增益。 */
const texture = (points: Pts, rng: () => number, spread = 0.06): Channel => {
	const gain = variation(rng, spread);
	const base = keys(points);
	return offset((t) => base(t) * gain);
};

/** absolute 目标通道（眼睑/口型/视线），逐字标定。 */
const tgt = (points: Pts): Channel => absolute(keys(points));

const head = (axis: "pitch" | "yaw" | "roll", points: Pts, rng: () => number): ChannelTuple => [`head.${axis}`, texture(points, rng)];
const headCurve = (axis: "pitch" | "yaw" | "roll", curve: Curve): ChannelTuple => [`head.${axis}`, offset(curve)];
const torsoCurve = (axis: "pitch" | "yaw" | "roll", curve: Curve): ChannelTuple => [`torso.${axis}`, offset(curve)];
const eyes = (side: "left" | "right", points: Pts): ChannelTuple => [`eyes.${side}.open`, tgt(points)];
const gaze = (axis: "x" | "y", points: Pts): ChannelTuple => [`gaze.${axis}`, tgt(points)];
const gazeCurve = (axis: "x" | "y", curve: Curve): ChannelTuple => [`gaze.${axis}`, absolute(curve)];
const mouth = (axis: "open" | "form", points: Pts): ChannelTuple => [`mouth.${axis}`, tgt(points)];
const mouthCurve = (axis: "open" | "form", curve: Curve): ChannelTuple => [`mouth.${axis}`, absolute(curve)];
/** 双侧眼睑共享同一条曲线实例：左右开合逐帧全等由构造保证。 */
const eyesBoth = (points: Pts): ChannelTuple[] => {
	const curve = tgt(points);
	return [
		["eyes.left.open", curve],
		["eyes.right.open", curve],
	];
};
const channels = (...tuples: ChannelTuple[]) => Object.fromEntries(tuples);

/** 头身错拍：共享一个随机相位与强度，轴间相差固定相位以保留动作整体性。 */
type SwayProfile = {
	durationMs: number;
	phase: number;
	torsoRoll: number;
	torsoYaw: number;
	torsoPitch: number;
	headRoll: number;
	headYaw: number;
	headPitch: number;
	gazeX: number;
	gazeY: number;
	blinkAt: number;
};
const swayPhrase = (profile: SwayProfile) =>
	motion(profile.durationMs, (rng) => {
		const gain = variation(rng, 0.08);
		const phase = profile.phase + (rng() - 0.5) * 0.14;
		const body =
			(amplitude: number, lag: number): Curve =>
			(t) =>
				amplitude * gain * windowedOscillation(t, profile.durationMs, 1.15, phase + lag, 0.45);
		const look =
			(amplitude: number, lag: number): Curve =>
			(t) =>
				amplitude * windowedOscillation(t, profile.durationMs, 1.15, phase + lag, 0.35);
		const blink = profile.blinkAt;
		return channels(
			torsoCurve("roll", body(profile.torsoRoll, 0)),
			torsoCurve("yaw", body(profile.torsoYaw, 0.48)),
			torsoCurve("pitch", body(profile.torsoPitch, 1.1)),
			headCurve("roll", body(profile.headRoll, 0.8)),
			headCurve("yaw", body(profile.headYaw, 1.2)),
			headCurve("pitch", body(profile.headPitch, 1.65)),
			gazeCurve("x", look(profile.gazeX, 1.9)),
			gazeCurve("y", look(profile.gazeY, 2.25)),
			...eyesBoth(pts(0, 1, blink - 110, 1, blink, 0.08, blink + 120, 0.08, blink + 220, 1, profile.durationMs, 1)),
		);
	});

const MO_SWAY_PHRASES = [
	swayPhrase({
		durationMs: 2600,
		phase: -0.25,
		torsoRoll: 5.4,
		torsoYaw: 2.8,
		torsoPitch: -1.8,
		headRoll: -2.5,
		headYaw: 2.8,
		headPitch: 1.5,
		gazeX: 0.62,
		gazeY: 0.28,
		blinkAt: 1780,
	}),
	swayPhrase({
		durationMs: 2850,
		phase: Math.PI - 0.3,
		torsoRoll: -5.1,
		torsoYaw: -3.0,
		torsoPitch: 1.7,
		headRoll: 2.6,
		headYaw: -2.7,
		headPitch: -1.4,
		gazeX: -0.68,
		gazeY: -0.3,
		blinkAt: 1040,
	}),
	swayPhrase({
		durationMs: 2450,
		phase: Math.PI / 2,
		torsoRoll: 3.0,
		torsoYaw: 5.0,
		torsoPitch: -2.7,
		headRoll: -3.1,
		headYaw: -4.8,
		headPitch: 2.6,
		gazeX: 0.76,
		gazeY: 0.38,
		blinkAt: 1870,
	}),
	swayPhrase({
		durationMs: 3050,
		phase: -Math.PI / 2,
		torsoRoll: -3.8,
		torsoYaw: -2.8,
		torsoPitch: -3.5,
		headRoll: 2.1,
		headYaw: 4.2,
		headPitch: 4.4,
		gazeX: -0.72,
		gazeY: -0.4,
		blinkAt: 730,
	}),
];

export const MO_CATALOG_SOURCE: CatalogSource = {
	motions: {
		nod: {
			description: "舒缓Q弹肯定点头：极限深潜软着陆、果冻大反弹与无顿挫缓收",
			aliases: ["点头"],
			playback: { fadeInMs: 50, fadeOutMs: 100 },
			motion: motion(950, (rng) => {
				const gain = variation(rng);
				const dive = elastic(640, 9.8, 1);
				const settle = elastic(310, 4.8, 1);
				return channels(
					headCurve("pitch", (t) => gain * (dive(t) + settle(t - 640))),
					headCurve("roll", (t) => gain * 2.6 * windowedOscillation(t, 950, 1.5, 2.3, 0.7)),
				);
			}),
			variants: [
				motion(850, (rng) => {
					const gain = variation(rng);
					const dive = elastic(600, 6.2, 1);
					const settle = elastic(250, 3, 1);
					return channels(
						headCurve("pitch", (t) => gain * (dive(t) + settle(t - 600))),
						headCurve("roll", (t) => gain * 1.8 * windowedOscillation(t, 850, 1.4, 2.3, 0.9)),
					);
				}),
			],
		},
		shake: {
			description: "丝滑大波浪撒娇摇头：满格钟摆摆幅、离心反向倾角与羽毛般长尾减速",
			aliases: ["摇头"],
			motion: motion(2300, (rng) => {
				const gain = variation(rng);
				return channels(
					headCurve("yaw", (t) => gain * 13 * windowedOscillation(t, 2300, 3, -Math.PI / 2, 0.28)),
					headCurve("roll", (t) => gain * 5.6 * windowedOscillation(t, 2300, 2.35, -Math.PI, 0.42)),
				);
			}),
		},
		wink: {
			description: "暴击歪头眨眼：大倾角立体贴肩、元气月牙笑与长定格电眼",
			aliases: ["眨眼"],
			playback: { fadeInMs: 60, fadeOutMs: 140 },
			motion: motion(840, (rng) => {
				const gain = variation(rng);
				const lean = pose(1, 0, 180, 360, 300);
				return channels(
					headCurve("roll", (t) => gain * 9.8 * lean(t)),
					headCurve("pitch", (t) => gain * -1.8 * lean(t)),
					headCurve("yaw", (t) => gain * 3.2 * lean(t)),
					eyes("left", pts(0, 1, 100, 0.8, 180, 0, 540, 0, 700, 1, 840, 1)),
					eyes("right", pts(0, 1, 840, 1)),
					mouthCurve("form", (t) => 0.95 * lean(t)),
				);
			}),
		},
		curious: {
			description: "贴肩猫猫大歪头：满格舒适歪头、收下巴立体肉感、大眼抬眸超长定格与慢悠悠回正",
			aliases: ["歪头"],
			playback: { fadeInMs: 80, fadeOutMs: 150 },
			motion: motion(1750, (rng) => {
				const gain = variation(rng);
				const tilt = pose(1, 0, 220, 1130, 400);
				const look = pose(1, 0, 180, 1170, 400);
				return channels(
					headCurve("roll", (t) => gain * 10 * tilt(t)),
					headCurve("pitch", (t) => gain * -2.2 * tilt(t)),
					headCurve("yaw", (t) => gain * 4.8 * tilt(t)),
					gazeCurve("y", (t) => 0.82 * look(t)),
					gazeCurve("x", (t) => -0.52 * look(t)),
					...eyesBoth(pts(0, 1, 1750, 1)),
					mouthCurve("form", (t) => 0.48 * tilt(t)),
				);
			}),
		},
		chin_up: {
			description: "得意昂头：满格高扬傲视、轻哼起伏狐狸笑与高位超长停滞",
			motion: motion(2300, (rng) => {
				const gain = variation(rng);
				const lift = pose(1, 0, 350, 1250, 700);
				const smirk = pose(1, 0, 300, 1350, 650);
				return channels(
					headCurve("pitch", (t) => gain * (10 * lift(t) + 0.55 * windowedOscillation(t - 350, 1250, 1.5, -Math.PI / 2, 0.8))),
					headCurve("roll", (t) => gain * -3.8 * lift(t)),
					headCurve("yaw", (t) => gain * 2.8 * lift(t)),
					gaze("y", pts(0, 0.15, 150, 0.35, 350, -0.85, 1650, -0.85, 2300, 0.15)),
					...eyesBoth(pts(0, 1, 350, 0.38, 1650, 0.38, 2300, 1)),
					mouthCurve("form", (t) => 0.98 * smirk(t)),
				);
			}),
		},
		head_toss: {
			description: "傲娇大甩头：爆发满格甩头、别开侧颜长定格与偷瞄对视",
			motion: motion(2400, (rng) => {
				const gain = variation(rng);
				const toss = pose(1, 0, 280, 1370, 750);
				return channels(
					headCurve("yaw", (t) => gain * 12 * toss(t)),
					headCurve("pitch", (t) => gain * 4.5 * toss(t)),
					headCurve("roll", (t) => gain * 5.2 * toss(t)),
					gaze("x", pts(0, 0, 160, 0.9, 650, 0.9, 850, -0.85, 1450, -0.85, 1600, 0.85, 2000, 0.3, 2400, 0)),
					mouth("form", pts(0, 0, 280, 0.15, 850, 0.45, 1600, 0.15, 2400, 0)),
				);
			}),
		},
		alert: {
			description: "凝神警觉：视线光速锁定、身体挺拔与超长屏息定格",
			motion: motion(1950, (rng) => {
				const gain = variation(rng);
				const brace = pose(1, 0, 110, 1390, 450);
				const lock = pose(1, 0, 70, 1430, 450);
				return channels(
					headCurve("yaw", (t) => gain * 8.5 * brace(t)),
					headCurve("pitch", (t) => gain * 3 * brace(t)),
					headCurve("roll", (t) => gain * 2.8 * brace(t)),
					gazeCurve("x", (t) => 0.95 * lock(t)),
					gazeCurve("y", (t) => 0.28 * lock(t)),
					...eyesBoth(pts(0, 1, 1950, 1)),
				);
			}),
		},
		startle: {
			description: "吓一跳：极速缩脖蓄力、触电爆发猛后仰、惨叫大张嘴与长尾平复",
			playback: { fadeInMs: 15, fadeOutMs: 250, resetVelocity: true },
			motion: motion(1100, (rng) => {
				const gain = variation(rng);
				const crouch = elastic(70, 5.2, 1);
				const burst = pose(1, 70, 70, 180, 500);
				const rollStrike = pose(1, 80, 60, 100, 420);
				const recoil = (t: number) => windowedOscillation(t - 480, 620, 1.15, Math.PI / 2, 0.8);
				return channels(
					headCurve("pitch", (t) => gain * (crouch(t) + 9.8 * burst(t) - 1.8 * recoil(t))),
					headCurve("roll", (t) => gain * (5 * rollStrike(t) + 1.4 * recoil(t))),
					...eyesBoth(pts(0, 1, 35, 0.1, 120, 1, 1100, 1)),
					mouth("open", pts(0, 0, 150, 0, 220, 0.75, 550, 0.7, 750, 0, 1100, 0)),
					mouth("form", pts(0, 0, 220, 0.2, 750, 0, 1100, 0)),
				);
			}),
		},
		surprise: {
			description: "惊讶一顿：后仰石化超长停滞、大张嘴发愣与从容回神",
			motion: motion(2100, (rng) => {
				const gain = variation(rng);
				const recoil = pose(1, 0, 180, 1420, 500);
				const gasp = pose(1, 150, 100, 1250, 250);
				return channels(
					headCurve("pitch", (t) => gain * 6.8 * recoil(t)),
					headCurve("roll", (t) => gain * -3 * recoil(t)),
					gazeCurve("x", () => 0),
					gazeCurve("y", (t) => 0.15 + 0.35 * recoil(t)),
					...eyesBoth(pts(0, 1, 2100, 1)),
					mouthCurve("open", (t) => 0.65 * gasp(t)),
				);
			}),
		},
		glance: {
			description: "偷瞄一眼：极速甩满眼角、缩颈暗中观察长定格与狡黠溜回",
			motion: motion(800, (rng) => {
				const gain = variation(rng);
				const eyesToSide = pose(1, 0, 40, 520, 240);
				const headPitch = pose(1, 0, 120, 440, 240);
				const headTurn = pose(1, 0, 150, 410, 240);
				return channels(
					gazeCurve("x", (t) => 0.98 * eyesToSide(t)),
					gazeCurve("y", (t) => 0.22 * eyesToSide(t)),
					headCurve("pitch", (t) => gain * -3.8 * headPitch(t)),
					headCurve("yaw", (t) => gain * 4.2 * headTurn(t)),
					headCurve("roll", (t) => gain * -3 * headTurn(t)),
				);
			}),
		},
		eye_roll: {
			description: "无语望天：极缓后仰叹气、天花板大圆弧滚眼、超长生无可恋定格与慵懒缓降收尾",
			motion: motion(2500, (rng) => {
				const gain = variation(rng);
				const sigh = pose(1, 0, 550, 1050, 900);
				return channels(
					headCurve("pitch", (t) => gain * 8.8 * sigh(t)),
					headCurve("roll", (t) => gain * -4.2 * sigh(t)),
					gaze("y", pts(0, 0.15, 200, 0.15, 550, 0.98, 1550, 0.98, 2500, 0.15)),
					gaze("x", pts(0, 0, 550, -0.3, 900, 0.45, 1300, 0.15, 2500, 0)),
					...eyesBoth(pts(0, 1, 300, 0.45, 1600, 0.45, 2500, 1)),
					mouth("form", pts(0, 0, 300, 0.05, 1600, 0.05, 2500, 0)),
				);
			}),
		},
		double_take: {
			description: "再看一眼：漫不经心收回、呆滞僵住、核爆猛回头与超长定格不敢置信",
			motion: motion(2500, (rng) => {
				const gain = variation(rng);
				const firstLook = pose(1, 0, 120, 230, 230);
				const secondLook = pose(1, 880, 80, 790, 750);
				const firstHeadTurn = pose(1, 0, 180, 220, 180);
				return channels(
					gazeCurve("x", (t) => 0.5 * firstLook(t) + 0.95 * secondLook(t)),
					headCurve("yaw", (t) => gain * (3.5 * firstHeadTurn(t) + 12 * secondLook(t))),
					headCurve("pitch", (t) => gain * 2.8 * secondLook(t)),
					headCurve("roll", (t) => gain * 4.5 * secondLook(t)),
					mouthCurve("open", (t) => 0.55 * secondLook(t)),
					...eyesBoth(pts(0, 1, 2500, 1)),
				);
			}),
		},
		joy_hop: {
			description: "雀跃一弹：深蹲蓄力、腾空月牙笑与软糯Q弹着陆",
			motion: motion(1100, (rng) => {
				const gain = variation(rng);
				const crouch = elastic(240, 5.2, 1);
				const leap = elastic(440, -8.5, 1);
				const landing = elastic(240, 4.8, 1);
				const rebound = elastic(300, -2.5, 1);
				return channels(
					headCurve("pitch", (t) => gain * (crouch(t) + leap(t - 120) + landing(t - 620) + rebound(t - 800))),
					headCurve("roll", (t) => gain * 4 * windowedOscillation(t, 1100, 1.8, -Math.PI / 2, 0.8)),
					...eyesBoth(pts(0, 1, 120, 0.6, 340, 0.1, 520, 0.1, 750, 1, 1100, 1)),
					mouth("form", pts(0, 0, 250, 0.98, 620, 0.98, 1100, 0)),
				);
			}),
			spatial: {
				segments: [
					{ durationMs: 120, delta: { y: -0.015 } },
					{ durationMs: 220, delta: { y: 0.08 } },
					{ durationMs: 280, delta: { y: 0 } },
					{ durationMs: 180, delta: { y: 0.02 } },
					{ durationMs: 300, delta: { y: 0 } },
				],
			},
		},
		petrify: {
			description: "五雷轰顶石化：模型瞬间褪色冷灰石雕、死鱼眼僵死与微裂震颤（不污染背景）",
			aliases: ["石化", "僵死", "灰白"],
			playback: { inhibitAdditives: true },
			motion: motion(4800, (rng) => {
				const gain = variation(rng);
				const statue = pose(1, 0, 150, 3850, 800);
				const crack = (t: number) => windowedOscillation(t, 4800, 9, -Math.PI / 2, 0.5);
				const preparatoryFlinch = elastic(80, 4.5, 1);
				return channels(
					headCurve("pitch", (t) => gain * (preparatoryFlinch(t) + 8.4 * statue(t) + 0.22 * crack(t))),
					headCurve("roll", (t) => gain * (-3.9 * statue(t) + 0.12 * crack(t))),
					headCurve("yaw", (t) => gain * -2.5 * statue(t)),
					gazeCurve("x", () => 0),
					gazeCurve("y", (t) => 0.12 * (1 - smooth((t - 4000) / 800))),
					...eyesBoth(pts(0, 1, 40, 0.2, 150, 1.0, 4000, 1.0, 4400, 0.45, 4800, 1)),
					mouthCurve("open", (t) => 0.48 * statue(t)),
					mouth("form", pts(0, 0, 4800, 0)),
				);
			}),
			spatial: {
				segments: [
					{ durationMs: 150, holdMs: 3850, delta: { y: 0 }, effects: { tint: { r: 110, g: 115, b: 125 } } },
					{ durationMs: 800, delta: { y: 0 } },
				],
			},
		},
		close_up: {
			description: "贴脸破屏特写：镜头急推大头贴、面部下移对齐镜头中央、近距离软萌慢摇晃头与满足缩回",
			aliases: ["贴脸", "凑近", "特写", "怼镜头"],
			motion: motion(4100, (rng) => {
				const gain = variation(rng, 0.04);
				const near = pose(1, 180, 420, 2800, 700);
				const sway = (t: number, cycles: number, phase: number) => windowedOscillation(t - 600, 2800, cycles, phase, 0.3);
				return channels(
					headCurve("pitch", (t) => gain * (3.5 * near(t) + 0.4 * sway(t, 2, -Math.PI / 2))),
					headCurve("roll", (t) => gain * 2.3 * sway(t, 2, -Math.PI / 2)),
					headCurve("yaw", (t) => gain * 1.1 * sway(t, 2, -Math.PI / 2 + 0.55)),
					gazeCurve("x", () => 0),
					gazeCurve("y", (t) => -0.15 * near(t)),
					...eyesBoth(pts(0, 1, 1800, 0.1, 2000, 1, 4100, 1)),
					mouthCurve("form", (t) => 0.9 * near(t)),
					mouth("open", pts(0, 0, 550, 0.22, 1900, 0.28, 3400, 0.22, 4100, 0)),
				);
			}),
			spatial: {
				segments: [
					{ durationMs: 180, delta: { size: -3, y: 0.02 } },
					{ durationMs: 420, holdMs: 2800, delta: { size: 40, y: -1.7, rotation: 1.5 } },
					{ durationMs: 700, delta: { size: 0, y: 0, rotation: 0 } },
				],
			},
		},
		edge_peek: {
			description: "边缘探头偷看：身体大倾角斜藏于屏幕外、探出半张脸露脑袋暗中观察与平滑归正",
			aliases: ["探头", "偷看", "窥视", "扒边"],
			motion: motion(4700, (rng) => {
				const gain = variation(rng);
				const peek = pose(1, 0, 550, 3600, 550);
				return channels(
					headCurve("roll", (t) => gain * -6.5 * peek(t)),
					headCurve("yaw", (t) => gain * 6 * peek(t)),
					headCurve("pitch", (t) => gain * -2 * peek(t)),
					gazeCurve("x", (t) => 0.95 * peek(t)),
					...eyesBoth(pts(0, 1, 550, 1.0, 1600, 1.0, 1750, 0.5, 1900, 1.0, 3100, 1.0, 3250, 0.5, 3400, 1.0, 4700, 1)),
					mouthCurve("form", (t) => 0.4 * peek(t)),
				);
			}),
			spatial: {
				segments: [
					{ durationMs: 550, holdMs: 3600, delta: { x: -0.78, y: -0.16, rotation: 24 } },
					{ durationMs: 550, delta: { x: 0, y: 0, rotation: 0 } },
				],
			},
		},
		spin: {
			description: "华丽自转一圈：屈膝下蹲垂直蓄力、单次缓动整圆飞旋与落地轻巧缓冲",
			aliases: ["转圈", "转个圈", "转圈圈", "旋转"],
			motion: motion(1700, (rng) =>
				channels(head("roll", pts(0, 0, 180, 0, 500, 3.5, 850, -2.5, 1200, 3.0, 1450, -1.0, 1700, 0), rng), head("pitch", pts(0, 0, 180, -3.5, 500, 2.0, 850, 1.0, 1200, -2.5, 1700, 0), rng), ...eyesBoth(pts(0, 1, 180, 0.08, 850, 0.08, 1100, 1, 1700, 1)), mouth("form", pts(0, 0, 180, 0.95, 1300, 0.95, 1700, 0))),
			),
			spatial: {
				segments: [
					// 1. 蓄力段：纯垂直下蹲微屈膝，不预加反向旋转，杜绝起手顿挫
					{ durationMs: 180, delta: { y: -0.02 } },
					// 2. 腾空浮起
					{ durationMs: 160, delta: { y: 0.05 } },
					// 3. 整圈自转：逐帧驱动的 relative 旋转 359°（VTS 对 rotation 一律最短弧插值，
					//    relative 单请求 359 折返 -1°，必须逐帧增量）。不声明 delta 即不改 y/size。
					{ durationMs: 1200, relativeRotation: 359 },
					// 4. 落地缓冲 + 1° 回正（relative 359 距整圈差 1°，absolute rotation:0 目标即基准朝向）
					{ durationMs: 420, delta: { y: 0, rotation: 0 } },
					// 5. 长定格展示段
					{ durationMs: 600, delta: { y: 0, rotation: 0 } },
				],
			},
		},
	},
	postures: {
		rest: { description: "自然站定", aliases: ["自然站立", "自然站定"], values: {}, transitionMs: 500 },
		tuck: {
			description: "垂头收起",
			aliases: ["低头", "垂头收拢"],
			values: { "head.pitch": -6.5, "head.yaw": -2.5, "head.roll": 3.0 },
			transitionMs: 500,
		},
		head_back: {
			description: "仰头放松",
			aliases: ["仰头", "仰头放松"],
			values: { "head.pitch": 6.0, "head.yaw": 1.2, "head.roll": -2.8 },
			transitionMs: 600,
		},
	},
	expressions: {
		smile: {
			description: "明朗笑",
			aliases: ["微笑", "明朗笑"],
			values: { "mouth.form": 0.9, "eyes.left.open": 1, "eyes.right.open": 1 },
			transitionMs: 280,
		},
		smirk: {
			description: "半眯坏笑",
			aliases: ["轻笑", "坏笑"],
			values: { "mouth.form": 0.65, "eyes.left.open": 0.55, "eyes.right.open": 0.55 },
			transitionMs: 350,
		},
		clear_face: { description: "清除表情", aliases: ["自然脸", "恢复平静"], values: {}, transitionMs: 350 },
	},
	background: {
		ambient: {
			sway: {
				description: "头身错拍的短动作组：左右倾、回正、换向看、眨眼，再自然接入下一段",
				aliases: ["摇摆", "晃动", "摇"],
				motion: MO_SWAY_PHRASES[0]!,
				variants: MO_SWAY_PHRASES.slice(1),
			},
		},
		idle: motion(3800, (rng) => {
			const gain = variation(rng, 0.1);
			const cycle =
				(cycles: number, lag = 0): Curve =>
				(t) =>
					phaseWave(t, 3800, cycles, lag);
			const slow = cycle(1);
			const secondary = cycle(2, 0.55);
			const yaw = cycle(1, -1.1);
			const yawSecondary = cycle(2, 0.3);
			const pitch = cycle(2, 1.3);
			const pitchSecondary = cycle(3, -0.6);
			return channels(
				headCurve("roll", (t) => gain * (3.5 * slow(t) + 0.2 * secondary(t))),
				headCurve("yaw", (t) => gain * (0.9 * yaw(t) + 0.2 * yawSecondary(t))),
				headCurve("pitch", (t) => gain * (0.5 * pitch(t) + 0.18 * pitchSecondary(t))),
			);
		}),
		thinking: motion(3600, (rng) => {
			const phase = rng() * 2 * Math.PI;
			const gain = variation(rng, 0.12);
			const cycle =
				(cycles: number, lag = 0): Curve =>
				(t) =>
					phaseWave(t, 3600, cycles, phase + lag);
			const roll = cycle(1);
			const rollSecondary = cycle(2, 0.6);
			const yaw = cycle(1, -0.8);
			const yawSecondary = cycle(2, 0.4);
			const pitch = cycle(1, 1.2);
			const gazeY = cycle(1, 1.7);
			const gazeX = cycle(1, -1.4);
			return channels(
				headCurve("roll", (t) => 4.6 + gain * (0.2 * roll(t) + 0.08 * rollSecondary(t))),
				headCurve("yaw", (t) => 3.3 + gain * (0.18 * yaw(t) + 0.06 * yawSecondary(t))),
				headCurve("pitch", (t) => -1.3 + gain * 0.22 * pitch(t)),
				gazeCurve("y", (t) => 0.38 + 0.04 * gazeY(t)),
				gazeCurve("x", (t) => 0.32 + 0.05 * gazeX(t)),
				...eyesBoth(pts(0, 0.8, 3600, 0.8)),
				mouth("form", pts(0, 0.24, 3600, 0.24)),
			);
		}),
	},
};

export function compileMOCatalog(rig: ModelRig): CatalogSnapshot {
	return compileCatalog(MO_MODEL_ID, MO_CATALOG_SOURCE, rig);
}

export function loadCatalog(modelID: string, rig: ModelRig): CatalogSnapshot | undefined {
	if (modelID === MO_MODEL_ID && rig.modelID === MO_MODEL_ID) return compileMOCatalog(rig);
	return undefined;
}
