import { describe, expect, it } from "vitest";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";
import { compileMOCatalog, loadCatalog } from "../.uina/worlds/live2d/models/mo/catalog.js";

describe("MO 动作目录装配 (compileMOCatalog & loadCatalog)", () => {
	it("基于真实 rig.json 成功编译 MO 目录且不越界，伴随动作采用 baseline-offset 增量空间", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = compileMOCatalog(rig);

		expect(catalog.modelID).toBe(MO_MODEL_ID);
		// 校验 motions 存在与别名
		expect(catalog.motions.has("nod")).toBe(true);
		expect(catalog.motions.has("shake")).toBe(true);
		expect(catalog.motions.has("curious")).toBe(true);
		expect(catalog.motions.has("greeting")).toBe(true);
		expect(catalog.motions.get("nod")?.aliases).toContain("dip");

		// 核心物理约束校验：伴随动作必须是 baseline-offset（Additive 增量），绝不抢占基础姿态
		const nodMotion = catalog.motions.get("nod")!.motion;
		expect(nodMotion.tracks.every((t) => t.space === "baseline-offset")).toBe(true);

		// 校验 postures
		expect(catalog.postures.has("attentive")).toBe(true);
		expect(catalog.postures.has("lean")).toBe(true);

		// 校验 expressions
		expect(catalog.expressions.has("smile")).toBe(true);
		expect(catalog.expressions.has("brighten")).toBe(true);

		// 校验 background.thinking
		expect(catalog.background.thinking).toBeDefined();

		// loadCatalog 动态解耦验证
		expect(loadCatalog(MO_MODEL_ID, rig)).toBeDefined();
		expect(loadCatalog("other-model", rig)).toBeUndefined();
	});
});
