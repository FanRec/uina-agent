import type { ModelRig } from "../../adapter/rig.js";
import type { CatalogSnapshot, CatalogSource } from "../../authoring/catalog.js";
import { compileCatalog } from "../../authoring/catalog.js";
import { absolute, keys, motion, offset, type Channel } from "../../authoring/motion.js";
import { MO_MODEL_ID } from "../rig-loader.js";

/**
 * MO 动作目录（2026-10-14 按曲线函数模型重建；数值基准 = catalog-bak.ts.txt 逐键保真）。
 *
 * 增强纪律（表演规范 §3：不改变关键姿势，允许有界的轻重/时长/方向变化）：
 * 1. bake 期幅度纹理：head/torso 增量通道幅度按 (1±6%) 随机缩放——每次播放重新 bake，
 *    连播不重样；时序与关键姿势等比保持。rng=0.5 时增益恰为 1，逐字复现标定曲线（测试锚点）。
 * 2. 双侧眼睑共享同一条曲线实例：左右开合由构造保证逐帧全等。
 * 3. 眼睑/口型/视线等 absolute 通道逐字标定，不参与纹理——口型与语音包络的互不感知、
 *    视线锚定语义不因纹理漂移。
 *
 * 本文件的创作形态：`pts(x0, y0, x1, y1, …)` 扁平关键帧速记（单行密度、biome 稳定，
 * formatter override lineWidth 320）；`elastic` 等生成器见 authoring/motion.ts。
 * 旧曲线树目录全文退役至 catalog-bak.ts.txt（动作设计参考）。
 */

type Pts = readonly (readonly [number, number])[];
type ChannelTuple = readonly [string, Channel];

/** 关键帧速记：扁平 x/y 对 → 点表（x0, y0, x1, y1, …）。单行密度、biome 稳定。 */
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
	const gain = 1 + (rng() * 2 - 1) * spread;
	const base = keys(points);
	return offset((t) => base(t) * gain);
};

/** absolute 目标通道（眼睑/口型/视线），逐字标定。 */
const tgt = (points: Pts): Channel => absolute(keys(points));

const head = (axis: "pitch" | "yaw" | "roll", points: Pts, rng: () => number): ChannelTuple => [`head.${axis}`, texture(points, rng)];
const torso = (axis: "pitch" | "yaw" | "roll", points: Pts, rng: () => number): ChannelTuple => [`torso.${axis}`, texture(points, rng)];
const eyes = (side: "left" | "right", points: Pts): ChannelTuple => [`eyes.${side}.open`, tgt(points)];
const gaze = (axis: "x" | "y", points: Pts): ChannelTuple => [`gaze.${axis}`, tgt(points)];
const mouth = (axis: "open" | "form", points: Pts): ChannelTuple => [`mouth.${axis}`, tgt(points)];
/** 双侧眼睑共享同一条曲线实例：左右开合逐帧全等由构造保证。 */
const eyesBoth = (points: Pts): ChannelTuple[] => {
	const curve = tgt(points);
	return [
		["eyes.left.open", curve],
		["eyes.right.open", curve],
	];
};
const channels = (...tuples: ChannelTuple[]) => Object.fromEntries(tuples);

