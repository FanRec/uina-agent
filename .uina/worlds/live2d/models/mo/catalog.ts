import type { CatalogSnapshot, CatalogSource } from "../../authoring/catalog.js";
import { compileCatalog } from "../../authoring/catalog.js";
import { motion, track } from "../../authoring/motion.js";
import type { ModelRig } from "../../adapter/rig.js";
import { MO_MODEL_ID } from "../rig-loader.js";

/**
 * MO 模型动作目录源定义（P5-3 目录定型）。
 *
 * 伴随动作采用 "baseline-offset"（Additive 增量空间），
 * 与当前基础姿态（如 lean/attentive）自然叠加，不抢占覆盖基础姿态。
 *
 * 所有轴值严格受限于 models/mo/rig.json 的 controls 约束：
 * - head.pitch: [-10, 10]
 * - head.yaw:   [-12, 12]
 * - head.roll:  [-10, 10]
 * - gaze.x/y:   [-1, 1]
 * - mouth.form: [0, 1]
 * - mouth.open: [0, 1]
 * - eyes.*.open: [0, 1]
 */
export const MO_CATALOG_SOURCE: CatalogSource = {
	motions: {
		nod: {
			description: "点头",
			atomic: true,
			aliases: ["dip"],
			motion: motion(
				500,
				track(
					"head.pitch",
					[
						[0, 0],
						[180, -7],
						[360, 1],
						[500, 0],
					],
					"baseline-offset",
				),
				track(
					"gaze.y",
					[
						[0, 0],
						[180, -0.4],
						[360, 0.1],
						[500, 0],
					],
					"baseline-offset",
				),
			),
		},
		shake: {
			description: "摇头",
			atomic: true,
			aliases: ["no"],
			motion: motion(
				600,
				track(
					"head.yaw",
					[
						[0, 0],
						[150, 6],
						[300, -6],
						[450, 2],
						[600, 0],
					],
					"baseline-offset",
				),
				track(
					"head.roll",
					[
						[0, 0],
						[150, -2],
						[300, 2],
						[450, -1],
						[600, 0],
					],
					"baseline-offset",
				),
			),
		},
		curious: {
			description: "好奇探头",
			atomic: true,
			aliases: ["tilt"],
			motion: motion(
				700,
				track(
					"head.roll",
					[
						[0, 0],
						[220, 5],
						[500, 5],
						[700, 0],
					],
					"baseline-offset",
				),
				track(
					"head.pitch",
					[
						[0, 0],
						[220, 2],
						[500, 2],
						[700, 0],
					],
					"baseline-offset",
				),
				track(
					"mouth.form",
					[
						[0, 0],
						[220, 0.3],
						[500, 0.3],
						[700, 0],
					],
					"baseline-offset",
				),
			),
		},
		greeting: {
			description: "打招呼致意",
			atomic: true,
			aliases: ["wave"],
			motion: motion(
				650,
				track(
					"head.pitch",
					[
						[0, 0],
						[160, 3],
						[360, -3],
						[650, 0],
					],
					"baseline-offset",
				),
				track(
					"mouth.form",
					[
						[0, 0],
						[160, 0.5],
						[500, 0.5],
						[650, 0],
					],
					"baseline-offset",
				),
			),
		},
	},
	postures: {
		attentive: {
			description: "端正专注",
			values: {
				"head.pitch": 1,
				"gaze.y": 0.2,
			},
		},
		lean: {
			description: "前倾倾听",
			values: {
				"head.pitch": 3,
				"gaze.y": 0.3,
			},
		},
	},
	expressions: {
		smile: {
			description: "微笑神态",
			values: {
				"mouth.form": 0.6,
			},
		},
		brighten: {
			description: "明朗开心",
			values: {
				"mouth.form": 0.85,
				"eyes.left.open": 1,
				"eyes.right.open": 1,
			},
		},
	},
	background: {
		thinking: motion(
			1200,
			track("head.roll", [
				[0, 0],
				[300, 2],
				[600, 0],
				[900, -2],
				[1200, 0],
			]),
			track("gaze.y", [
				[0, 0],
				[300, 0.25],
				[600, 0],
				[900, 0.25],
				[1200, 0],
			]),
		),
	},
};

/**
 * 编译 MO 模型目录快照。
 */
export function compileMOCatalog(rig: ModelRig): CatalogSnapshot {
	return compileCatalog(MO_MODEL_ID, MO_CATALOG_SOURCE, rig);
}

/**
 * 按模型身份动态加载匹配的动作目录（未登记模型安全返回 undefined，不抛错）。
 */
export function loadCatalog(modelID: string, rig: ModelRig): CatalogSnapshot | undefined {
	if (modelID === MO_MODEL_ID && rig.modelID === MO_MODEL_ID) {
		return compileMOCatalog(rig);
	}
	return undefined;
}
