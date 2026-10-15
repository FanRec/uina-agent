import { describe, expect, it } from "vitest";
import { compileMOCatalog, MO_CATALOG_SOURCE, loadCatalog } from "../.uina/worlds/live2d/models/mo/catalog.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

describe("MO catalog authoring entries", () => {
	it("ships authored motions and registers all 13 actions with expected aliases", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = compileMOCatalog(rig);
		expect(MO_CATALOG_SOURCE.postures).toBeDefined();
		expect(MO_CATALOG_SOURCE.expressions).toBeDefined();
		expect(catalog.list("posture")).toHaveLength(2);
		expect(catalog.list("expression")).toHaveLength(2);
		expect(catalog.list("ambient")).toHaveLength(1);
		expect(catalog.background.idle).toBeDefined();
		expect(catalog.background.thinking).toBeDefined();
		expect(catalog.resolve("posture", "rest")).toBeUndefined();
		expect(catalog.resolve("expression", "smile")).toBeUndefined();
		expect(catalog.resolve("motion", "sway")).toBeUndefined();
		expect(catalog.resolve("ambient", "sway")).toBeDefined();
		expect(catalog.resolve("ambient", "sway")?.aliases).toContain("摇摆");
		expect(catalog.resolve("ambient", "sway")?.entry.variants).toHaveLength(3);

		const expectedPostures = [
			{ name: "sleep", alias: "睡觉" },
			{ name: "neutral_posture", alias: "正常姿态" },
		];
		for (const { name, alias } of expectedPostures) {
			const entry = catalog.resolve("posture", name);
			expect(entry, `posture '${name}' should be defined`).toBeDefined();
			expect(entry?.name).toBe(name);
			expect(entry?.aliases).toContain(alias);
			expect(catalog.resolve("posture", alias)?.name).toBe(name);
			expect(catalog.resolveCue(alias)?.name).toBe(name);
		}

		const expectedExpressions = [
			{ name: "closed_eyes", alias: "闭眼" },
			{ name: "neutral_expression", alias: "正常表情" },
		];
		for (const { name, alias } of expectedExpressions) {
			const entry = catalog.resolve("expression", name);
			expect(entry, `expression '${name}' should be defined`).toBeDefined();
			expect(entry?.name).toBe(name);
			expect(entry?.aliases).toContain(alias);
			expect(catalog.resolve("expression", alias)?.name).toBe(name);
		}

		const expectedActions = [
			{ name: "nod", alias: "点头" },
			{ name: "shake", alias: "摇头" },
			{ name: "wink", alias: "眨眼" },
			{ name: "curious", alias: "歪头" },
			{ name: "chin_up", alias: "得意昂头" },
			{ name: "head_toss", alias: "傲娇甩头" },
			{ name: "surprise", alias: "惊讶" },
			{ name: "glance", alias: "视线一瞥" },
			{ name: "joy_hop", alias: "雀跃弹跳" },
			{ name: "petrify", alias: "石化" },
			{ name: "close_up", alias: "贴脸" },
			{ name: "edge_peek", alias: "探头偷看" },
			{ name: "spin", alias: "转圈" },
			{ name: "pout", alias: "嘟嘴" },
			{ name: "panic", alias: "慌张" },
			{ name: "sleepy", alias: "打瞌睡" },
			{ name: "smug_laugh", alias: "大笑" },
		];

		for (const { name, alias } of expectedActions) {
			const entry = catalog.resolve("motion", name);
			expect(entry, `motion '${name}' should be defined`).toBeDefined();
			expect(entry?.name).toBe(name);
			expect(entry?.aliases).toContain(alias);
			expect(catalog.resolve("motion", alias)?.name).toBe(name);
		}
	});

	it("keeps model binding and rejects catalogs for unregistered models", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		expect(compileMOCatalog(rig).modelID).toBe(MO_MODEL_ID);
		expect(loadCatalog("unregistered-model", rig)).toBeUndefined();
	});
});
