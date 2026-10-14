import { describe, expect, it } from "vitest";
import { compileMOCatalog, MO_CATALOG_SOURCE, loadCatalog } from "../.uina/worlds/live2d/models/mo/catalog.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

describe("MO catalog after the authoring reset", () => {
	it("ships no migrated motions, ambient clips, idle, or thinking animation", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = compileMOCatalog(rig);
		expect(MO_CATALOG_SOURCE.motions).toBeUndefined();
		expect(catalog.list("motion")).toEqual([]);
		expect(catalog.list("ambient")).toEqual([]);
		expect(catalog.background.idle).toBeUndefined();
		expect(catalog.background.thinking).toBeUndefined();
		expect(catalog.resolve("motion", "nod")).toBeUndefined();
		expect(catalog.resolve("ambient", "sway")).toBeUndefined();
	});

	it("keeps the authored posture and expression state tables", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = compileMOCatalog(rig);
		expect(catalog.list("posture").map(({ name }) => name)).toEqual(["rest", "tuck", "head_back"]);
		expect(catalog.list("expression").map(({ name }) => name)).toEqual(["smile", "smirk", "clear_face"]);
		expect(catalog.resolve("posture", "低头")?.name).toBe("tuck");
		expect(catalog.resolve("expression", "坏笑")?.name).toBe("smirk");
	});

	it("keeps model binding and rejects catalogs for unregistered models", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		expect(compileMOCatalog(rig).modelID).toBe(MO_MODEL_ID);
		expect(loadCatalog("unregistered-model", rig)).toBeUndefined();
	});
});
