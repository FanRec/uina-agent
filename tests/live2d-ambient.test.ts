import { unconfirmedInjections } from "./live2d-injection-fixture.js";
import { describe, expect, it } from "vitest";
import type { ActionContext, ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../src/tools/broker.js";
import type { ModelProfile } from "../.uina/worlds/live2d/adapter/profile.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { compileCatalog, type CatalogSnapshot, type CatalogSource } from "../.uina/worlds/live2d/authoring/catalog.js";
import { motion, track } from "../.uina/worlds/live2d/authoring/motion.js";
import { createLive2DApp } from "../.uina/worlds/live2d/index.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

/**
 * ambient 环境循环：目录词表编译（含全局命名空间 claim）+ 运行时静止态槽位生命周期
 * （选择替换 idle / 清除回落 / 幂等 / interrupt 不影响 / 目录更替清空）+ 工具面接线。
 *
 * 合成推进纯函数化：composeTick 手工步进；客户端用鸭子类型假体。
 */

const MODEL_ID = "fixture-model";

const makeRig = (): ModelRig => ({
	version: 3,
	modelID: MODEL_ID,
	controls: {
		"head.yaw": { min: -12, max: 12, neutral: 0 },
	},
	bindings: {
		"head.yaw": [
			{
				parameter: "ParamAngleX",
				input: "FaceAngleX",
				points: [
					[-12, -30],
					[0, 0],
					[12, 30],
				],
				followers: [],
				physicsFollowers: [],
				smoothing: 0,
			},
		],
	},
	external: { blink: "uina", breath: "vts" },
});

const swayLoop = (amplitude: number) =>
	motion(
		3200,
		track("head.yaw", [
			[0, 0],
			[800, amplitude],
			[1600, 0],
			[2400, -amplitude],
			[3200, 0],
		]),
	);

const makeCatalogSource = (): CatalogSource => ({
	motions: {
		nod: {
			description: "点头",
			motion: motion(
				500,
				track("head.yaw", [
					[0, 6],
					[500, 6],
				]),
			),
		},
	},
	background: {
		idle: swayLoop(3),
		ambient: {
			sway: { description: "左右摇摆", aliases: ["摇摆"], motion: swayLoop(8) },
		},
	},
});

const makeCatalog = (source = makeCatalogSource()): CatalogSnapshot => compileCatalog(MODEL_ID, source, makeRig());

const makeProfile = (modelID = MODEL_ID): ModelProfile => ({ modelID, physicsOutputs: [] }) as unknown as ModelProfile;

/** 鸭子类型假客户端：记录注入帧序列供幅值断言。 */
const makeFakeClient = (options: { connected?: boolean; modelID?: string } = {}) => {
	const state = {
		connected: options.connected ?? true,
		profile: makeProfile(options.modelID),
		injected: [] as { id: string; value: number }[][],
	};
	const client = {
		...unconfirmedInjections(),
		isConnected: () => state.connected,
		getModelProfile: () => state.profile,
		injectParameters: (frame: { id: string; value: number }[]) => {
			state.injected.push(frame);
		},
		setConnectionChangeListener: (_listener: (connected: boolean) => void) => {},
		connect: () => {},
		disconnect: () => {},
		getConnectionStatus: () => ({ connected: state.connected }),
		findHotkey: () => undefined,
		reloadCurrentModel: async () => {},
	} as unknown as VTSClient;
	return { client, state };
};

const harness = async (catalog: CatalogSnapshot = makeCatalog()) => {
	const fake = makeFakeClient();
	const runtime = new Live2DRuntime({ client: fake.client, rig: makeRig(), catalog, rng: () => 0.5 });
	const app = createLive2DApp({ instance: runtime });
	const startCtx = {
		expose: () => () => {},
		signal: new AbortController().signal,
	} as unknown as ServiceCompanionContext;
	await app.onStart!(startCtx);
	const ctx = { signal: new AbortController().signal, operationIdentity: {} } as unknown as ActionContext;
	const run = (action: string, args: Record<string, unknown>): Promise<ToolExecutionResult> =>
		app.actions[action]!.run(args, ctx) as Promise<ToolExecutionResult>;
	const status = async () =>
		JSON.parse(await runtime.formatStatus()) as {
			catalog: { ambient: { available: { id: string; description: string }[]; current: string | null } };
		};
	const stepMs = (totalMs: number, step = 16): void => {
		for (let i = 0; i < Math.ceil(totalMs / step); i++) runtime.composeTick(step);
	};
	/** 稳定后采样一个完整循环周期的 FaceAngleX 幅值。 */
	const yawAmplitude = (): number => {
		const from = fake.state.injected.length;
		stepMs(3200);
		const values = fake.state.injected
			.slice(from)
			.flatMap((frame) => frame.filter((p) => p.id === "FaceAngleX").map((p) => Math.abs(p.value)));
		return Math.max(...values);
	};
	return { app, runtime, fake, run, status, stepMs, yawAmplitude };
};

describe("live2d ambient 环境循环", () => {
	it("compileCatalog：ambient 条目编译入快照并保留描述", () => {
		const catalog = makeCatalog();
		expect(catalog.background.ambient?.get("sway")).toMatchObject({ description: "左右摇摆" });
	});

	it("compileCatalog：ambient 命名与动作冲突即拒绝（全局唯一命名空间）", () => {
		const source = makeCatalogSource();
		source.background!.ambient!.nod = { description: "冲突", motion: swayLoop(1) };
		expect(() => makeCatalog(source)).toThrow(/命名冲突/);
	});

	it("compileCatalog：ambient 别名与内置注视词表冲突即拒绝", () => {
		const source = makeCatalogSource();
		source.background!.ambient!.sway.aliases = ["用户"];
		expect(() => makeCatalog(source)).toThrow(/命名冲突/);
	});

	it("默认静止态播放 idle；选择 sway 后替换为环境循环（幅值显著增大）", async () => {
		const h = await harness();
		h.stepMs(1200); // idle 已在播（fade 450ms + 弹簧收敛）
		const idleAmplitude = h.yawAmplitude();
		const selected = await h.run("ambient", { name: "sway" });
		expect(selected.status).toBe("succeeded");
		expect((await h.status()).catalog.ambient.current).toBe("sway");
		h.stepMs(1200); // 换播 fade-in + 弹簧收敛
		expect(h.yawAmplitude()).toBeGreaterThan(idleAmplitude * 1.5);
	});

	it("清除后回落 idle；status 词表列出可用环境循环", async () => {
		const h = await harness();
		await h.run("ambient", { name: "sway" });
		h.stepMs(1200);
		const swayAmplitude = h.yawAmplitude();
		const cleared = await h.run("ambient", {});
		expect(cleared.status).toBe("succeeded");
		expect((await h.status()).catalog.ambient.current).toBeNull();
		h.stepMs(1200);
		expect(h.yawAmplitude()).toBeLessThan(swayAmplitude / 1.5);
		const { catalog } = await h.status();
		expect(catalog.ambient.available).toEqual([{ id: "sway", description: "左右摇摆" }]);
	});

	it("interrupt 不影响持续环境循环（与姿态同级的持续状态）", async () => {
		const h = await harness();
		await h.run("ambient", { name: "sway" });
		h.stepMs(1200);
		h.runtime.interrupt();
		expect((await h.status()).catalog.ambient.current).toBe("sway");
		h.stepMs(600);
		expect(h.fake.state.injected.length).toBeGreaterThan(0);
	});

	it("幂等：重复选择同名不重建，重复清除同样幂等", async () => {
		const h = await harness();
		await h.run("ambient", { name: "sway" });
		const again = await h.run("ambient", { name: "sway" });
		expect(again.result).toContain("已在选择中");
		const clear = await h.run("ambient", {});
		expect(clear.status).toBe("succeeded");
		const clearAgain = await h.run("ambient", {});
		expect(clearAgain.result).toContain("无环境循环");
	});

	it("未知名字拒绝并列出可用词表；非法参数拒绝", async () => {
		const h = await harness();
		const unknown = await h.run("ambient", { name: "groove" });
		expect(unknown.status).toBe("failed");
		expect(unknown.result).toContain("groove");
		expect(unknown.result).toContain("sway");
		const invalid = await h.run("ambient", { name: "" });
		expect(invalid.status).toBe("failed");
	});

	it("目录更替清空选中（新快照可能无同名项，诚实回落 idle）", async () => {
		const h = await harness();
		await h.run("ambient", { name: "sway" });
		expect((await h.status()).catalog.ambient.current).toBe("sway");
		h.runtime.setCatalog(makeCatalog({ motions: {}, background: { idle: swayLoop(3) } }));
		expect((await h.status()).catalog.ambient.current).toBeNull();
	});
});
