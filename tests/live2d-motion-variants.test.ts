import { unconfirmedInjections } from "./live2d-injection-fixture.js";
import { describe, expect, it } from "vitest";
import type { ActionContext, ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../src/tools/broker.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import type { ModelProfile } from "../.uina/worlds/live2d/adapter/profile.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { compileCatalog, type CatalogSnapshot, type CatalogSource } from "../.uina/worlds/live2d/authoring/catalog.js";
import { compileMotion, motion, keys, absolute } from "../.uina/worlds/live2d/authoring/motion.js";
import { createLive2DApp } from "../.uina/worlds/live2d/index.js";
import { Live2DRuntime, pickVariantIndex } from "../.uina/worlds/live2d/runtime.js";

/**
 * 动作变体轮换（同义纹理变体 + 随机接续）：绑定期编译校验、运行时均匀随机排除上次选中
 * （连播不重样）、express 与 endpoint.emitCue 双路轮换、speech 覆写按选中变体重编译、
 * 快照换代轮换归零、无变体动作逐比特回归、status 变体数量暴露。
 *
 * 合成推进纯函数化：composeTick 手工步进；客户端用鸭子类型假体；rng 注入恒 0.5
 * ——池 2 时严格交替（首播主定义 → 变体 → 主定义），幅值断言因此完全确定。
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

/** 主定义持 6、变体持 2：FaceAngleX 峰值 ≈15 vs ≈6（rig 映射 ×2.5 + 弹簧动态），间隔远超 idle 微晃。
 * idle 0.1 仅用于禁用内置 ±1.2 微晃；幅值断言用相对阈值（主 >10 / 变体 <10），不耦合映射常数。 */
const holdYaw = (value: number) =>
	motion(400, {
		"head.yaw": absolute(
			keys([
				[0, value],
				[400, value],
			]),
		),
	});

const makeSource = (): CatalogSource => ({
	motions: {
		nod: {
			description: "点头",
			motion: holdYaw(6),
			variants: [holdYaw(2)],
		},
		plain: {
			description: "无变体动作",
			motion: holdYaw(6),
		},
	},
	background: {
		idle: motion(3200, {
			"head.yaw": absolute(
				keys([
					[0, 0],
					[800, 0.1],
					[1600, 0],
					[2400, -0.1],
					[3200, 0],
				]),
			),
		}),
	},
});

const makeCatalog = (source = makeSource()): CatalogSnapshot => compileCatalog(MODEL_ID, source, makeRig());

const makeProfile = (modelID = MODEL_ID): ModelProfile => ({ modelID, physicsOutputs: [] }) as unknown as ModelProfile;

/** 鸭子类型假客户端：记录注入帧序列供幅值断言。 */
const makeFakeClient = () => {
	const state = {
		connected: true,
		profile: makeProfile(),
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

/** 冲刷终态回调的微任务（emitCue fire-and-forget 的落账在 composeTick 后的微任务链上）。 */
const flush = async (): Promise<void> => {
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};

const harness = async (catalog: CatalogSnapshot = makeCatalog(), rng: () => number = () => 0.5) => {
	const fake = makeFakeClient();
	const runtime = new Live2DRuntime({ client: fake.client, rig: makeRig(), catalog, rng });
	const app = createLive2DApp({ instance: runtime });
	const startCtx = {
		expose: () => () => {},
		signal: new AbortController().signal,
	} as unknown as ServiceCompanionContext;
	await app.onStart!(startCtx);
	const ctx = { signal: new AbortController().signal, operationIdentity: {} } as unknown as ActionContext;
	const run = (action: string, args: Record<string, unknown>): Promise<ToolExecutionResult> =>
		app.actions[action]!.run(args, ctx) as Promise<ToolExecutionResult>;
	const stepMs = (totalMs: number, step = 16): void => {
		for (let i = 0; i < Math.ceil(totalMs / step); i++) runtime.composeTick(step);
	};
	const amplitudeSince = (from: number): number => {
		const values = fake.state.injected
			.slice(from)
			.flatMap((frame) => frame.filter((p) => p.id === "FaceAngleX").map((p) => Math.abs(p.value)));
		return Math.max(...values);
	};
	/** 播放一个动作并采样播放窗口内的 FaceAngleX 最大幅值。 */
	const playAndSample = async (args: Record<string, unknown>) => {
		const from = fake.state.injected.length;
		const pending = run("express", args);
		stepMs(1000);
		const result = await pending;
		return { result, amplitude: amplitudeSince(from) };
	};
	return { app, runtime, fake, run, stepMs, amplitudeSince, playAndSample };
};

describe("live2d 动作变体轮换", () => {
	it("pickVariantIndex：池 1 恒 0；排除 lastPick 且结果在池范围内", () => {
		const randoms = [0, 0.17, 0.33, 0.5, 0.68, 0.84, 0.99];
		expect(randoms.map((r) => pickVariantIndex(1, undefined, () => r))).toEqual([0, 0, 0, 0, 0, 0, 0]);
		expect(randoms.map((r) => pickVariantIndex(2, 0, () => r))).toEqual([1, 1, 1, 1, 1, 1, 1]);
		expect(randoms.map((r) => pickVariantIndex(2, 1, () => r))).toEqual([0, 0, 0, 0, 0, 0, 0]);
		for (const poolSize of [2, 3, 4, 5]) {
			for (const lastPick of [undefined, ...Array.from({ length: poolSize }, (_, i) => i)]) {
				for (const r of randoms) {
					const picked = pickVariantIndex(poolSize, lastPick, () => r);
					expect(picked).toBeGreaterThanOrEqual(0);
					expect(picked).toBeLessThan(poolSize);
					if (lastPick !== undefined) expect(picked).not.toBe(lastPick);
				}
			}
		}
	});

	it("compileCatalog：附加变体入条目（池 = 主定义 + 变体），可被 bake", () => {
		const entry = makeCatalog().resolve("motion", "nod")!.entry;
		expect(entry.variants).toHaveLength(1);
		expect(compileMotion(entry.variants![0]!, makeRig().controls).durationMs).toBe(400);
		expect(compileMotion(entry.definition, makeRig().controls).durationMs).toBe(400);
	});

	it("compileCatalog：空变体池拒绝（主定义 + 变体 ≥ 2 才构成轮换）", () => {
		const source = makeSource();
		source.motions!.nod.variants = [];
		expect(() => makeCatalog(source)).toThrow(/变体池为空/);
	});

	it("compileCatalog：非法定义变体绑定期即抛（非法轴）", () => {
		const source = makeSource();
		source.motions!.nod.variants = [
			motion(400, {
				"nope.x": absolute(
					keys([
						[0, 1],
						[400, 1],
					]),
				),
			}),
		];
		expect(() => makeCatalog(source)).toThrow(/未知轴: nope.x/);
	});

	it("express：三连播幅值 6 → 2 → 6 交替（均匀随机排除上次选中）", async () => {
		const h = await harness();
		const first = await h.playAndSample({ motion: "nod" });
		const second = await h.playAndSample({ motion: "nod" });
		const third = await h.playAndSample({ motion: "nod" });
		// 此假体没有协议 ACK：完成但注入未确认，诚实结算 unknown（tool-surface 同款语义）。
		expect(first.result.status).toBe("unknown");
		expect(first.amplitude).toBeGreaterThan(10);
		expect(second.amplitude).toBeLessThan(10);
		expect(third.amplitude).toBeGreaterThan(10);
	});

	it("无变体动作三连播幅值恒定（回归：clip 身份不变）", async () => {
		const h = await harness();
		const first = await h.playAndSample({ motion: "plain" });
		const second = await h.playAndSample({ motion: "plain" });
		const third = await h.playAndSample({ motion: "plain" });
		for (const { amplitude } of [first, second, third]) expect(amplitude).toBeGreaterThan(10);
	});

	it("speech 覆写在选中变体上生效：speech 播放同样推进轮换", async () => {
		const h = await harness();
		const first = await h.playAndSample({ motion: "nod" });
		const second = await h.playAndSample({ motion: "nod", speech: "exclusive" });
		const third = await h.playAndSample({ motion: "nod" });
		expect(first.amplitude).toBeGreaterThan(10);
		expect(second.amplitude).toBeLessThan(10);
		expect(third.amplitude).toBeGreaterThan(10);
	});

	it("endpoint.emitCue 路径同获轮换；终态落账 finished", async () => {
		const h = await harness();
		const fromA = h.fake.state.injected.length;
		h.runtime.endpoint.emitCue("nod");
		h.stepMs(1000);
		await flush();
		expect(h.amplitudeSince(fromA)).toBeGreaterThan(10);
		expect(h.runtime.endpoint.lastCue().at(-1)).toMatchObject({ id: "nod", state: "finished" });
		const fromB = h.fake.state.injected.length;
		h.runtime.endpoint.emitCue("nod");
		h.stepMs(1000);
		await flush();
		expect(h.amplitudeSince(fromB)).toBeLessThan(10);
	});

	it("目录快照换代：新条目对象使轮换状态归零（首播回到主定义）", async () => {
		const h = await harness();
		const first = await h.playAndSample({ motion: "nod" });
		expect(first.amplitude).toBeGreaterThan(10);
		h.runtime.setCatalog(makeCatalog());
		const second = await h.playAndSample({ motion: "nod" });
		// 若未随换代归零，第二播会排除上次选中（主定义）而落到变体（幅值 < 4）。
		expect(second.amplitude).toBeGreaterThan(10);
	});

	it("interrupt 打断后轮换继续：上次选中仍被排除", async () => {
		const h = await harness();
		const pending = h.run("express", { motion: "nod" });
		h.stepMs(100);
		h.runtime.interrupt();
		await expect(pending).resolves.toMatchObject({ status: "cancelled" });
		h.stepMs(800); // 待被打断主定义的 fade 收势残迹（6→0）完全衰减，避免污染第二次采样窗口
		const second = await h.playAndSample({ motion: "nod" });
		expect(second.amplitude).toBeLessThan(10);
	});

	it("status 词表暴露变体数量；unknown_motion 提示同源", async () => {
		const h = await harness();
		const status = JSON.parse(h.runtime.formatStatus()) as { catalog: { motions: string[] } };
		expect(status.catalog.motions).toContain("nod[2变体]");
		expect(status.catalog.motions).toContain("plain");
		const unknown = await h.run("express", { motion: "nope" });
		expect(unknown.result).toContain("nod[2变体]");
	});
});
