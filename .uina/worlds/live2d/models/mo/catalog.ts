import type { CatalogSnapshot, CatalogSource } from "../../authoring/catalog.js";
import { compileCatalog } from "../../authoring/catalog.js";
import { motion, track, type MotionTrack } from "../../authoring/motion.js";
import type { ModelRig } from "../../adapter/rig.js";
import { MO_MODEL_ID } from "../rig-loader.js";

type Keys = readonly (readonly [number, number])[];

function head(axis: "pitch" | "yaw" | "roll", keys: Keys): MotionTrack {
	return track(`head.${axis}`, keys, "baseline-offset");
}

/** 头部增量与临时眼口接管分开创作；未声明的部位继续由当前状态控制。 */
export const MO_CATALOG_SOURCE: CatalogSource = {
	motions: {
		nod: {
			description: "舒缓Q弹肯定点头：极限深潜软着陆、果冻大反弹与无顿挫缓收",
			aliases: ["点头"],
			playback: { fadeInMs: 50, fadeOutMs: 100 },
			motion: motion(
				950,
				head("pitch", [
					[0, 0],
					[100, 2.0],
					[320, -9.8],
					[350, -9.8],
					[520, 2.8],
					[680, -4.8],
					[800, 0.6],
					[950, 0],
				]),
				head("roll", [
					[0, 0],
					[320, -2.6],
					[520, 1.8],
					[680, -1.0],
					[950, 0],
				]),
			),
			// 轻快确认点头：幅度收敛到六成、双反弹保留但更含蓄——高频应答不抢戏
			variants: [
				motion(
					850,
					head("pitch", [
						[0, 0],
						[100, 1.6],
						[300, -6.2],
						[330, -6.2],
						[480, 2.0],
						[620, -3.0],
						[730, 0.5],
						[850, 0],
					]),
					head("roll", [
						[0, 0],
						[300, -1.8],
						[480, 1.2],
						[620, -0.7],
						[850, 0],
					]),
				),
			],
		},
		shake: {
			description: "丝滑大波浪撒娇摇头：满格钟摆摆幅、离心反向倾角与羽毛般长尾减速",
			aliases: ["摇头"],
			motion: motion(
				2300,
				head("yaw", [
					[0, 0],
					[120, -2.8],
					[380, 12.0],
					[780, -11.8],
					[1180, 7.2],
					[1550, -3.2],
					[1850, 1.0],
					[2300, 0],
				]),
				head("roll", [
					[0, 0],
					[380, -5.0],
					[780, 4.8],
					[1180, -2.5],
					[1550, 1.0],
					[2300, 0],
				]),
			),
		},
		wink: {
			description: "暴击歪头眨眼：大倾角立体贴肩、元气月牙笑与长定格电眼",
			aliases: ["眨眼"],
			playback: { fadeInMs: 60, fadeOutMs: 140 },
			motion: motion(
				840,
				head("roll", [
					[0, 0],
					[180, 9.8],
					[540, 9.8],
					[700, 2.0],
					[840, 0],
				]),
				head("pitch", [
					[0, 0],
					[180, -1.8],
					[540, -1.8],
					[840, 0],
				]),
				head("yaw", [
					[0, 0],
					[180, 3.2],
					[540, 3.2],
					[840, 0],
				]),
				track("eyes.left.open", [
					[0, 1],
					[100, 0.8],
					[180, 0],
					[540, 0],
					[700, 1],
					[840, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[840, 1],
				]),
				track("mouth.form", [
					[0, 0],
					[180, 0.95],
					[540, 0.95],
					[840, 0],
				]),
			),
		},
		curious: {
			description: "贴肩猫猫大歪头：满格舒适歪头、收下巴立体肉感、大眼抬眸超长定格与慢悠悠回正",
			aliases: ["歪头"],
			playback: { fadeInMs: 80, fadeOutMs: 150 },
			motion: motion(
				1750,
				head("roll", [
					[0, 0],
					[220, 10.0],
					[1350, 10.0],
					[1580, 2.5],
					[1750, 0],
				]),
				head("pitch", [
					[0, 0],
					[220, -2.2],
					[1350, -2.2],
					[1750, 0],
				]),
				head("yaw", [
					[0, 0],
					[220, 4.8],
					[1350, 4.8],
					[1750, 0],
				]),
				track("gaze.y", [
					[0, 0],
					[180, 0.82],
					[1350, 0.82],
					[1750, 0],
				]),
				track("gaze.x", [
					[0, 0],
					[180, -0.52],
					[1350, -0.52],
					[1750, 0],
				]),
				track("eyes.left.open", [
					[0, 1],
					[1750, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[1750, 1],
				]),
				track("mouth.form", [
					[0, 0],
					[220, 0.48],
					[1350, 0.48],
					[1750, 0],
				]),
			),
		},
		chin_up: {
			description: "得意昂头：满格高扬傲视、轻哼起伏狐狸笑与高位超长停滞",
			motion: motion(
				2300,
				head("pitch", [
					[0, 0],
					[120, -1.2],
					[350, 10.0],
					[750, 8.2],
					[1100, 10.0],
					[1600, 10.0],
					[2000, 3.0],
					[2300, 0],
				]),
				head("roll", [
					[0, 0],
					[350, -3.8],
					[1600, -3.8],
					[2300, 0],
				]),
				head("yaw", [
					[0, 0],
					[350, 2.8],
					[1600, 2.8],
					[2300, 0],
				]),
				track("gaze.y", [
					[0, 0.15],
					[150, 0.35],
					[350, -0.85],
					[1650, -0.85],
					[2300, 0.15],
				]),
				track("eyes.left.open", [
					[0, 1],
					[350, 0.38],
					[1650, 0.38],
					[2300, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[350, 0.38],
					[1650, 0.38],
					[2300, 1],
				]),
				track("mouth.form", [
					[0, 0],
					[300, 0.98],
					[1650, 0.98],
					[2300, 0],
				]),
			),
		},
		head_toss: {
			description: "傲娇大甩头：爆发满格甩头、别开侧颜长定格与偷瞄对视",
			motion: motion(
				2400,
				head("yaw", [
					[0, 0],
					[90, -2.2],
					[280, 12.0],
					[1650, 12.0],
					[2050, 3.5],
					[2400, 0],
				]),
				head("pitch", [
					[0, 0],
					[280, 4.5],
					[1650, 4.5],
					[2400, 0],
				]),
				head("roll", [
					[0, 0],
					[280, 5.2],
					[1650, 5.2],
					[2400, 0],
				]),
				track("gaze.x", [
					[0, 0],
					[160, 0.9],
					[650, 0.9],
					[850, -0.85],
					[1450, -0.85],
					[1600, 0.85],
					[2000, 0.3],
					[2400, 0],
				]),
				track("mouth.form", [
					[0, 0],
					[280, 0.15],
					[850, 0.45],
					[1600, 0.15],
					[2400, 0],
				]),
			),
		},
		alert: {
			description: "凝神警觉：视线光速锁定、身体挺拔与超长屏息定格",
			motion: motion(
				1950,
				head("yaw", [
					[0, 0],
					[110, 8.5],
					[1500, 8.5],
					[1950, 0],
				]),
				head("pitch", [
					[0, 0],
					[110, 3.0],
					[1500, 3.0],
					[1950, 0],
				]),
				head("roll", [
					[0, 0],
					[110, 2.8],
					[1500, 2.8],
					[1950, 0],
				]),
				track("gaze.x", [
					[0, 0],
					[70, 0.95],
					[1500, 0.95],
					[1950, 0],
				]),
				track("gaze.y", [
					[0, 0],
					[70, 0.28],
					[1500, 0.28],
					[1950, 0],
				]),
				track("eyes.left.open", [
					[0, 1.0],
					[1950, 1.0],
				]),
				track("eyes.right.open", [
					[0, 1.0],
					[1950, 1.0],
				]),
			),
		},
		startle: {
			description: "吓一跳：极速缩脖蓄力、触电爆发猛后仰、惨叫大张嘴与长尾平复",
			playback: { fadeInMs: 15, fadeOutMs: 250, resetVelocity: true },
			motion: motion(
				1100,
				head("pitch", [
					[0, 0],
					[35, -5.2],
					[140, 9.8],
					[300, 4.0],
					[480, 7.5],
					[750, -1.5],
					[1100, 0],
				]),
				head("roll", [
					[0, 0],
					[140, 5.0],
					[480, -2.5],
					[1100, 0],
				]),
				track("eyes.left.open", [
					[0, 1],
					[35, 0.1],
					[120, 1],
					[1100, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[35, 0.1],
					[120, 1],
					[1100, 1],
				]),
				track("mouth.open", [
					[0, 0],
					[150, 0],
					[220, 0.75],
					[550, 0.7],
					[750, 0],
					[1100, 0],
				]),
				track("mouth.form", [
					[0, 0],
					[220, 0.2],
					[750, 0],
					[1100, 0],
				]),
			),
		},
		surprise: {
			description: "惊讶一顿：后仰石化超长停滞、大张嘴发愣与从容回神",
			motion: motion(
				2100,
				head("pitch", [
					[0, 0],
					[180, 6.8],
					[1600, 6.8],
					[2100, 0],
				]),
				head("roll", [
					[0, 0],
					[180, -3.0],
					[1600, -3.0],
					[2100, 0],
				]),
				track("gaze.x", [
					[0, 0],
					[2100, 0],
				]),
				track("gaze.y", [
					[0, 0.15],
					[180, 0.5],
					[1600, 0.5],
					[2100, 0.15],
				]),
				track("eyes.left.open", [
					[0, 1],
					[2100, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[2100, 1],
				]),
				track("mouth.open", [
					[0, 0],
					[150, 0],
					[250, 0.65],
					[1500, 0.65],
					[1750, 0],
					[2100, 0],
				]),
			),
		},
		glance: {
			description: "偷瞄一眼：极速甩满眼角、缩颈暗中观察长定格与狡黠溜回",
			motion: motion(
				800,
				track("gaze.x", [
					[0, 0],
					[40, 0.98],
					[560, 0.98],
					[740, 0],
					[800, 0],
				]),
				track("gaze.y", [
					[0, 0],
					[40, 0.22],
					[560, 0.22],
					[800, 0],
				]),
				head("pitch", [
					[0, 0],
					[120, -3.8],
					[560, -3.8],
					[800, 0],
				]),
				head("yaw", [
					[0, 0],
					[150, 4.2],
					[560, 4.2],
					[800, 0],
				]),
				head("roll", [
					[0, 0],
					[150, -3.0],
					[560, -3.0],
					[800, 0],
				]),
			),
		},
		eye_roll: {
			description: "无语望天：极缓后仰叹气、天花板大圆弧滚眼、超长生无可恋定格与慵懒缓降收尾",
			motion: motion(
				2500,
				head("pitch", [
					[0, 0],
					[550, 8.8],
					[1600, 8.8],
					[2500, 0],
				]),
				head("roll", [
					[0, 0],
					[550, -4.2],
					[1600, -4.2],
					[2500, 0],
				]),
				track("gaze.y", [
					[0, 0.15],
					[200, 0.15],
					[550, 0.98],
					[1550, 0.98],
					[2500, 0.15],
				]),
				track("gaze.x", [
					[0, 0],
					[550, -0.3],
					[900, 0.45],
					[1300, 0.15],
					[2500, 0],
				]),
				track("eyes.left.open", [
					[0, 1],
					[300, 0.45],
					[1600, 0.45],
					[2500, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[300, 0.45],
					[1600, 0.45],
					[2500, 1],
				]),
				track("mouth.form", [
					[0, 0],
					[300, 0.05],
					[1600, 0.05],
					[2500, 0],
				]),
			),
		},
		double_take: {
			description: "再看一眼：漫不经心收回、呆滞僵住、核爆猛回头与超长定格不敢置信",
			motion: motion(
				2500,
				track("gaze.x", [
					[0, 0],
					[120, 0.5],
					[350, 0.5],
					[580, 0],
					[880, 0],
					[960, 0.95],
					[1750, 0.95],
					[2500, 0],
				]),
				head("yaw", [
					[0, 0],
					[180, 3.5],
					[580, 0],
					[880, 0],
					[960, 12.0],
					[1750, 12.0],
					[2500, 0],
				]),
				head("pitch", [
					[0, 0],
					[880, 0],
					[960, 2.8],
					[1750, 2.8],
					[2500, 0],
				]),
				head("roll", [
					[0, 0],
					[880, 0],
					[960, 4.5],
					[1750, 4.5],
					[2500, 0],
				]),
				track("mouth.open", [
					[0, 0],
					[880, 0],
					[960, 0.55],
					[1750, 0.55],
					[2500, 0],
				]),
				track("eyes.left.open", [
					[0, 1],
					[2500, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[2500, 1],
				]),
			),
		},
		joy_hop: {
			description: "雀跃一弹：深蹲蓄力、腾空月牙笑与软糯Q弹着陆",
			motion: motion(
				1100,
				head("pitch", [
					[0, 0],
					[120, -5.2],
					[340, 8.5],
					[420, 7.0],
					[620, -4.8],
					[800, 2.5],
					[1100, 0],
				]),
				head("roll", [
					[0, 0],
					[340, 3.8],
					[620, -2.2],
					[1100, 0],
				]),
				track("eyes.left.open", [
					[0, 1],
					[120, 0.6],
					[340, 0.1],
					[520, 0.1],
					[750, 1],
					[1100, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[120, 0.6],
					[340, 0.1],
					[520, 0.1],
					[750, 1],
					[1100, 1],
				]),
				track("mouth.form", [
					[0, 0],
					[250, 0.98],
					[620, 0.98],
					[1100, 0],
				]),
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
			description: "五雷轰顶石化：瞬间褪色灰白石雕、场景灰度滤镜、死鱼眼僵死与微裂震颤",
			aliases: ["石化", "僵死", "灰白"],
			motion: motion(
				2800,
				head("pitch", [
					[0, 0],
					[40, -4.5],
					[150, 8.2],
					[1100, 8.7],
					[1140, 8.2],
					[1600, 8.9],
					[1640, 8.2],
					[2000, 8.2],
					[2400, -3.2],
					[2800, 0],
				]),
				head("roll", [
					[0, 0],
					[150, -4.2],
					[1100, -3.6],
					[1140, -4.2],
					[2000, -4.2],
					[2800, 0],
				]),
				head("yaw", [
					[0, 0],
					[150, -2.5],
					[2000, -2.5],
					[2800, 0],
				]),
				track("gaze.x", [
					[0, 0],
					[2800, 0],
				]),
				track("gaze.y", [
					[0, 0.12],
					[2000, 0.12],
					[2800, 0],
				]),
				track("eyes.left.open", [
					[0, 1],
					[40, 0.2],
					[150, 1.0],
					[2000, 1.0],
					[2400, 0.45],
					[2800, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[40, 0.2],
					[150, 1.0],
					[2000, 1.0],
					[2400, 0.45],
					[2800, 1],
				]),
				track("mouth.open", [
					[0, 0],
					[150, 0.48],
					[2000, 0.48],
					[2400, 0],
					[2800, 0],
				]),
				track("mouth.form", [
					[0, 0],
					[2800, 0],
				]),
			),
			spatial: {
				segments: [
					{
						durationMs: 150,
						holdMs: 1850,
						delta: { y: 0 },
						effects: {
							tint: { r: 120, g: 120, b: 128 },
							postProcessing: { on: true, preset: "Grayscale", fadeTime: 0.15 },
						},
					},
					{
						durationMs: 800,
						delta: { y: 0 },
					},
				],
			},
		},
		close_up: {
			description: "贴脸破屏特写：镜头急推大头贴、近距离斗鸡眼视差对焦与满足缩回",
			aliases: ["贴脸", "凑近", "特写", "怼镜头"],
			motion: motion(
				2500,
				head("pitch", [
					[0, 0],
					[180, -2.0],
					[550, 2.5],
					[1800, 2.5],
					[2500, 0],
				]),
				track("gaze.x", [
					[0, 0],
					[2500, 0],
				]),
				track("gaze.y", [
					[0, 0],
					[550, -0.18],
					[1800, -0.18],
					[2500, 0],
				]),
				track("eyes.left.open", [
					[0, 1],
					[1100, 0.1],
					[1200, 1],
					[1800, 1],
					[2150, 0.15],
					[2500, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[1100, 0.1],
					[1200, 1],
					[1800, 1],
					[2150, 0.15],
					[2500, 1],
				]),
				track("mouth.form", [
					[0, 0],
					[550, 0.88],
					[1800, 0.88],
					[2500, 0],
				]),
				track("mouth.open", [
					[0, 0],
					[550, 0.22],
					[1800, 0.22],
					[2500, 0],
				]),
			),
			spatial: {
				segments: [
					{ durationMs: 180, delta: { size: -5, y: -0.01 } },
					{
						durationMs: 370,
						holdMs: 1250,
						delta: { size: 42, y: 0.06, rotation: 2 },
					},
					{
						durationMs: 700,
						delta: { size: 0, y: 0, rotation: 0 },
					},
				],
			},
		},
		edge_peek: {
			description: "边缘探头偷看：完全隐匿屏幕侧边、扒墙大倾角探头与抓包惊逃",
			aliases: ["探头", "偷看", "窥视", "扒边"],
			motion: motion(
				2700,
				head("roll", [
					[0, 0],
					[600, 9.8],
					[1900, 9.8],
					[2700, 0],
				]),
				head("yaw", [
					[0, 0],
					[600, 8.5],
					[1900, 8.5],
					[2700, 0],
				]),
				head("pitch", [
					[0, 0],
					[600, -1.8],
					[1900, -1.8],
					[2700, 0],
				]),
				track("gaze.x", [
					[0, 0],
					[600, 0.82],
					[1200, 0.4],
					[1600, 0],
					[1900, 0],
					[2700, 0],
				]),
				track("eyes.left.open", [
					[0, 1],
					[1600, 1.0],
					[1900, 1.0],
					[2100, 0.3],
					[2700, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[1600, 1.0],
					[1900, 1.0],
					[2100, 0.3],
					[2700, 1],
				]),
				track("mouth.form", [
					[0, 0],
					[600, 0.45],
					[1600, 0.0],
					[2700, 0],
				]),
			),
			spatial: {
				segments: [
					{ durationMs: 150, delta: { x: -0.42 } },
					{ durationMs: 450, holdMs: 1300, delta: { x: -0.18 } },
					{ durationMs: 250, delta: { x: -0.45 } },
					{ durationMs: 550, delta: { x: 0 } },
				],
			},
		},
		spin: {
			description: "华丽自转一圈：屈膝反扭蓄力、360度腾空飞旋与落地头晕醉步",
			aliases: ["转圈", "转个圈", "转圈圈", "旋转"],
			motion: motion(
				2300,
				head("roll", [
					[0, 0],
					[950, 0],
					[1200, 5.5],
					[1500, -3.8],
					[1800, 2.0],
					[2300, 0],
				]),
				head("pitch", [
					[0, 0],
					[200, -3.5],
					[550, 3.5],
					[950, -2.5],
					[2300, 0],
				]),
				track("eyes.left.open", [
					[0, 1],
					[400, 0.08],
					[850, 0.08],
					[1200, 0.6],
					[1500, 0.1],
					[2300, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[400, 0.08],
					[850, 0.08],
					[1200, 0.6],
					[1500, 0.1],
					[2300, 1],
				]),
				track("mouth.form", [
					[0, 0],
					[400, 0.98],
					[850, 0.98],
					[1500, 0.4],
					[2300, 0],
				]),
			),
			spatial: {
				segments: [
					{ durationMs: 200, delta: { y: -0.015, rotation: -12 } },
					// 359 而非 360：VTS rotation 硬边界 ±360，整圈留 1° 余量（边界值实测被 302 拒绝）
					{ durationMs: 700, delta: { y: 0.09, rotation: 359 } },
					{ durationMs: 400, delta: { y: 0, rotation: 0 } },
					{ durationMs: 1000, delta: { y: 0, rotation: 0 } },
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
				description: "左右摇摆：像人控制皮套那样循环晃动身体（左右为主，微微上下颠）",
				aliases: ["摇摆", "晃动", "摇"],
				motion: motion(
					3200,
					head("roll", [
						[0, 0],
						[800, 7.5],
						[1600, 0],
						[2400, -7.5],
						[3200, 0],
					]),
					head("yaw", [
						[0, 0],
						[800, 3.0],
						[1600, 0],
						[2400, -3.0],
						[3200, 0],
					]),
					head("pitch", [
						[0, 0],
						[800, 1.4],
						[1600, 0],
						[2400, 1.4],
						[3200, 0],
					]),
				),
			},
		},
		idle: motion(
			3800,
			head("roll", [
				[0, 0],
				[600, 1.2],
				[1100, 3.2],
				[1800, 2.4],
				[2700, -2.8],
				[3300, -1.8],
				[3800, 0],
			]),
			head("yaw", [
				[0, 0],
				[800, 1.0],
				[1300, 2.2],
				[2100, 0.8],
				[2900, -1.8],
				[3400, -0.6],
				[3800, 0],
			]),
			head("pitch", [
				[0, 0],
				[900, 1.2],
				[1500, 0.4],
				[2700, -1.0],
				[3800, 0],
			]),
		),
		thinking: motion(
			3600,
			head("roll", [
				[0, 4.6],
				[1800, 4.9],
				[3600, 4.6],
			]),
			head("yaw", [
				[0, 3.3],
				[1800, 3.6],
				[3600, 3.3],
			]),
			head("pitch", [
				[0, -1.3],
				[1800, -1.6],
				[3600, -1.3],
			]),
			track("gaze.y", [
				[0, 0.38],
				[1800, 0.41],
				[3600, 0.38],
			]),
			track("gaze.x", [
				[0, 0.32],
				[1800, 0.35],
				[3600, 0.32],
			]),
			track("eyes.left.open", [
				[0, 0.80],
				[3600, 0.80],
			]),
			track("eyes.right.open", [
				[0, 0.80],
				[3600, 0.80],
			]),
			track("mouth.form", [
				[0, 0.24],
				[3600, 0.24],
			]),
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
