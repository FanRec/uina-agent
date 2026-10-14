import { describe, expect, it } from "vitest";
import { compileMOCatalog, MO_CATALOG_SOURCE, loadCatalog } from "../.uina/worlds/live2d/models/mo/catalog.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

describe("MO catalog after the authoring reset", () => {
	it("ships no old motion, state, or background entries", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = compileMOCatalog(rig);
		expect(MO_CATALOG_SOURCE.motions).toBeUndefined();
		expect(MO_CATALOG_SOURCE.postures).toBeUndefined();
		expect(MO_CATALOG_SOURCE.expressions).toBeUndefined();
		expect(catalog.list("motion")).toEqual([]);
		expect(catalog.list("posture")).toEqual([]);
		expect(catalog.list("expression")).toEqual([]);
		expect(catalog.list("ambient")).toEqual([]);
		expect(catalog.background.idle).toBeUndefined();
		expect(catalog.background.thinking).toBeUndefined();
		expect(catalog.resolve("motion", "nod")).toBeUndefined();
		expect(catalog.resolve("posture", "rest")).toBeUndefined();
		expect(catalog.resolve("expression", "smile")).toBeUndefined();
		expect(catalog.resolve("ambient", "sway")).toBeUndefined();
	});

	it("keeps model binding and rejects catalogs for unregistered models", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		expect(compileMOCatalog(rig).modelID).toBe(MO_MODEL_ID);
		expect(loadCatalog("unregistered-model", rig)).toBeUndefined();
	});
});
