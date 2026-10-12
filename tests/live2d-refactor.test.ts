import { describe, expect, it } from "vitest";
import { compileCatalog } from "../.uina/worlds/live2d/authoring/catalog.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";
import { loadCatalog } from "../.uina/worlds/live2d/models/mo/catalog.js";
import { fixtureMotion, refactorClient, refactorRig, refactorRuntime } from "./live2d-refactor-fixture.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

describe("Live2D 架构缺口正式回归", () => {
	it("编译后修改作者值和别名不改变快照", () => {
		const rig = refactorRig();
		const source = { postures: { lean: { description: "lean", values: { "head.yaw": 4 }, aliases: ["initial"] } } };
		const catalog = compileCatalog(rig.modelID, source, rig);
		source.postures.lean.values["head.yaw"] = 9;
		source.postures.lean.aliases.push("late");
		expect(catalog.resolve("posture", "lean")?.entry.values["head.yaw"]).toBe(4);
		expect(catalog.resolve("posture", "lean")?.entry.aliases).toEqual(["initial"]);
	});
	it("实际 MO 的 sway 中文别名均可执行", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const { client, state } = refactorClient(); state.modelID = MO_MODEL_ID;
		const runtime = new Live2DRuntime({ rig, client, catalog: loadCatalog(MO_MODEL_ID, rig) });
		await runtime.start({} as never);
		try { for (const ambient of ["摇摆", "晃动", "摇"]) expect((await runtime.state({ ambient }, {})).status).toBe("succeeded"); }
		finally { await runtime.stop(); }
	});
	it("身份不匹配的姿态 cue 和 state 一致拒绝，cue 不启动", async () => {
		const { runtime, state } = await refactorRuntime({ postures: { lean: { description: "lean", values: { "head.yaw": 4 } } } });
		state.modelID = "different";
		try {
			expect((await runtime.state({ posture: "lean" }, {})).details).toMatchObject({ reason: "unadapted" });
			runtime.endpoint.emitCue("lean");
			await Promise.resolve();
			expect(runtime.endpoint.lastCue().at(-1)).toMatchObject({ state: "rejected", reason: "unadapted" });
		} finally { runtime.director?.invalidateAll(); await runtime.stop(); }
	});
	it("tint 恢复失败不能被 safeStop 位姿布尔值漏报", async () => {
		const { runtime, state } = await refactorRuntime({ motions: { stunt: { description: "stunt", motion: fixtureMotion(), spatial: { segments: [{ delta: { x: 0.1 }, durationMs: 1, effects: { tint: { r: 200, g: 200, b: 200 } } }, { delta: { x: 0 }, durationMs: 1 }] } } } });
		state.failTintRestore = true;
		try {
			const result = await runtime.express({ motion: "stunt" }, {});
			expect(result.status).toBe("unknown");
			await expect(runtime.safeStop()).rejects.toThrow("未确认");
		} finally { await runtime.stop().catch(() => {}); }
	});
	it("后处理基线捕获失败在任何副作用前拒绝", async () => {
		const { runtime, state } = await refactorRuntime({ motions: { stunt: { description: "stunt", motion: fixtureMotion(), spatial: { segments: [{ delta: { x: 0.1 }, durationMs: 1, effects: { postProcessing: { on: true } } }, { delta: { x: 0 }, durationMs: 1 }] } } } });
		state.failRead = true;
		try {
			expect(await runtime.express({ motion: "stunt" }, {})).toMatchObject({ status: "failed", details: { reason: "effect_baseline_unavailable", effectStatus: "not_started" } });
			expect(state.moves).toHaveLength(0); expect(state.posts).toHaveLength(0);
		} finally { await runtime.stop().catch(() => {}); }
	});
	it("仅染色不读取或改写用户后处理；纯效果不移动模型", async () => {
		const { runtime, state } = await refactorRuntime({ motions: { tint: { description: "tint", motion: fixtureMotion(), spatial: { segments: [{ delta: {}, durationMs: 1, effects: { tint: { r: 200, g: 200, b: 200 } } }, { delta: { x: 0 }, durationMs: 1 }] } } } });
		state.failRead = true;
		try {
			const result = await runtime.express({ motion: "tint" }, {});
			expect(state.posts).toHaveLength(0); expect(state.moves).toHaveLength(0);
			expect(result.details).toMatchObject({ cleanup: { pose: "not_needed", tint: "confirmed", post: "not_needed" } });
		} finally { await runtime.stop(); }
	});
	it("模型换代后不向新模型发送旧特效恢复", async () => {
		const { runtime, client, state } = await refactorRuntime({ motions: { tint: { description: "tint", motion: fixtureMotion(), spatial: { segments: [{ delta: { x: 0.1 }, durationMs: 1, effects: { tint: { r: 200, g: 200, b: 200 } } }, { delta: { x: 0 }, durationMs: 1 }] } } } });
		const tint = client.tintModel.bind(client);
		client.tintModel = async (value) => { const result = await tint(value); state.modelGeneration++; return result; };
		try {
			const result = await runtime.express({ motion: "tint" }, {});
			expect(state.tints).toHaveLength(1); expect(state.posts).toHaveLength(0);
			expect(result.details).toMatchObject({ cleanup: { tint: "unknown" } });
		} finally { await runtime.stop().catch(() => {}); }
	});
});
