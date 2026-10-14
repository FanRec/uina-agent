import { describe, expect, it } from "vitest";
import { compileMotion, sampleMotion } from "../.uina/worlds/live2d/authoring/motion.js";
import { compileMOCatalog, loadCatalog, MO_CATALOG_SOURCE } from "../.uina/worlds/live2d/models/mo/catalog.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

/** MO 目录装配；nod 保留标定峰值，其幅度纹理在 bake 时由共享参数决定。 */
const MOTION_NAMES = [
	"nod",
	"shake",
	"wink",
	"curious",
	"chin_up",
	"head_toss",
	"alert",
	"startle",
	"surprise",
	"glance",
	"eye_roll",
	"double_take",
	"joy_hop",
	"petrify",
	"close_up",
	"edge_peek",
	"spin",
];

describe("MO 目录装配（loadCatalog & compileMOCatalog）", () => {
	it("基于真实 rig.json 编译 17 个命名动作，别名可达，移除项不可达", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = compileMOCatalog(rig);
		expect(catalog.modelID).toBe(MO_MODEL_ID);
		expect(catalog.list("motion").map((record) => record.name)).toEqual(MOTION_NAMES);
		for (const name of MOTION_NAMES) expect(catalog.resolve("motion", name) !== undefined).toBe(true);
		expect(catalog.resolve("motion", "点头")!.name).toBe("nod");
		expect(catalog.resolve("motion", "转圈圈")!.name).toBe("spin");
		for (const removed of ["greeting", "wave", "freeze", "music_groove"])
			expect(catalog.resolve("motion", removed) !== undefined).toBe(false);
	});

	it("nod 全通道为 baseline-offset（伴随动作绝不抢占基础姿态），bake 逐字复现标定值", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const entry = compileMOCatalog(rig).resolve("motion", "nod")!.entry;
		const clip = compileMotion(entry.definition, rig.controls, () => 0.5); // rng=0.5 → 纹理增益恰为 1
		expect(clip.durationMs).toBe(950);
		expect(clip.channels.every((channel) => channel.space === "baseline-offset")).toBe(true);
		const frame = sampleMotion(clip, 320);
		const neutral = rig.controls["head.pitch"]!.neutral;
		expect(frame["head.pitch"]! - neutral).toBeCloseTo(-9.8, 6);
	});

	it("bake 期幅度纹理：rng=0.5 精确复现标定值，rng=0 幅度 -6%（有界轻重变化）", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const definition = MO_CATALOG_SOURCE.motions!.nod!.motion;
		const tuned = sampleMotion(
			compileMotion(definition, rig.controls, () => 0.5),
			320,
		);
		const textured = sampleMotion(
			compileMotion(definition, rig.controls, () => 0),
			320,
		);
		const neutral = rig.controls["head.pitch"]!.neutral;
		// gain 1 vs gain 0.94：textured 偏差更小，差值 = 峰值 × spread
		expect(textured["head.pitch"]! - tuned["head.pitch"]!).toBeCloseTo(9.8 * 0.06, 1);
		// 纹理只作用于增量幅度：相对中性值的偏差按比例缩放，不产生符号翻转或时序漂移
		expect(Math.sign(textured["head.pitch"]! - neutral)).toBe(-1);
	});

	it("postures / expressions / ambient / background 词表完整", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = compileMOCatalog(rig);
		expect(catalog.list("posture").map((record) => record.name)).toEqual(["rest", "tuck", "head_back"]);
		expect(catalog.list("expression").map((record) => record.name)).toEqual(["smile", "smirk", "clear_face"]);
		expect(catalog.resolve("ambient", "摇摆")!.name).toBe("sway");
		expect(catalog.resolve("ambient", "sway")!.entry.variants).toHaveLength(3);
		expect(catalog.background.idle).toBeDefined();
		expect(catalog.background.thinking).toBeDefined();
	});

	it("spatial 特技登记完整：spin 整圈 relative 旋转、petrify 携带染色、joy_hop 五段", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = compileMOCatalog(rig);
		const spin = catalog.resolve("motion", "spin")!.entry;
		expect(spin.spatial!.segments.map((segment) => segment.relativeRotation ?? null)).toEqual([
			null,
			null,
			359,
			null,
			null,
		]);
		const petrify = catalog.resolve("motion", "petrify")!.entry;
		expect(petrify.playback).toMatchObject({ inhibitAdditives: true });
		expect(petrify.spatial!.segments[0]!.effects!.tint).toMatchObject({ r: 110, g: 115, b: 125 });
		expect(catalog.resolve("motion", "joy_hop")!.entry.spatial!.segments).toHaveLength(5);
	});

	it("未登记模型返回 undefined（诚实零输出）", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		expect(loadCatalog("unregistered-model", rig)).toBeUndefined();
	});
});
