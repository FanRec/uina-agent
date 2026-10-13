import { describe, expect, it, vi } from "vitest";
import { compileCatalog, emptyCatalog } from "../.uina/worlds/live2d/authoring/catalog.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";
import { fixtureMotion, refactorClient, refactorRig, refactorRuntime } from "./live2d-refactor-fixture.js";
import { perfCatalogSource } from "./live2d-mo-fixture.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import {
	compileMotion,
	keys,
	motion,
	absolute,
	sampleMotion,
	withSpeech,
} from "../.uina/worlds/live2d/authoring/motion.js";

describe("Live2D 架构缺口正式回归", () => {
	it("state 最后一项等待后换代也不能报告旧意图成功", async () => {
		const { runtime } = await refactorRuntime({});
		try {
			const pending = runtime.state({ attention: "screen" }, {});
			runtime.setCatalog(emptyCatalog(refactorRig().modelID));
			await expect(pending).resolves.toMatchObject({
				status: "cancelled",
				details: { reason: "stale_catalog", applied: ["screen"] },
			});
			expect(runtime.director!.getAttention()).toBeUndefined();
		} finally {
			await runtime.stop();
		}
	});
	it("停止等待中迟到的 ready 回调不能遗留注入时钟", async () => {
		vi.useFakeTimers();
		const { runtime, client, state } = await refactorRuntime({
			costumes: [{ id: "glasses", description: "glasses", hotkeyID: "hk" }],
		});
		let finish: () => void = () => {};
		client.triggerHotkey = () =>
			new Promise((resolve) => {
				finish = () => resolve({});
			});
		try {
			const pending = runtime.costume({ item: "glasses" }, {});
			const stopped = runtime.stop();
			state.listener(true);
			finish();
			await pending;
			await stopped;
			expect(JSON.parse(runtime.diagnose()).clockRunning).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
	it("全部作者嵌套内容隔离，消费者修改被拒绝，语音覆写仍读固定定义", () => {
		const rig = refactorRig();
		const definition = motion(5, {
			"head.yaw": absolute(
				keys([
					[0, 0],
					[5, 0],
				]),
			),
		});
		const source = {
			motions: {
				act: {
					description: "act",
					motion: definition,
					variants: [definition],
					playback: { fadeInMs: 10 },
					spatial: {
						segments: [
							{ delta: { x: 0.1 }, durationMs: 1, effects: { tint: { r: 200, g: 200, b: 200 } } },
							{ delta: { x: 0 }, durationMs: 1 },
						],
					},
				},
			},
			attentions: { window: { description: "window", target: { x: 0.2, y: 0.1 } } },
			costumes: [{ id: "glasses", description: "glasses", hotkeyID: "old" }],
		};
		const catalog = compileCatalog(rig.modelID, source, rig);
		source.motions.act.playback.fadeInMs = 999;
		source.motions.act.spatial.segments[0]!.delta.x = 9;
		source.motions.act.spatial.segments[0]!.effects!.tint.r = 0;
		source.attentions.window.target.x = 9;
		source.costumes[0]!.hotkeyID = "new";
		const act = catalog.resolve("motion", "act")!.entry;
		expect(act.spatial!.segments[0]).toMatchObject({ delta: { x: 0.1 }, effects: { tint: { r: 200 } } });
		expect(act.playback!.fadeInMs).toBe(10);
		expect(catalog.resolve("attention", "window")!.entry.target).toEqual({ x: 0.2, y: 0.1 });
		expect(catalog.resolve("costume", "glasses")!.entry.hotkeyID).toBe("old");
		expect(sampleMotion(compileMotion(withSpeech(act.variants![0]!, "exclusive"), rig.controls), 5)["head.yaw"]).toBe(
			0,
		);
		expect(Reflect.set(catalog.list("motion"), "0", undefined)).toBe(false);
		expect(Reflect.set(act.spatial!.segments[0]!.delta!, "x", 99)).toBe(false);
	});
	it("组合 state 全部名字预校验，途中取消不施加余项也不回滚姿态", async () => {
		const { runtime } = await refactorRuntime({
			postures: { lean: { description: "lean", values: { "head.yaw": 4 }, transitionMs: 200 } },
		});
		const control = await refactorRuntime({
			postures: { lean: { description: "lean", values: { "head.yaw": 4 }, transitionMs: 200 } },
		});
		try {
			expect((await runtime.state({ posture: "lean", attention: "missing" }, {})).status).toBe("failed");
			runtime.composeTick(800);
			control.runtime.composeTick(800);
			expect(runtime.director!.currentFrame).toEqual(control.runtime.director!.currentFrame);
			const controller = new AbortController();
			const pending = runtime.state({ posture: "lean", attention: "screen" }, { signal: controller.signal });
			controller.abort();
			await expect(pending).resolves.toMatchObject({ status: "cancelled", details: { applied: ["lean"] } });
			expect(runtime.director!.getAttention()).toBeUndefined();
			for (let i = 0; i < 50; i++) runtime.composeTick(16);
			expect(runtime.director!.currentFrame["head.yaw"]).toBeGreaterThan(2);
		} finally {
			await runtime.stop();
			await control.runtime.stop();
		}
	});
	it("组合 state 等待期间换代，不向新目录施加余项", async () => {
		const { runtime } = await refactorRuntime({
			postures: { lean: { description: "lean", values: { "head.yaw": 4 }, transitionMs: 200 } },
		});
		try {
			const pending = runtime.state({ posture: "lean", attention: "screen" }, {});
			runtime.setCatalog(emptyCatalog(refactorRig().modelID));
			await expect(pending).resolves.toMatchObject({ status: "cancelled", details: { reason: "stale_catalog" } });
			expect(runtime.director!.getAttention()).toBeUndefined();
		} finally {
			await runtime.stop();
		}
	});
	it("safeStop 结束持续状态等待，resume 保留已接受的姿态", async () => {
		const { runtime } = await refactorRuntime({
			postures: { lean: { description: "lean", values: { "head.yaw": 4 }, transitionMs: 200 } },
		});
		let status: string | undefined;
		void runtime.state({ posture: "lean" }, {}).then((result) => {
			status = result.status;
		});
		try {
			await runtime.safeStop();
			for (let i = 0; i < 8; i++) await Promise.resolve();
			expect(status).toBe("cancelled");
			await runtime.resume();
			for (let i = 0; i < 50; i++) runtime.composeTick(16);
			expect(runtime.director!.currentFrame["head.yaw"]).toBeGreaterThan(3);
		} finally {
			await runtime.stop();
		}
	});
	it("safeStop 后姿态 cue 也结束账本等待，不永久 started", async () => {
		const { runtime } = await refactorRuntime({
			postures: { lean: { description: "lean", values: { "head.yaw": 4 }, transitionMs: 200 } },
		});
		try {
			runtime.endpoint.emitCue("lean");
			await runtime.safeStop();
			for (let i = 0; i < 8; i++) await Promise.resolve();
			expect(runtime.endpoint.lastCue().at(-1)).toMatchObject({ state: "finished", reason: "cancelled" });
		} finally {
			await runtime.stop();
		}
	});
	it("未启动和已停止的保留引用都不接受意图、不报告在线", async () => {
		const rig = refactorRig();
		const { client } = refactorClient();
		const runtime = new Live2DRuntime({ rig, client, catalog: emptyCatalog(rig.modelID) });
		expect(runtime.endpoint.state().online).toBe(false);
		expect((await runtime.state({}, {})).status).toBe("not_started");
		await runtime.start({} as never);
		await runtime.stop();
		expect(runtime.endpoint.state().online).toBe(false);
		expect((await runtime.state({}, {})).status).toBe("not_started");
	});
	it("启动连接抛错回滚登记和订阅，保留启动原因", async () => {
		const rig = refactorRig();
		const { client, state } = refactorClient();
		const exposed = new Set<string>();
		let off = 0;
		client.connect = () => {
			throw new Error("connect failed");
		};
		const runtime = new Live2DRuntime({ rig, client, catalog: emptyCatalog(rig.modelID) });
		await expect(
			runtime.start({
				expose(name: string) {
					exposed.add(name);
					return () => {
						exposed.delete(name);
					};
				},
				onHostEvent() {
					return () => {
						off++;
					};
				},
			} as never),
		).rejects.toThrow("connect failed");
		expect(exposed.size).toBe(0);
		expect(off).toBe(1);
		expect(state.disconnects).toBe(1);
		expect(runtime.endpoint.state().online).toBe(false);
	});
	it("编译后修改作者值和别名不改变快照", () => {
		const rig = refactorRig();
		const source = { postures: { lean: { description: "lean", values: { "head.yaw": 4 }, aliases: ["initial"] } } };
		const catalog = compileCatalog(rig.modelID, source, rig);
		source.postures.lean.values["head.yaw"] = 9;
		source.postures.lean.aliases.push("late");
		expect(catalog.resolve("posture", "lean")?.entry.values["head.yaw"]).toBe(4);
		expect(catalog.resolve("posture", "lean")?.entry.aliases).toEqual(["initial"]);
	});
	it("夹具目录的 sway 中文别名均可执行（别名解析 → ambient 选择）", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const { client, state } = refactorClient();
		state.modelID = MO_MODEL_ID;
		const catalog = compileCatalog(MO_MODEL_ID, perfCatalogSource(), rig);
		const runtime = new Live2DRuntime({ rig, client, catalog });
		await runtime.start({} as never);
		try {
			for (const ambient of ["摇摆", "晃动", "摇"])
				expect((await runtime.state({ ambient }, {})).status).toBe("succeeded");
		} finally {
			await runtime.stop();
		}
	});
	it("身份不匹配的姿态 cue 和 state 一致拒绝，cue 不启动", async () => {
		const { runtime, state } = await refactorRuntime({
			postures: { lean: { description: "lean", values: { "head.yaw": 4 } } },
		});
		state.modelID = "different";
		try {
			expect((await runtime.state({ posture: "lean" }, {})).details).toMatchObject({ reason: "unadapted" });
			runtime.endpoint.emitCue("lean");
			await Promise.resolve();
			expect(runtime.endpoint.lastCue().at(-1)).toMatchObject({ state: "rejected", reason: "unadapted" });
		} finally {
			runtime.director?.invalidateAll();
			await runtime.stop();
		}
	});
	it("tint 恢复失败不能被 safeStop 位姿布尔值漏报", async () => {
		const { runtime, state } = await refactorRuntime({
			motions: {
				stunt: {
					description: "stunt",
					motion: fixtureMotion(),
					spatial: {
						segments: [
							{ delta: { x: 0.1 }, durationMs: 1, effects: { tint: { r: 200, g: 200, b: 200 } } },
							{ delta: { x: 0 }, durationMs: 1 },
						],
					},
				},
			},
		});
		state.failTintRestore = true;
		try {
			const result = await runtime.express({ motion: "stunt" }, {});
			expect(result.status).toBe("unknown");
			await expect(runtime.safeStop()).rejects.toThrow("未确认");
		} finally {
			await runtime.stop().catch(() => {});
		}
	});
	it("后处理基线捕获失败在任何副作用前拒绝", async () => {
		const { runtime, state } = await refactorRuntime({
			motions: {
				stunt: {
					description: "stunt",
					motion: fixtureMotion(),
					spatial: {
						segments: [
							{ delta: { x: 0.1 }, durationMs: 1, effects: { postProcessing: { on: true } } },
							{ delta: { x: 0 }, durationMs: 1 },
						],
					},
				},
			},
		});
		state.failRead = true;
		try {
			expect(await runtime.express({ motion: "stunt" }, {})).toMatchObject({
				status: "failed",
				details: { reason: "effect_baseline_unavailable", effectStatus: "not_started" },
			});
			expect(state.moves).toHaveLength(0);
			expect(state.posts).toHaveLength(0);
		} finally {
			await runtime.stop().catch(() => {});
		}
	});
	it("仅染色不读取或改写用户后处理；纯效果不移动模型", async () => {
		const { runtime, state } = await refactorRuntime({
			motions: {
				tint: {
					description: "tint",
					motion: fixtureMotion(),
					spatial: {
						segments: [
							{ delta: {}, durationMs: 1, effects: { tint: { r: 200, g: 200, b: 200 } } },
							{ delta: { x: 0 }, durationMs: 1 },
						],
					},
				},
			},
		});
		state.failRead = true;
		try {
			const result = await runtime.express({ motion: "tint" }, {});
			expect(state.posts).toHaveLength(0);
			expect(state.moves).toHaveLength(0);
			expect(result.details).toMatchObject({ cleanup: { pose: "not_needed", tint: "confirmed", post: "not_needed" } });
		} finally {
			await runtime.stop();
		}
	});
	it("模型换代后不向新模型发送旧特效恢复", async () => {
		const { runtime, client, state } = await refactorRuntime({
			motions: {
				tint: {
					description: "tint",
					motion: fixtureMotion(),
					spatial: {
						segments: [
							{ delta: { x: 0.1 }, durationMs: 1, effects: { tint: { r: 200, g: 200, b: 200 } } },
							{ delta: { x: 0 }, durationMs: 1 },
						],
					},
				},
			},
		});
		const tint = client.tintModel.bind(client);
		client.tintModel = async (value) => {
			const result = await tint(value);
			state.modelGeneration++;
			state.modelID = "replacement";
			return result;
		};
		try {
			const result = await runtime.express({ motion: "tint" }, {});
			expect(state.tints).toHaveLength(1);
			expect(state.posts).toHaveLength(0);
			expect(state.moves).toHaveLength(0);
			expect(result.details).toMatchObject({ cleanup: { tint: "unknown" } });
		} finally {
			await runtime.stop().catch(() => {});
		}
	});
});
