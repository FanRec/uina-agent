import type { ModelRig } from "../../adapter/rig.js";
import { compileCatalog, type CatalogSnapshot, type CatalogSource } from "../../authoring/catalog.js";
import { MO_MODEL_ID } from "../rig-loader.js";

/** Static state affordances remain model-authored; finite animation content will be rebuilt later. */
export const MO_CATALOG_SOURCE: CatalogSource = {
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
		clear_face: {
			description: "清除表情",
			aliases: ["自然脸", "恢复平静"],
			values: {},
			transitionMs: 350,
		},
	},
};

export function compileMOCatalog(rig: ModelRig): CatalogSnapshot {
	return compileCatalog(MO_MODEL_ID, MO_CATALOG_SOURCE, rig);
}

export function loadCatalog(modelID: string, rig: ModelRig): CatalogSnapshot | undefined {
	if (modelID === MO_MODEL_ID && rig.modelID === MO_MODEL_ID) return compileMOCatalog(rig);
	return undefined;
}