/** 头身错拍的待机短动作组：四段互异短语（轮换池），每段起止归零自然衔接。 */
const MO_SWAY_PHRASES = [
	motion(2600, (rng) =>
		channels(
			torso("roll", pts(0, 0, 450, 3.6, 850, 5.8, 1200, 4.2, 1650, 1.2, 2200, 0, 2600, 0), rng),
			torso("yaw", pts(0, 0, 500, 1.8, 950, 3.2, 1400, 2.2, 2050, 0, 2600, 0), rng),
			torso("pitch", pts(0, 0, 650, -1.2, 1150, -2.4, 1750, -0.8, 2300, 0, 2600, 0), rng),
			head("roll", pts(0, 0, 450, -0.8, 900, -2.1, 1350, -1.2, 1900, 0.6, 2400, 0, 2600, 0), rng),
			head("yaw", pts(0, 0, 550, -1.1, 1000, 1.8, 1450, 2.5, 1950, 0.8, 2400, 0, 2600, 0), rng),
			head("pitch", pts(0, 0, 550, 1.0, 1050, 2.3, 1500, 0.6, 2050, -0.6, 2500, 0, 2600, 0), rng),
			gaze("x", pts(0, 0, 600, 0.5, 1100, 0.72, 1650, 0.2, 2100, -0.2, 2500, 0, 2600, 0)),
			gaze("y", pts(0, 0, 700, 0.15, 1350, 0.34, 2000, 0.08, 2450, 0, 2600, 0)),
			...eyesBoth(pts(0, 1, 1670, 1, 1780, 0.08, 1900, 0.08, 2020, 1, 2600, 1)),
		),
	),
	motion(2850, (rng) =>
		channels(
			torso("roll", pts(0, 0, 500, -3.8, 950, -5.6, 1450, -3.1, 2050, -0.8, 2500, 0, 2850, 0), rng),
			torso("yaw", pts(0, 0, 650, -2.4, 1150, -4.2, 1700, -2.6, 2250, 0, 2850, 0), rng),
			torso("pitch", pts(0, 0, 600, 1.0, 1200, 1.8, 1750, 0.7, 2350, 0, 2850, 0), rng),
			head("roll", pts(0, 0, 450, 1.2, 900, 2.8, 1350, 1.1, 1950, -0.6, 2500, 0, 2850, 0), rng),
			head("yaw", pts(0, 0, 600, 1.6, 1050, -1.8, 1550, -2.8, 2100, -0.7, 2550, 0, 2850, 0), rng),
			head("pitch", pts(0, 0, 550, -0.8, 1100, -1.8, 1650, -0.3, 2250, 0.6, 2650, 0, 2850, 0), rng),
			gaze("x", pts(0, 0, 500, -0.55, 1000, -0.8, 1520, -0.25, 2050, 0.42, 2600, 0, 2850, 0)),
			gaze("y", pts(0, 0, 700, -0.1, 1300, -0.34, 1850, -0.12, 2450, 0, 2850, 0)),
			...eyesBoth(pts(0, 1, 930, 1, 1040, 0.06, 1170, 0.06, 1290, 1, 2850, 1)),
		),
	),
	motion(2450, (rng) =>
		channels(
			torso("roll", pts(0, 0, 450, 2.2, 850, 3.1, 1320, 1.2, 1900, 0, 2450, 0), rng),
			torso("yaw", pts(0, 0, 500, 3.2, 950, 5.3, 1430, 2.6, 1950, 0, 2450, 0), rng),
			torso("pitch", pts(0, 0, 600, -2.0, 1050, -3.2, 1600, -1.0, 2050, 0, 2450, 0), rng),
			head("roll", pts(0, 0, 400, -1.3, 800, -3.1, 1250, -1.7, 1750, 0.8, 2200, 0, 2450, 0), rng),
			head("yaw", pts(0, 0, 450, -2.4, 850, -5.2, 1300, -2.4, 1800, 1.4, 2200, 0, 2450, 0), rng),
			head("pitch", pts(0, 0, 500, 1.1, 900, 2.8, 1420, 0.8, 1900, -0.8, 2250, 0, 2450, 0), rng),
			gaze("x", pts(0, 0, 420, 0.72, 850, 0.92, 1300, 0.34, 1780, -0.4, 2200, 0, 2450, 0)),
			gaze("y", pts(0, 0, 550, 0.3, 1050, 0.48, 1600, 0.12, 2100, 0, 2450, 0)),
			...eyesBoth(pts(0, 1, 1760, 1, 1870, 0.06, 1980, 0.06, 2090, 1, 2450, 1)),
		),
	),
	motion(3050, (rng) =>
		channels(
			torso("roll", pts(0, 0, 500, -2.6, 1000, -3.7, 1550, -1.4, 2200, 0, 2700, 0, 3050, 0), rng),
			torso("yaw", pts(0, 0, 650, -1.8, 1250, -3.0, 1850, -1.2, 2350, 0, 3050, 0), rng),
			torso("pitch", pts(0, 0, 550, -2.6, 1050, -4.0, 1600, -1.4, 2250, 0, 3050, 0), rng),
			head("roll", pts(0, 0, 450, 1.1, 900, 1.8, 1450, 0.6, 2050, -0.6, 2600, 0, 3050, 0), rng),
			head("yaw", pts(0, 0, 500, 2.8, 950, 4.6, 1480, 2.2, 1980, -1.2, 2550, 0, 3050, 0), rng),
			head("pitch", pts(0, 0, 450, 3.0, 900, 4.8, 1400, 2.1, 1950, -0.8, 2550, 0, 3050, 0), rng),
			gaze("x", pts(0, 0, 500, -0.65, 950, -0.82, 1500, -0.3, 2100, 0.36, 2650, 0, 3050, 0)),
			gaze("y", pts(0, 0, 500, -0.18, 1000, -0.48, 1550, -0.18, 2150, 0.16, 2700, 0, 3050, 0)),
			...eyesBoth(pts(0, 1, 620, 1, 730, 0.12, 980, 0.12, 1100, 1, 3050, 1)),
		),
	),
];

