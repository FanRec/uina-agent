import type { CatalogSource } from "../.uina/worlds/live2d/authoring/catalog.js";
import { absolute, keys, motion, offset } from "../.uina/worlds/live2d/authoring/motion.js";

/**
 * MO 表演夹具（引擎行为回归测试用）：从退役目录 catalog-bak.ts.txt 保真移植的最小动作集，
 * 数值与节奏逐键一致——`head.*` 为 baseline-offset 增量（旧 head() 助手语义），
 * eyes/gaze/mouth 为 absolute 目标（旧裸 track 语义），default 曲线同为五次 smootherstep。
 * 仅供 director/管道行为断言使用；正式动作内容按曲线函数模型另案重写。
 */

type Pts = Parameters<typeof keys>[0];
type ChannelTuple = readonly [string, ReturnType<typeof offset>];

const head = (axis: "pitch" | "yaw" | "roll", points: Pts): ChannelTuple => [`head.${axis}`, offset(keys(points))];
const eyes = (side: "left" | "right", points: Pts): ChannelTuple => [`eyes.${side}.open`, absolute(keys(points))];
const gaze = (axis: "x" | "y", points: Pts): ChannelTuple => [`gaze.${axis}`, absolute(keys(points))];
const mouth = (axis: "open" | "form", points: Pts): ChannelTuple => [`mouth.${axis}`, absolute(keys(points))];
const channels = (...tuples: ChannelTuple[]) => Object.fromEntries(tuples);

export const perfCatalogSource = (): CatalogSource => ({
	motions: {
		nod: {
			description: "舒缓Q弹肯定点头",
			aliases: ["点头"],
			playback: { fadeInMs: 50, fadeOutMs: 100 },
			motion: motion(
				950,
				channels(
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
			),
			variants: [
				motion(
					850,
					channels(
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
				),
			],
		},
		wink: {
			description: "暴击歪头眨眼",
			aliases: ["眨眼"],
			playback: { fadeInMs: 60, fadeOutMs: 140 },
			motion: motion(
				840,
				channels(
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
					eyes("left", [
						[0, 1],
						[100, 0.8],
						[180, 0],
						[540, 0],
						[700, 1],
						[840, 1],
					]),
					eyes("right", [
						[0, 1],
						[840, 1],
					]),
					mouth("form", [
						[0, 0],
						[180, 0.95],
						[540, 0.95],
						[840, 0],
					]),
				),
			),
		},
		curious: {
			description: "贴肩猫猫大歪头",
			aliases: ["歪头"],
			playback: { fadeInMs: 80, fadeOutMs: 150 },
			motion: motion(
				1750,
				channels(
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
					gaze("y", [
						[0, 0],
						[180, 0.82],
						[1350, 0.82],
						[1750, 0],
					]),
					gaze("x", [
						[0, 0],
						[180, -0.52],
						[1350, -0.52],
						[1750, 0],
					]),
					eyes("left", [
						[0, 1],
						[1750, 1],
					]),
					eyes("right", [
						[0, 1],
						[1750, 1],
					]),
					mouth("form", [
						[0, 0],
						[220, 0.48],
						[1350, 0.48],
						[1750, 0],
					]),
				),
			),
		},
		startle: {
			description: "吓一跳",
			playback: { fadeInMs: 15, fadeOutMs: 250, resetVelocity: true },
			motion: motion(
				1100,
				channels(
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
					eyes("left", [
						[0, 1],
						[35, 0.1],
						[120, 1],
						[1100, 1],
					]),
					eyes("right", [
						[0, 1],
						[35, 0.1],
						[120, 1],
						[1100, 1],
					]),
					mouth("open", [
						[0, 0],
						[150, 0],
						[220, 0.75],
						[550, 0.7],
						[750, 0],
						[1100, 0],
					]),
					mouth("form", [
						[0, 0],
						[220, 0.2],
						[750, 0],
						[1100, 0],
					]),
				),
			),
		},
		surprise: {
			description: "惊讶一顿",
			motion: motion(
				2100,
				channels(
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
					gaze("x", [
						[0, 0],
						[2100, 0],
					]),
					gaze("y", [
						[0, 0.15],
						[180, 0.5],
						[1600, 0.5],
						[2100, 0.15],
					]),
					eyes("left", [
						[0, 1],
						[2100, 1],
					]),
					eyes("right", [
						[0, 1],
						[2100, 1],
					]),
					mouth("open", [
						[0, 0],
						[150, 0],
						[250, 0.65],
						[1500, 0.65],
						[1750, 0],
						[2100, 0],
					]),
				),
			),
		},
		glance: {
			description: "偷瞄一眼",
			motion: motion(
				800,
				channels(
					gaze("x", [
						[0, 0],
						[40, 0.98],
						[560, 0.98],
						[740, 0],
						[800, 0],
					]),
					gaze("y", [
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
			),
		},
		joy_hop: {
			description: "雀跃一弹：深蹲蓄力、腾空月牙笑与软糯Q弹着陆",
			motion: motion(
				1100,
				channels(
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
					eyes("left", [
						[0, 1],
						[120, 0.6],
						[340, 0.1],
						[520, 0.1],
						[750, 1],
						[1100, 1],
					]),
					eyes("right", [
						[0, 1],
						[120, 0.6],
						[340, 0.1],
						[520, 0.1],
						[750, 1],
						[1100, 1],
					]),
					mouth("form", [
						[0, 0],
						[250, 0.98],
						[620, 0.98],
						[1100, 0],
					]),
				),
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
	},
	expressions: {
		smirk: {
			description: "半眯坏笑",
			aliases: ["轻笑", "坏笑"],
			values: { "mouth.form": 0.65, "eyes.left.open": 0.55, "eyes.right.open": 0.55 },
			transitionMs: 350,
		},
	},
	background: {
		ambient: {
			sway: {
				description: "头身错拍短动作组（引擎行为测试夹具）",
				aliases: ["摇摆", "晃动", "摇"],
				motion: motion(
					600,
					channels(
						head("yaw", [
							[0, 0],
							[300, 2],
							[600, 0],
						]),
					),
				),
				variants: [
					motion(
						600,
						channels(
							head("yaw", [
								[0, 0],
								[300, -2],
								[600, 0],
							]),
						),
					),
				],
			},
		},
		idle: motion(
			3800,
			channels(
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
		),
		thinking: motion(
			3600,
			channels(
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
				gaze("y", [
					[0, 0.38],
					[1800, 0.41],
					[3600, 0.38],
				]),
				gaze("x", [
					[0, 0.32],
					[1800, 0.35],
					[3600, 0.32],
				]),
				eyes("left", [
					[0, 0.8],
					[3600, 0.8],
				]),
				eyes("right", [
					[0, 0.8],
					[3600, 0.8],
				]),
				mouth("form", [
					[0, 0.24],
					[3600, 0.24],
				]),
			),
		),
	},
});
