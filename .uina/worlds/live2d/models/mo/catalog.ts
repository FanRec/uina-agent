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
			description: "点头应声：一下明确下点，轻微回弹",
			motion: motion(
				650,
				head("pitch", [
					[0, 0],
					[100, 0.8],
					[270, -5.5],
					[330, -5.5],
					[470, 1],
					[650, 0],
				]),
			),
		},
		shake: {
			description: "摇头否认：左右不同轻重，随后回正",
			motion: motion(
				820,
				head("yaw", [
					[0, 0],
					[190, 6],
					[280, 6],
					[470, -4.5],
					[560, -4.5],
					[690, 1],
					[820, 0],
				]),
				head("roll", [
					[0, 0],
					[240, -1.5],
					[520, 1],
					[820, 0],
				]),
			),
		},
		wink: {
			description: "俏皮眨眼：左眼短闭，右眼保持可见",
			playback: { fadeInMs: 60, fadeOutMs: 180 },
			motion: motion(
				620,
				head("roll", [
					[0, 0],
					[150, 2],
					[300, 2],
					[620, 0],
				]),
				track("eyes.left.open", [
					[0, 1],
					[90, 1],
					[150, 0],
					[270, 0],
					[430, 1],
					[620, 1],
				]),
				track("eyes.right.open", [
					[0, 0.9],
					[620, 0.9],
				]),
			),
		},
		curious: {
			description: "侧歪打量：歪头停住，等一句解释",
			motion: motion(
				1100,
				head("roll", [
					[0, 0],
					[100, 0],
					[360, 5.5],
					[750, 5.5],
					[1100, 0],
				]),
				head("pitch", [
					[0, 0],
					[100, 0],
					[360, 1],
					[750, 1],
					[1100, 0],
				]),
				head("yaw", [
					[0, 0],
					[360, 1],
					[750, 1],
					[1100, 0],
				]),
			),
		},
		chin_up: {
			description: "得意昂头：抬下巴，再把目光压回观众",
			motion: motion(
				1100,
				head("pitch", [
					[0, 0],
					[140, 0],
					[360, 5],
					[760, 5],
					[1100, 0],
				]),
				head("roll", [
					[0, 0],
					[360, -1],
					[760, -1],
					[1100, 0],
				]),
				track("gaze.y", [
					[0, 0.15],
					[140, 0.35],
					[360, 0.35],
					[470, -0.3],
					[760, -0.3],
					[1100, 0.15],
				]),
			),
		},
		head_toss: {
			description: "哼一下：转开、偷偷看回，再慢回头",
			motion: motion(
				1250,
				track("gaze.x", [
					[0, 0],
					[90, 0.55],
					[650, 0.55],
					[790, -0.25],
					[900, 0.55],
					[1250, 0],
				]),
				head("yaw", [
					[0, 0],
					[90, 0],
					[320, 8],
					[900, 8],
					[1250, 0],
				]),
				head("pitch", [
					[0, 0],
					[320, 2],
					[900, 2],
					[1250, 0],
				]),
				head("roll", [
					[0, 0],
					[320, 2],
					[900, 2],
					[1250, 0],
				]),
			),
		},
		alert: {
			description: "凝神警觉：目光定向，头跟随后停住",
			motion: motion(
				1050,
				track("gaze.x", [
					[0, 0],
					[100, 0],
					[190, 0.55],
					[760, 0.55],
					[1050, 0],
				]),
				head("yaw", [
					[0, 0],
					[190, 0],
					[430, 4],
					[760, 4],
					[1050, 0],
				]),
				head("roll", [
					[0, 0],
					[430, 1.5],
					[760, 1.5],
					[1050, 0],
				]),
				track("eyes.left.open", [
					[0, 0.95],
					[1050, 0.95],
				]),
				track("eyes.right.open", [
					[0, 0.95],
					[1050, 0.95],
				]),
			),
		},
		startle: {
			description: "吓一跳：先收缩，再后缩确认，带小余势",
			playback: { fadeInMs: 25, fadeOutMs: 180, resetVelocity: true },
			motion: motion(
				900,
				head("pitch", [
					[0, 0],
					[110, -2.5],
					[290, 5],
					[430, 5],
					[610, -1],
					[900, 0],
				]),
				head("roll", [
					[0, 0],
					[110, 0],
					[290, 2.5],
					[430, 2.5],
					[900, 0],
				]),
				track("eyes.left.open", [
					[0, 1],
					[110, 0.25],
					[220, 1],
					[900, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[110, 0.25],
					[220, 1],
					[900, 1],
				]),
				track("mouth.open", [
					[0, 0],
					[220, 0],
					[330, 0.25],
					[430, 0.25],
					[610, 0],
					[900, 0],
				]),
			),
		},
		surprise: {
			description: "惊讶一顿：睁眼略张嘴，留出长停顿",
			motion: motion(
				1300,
				head("pitch", [
					[0, 0],
					[150, 0],
					[340, 2],
					[850, 2],
					[1300, 0],
				]),
				track("gaze.x", [
					[0, 0],
					[1300, 0],
				]),
				track("gaze.y", [
					[0, 0.15],
					[1300, 0.15],
				]),
				track("eyes.left.open", [
					[0, 1],
					[1300, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[1300, 1],
				]),
				track("mouth.open", [
					[0, 0],
					[150, 0],
					[340, 0.22],
					[850, 0.22],
					[1100, 0],
					[1300, 0],
				]),
			),
		},
		glance: {
			description: "偷瞄一眼：眼先看向侧边，头只轻跟",
			motion: motion(
				800,
				track("gaze.x", [
					[0, 0],
					[100, 0.5],
					[480, 0.5],
					[620, 0],
					[800, 0],
				]),
				head("yaw", [
					[0, 0],
					[100, 0],
					[250, 1.5],
					[620, 1.5],
					[800, 0],
				]),
			),
		},
		eye_roll: {
			description: "无语望天：半眯、上望，慢慢回落",
			motion: motion(
				1200,
				track("eyes.left.open", [
					[0, 0.55],
					[900, 0.55],
					[1200, 0.8],
				]),
				track("eyes.right.open", [
					[0, 0.55],
					[900, 0.55],
					[1200, 0.8],
				]),
				track("gaze.y", [
					[0, 0.15],
					[180, 0.15],
					[350, 0.7],
					[780, 0.7],
					[1200, 0.15],
				]),
				track("gaze.x", [
					[0, 0],
					[350, 0],
					[560, 0.18],
					[780, 0],
					[1200, 0],
				]),
				head("pitch", [
					[0, 0],
					[350, 1.5],
					[780, 1.5],
					[1200, 0],
				]),
			),
		},
		double_take: {
			description: "再看一眼：轻瞄回正后，明显转头确认",
			motion: motion(
				1350,
				track("gaze.x", [
					[0, 0],
					[100, 0.3],
					[200, 0.3],
					[350, 0],
					[400, 0],
					[490, 0.6],
					[1000, 0.6],
					[1200, 0],
					[1350, 0],
				]),
				head("yaw", [
					[0, 0],
					[200, 1.5],
					[350, 0],
					[490, 0],
					[650, 7],
					[1000, 7],
					[1350, 0],
				]),
			),
		},
		joy_hop: {
			description: "雀跃一弹：整模预备、弹起、落下与小余弹",
			motion: motion(
				1100,
				head("pitch", [
					[0, 0],
					[120, -1],
					[340, 1.5],
					[620, -0.8],
					[800, 0.5],
					[1100, 0],
				]),
				track("eyes.left.open", [
					[0, 1],
					[340, 1],
					[430, 0.35],
					[530, 0.35],
					[700, 1],
					[1100, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[340, 1],
					[430, 0.35],
					[530, 0.35],
					[700, 1],
					[1100, 1],
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
	},
	postures: {
		rest: { description: "自然站定", values: {}, transitionMs: 500 },
		tuck: { description: "垂头收起", values: { "head.pitch": -5, "head.yaw": -2, "head.roll": 2 }, transitionMs: 450 },
		head_back: {
			description: "仰头放松",
			values: { "head.pitch": 4.5, "head.yaw": 1, "head.roll": -2 },
			transitionMs: 600,
		},
	},
	expressions: {
		smile: {
			description: "明朗笑",
			values: { "mouth.form": 0.85, "eyes.left.open": 1, "eyes.right.open": 1 },
			transitionMs: 280,
		},
		smirk: {
			description: "半眯坏笑",
			values: { "mouth.form": 0.55, "eyes.left.open": 0.55, "eyes.right.open": 0.55 },
			transitionMs: 350,
		},
		clear_face: { description: "清除表情", values: {}, transitionMs: 350 },
	},
	background: {
		idle: motion(
			3800,
			head("roll", [
				[0, 0],
				[1100, 3],
				[1600, 3],
				[2850, -2.5],
				[3200, -2.5],
				[3800, 0],
			]),
			head("yaw", [
				[0, 0],
				[1250, 1.5],
				[1750, 1.5],
				[3000, -1.2],
				[3300, -1.2],
				[3800, 0],
			]),
			head("pitch", [
				[0, 0],
				[1350, 0.6],
				[2900, -0.4],
				[3800, 0],
			]),
		),
		thinking: motion(
			3600,
			head("roll", [
				[0, 2.5],
				[2400, 2.5],
				[2800, 3],
				[3200, 3],
				[3600, 2.5],
			]),
			head("pitch", [
				[0, 1],
				[2400, 1],
				[2800, 0.6],
				[3200, 0.6],
				[3600, 1],
			]),
			track("gaze.x", [
				[0, 0.3],
				[2400, 0.3],
				[2800, 0.4],
				[3200, 0.4],
				[3600, 0.3],
			]),
			track("gaze.y", [
				[0, 0.35],
				[2400, 0.35],
				[2800, 0.28],
				[3200, 0.28],
				[3600, 0.35],
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