export const MO_CATALOG_SOURCE: CatalogSource = {
	motions: {
		nod: {
			description: "舒缓Q弹肯定点头：极限深潜软着陆、果冻大反弹与无顿挫缓收",
			aliases: ["点头"],
			playback: { fadeInMs: 50, fadeOutMs: 100 },
			motion: motion(950, (rng) => channels(head("pitch", pts(0, 0, 100, 2.0, 320, -9.8, 350, -9.8, 520, 2.8, 680, -4.8, 800, 0.6, 950, 0), rng), head("roll", pts(0, 0, 320, -2.6, 520, 1.8, 680, -1.0, 950, 0), rng))),
			variants: [motion(850, (rng) => channels(head("pitch", pts(0, 0, 100, 1.6, 300, -6.2, 330, -6.2, 480, 2.0, 620, -3.0, 730, 0.5, 850, 0), rng), head("roll", pts(0, 0, 300, -1.8, 480, 1.2, 620, -0.7, 850, 0), rng)))],
		},
		shake: {
			description: "丝滑大波浪撒娇摇头：满格钟摆摆幅、离心反向倾角与羽毛般长尾减速",
			aliases: ["摇头"],
			motion: motion(2300, (rng) => channels(head("yaw", pts(0, 0, 120, -2.8, 380, 12.0, 780, -11.8, 1180, 7.2, 1550, -3.2, 1850, 1.0, 2300, 0), rng), head("roll", pts(0, 0, 380, -5.0, 780, 4.8, 1180, -2.5, 1550, 1.0, 2300, 0), rng))),
		},
		wink: {
			description: "暴击歪头眨眼：大倾角立体贴肩、元气月牙笑与长定格电眼",
			aliases: ["眨眼"],
			playback: { fadeInMs: 60, fadeOutMs: 140 },
			motion: motion(840, (rng) =>
				channels(
					head("roll", pts(0, 0, 180, 9.8, 540, 9.8, 700, 2.0, 840, 0), rng),
					head("pitch", pts(0, 0, 180, -1.8, 540, -1.8, 840, 0), rng),
					head("yaw", pts(0, 0, 180, 3.2, 540, 3.2, 840, 0), rng),
					eyes("left", pts(0, 1, 100, 0.8, 180, 0, 540, 0, 700, 1, 840, 1)),
					eyes("right", pts(0, 1, 840, 1)),
					mouth("form", pts(0, 0, 180, 0.95, 540, 0.95, 840, 0)),
				),
			),
		},
		curious: {
			description: "贴肩猫猫大歪头：满格舒适歪头、收下巴立体肉感、大眼抬眸超长定格与慢悠悠回正",
			aliases: ["歪头"],
			playback: { fadeInMs: 80, fadeOutMs: 150 },
			motion: motion(1750, (rng) =>
				channels(
					head("roll", pts(0, 0, 220, 10.0, 1350, 10.0, 1580, 2.5, 1750, 0), rng),
					head("pitch", pts(0, 0, 220, -2.2, 1350, -2.2, 1750, 0), rng),
					head("yaw", pts(0, 0, 220, 4.8, 1350, 4.8, 1750, 0), rng),
					gaze("y", pts(0, 0, 180, 0.82, 1350, 0.82, 1750, 0)),
					gaze("x", pts(0, 0, 180, -0.52, 1350, -0.52, 1750, 0)),
					...eyesBoth(pts(0, 1, 1750, 1)),
					mouth("form", pts(0, 0, 220, 0.48, 1350, 0.48, 1750, 0)),
				),
			),
		},
		chin_up: {
			description: "得意昂头：满格高扬傲视、轻哼起伏狐狸笑与高位超长停滞",
			motion: motion(2300, (rng) =>
				channels(
					head("pitch", pts(0, 0, 120, -1.2, 350, 10.0, 750, 8.2, 1100, 10.0, 1600, 10.0, 2000, 3.0, 2300, 0), rng),
					head("roll", pts(0, 0, 350, -3.8, 1600, -3.8, 2300, 0), rng),
					head("yaw", pts(0, 0, 350, 2.8, 1600, 2.8, 2300, 0), rng),
					gaze("y", pts(0, 0.15, 150, 0.35, 350, -0.85, 1650, -0.85, 2300, 0.15)),
					...eyesBoth(pts(0, 1, 350, 0.38, 1650, 0.38, 2300, 1)),
					mouth("form", pts(0, 0, 300, 0.98, 1650, 0.98, 2300, 0)),
				),
			),
		},
		head_toss: {
			description: "傲娇大甩头：爆发满格甩头、别开侧颜长定格与偷瞄对视",
			motion: motion(2400, (rng) =>
				channels(
					head("yaw", pts(0, 0, 90, -2.2, 280, 12.0, 1650, 12.0, 2050, 3.5, 2400, 0), rng),
					head("pitch", pts(0, 0, 280, 4.5, 1650, 4.5, 2400, 0), rng),
					head("roll", pts(0, 0, 280, 5.2, 1650, 5.2, 2400, 0), rng),
					gaze("x", pts(0, 0, 160, 0.9, 650, 0.9, 850, -0.85, 1450, -0.85, 1600, 0.85, 2000, 0.3, 2400, 0)),
					mouth("form", pts(0, 0, 280, 0.15, 850, 0.45, 1600, 0.15, 2400, 0)),
				),
			),
		},
		alert: {
			description: "凝神警觉：视线光速锁定、身体挺拔与超长屏息定格",
			motion: motion(1950, (rng) =>
				channels(
					head("yaw", pts(0, 0, 110, 8.5, 1500, 8.5, 1950, 0), rng),
					head("pitch", pts(0, 0, 110, 3.0, 1500, 3.0, 1950, 0), rng),
					head("roll", pts(0, 0, 110, 2.8, 1500, 2.8, 1950, 0), rng),
					gaze("x", pts(0, 0, 70, 0.95, 1500, 0.95, 1950, 0)),
					gaze("y", pts(0, 0, 70, 0.28, 1500, 0.28, 1950, 0)),
					...eyesBoth(pts(0, 1.0, 1950, 1.0)),
				),
			),
		},
		startle: {
			description: "吓一跳：极速缩脖蓄力、触电爆发猛后仰、惨叫大张嘴与长尾平复",
			playback: { fadeInMs: 15, fadeOutMs: 250, resetVelocity: true },
			motion: motion(1100, (rng) =>
				channels(
					head("pitch", pts(0, 0, 35, -5.2, 140, 9.8, 300, 4.0, 480, 7.5, 750, -1.5, 1100, 0), rng),
					head("roll", pts(0, 0, 140, 5.0, 480, -2.5, 1100, 0), rng),
					...eyesBoth(pts(0, 1, 35, 0.1, 120, 1, 1100, 1)),
					mouth("open", pts(0, 0, 150, 0, 220, 0.75, 550, 0.7, 750, 0, 1100, 0)),
					mouth("form", pts(0, 0, 220, 0.2, 750, 0, 1100, 0)),
				),
			),
		},
		surprise: {
			description: "惊讶一顿：后仰石化超长停滞、大张嘴发愣与从容回神",
			motion: motion(2100, (rng) =>
				channels(
					head("pitch", pts(0, 0, 180, 6.8, 1600, 6.8, 2100, 0), rng),
					head("roll", pts(0, 0, 180, -3.0, 1600, -3.0, 2100, 0), rng),
					gaze("x", pts(0, 0, 2100, 0)),
					gaze("y", pts(0, 0.15, 180, 0.5, 1600, 0.5, 2100, 0.15)),
					...eyesBoth(pts(0, 1, 2100, 1)),
					mouth("open", pts(0, 0, 150, 0, 250, 0.65, 1500, 0.65, 1750, 0, 2100, 0)),
				),
			),
		},
		glance: {
			description: "偷瞄一眼：极速甩满眼角、缩颈暗中观察长定格与狡黠溜回",
			motion: motion(800, (rng) =>
				channels(gaze("x", pts(0, 0, 40, 0.98, 560, 0.98, 740, 0, 800, 0)), gaze("y", pts(0, 0, 40, 0.22, 560, 0.22, 800, 0)), head("pitch", pts(0, 0, 120, -3.8, 560, -3.8, 800, 0), rng), head("yaw", pts(0, 0, 150, 4.2, 560, 4.2, 800, 0), rng), head("roll", pts(0, 0, 150, -3.0, 560, -3.0, 800, 0), rng)),
			),
		},
		eye_roll: {
			description: "无语望天：极缓后仰叹气、天花板大圆弧滚眼、超长生无可恋定格与慵懒缓降收尾",
			motion: motion(2500, (rng) =>
				channels(
					head("pitch", pts(0, 0, 550, 8.8, 1600, 8.8, 2500, 0), rng),
					head("roll", pts(0, 0, 550, -4.2, 1600, -4.2, 2500, 0), rng),
					gaze("y", pts(0, 0.15, 200, 0.15, 550, 0.98, 1550, 0.98, 2500, 0.15)),
					gaze("x", pts(0, 0, 550, -0.3, 900, 0.45, 1300, 0.15, 2500, 0)),
					...eyesBoth(pts(0, 1, 300, 0.45, 1600, 0.45, 2500, 1)),
					mouth("form", pts(0, 0, 300, 0.05, 1600, 0.05, 2500, 0)),
				),
			),
		},
		double_take: {
			description: "再看一眼：漫不经心收回、呆滞僵住、核爆猛回头与超长定格不敢置信",
			motion: motion(2500, (rng) =>
				channels(
					gaze("x", pts(0, 0, 120, 0.5, 350, 0.5, 580, 0, 880, 0, 960, 0.95, 1750, 0.95, 2500, 0)),
					head("yaw", pts(0, 0, 180, 3.5, 580, 0, 880, 0, 960, 12.0, 1750, 12.0, 2500, 0), rng),
					head("pitch", pts(0, 0, 880, 0, 960, 2.8, 1750, 2.8, 2500, 0), rng),
					head("roll", pts(0, 0, 880, 0, 960, 4.5, 1750, 4.5, 2500, 0), rng),
					mouth("open", pts(0, 0, 880, 0, 960, 0.55, 1750, 0.55, 2500, 0)),
					...eyesBoth(pts(0, 1, 2500, 1)),
				),
			),
		},
		joy_hop: {
			description: "雀跃一弹：深蹲蓄力、腾空月牙笑与软糯Q弹着陆",
			motion: motion(1100, (rng) =>
				channels(head("pitch", pts(0, 0, 120, -5.2, 340, 8.5, 420, 7.0, 620, -4.8, 800, 2.5, 1100, 0), rng), head("roll", pts(0, 0, 340, 3.8, 620, -2.2, 1100, 0), rng), ...eyesBoth(pts(0, 1, 120, 0.6, 340, 0.1, 520, 0.1, 750, 1, 1100, 1)), mouth("form", pts(0, 0, 250, 0.98, 620, 0.98, 1100, 0))),
			),
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
			motion: motion(4800, (rng) =>
				channels(
					head("pitch", pts(0, 0, 40, -4.5, 150, 8.2, 1500, 8.7, 1540, 8.2, 2800, 8.9, 2840, 8.2, 4000, 8.2, 4400, -3.2, 4800, 0), rng),
					head("roll", pts(0, 0, 150, -4.2, 1500, -3.6, 1540, -4.2, 4000, -4.2, 4800, 0), rng),
					head("yaw", pts(0, 0, 150, -2.5, 4000, -2.5, 4800, 0), rng),
					gaze("x", pts(0, 0, 4800, 0)),
					gaze("y", pts(0, 0.12, 4000, 0.12, 4800, 0)),
					...eyesBoth(pts(0, 1, 40, 0.2, 150, 1.0, 4000, 1.0, 4400, 0.45, 4800, 1)),
					mouth("open", pts(0, 0, 150, 0.48, 4000, 0.48, 4400, 0, 4800, 0)),
					mouth("form", pts(0, 0, 4800, 0)),
				),
			),
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
			motion: motion(4100, (rng) =>
				channels(
					head("pitch", pts(0, 0, 180, -2.0, 550, 3.5, 1200, 3.0, 1900, 3.8, 2600, 3.1, 3400, 3.5, 4100, 0), rng),
					head("roll", pts(0, 0, 550, 0, 900, -3.2, 1600, 3.0, 2300, -2.8, 3000, 2.4, 3400, 0, 4100, 0), rng),
					head("yaw", pts(0, 0, 550, 0, 900, -1.5, 1600, 1.5, 2300, -1.2, 3000, 1.0, 3400, 0, 4100, 0), rng),
					gaze("x", pts(0, 0, 4100, 0)),
					gaze("y", pts(0, 0, 550, -0.15, 3400, -0.15, 4100, 0)),
					...eyesBoth(pts(0, 1, 1800, 0.1, 2000, 1, 4100, 1)),
					mouth("form", pts(0, 0, 550, 0.9, 3400, 0.9, 4100, 0)),
					mouth("open", pts(0, 0, 550, 0.22, 1900, 0.28, 3400, 0.22, 4100, 0)),
				),
			),
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
			motion: motion(4700, (rng) =>
				channels(
					head("roll", pts(0, 0, 550, -6.5, 4150, -6.5, 4700, 0), rng),
					head("yaw", pts(0, 0, 550, 6.0, 4150, 6.0, 4700, 0), rng),
					head("pitch", pts(0, 0, 550, -2.0, 4150, -2.0, 4700, 0), rng),
					gaze("x", pts(0, 0, 550, 0.95, 4150, 0.95, 4700, 0)),
					...eyesBoth(pts(0, 1, 550, 1.0, 1600, 1.0, 1750, 0.5, 1900, 1.0, 3100, 1.0, 3250, 0.5, 3400, 1.0, 4700, 1)),
					mouth("form", pts(0, 0, 550, 0.4, 4150, 0.4, 4700, 0)),
				),
			),
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
		idle: motion(3800, (rng) => channels(head("roll", pts(0, 0, 600, 1.2, 1100, 3.2, 1800, 2.4, 2700, -2.8, 3300, -1.8, 3800, 0), rng), head("yaw", pts(0, 0, 800, 1.0, 1300, 2.2, 2100, 0.8, 2900, -1.8, 3400, -0.6, 3800, 0), rng), head("pitch", pts(0, 0, 900, 1.2, 1500, 0.4, 2700, -1.0, 3800, 0), rng))),
		thinking: motion(3600, (rng) =>
			channels(
				head("roll", pts(0, 4.6, 1800, 4.9, 3600, 4.6), rng),
				head("yaw", pts(0, 3.3, 1800, 3.6, 3600, 3.3), rng),
				head("pitch", pts(0, -1.3, 1800, -1.6, 3600, -1.3), rng),
				gaze("y", pts(0, 0.38, 1800, 0.41, 3600, 0.38)),
				gaze("x", pts(0, 0.32, 1800, 0.35, 3600, 0.32)),
				...eyesBoth(pts(0, 0.8, 3600, 0.8)),
				mouth("form", pts(0, 0.24, 3600, 0.24)),
			),
		),
	},
};

export function compileMOCatalog(rig: ModelRig): CatalogSnapshot {
	return compileCatalog(MO_MODEL_ID, MO_CATALOG_SOURCE, rig);
}

export function loadCatalog(modelID: string, rig: ModelRig): CatalogSnapshot | undefined {
	if (modelID === MO_MODEL_ID && rig.modelID === MO_MODEL_ID) return compileMOCatalog(rig);
	return undefined;
}
