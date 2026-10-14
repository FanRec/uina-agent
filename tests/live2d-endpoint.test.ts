import { unconfirmedInjections } from "./live2d-injection-fixture.js";
import { describe, expect, it } from "vitest";
import type { ActionContext, ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../src/tools/broker.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import type { ModelProfile } from "../.uina/worlds/live2d/adapter/profile.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { compileCatalog, type CatalogSource } from "../.uina/worlds/live2d/authoring/catalog.js";
import { motion, keys, absolute } from "../.uina/worlds/live2d/authoring/index.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import { createLive2DApp } from "../.uina/worlds/live2d/index.js";

/**
 * P4-2：BodyEndpoint 全量 + lastCue 记账 + supportsCue 同源 + onFocus 幂等冻结（边界 #1/#5/#14）
 * + §6 暂停机制（safeStop 保持帧口型覆写 / 注入不断 / resume 恢复）。
 *
 * 合成推进纯函数化：composeTick 手工步进；客户端用鸭子类型假体。
 * 自律微晃 head.yaw 全幅 ±1.2（DEFAULT_SWAY）+ 弹簧残差，空闲态帧断言放宽到 ±1.5。
 */

const MODEL_ID = "fixture-model";

const makeRig = (): ModelRig => ({
	version: 3,
	modelID: MODEL_ID,
	controls: {
		"head.yaw": { min: -12, max: 12, neutral: 0 },
		"torso.breath": { min: 0, max: 1, neutral: 0.5 },
		"mouth.open": { min: 0, max: 1, neutral: 0 },
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
		"torso.breath": [
			{
				parameter: "ParamBreath",
				input: "FaceAngY",
				points: [
					[0, 0],
					[0.5, 0.5],
					[1, 1],
				],
				followers: [],
				physicsFollowers: [],
				smoothing: 0,
			},
		],
		"mouth.open": [
			{
				parameter: "ParamMouthOpenY",
				input: "MouthOpen",
				points: [
					[0, 0],
					[1, 1],
				],
				followers: [],
				physicsFollowers: [],
				smoothing: 0,
			},
		],
	},
	external: { blink: "uina", breath: "vts" },
});

const makeCatalogSource = (): CatalogSource => ({
	motions: {
		nod: {
			description: "点头",
			atomic: true,
			aliases: ["dip"],
			motion: motion(500, {
				"head.yaw": absolute(
					keys([
						[0, 6],
						[500, 6],
					]),
				),
			}),
		},
		long: {
			description: "长动作",
			atomic: false,
			motion: motion(2000, {
				"head.yaw": absolute(
					keys([
						[0, 3],
						[2000, 3],
					]),
				),
			}),
		},
	},
	postures: { lean: { description: "侧倾", values: { "head.yaw": 4 } } },
	expressions: { brighten: { description: "提气", values: { "torso.breath": 0.8 } } },
});

const makeCatalog = () => compileCatalog(MODEL_ID, makeCatalogSource(), makeRig());

const makeProfile = (modelID = MODEL_ID): ModelProfile => ({ modelID, physicsOutputs: [] }) as unknown as ModelProfile;

const makeFakeClient = (options: { connected?: boolean; modelID?: string } = {}) => {
	const state = {
		connected: options.connected ?? true,
		profile: makeProfile(options.modelID),
		fault: undefined as string | undefined,
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
		getFault: () => state.fault,
	} as unknown as VTSClient;
	return { client, state };
};

interface HarnessOptions {
	connected?: boolean;
}

const harness = async (options: HarnessOptions = {}) => {
	const fake = makeFakeClient({ connected: options.connected });
	const runtime = new Live2DRuntime({
		client: fake.client,
		rig: makeRig(),
		catalog: makeCatalog(),
		// 作者标定口型映射（恒等映射）：levelSink 存在 = 生产电平链路（P3-2）。
		speech: {
			points: [
				[0, 0],
				[1, 1],
			],
			staleMs: 400,
		},
	});
	const app = createLive2DApp({ instance: runtime });
	const startCtx = {
		expose: () => () => {},
		signal: new AbortController().signal,
	} as unknown as ServiceCompanionContext;
	await app.onStart!(startCtx);
	const ctx = { signal: new AbortController().signal, operationIdentity: {} } as unknown as ActionContext;
	return { app, runtime, fake, ctx, endpoint: runtime.endpoint };
};

const run = (
	app: ReturnType<typeof createLive2DApp>,
	action: string,
	args: Record<string, unknown>,
	ctx: ActionContext,
): Promise<ToolExecutionResult> => app.actions[action]!.run(args, ctx) as Promise<ToolExecutionResult>;

const stepMs = (rt: Live2DRuntime, totalMs: number, stepMs = 16): void => {
	for (let i = 0; i < Math.ceil(totalMs / stepMs); i++) rt.composeTick(stepMs);
};

/** 冲刷终态回调的微任务（finished 在某个 composeTick 内同步 resolve）。 */
const flush = async (): Promise<void> => {
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};

const mouthValue = (rt: Live2DRuntime): number => rt.director!.currentFrame["mouth.open"]!;

describe("live2d endpoint（P4-2）", () => {
	it("边界 #1 目录同源：supportsCue 集合 ≡ affordance().cues 集合（含别名、含姿态），目录更新后同步更新", async () => {
		const { app, runtime, endpoint } = await harness();
		try {
			const cues = endpoint.affordance().cues;
			const cueIds = cues.flatMap((c) => [c.id, ...(c.aliases ?? [])]);
			expect(cueIds).toEqual(expect.arrayContaining(["nod", "dip", "long", "lean"]));
			// 表情/注视不是 cue（走 state 工具）。
			expect(cueIds).not.toContain("brighten");
			for (const id of cueIds) expect(endpoint.supportsCue?.(id)).toBe(true);
			expect(endpoint.supportsCue?.("brighten")).toBe(false);
			expect(endpoint.supportsCue?.("nonexistent")).toBe(false);

			// 目录更新：affordance 与 supportsCue 同步换血（同一次 catalogView 快照）。
			const next = compileCatalog(
				MODEL_ID,
				{
					motions: {
						wave: {
							description: "挥手",
							motion: motion(300, {
								"head.yaw": absolute(
									keys([
										[0, 2],
										[300, 2],
									]),
								),
							}),
						},
					},
				},
				makeRig(),
			);
			runtime.setCatalog(next);
			expect(endpoint.affordance().cues.map((c) => c.id)).toEqual(["wave"]);
			expect(endpoint.supportsCue?.("nod")).toBe(false);
			expect(endpoint.supportsCue?.("wave")).toBe(true);
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("emitCue 命中动作：received→started→finished 记账，帧推进到轨迹值", async () => {
		const { app, runtime, endpoint } = await harness();
		try {
			endpoint.emitCue("nod");
			expect(endpoint.lastCue().at(-1)).toMatchObject({ id: "nod", state: "started" });
			stepMs(runtime, 300); // 播放保持段（sway 被抑制）
			expect(runtime.director!.currentFrame["head.yaw"]).toBeCloseTo(6, 0);
			stepMs(runtime, 600); // 500ms 动作 + 250ms fadeOut
			await flush();
			const record = endpoint.lastCue().at(-1)!;
			expect(record).toMatchObject({ id: "nod", state: "finished" });
			expect(record.reason).toBe("unknown"); // 无协议确认的假体不能证明动作接受。
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("emitCue 别名归一化：按原始 cueId 记账，命中规范动作播放", async () => {
		const { app, runtime, endpoint } = await harness();
		try {
			endpoint.emitCue("dip");
			expect(endpoint.lastCue().at(-1)).toMatchObject({ id: "dip", state: "started" });
			stepMs(runtime, 300);
			expect(runtime.director!.currentFrame["head.yaw"]).toBeCloseTo(6, 0);
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("emitCue 命中姿态：转 state 槽调用", async () => {
		const { app, runtime, endpoint } = await harness();
		try {
			endpoint.emitCue("lean");
			stepMs(runtime, 800);
			await flush();
			expect(Math.abs(runtime.director!.currentFrame["head.yaw"]! - 4)).toBeLessThan(1.5);
			expect(endpoint.lastCue().at(-1)).toMatchObject({ id: "lean", state: "finished" });
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("emitCue 未知与暂停：rejected 记账（不启动执行）", async () => {
		const { app, runtime, endpoint } = await harness();
		try {
			endpoint.emitCue("nope");
			await flush();
			expect(endpoint.lastCue().at(-1)).toMatchObject({ id: "nope", state: "rejected", reason: "unknown_cue" });
			await runtime.safeStop();
			endpoint.emitCue("nod");
			await flush();
			expect(endpoint.lastCue().at(-1)).toMatchObject({ id: "nod", state: "rejected", reason: "paused" });
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("边界 #14 lastCue：seq 单调、迟到回调只更新自身条目、目录更新后旧执行不产生效果", async () => {
		const { app, runtime, endpoint } = await harness();
		try {
			endpoint.emitCue("long"); // seq 1：2000ms 动作
			await flush();
			stepMs(runtime, 100);
			endpoint.emitCue("lean"); // seq 2：姿态槽
			stepMs(runtime, 800);
			await flush();
			const before = endpoint.lastCue();
			expect(before.find((r) => r.id === "lean")).toMatchObject({ state: "finished" });
			expect(before.find((r) => r.id === "long")).toMatchObject({ state: "started" });

			// 长动作迟到终态：只更新自身条目，seq 更大的 lean 记录原样保留。
			stepMs(runtime, 1600); // 100+800+1600 = 2500 > 2000+250ms fadeOut
			await flush();
			const after = endpoint.lastCue();
			expect(after.find((r) => r.id === "long")).toMatchObject({ state: "finished" });
			expect(after.find((r) => r.id === "lean")).toEqual(before.find((r) => r.id === "lean"));

			// seq 严格递增且账本有序。
			const seqs = endpoint.lastCue().map((r) => r.seq);
			expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("边界 #14 目录更新失效 in-flight：旧代次播放结算 cancelled 并落账", async () => {
		const { app, runtime, endpoint } = await harness();
		try {
			endpoint.emitCue("long");
			await flush();
			expect(endpoint.lastCue().at(-1)).toMatchObject({ state: "started" });
			runtime.setCatalog(makeCatalog()); // 目录更新 → invalidateAll
			stepMs(runtime, 100);
			await flush();
			const record = endpoint.lastCue().at(-1)!;
			expect(record).toMatchObject({ id: "long", state: "finished" });
			expect(record.reason).toBe("catalog changed");
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("边界 #5 焦点：失焦冻结倒计时、相同值重复通知幂等、回焦恢复剩余", async () => {
		const { app, runtime, endpoint, ctx } = await harness();
		try {
			// 过渡类 posture 的 Promise 由合成推进结算：先发起、步进、后 await。
			const stateP = run(app, "state", { posture: "lean", hold_ms: 100 }, ctx);
			stepMs(runtime, 600); // 过渡完成（holdTotal = 100 + 600 = 700，自受理起算）
			await stateP;
			// 剩余保持 = 100ms。
			endpoint.onFocus?.(false); // 冻结
			const frozen = runtime.director!.currentFrame["head.yaw"];
			stepMs(runtime, 1000); // 冻结期倒计时不走
			expect(runtime.director!.currentFrame["head.yaw"]).toBe(frozen);
			endpoint.onFocus?.(false); // 相同值重复通知：幂等，不得重置剩余时间
			endpoint.onFocus?.(true); // 恢复剩余（100ms）
			stepMs(runtime, 80); // 80 < 100：仍在保持
			expect(Math.abs(runtime.director!.currentFrame["head.yaw"]! - 4)).toBeLessThan(1.5);
			stepMs(runtime, 100); // 越过剩余 → 回中性过渡
			stepMs(runtime, 700); // 600ms 过渡完成
			expect(Math.abs(runtime.director!.currentFrame["head.yaw"]! - 0)).toBeLessThan(1.5);
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("边界 #5 初始焦点幂等：启动后首个 onFocus(true) 不构成状态跳变", async () => {
		const fake = makeFakeClient();
		const runtime = new Live2DRuntime({ client: fake.client, rig: makeRig(), catalog: makeCatalog() });
		await runtime.start({} as never);
		const endpoint = runtime.endpoint;
		expect(endpoint.state()).toMatchObject({ paused: false, online: true });
		// router 注册期会调用 onFocus(true)：与初始 focused 一致 → 幂等无跳变。
		endpoint.onFocus?.(true);
		expect(runtime.isPaused).toBe(false);
		await runtime.stop();
	});

	it("§6 safeStop：保持帧口型覆写中性、注入不断、动作立即结算、工具 paused 拒绝、resume 恢复", async () => {
		const { app, runtime, fake, endpoint, ctx } = await harness();
		try {
			// 口型张到接近全开（攻击瞬时），同时播放命名动作——走生产电平链路（levelSink）。
			runtime.levelSink!.processLevel({ rms: 1 });
			const expressP = run(app, "express", { motion: "long" }, ctx);
			stepMs(runtime, 300);
			expect(mouthValue(runtime)).toBeGreaterThan(0.5);

			await runtime.safeStop(); // 保持帧捕获 + 全部播放 cut 结算
			await expect(expressP).resolves.toMatchObject({ status: "cancelled" });

			// 暂停期间注入不停止：帧完全冻结（保持帧），口型通道覆写中性。
			const countAtPause = fake.state.injected.length;
			stepMs(runtime, 200);
			expect(fake.state.injected.length).toBeGreaterThan(countAtPause);
			const tail = fake.state.injected.slice(countAtPause);
			for (const frame of tail) {
				expect(frame.find((p) => p.id === "MouthOpen")!.value).toBe(0);
				expect(frame.find((p) => p.id === "FaceAngleX")!.value).toBe(
					tail[0]!.find((p) => p.id === "FaceAngleX")!.value,
				);
			}

			// gate：暂停期间具身工具拒绝 paused（status/diagnose 只读不受限）。
			expect(await run(app, "express", { motion: "nod" }, ctx)).toMatchObject({
				status: "failed",
				details: { reason: "paused" },
			});
			expect(endpoint.state()).toMatchObject({ paused: true, online: true });

			// resume：清保持帧、口型包络归零、合成恢复。
			await runtime.resume();
			stepMs(runtime, 300);
			expect(mouthValue(runtime)).toBeLessThan(0.1); // speechInput.reset → 包络 50ms 释放回零
			const postResume = fake.state.injected.at(-1)!.find((p) => p.id === "MouthOpen")!.value;
			expect(postResume).toBeLessThan(0.1);
			expect(endpoint.state()).toMatchObject({ paused: false });
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("§6 电平丢弃：暂停期间 processLevel 不进入声学输入（resume 后无残留张嘴）", async () => {
		const { app, runtime, ctx } = await harness();
		try {
			await runtime.safeStop();
			runtime.levelSink!.processLevel({ rms: 1 });
			await runtime.resume();
			// 丢弃的电平不得在 resume 后瞬间张开嘴（包络从未收到该测量）。
			runtime.director!.setSpeechLevel(0);
			stepMs(runtime, 100);
			expect(mouthValue(runtime)).toBeLessThan(0.1);
			// 正常路径仍可用：resume 后投递的电平驱动包络。
			runtime.levelSink!.processLevel({ rms: 1 });
			stepMs(runtime, 100);
			expect(mouthValue(runtime)).toBeGreaterThan(0.5);
			void ctx;
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("state() 事实：online = 连接且身份匹配；fault 透传；safeStop 后 paused", async () => {
		const { app, runtime, fake, endpoint } = await harness();
		try {
			expect(endpoint.state()).toMatchObject({ online: true, paused: false });
			fake.state.connected = false;
			expect(endpoint.state().online).toBe(false);
			fake.state.connected = true;
			fake.state.fault = "injection rejected";
			expect(endpoint.state().fault).toBe("injection rejected");
			fake.state.fault = undefined;
			await runtime.safeStop();
			expect(endpoint.state().paused).toBe(true);
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});
});
