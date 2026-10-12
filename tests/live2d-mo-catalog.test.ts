import { describe, expect, it } from "vitest";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";
import { compileMOCatalog, loadCatalog } from "../.uina/worlds/live2d/models/mo/catalog.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import { unconfirmedInjections } from "./live2d-injection-fixture.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import type { ModelProfile } from "../.uina/worlds/live2d/adapter/profile.js";

const makeFakeClient = (modelID = MO_MODEL_ID) => {
	const state = {
		connected: true,
		profile: { modelID, physicsOutputs: [] } as unknown as ModelProfile,
	};
	return {
		...unconfirmedInjections(),
		isConnected: () => state.connected,
		getModelProfile: () => state.profile,
		injectParameters: () => {},
		setConnectionChangeListener: () => {},
		connect: () => {},
		disconnect: () => {},
		getConnectionStatus: () => ({ connected: state.connected }),
		findHotkey: () => undefined,
	} as unknown as VTSClient;
};

describe("MO 动作目录装配 (compileMOCatalog & loadCatalog)", () => {
	it("基于真实 rig.json 成功编译 MO 目录且不越界，伴随动作采用 baseline-offset 增量空间", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = compileMOCatalog(rig);

		expect(catalog.modelID).toBe(MO_MODEL_ID);
		// 校验 motions 存在与别名
		expect((catalog.resolve("motion", "nod") !== undefined)).toBe(true);
		expect((catalog.resolve("motion", "shake") !== undefined)).toBe(true);
		expect((catalog.resolve("motion", "curious") !== undefined)).toBe(true);
		expect((catalog.resolve("motion", "petrify") !== undefined)).toBe(true);
		expect((catalog.resolve("motion", "close_up") !== undefined)).toBe(true);
		expect((catalog.resolve("motion", "edge_peek") !== undefined)).toBe(true);
		expect((catalog.resolve("motion", "spin") !== undefined)).toBe(true);
		expect(catalog.list("motion").length).toBe(17);
		for (const removed of ["greeting", "wave", "freeze", "music_groove"])
			expect((catalog.resolve("motion", removed) !== undefined)).toBe(false);

		// 核心物理约束校验：伴随动作必须是 baseline-offset（Additive 增量），绝不抢占基础姿态
		const nodMotion = catalog.resolve("motion", "nod")!.entry.motion;
		expect(nodMotion.tracks.every((t) => t.space === "baseline-offset")).toBe(true);

		// 校验 postures
		expect(catalog.list("posture").map((record) => record.name)).toEqual(["rest", "tuck", "head_back"]);

		// 校验 expressions
		expect((catalog.resolve("expression", "smile") !== undefined)).toBe(true);
		expect(catalog.list("expression").map((record) => record.name)).toEqual(["smile", "smirk", "clear_face"]);

		// 校验 background.thinking
		expect(catalog.background.thinking).toBeDefined();
		expect(catalog.background.idle).toBeDefined();

		// 校验 ambient 环境循环（皮套式摇摆已升级为 2000ms 黄金节奏闭环）
		expect(catalog.resolve("ambient", "sway")?.entry).toMatchObject({ description: expect.stringContaining("摇摆") });
		expect(catalog.resolve("ambient", "sway")!.entry.motion.durationMs).toBe(2000);

		// loadCatalog 动态解耦验证
		expect(loadCatalog(MO_MODEL_ID, rig)).toBeDefined();
		expect(loadCatalog("other-model", rig)).toBeUndefined();
	});

	it("别名反查与注视映射 (findMotion / findSlot / resolveAttention)", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = compileMOCatalog(rig);

		// 动作别名
		expect(catalog.resolve("motion", "点头")?.entry).toBe(catalog.resolve("motion", "nod")?.entry);
		expect(catalog.resolve("motion", "nod")?.entry).toBe(catalog.resolve("motion", "nod")?.entry);
		expect(catalog.resolve("motion", "石化")?.entry).toBe(catalog.resolve("motion", "petrify")?.entry);
		expect(catalog.resolve("motion", "转圈")?.entry).toBe(catalog.resolve("motion", "spin")?.entry);
		expect(catalog.resolve("motion", "摇摇头")?.entry).toBeUndefined();

		// 姿态别名
		expect(catalog.resolve("posture", "低头")?.entry).toBe(catalog.resolve("posture", "tuck")?.entry);
		expect(catalog.resolve("posture", "tuck")?.entry).toBe(catalog.resolve("posture", "tuck")?.entry);
		expect(catalog.resolve("posture", "自然站立")?.entry).toBe(catalog.resolve("posture", "rest")?.entry);

		// 表情别名
		expect(catalog.resolve("expression", "微笑")?.entry).toBe(catalog.resolve("expression", "smile")?.entry);
		expect(catalog.resolve("expression", "坏笑")?.entry).toBe(catalog.resolve("expression", "smirk")?.entry);

		// 注视解析（内置 + 中文别名）
		expect(catalog.resolve("attention", "看对方")?.entry.target).toBe("user");
		expect(catalog.resolve("attention", "user")?.entry.target).toBe("user");
		expect(catalog.resolve("attention", "看屏幕")?.entry.target).toBe("screen");
		expect(catalog.resolve("attention", "screen")?.entry.target).toBe("screen");
		expect(catalog.resolve("attention", "垂眸")?.entry.target).toBe("avert_down");
		expect(catalog.resolve("attention", "看下方")?.entry.target).toBe("avert_down");
		expect(catalog.resolve("attention", "看左侧")?.entry.target).toBe("avert_left");
		expect(catalog.resolve("attention", "看右侧")?.entry.target).toBe("avert_right");
		expect(catalog.resolve("attention", "天花板")?.entry.target).toBeUndefined();
	});

	it("Endpoint cue 解析对姿态与动作别名均可命中", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = compileMOCatalog(rig);
		const runtime = new Live2DRuntime({
			client: makeFakeClient(),
			rig,
			catalog,
		});
		const endpoint = runtime.endpoint;

		expect(endpoint.supportsCue?.("点头")).toBe(true);
		expect(endpoint.supportsCue?.("nod")).toBe(true);
		expect(endpoint.supportsCue?.("石化")).toBe(true);
		expect(endpoint.supportsCue?.("转圈圈")).toBe(true);
		expect(endpoint.supportsCue?.("凑近")).toBe(true);
		expect(endpoint.supportsCue?.("探头")).toBe(true);
		expect(endpoint.supportsCue?.("低头")).toBe(true);
		expect(endpoint.supportsCue?.("tuck")).toBe(true);
		expect(endpoint.supportsCue?.("微笑")).toBe(false); // 表情走工具，不是伴随 cue
	});

	it("Runtime 工具单轮自愈报错列出当前模型候选项，成功返回朴素说人话", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = compileMOCatalog(rig);
		const runtime = new Live2DRuntime({
			client: makeFakeClient(),
			rig,
			catalog,
		});
		const ctx = { signal: new AbortController().signal };

		// 动作传错自愈
		const motionRes = await runtime.express({ motion: "invalid_dance" }, ctx);
		expect(motionRes.status).toBe("failed");
		expect(motionRes.result).toContain('动作不在当前模型目录: "invalid_dance"');
		expect(motionRes.result).toContain("nod(点头)");
		expect(motionRes.result).toContain("shake(摇头)");

		// 姿势传错自愈
		const postureRes = await runtime.state({ posture: "flying" }, ctx);
		expect(postureRes.status).toBe("failed");
		expect(postureRes.result).toContain('姿态不在当前模型目录: "flying"');
		expect(postureRes.result).toContain("rest(自然站立/自然站定)");
		expect(postureRes.result).toContain("tuck(低头/垂头收拢)");

		// 表情传错自愈
		const expRes = await runtime.state({ expression: "crying" }, ctx);
		expect(expRes.status).toBe("failed");
		expect(expRes.result).toContain('表情不在当前模型目录: "crying"');
		expect(expRes.result).toContain("smile(微笑/明朗笑)");

		// 注视传错自愈
		const attRes = await runtime.state({ attention: "sky" }, ctx);
		expect(attRes.status).toBe("failed");
		expect(attRes.result).toContain('注视目标不在词表: "sky"');
		expect(attRes.result).toContain("user(看对方/用户/看用户)");

		// 成功返回朴素文案，支持别名
		const pPosture = runtime.state({ posture: "低头" }, ctx);
		for (let i = 0; i < 60; i++) runtime.composeTick(16);
		const okPosture = await pPosture;
		expect(okPosture.status).toBe("succeeded");
		expect(okPosture.result).toBe("低头 OK");

		const pExp = runtime.state({ expression: "微笑" }, ctx);
		for (let i = 0; i < 60; i++) runtime.composeTick(16);
		const okExp = await pExp;
		expect(okExp.status).toBe("succeeded");
		expect(okExp.result).toBe("微笑 OK");

		const okAtt = await runtime.state({ attention: "看对方" }, ctx);
		expect(okAtt.status).toBe("succeeded");
		expect(okAtt.result).toBe("看对方 OK");
	});
});
