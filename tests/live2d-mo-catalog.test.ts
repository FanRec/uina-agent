import { describe, expect, it } from "vitest";
import { loadCatalog } from "../.uina/worlds/live2d/models/mo/catalog.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

/**
 * MO 目录装配（曲线函数模型重写期）：
 * 旧曲线树目录已整体退役至 catalog-bak.ts.txt（动作设计参考）。
 * 当前 loadCatalog 返回诚实空目录——一切命名参数显式拒绝，正式内容按
 * docs/proposals/live2d-curve-authoring-design.md 批次 4 另案重写。
 */
describe("MO 目录装配（loadCatalog）", () => {
	it("MO 模型返回诚实空目录：全部词表为空，命名一律不可达", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = loadCatalog(MO_MODEL_ID, rig)!;
		expect(catalog.modelID).toBe(MO_MODEL_ID);
		expect(catalog.list("motion")).toEqual([]);
		expect(catalog.list("posture")).toEqual([]);
		expect(catalog.list("expression")).toEqual([]);
		expect(catalog.list("attention").map((record) => record.name)).toEqual([
			"user",
			"screen",
			"avert_down",
			"avert_left",
			"avert_right",
		]);
		expect(catalog.list("ambient")).toEqual([]);
		expect(catalog.list("costume")).toEqual([]);
		expect(catalog.resolveCue("nod")).toBeUndefined();
		expect(catalog.resolve("motion", "wink")).toBeUndefined();
		expect(catalog.background.idle).toBeUndefined();
		expect(catalog.background.thinking).toBeUndefined();
	});

	it("未登记模型返回 undefined（诚实零输出）", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		expect(loadCatalog("unregistered-model", rig)).toBeUndefined();
	});
});
