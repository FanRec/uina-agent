import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionContext, ServiceCompanionContext, WorldDef } from "../src/extensions/world-framework/types.js";
import { TOOL_RESULT_STATUSES } from "../src/core/types.js";
import type { ToolExecutionResult } from "../src/tools/broker.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { compileCatalog, emptyCatalog } from "../.uina/worlds/live2d/authoring/catalog.js";
import { motion, track } from "../.uina/worlds/live2d/authoring/motion.js";
import type { ModelProfile } from "../.uina/worlds/live2d/adapter/profile.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { createLive2DApp } from "../.uina/worlds/live2d/index.js";
import { EFFECT_STATUSES, VERIFICATIONS } from "../.uina/worlds/live2d/results.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

/**
 * P4-1：WorldDef 工具面 + 结果词汇表（边界 #11）+ gate 链（§2.1/§7）+ 目录编译校验 + 作者会话标记门。
 *
 * 合成推进纯函数化：composeTick 手工步进；客户端用鸭子类型假体。
 */

const MODEL_ID = "fixture-model";

const makeRig = (): ModelRig => ({
	version: 3,
	modelID: MODEL_ID,
	controls: {
		"head.yaw": { min: -12, max: 12, neutral: 0 },
		"torso.breath": { min: 0, max: 1, neutral: 0.5 },
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
	},
	external: { blink: "uina", breath: "vts" },
});

const makeCatalog = () =>
	compileCatalog(
		MODEL_ID,
		{
			motions: {
				nod: {
					description: "点头",
					atomic: true,
					motion: motion(
						500,
						track("head.yaw", [
							[0, 6],
							[500, 6],
						]),
					),
				},
			},
			postures: { lean: { description: "侧倾", values: { "head.yaw": 4 } } },
			expressions: { brighten: { description: "提气", values: { "torso.breath": 0.8 } } },
			attentions: { window: { description: "看向窗外", target: { x: 0.3, y: 0.1 } } },
			costumes: [{ id: "glasses", description: "眼镜", hotkeyID: "HotkeyGlasses" }],
		},
		makeRig(),
	);

const makeProfile = (modelID = MODEL_ID): ModelProfile => ({ modelID, physicsOutputs: [] }) as unknown as ModelProfile;

/** 鸭子类型假客户端：可手动拨动连接/身份事实，reloadCurrentModel 可观测。 */
const makeFakeClient = (options: { connected?: boolean; modelID?: string } = {}) => {
	const state = {
		connected: options.connected ?? true,
		profile: makeProfile(options.modelID),
		reloadCalls: 0,
	};
	const client = {
		isConnected: () => state.connected,
		getModelProfile: () => state.profile,
		injectParameters: () => {},
		setConnectionChangeListener: (_listener: (connected: boolean) => void) => {},
		connect: () => {},
		disconnect: () => {},
		getConnectionStatus: () => ({ connected: state.connected }),
		reloadCurrentModel: async () => {
			state.reloadCalls++;
		},
	} as unknown as VTSClient;
	return { client, state };
};

interface HarnessOptions {
	connected?: boolean;
	modelID?: string;
	published?: boolean;
	worldDataDir?: string;
	catalog?: boolean;
}

const harness = async (options: HarnessOptions = {}) => {
	const fake = makeFakeClient({ connected: options.connected, modelID: options.modelID });
	const runtime = new Live2DRuntime({
		client: fake.client,
		rig: makeRig(),
		catalog: options.catalog === false ? emptyCatalog(MODEL_ID) : makeCatalog(),
		published: options.published,
	});
	const app = createLive2DApp({ instance: runtime });
	const startCtx = {
		expose: () => () => {},
		worldDataDir: options.worldDataDir,
		signal: new AbortController().signal,
	} as unknown as ServiceCompanionContext;
	await app.onStart!(startCtx);
	const ctx = { signal: new AbortController().signal, operationIdentity: {} } as unknown as ActionContext;
	return { app, runtime, fake, ctx };
};

const run = (
	app: WorldDef,
	action: string,
	args: Record<string, unknown>,
	ctx: ActionContext,
): Promise<ToolExecutionResult> => app.actions[action]!.run(args, ctx) as Promise<ToolExecutionResult>;

/** 边界 #11：status ∈ 五值；details.effectStatus / verification 如声明则 ∈ 各自词表。 */
const expectVocabulary = (res: ToolExecutionResult): void => {
	expect(TOOL_RESULT_STATUSES).toContain(res.status);
	const details = res.details as { effectStatus?: string; verification?: string } | undefined;
	if (details?.effectStatus !== undefined) expect(EFFECT_STATUSES).toContain(details.effectStatus);
	if (details?.verification !== undefined) expect(VERIFICATIONS).toContain(details.verification);
};

const stepMs = (rt: Live2DRuntime, totalMs: number, stepMs = 16): void => {
	for (let i = 0; i < Math.ceil(totalMs / stepMs); i++) rt.composeTick(stepMs);
};

let scratchDir: string | undefined;
afterEach(() => {
	if (scratchDir) {
		try {
			rmSync(scratchDir, { recursive: true, force: true });
		} catch {
			// 清理失败不掩盖断言结果
		}
		scratchDir = undefined;
	}
});

describe("live2d 工具面（P4-1）", () => {
	it("WorldDef 显式声明 executionMode parallel（§2：并发是常态，工具层不串行化）", () => {
		expect(createLive2DApp().executionMode).toBe("parallel");
	});

	it("未启动时全部工具如实返回 not_started", async () => {
		const app = createLive2DApp();
		const ctx = { signal: new AbortController().signal, operationIdentity: {} } as unknown as ActionContext;
		for (const name of Object.keys(app.actions)) {
			const res = await run(
				app,
				name,
				name === "express" ? { motion: "nod" } : name === "costume" ? { item: "list" } : {},
				ctx,
			);
			expect(res.status).toBe("not_started");
			expectVocabulary(res);
		}
	});

	it("边界 #11：启动后十个工具全部返回词汇合法结果", async () => {
		const { app, runtime, ctx } = await harness();
		try {
			// express/state 的终态结算由合成推进驱动：先步进再 await（无真实定时器）。
			const expressP = run(app, "express", { motion: "nod" }, ctx);
			for (let i = 0; i < 90; i++) runtime.composeTick(16);
			const results = [
				await expressP,
				await run(app, "state", { attention: "user" }, ctx),
				await run(app, "costume", { item: "list" }, ctx),
				await run(app, "flip", {}, ctx),
				await run(app, "spatial", { x: 1 }, ctx),
				await run(app, "status", {}, ctx),
				await run(app, "diagnose", {}, ctx),
				await run(app, "preview", {}, ctx),
				await run(app, "accept", { evidence: "人工画面验收说明占位" }, ctx),
				await run(app, "reload", {}, ctx),
			];
			for (const res of results) expectVocabulary(res);
			// 目录命名动作播放到终态：succeeded + effectStatus applied（§2.1 引擎终态映射）。
			expect(results[0]!.status).toBe("succeeded");
			expect((results[0]!.details as { effectStatus: string }).effectStatus).toBe("applied");
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("gate 顺序（§7）：断线 + 未发布同时成立时报 model_not_ready 而非 draft", async () => {
		const { app, ctx } = await harness({ connected: false, published: false });
		try {
			const res = await run(app, "express", { motion: "nod" }, ctx);
			expect(res.status).toBe("failed");
			expect((res.details as { reason: string }).reason).toBe("model_not_ready");
			expectVocabulary(res);
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("gate：模型身份不匹配报 unadapted；无 rig 同样 unadapted", async () => {
		const { app, ctx } = await harness({ modelID: "another-model" });
		try {
			const res = await run(app, "express", { motion: "nod" }, ctx);
			expect((res.details as { reason: string }).reason).toBe("unadapted");
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("gate：未发布报 draft，作者工具不受 draft 之外的额外拒绝", async () => {
		const { app, ctx } = await harness({ published: false });
		try {
			const res = await run(app, "state", { posture: "lean" }, ctx);
			expect((res.details as { reason: string }).reason).toBe("draft");
			expectVocabulary(res);
			// status/diagnose 只读，不设 gate，未发布事实如实可见。
			const status = JSON.parse((await run(app, "status", {}, ctx)).result) as { published: boolean };
			expect(status.published).toBe(false);
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("目录词表拒绝：unknown_motion / unknown_pose / unknown_expression / unknown_attention / unknown_costume", async () => {
		const { app, ctx } = await harness({ catalog: false });
		try {
			expect((await run(app, "express", { motion: "nod" }, ctx)).details).toMatchObject({ reason: "unknown_motion" });
			expect((await run(app, "state", { posture: "lean" }, ctx)).details).toMatchObject({ reason: "unknown_pose" });
			expect((await run(app, "state", { expression: "brighten" }, ctx)).details).toMatchObject({
				reason: "unknown_expression",
			});
			expect((await run(app, "state", { attention: "window" }, ctx)).details).toMatchObject({
				reason: "unknown_attention",
			});
			expect((await run(app, "costume", { item: "glasses" }, ctx)).details).toMatchObject({
				reason: "unknown_costume",
			});
			// 空目录下内置注视词表仍然可达（不受目录空置影响）。
			expect(await run(app, "state", { attention: "user" }, ctx)).toMatchObject({ status: "succeeded" });
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("参数非法：invalid_motion / invalid_duration", async () => {
		const { app, ctx } = await harness();
		try {
			expect((await run(app, "express", { motion: "nod", atomic: "yes" }, ctx)).details).toMatchObject({
				reason: "invalid_motion",
			});
			expect((await run(app, "express", { motion: "nod", speech: "loud" }, ctx)).details).toMatchObject({
				reason: "invalid_motion",
			});
			expect((await run(app, "state", { posture: "lean", hold_ms: -5 }, ctx)).details).toMatchObject({
				reason: "invalid_duration",
			});
			expect((await run(app, "state", { posture: "lean", hold_ms: "soon" }, ctx)).details).toMatchObject({
				reason: "invalid_duration",
			});
			expect(await run(app, "state", {}, ctx)).toMatchObject({ status: "succeeded" }); // 空声明 = 无操作
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("作者会话门：无标记时 preview/accept 得 author_session_required", async () => {
		const { app, ctx } = await harness();
		try {
			expect((await run(app, "preview", {}, ctx)).details).toMatchObject({ reason: "author_session_required" });
			expect((await run(app, "accept", { evidence: "说明" }, ctx)).details).toMatchObject({
				reason: "author_session_required",
			});
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("作者会话门：标记文件存在时 preview/accept 通过 gate（引擎在后续批次接入，如实 not_started）", async () => {
		scratchDir = mkdtempSync(join(tmpdir(), "live2d-author-"));
		writeFileSync(join(scratchDir, "author-session"), "");
		const { app, ctx } = await harness({ worldDataDir: scratchDir });
		try {
			expect(await run(app, "preview", {}, ctx)).toMatchObject({ status: "not_started" });
			expect(await run(app, "accept", { evidence: "说明" }, ctx)).toMatchObject({ status: "not_started" });
			const status = JSON.parse((await run(app, "status", {}, ctx)).result) as { authorSession: boolean };
			expect(status.authorSession).toBe(true);
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("express：命名动作播放至 succeeded，合成帧推进到目标值", async () => {
		const { app, runtime, ctx } = await harness();
		try {
			const p = run(app, "express", { motion: "nod" }, ctx);
			// 播放保持段（0~500ms）内帧收敛到轨迹值；主动动作播放期间自律微晃被抑制（探针实证）。
			for (let i = 0; i < 30; i++) runtime.composeTick(16);
			expect(runtime.director!.currentFrame["head.yaw"]).toBeCloseTo(6, 0);
			// 覆盖 500ms 动作 + 250ms fadeOut → 工具在终态结算。
			for (let i = 0; i < 60; i++) runtime.composeTick(16);
			const res = await p;
			expectVocabulary(res);
			expect(res.status).toBe("succeeded");
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("express：调用中止 → cancelled（信号透传给可取消原语，不谎报）", async () => {
		const { app } = await harness();
		try {
			const ac = new AbortController();
			const p = run(app, "express", { motion: "nod" }, {
				signal: ac.signal,
				operationIdentity: {},
			} as unknown as ActionContext);
			ac.abort();
			const res = await p;
			expect(res.status).toBe("cancelled");
			expectVocabulary(res);
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("state：三槽独立生效，hold_ms 到期回 neutral，被取代的旧调用结算 cancelled", async () => {
		const { app, runtime, ctx } = await harness();
		try {
			// 过渡类 state 的 Promise 由合成推进结算：先发起、步进、后 await。
			const apply = run(app, "state", { posture: "lean", expression: "brighten", attention: "window" }, ctx);
			stepMs(runtime, 800); // 过渡 600ms 收敛
			expect(await apply).toMatchObject({ status: "succeeded" });
			// 自律微晃 head.yaw 全幅 ±1.2（DEFAULT_SWAY）+ 弹簧残差，断言按真实行为放宽。
			expect(Math.abs(runtime.director!.currentFrame["head.yaw"]! - 4)).toBeLessThan(1.5);
			expect(runtime.director!.currentFrame["torso.breath"]).toBeCloseTo(0.8, 1);

			// hold_ms：holdTotal = holdMs + 过渡 600ms；到期自动回 neutral（多槽独立计时同规则）。
			const hold = run(app, "state", { posture: "lean", hold_ms: 100 }, ctx);
			stepMs(runtime, 1500);
			expect(await hold).toMatchObject({ status: "succeeded" });
			expect(Math.abs(runtime.director!.currentFrame["head.yaw"]! - 0)).toBeLessThan(1.5);

			// 整槽替换竞争：旧 Promise SupersededError → 工具层 cancelled，运动归属新调用。
			const p1 = run(app, "state", { posture: "lean" }, ctx);
			const p2 = run(app, "state", { posture: "lean" }, ctx);
			stepMs(runtime, 800); // p2 的过渡由合成推进结算
			const [r1, r2] = await Promise.all([p1, p2]);
			expect(r1.status).toBe("cancelled");
			expect(r2.status).toBe("succeeded");
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("costume：list 列出登记项；目录命中但执行面未接入时如实 not_started", async () => {
		const { app, ctx } = await harness();
		try {
			const listed = await run(app, "costume", { item: "list" }, ctx);
			expect(listed.status).toBe("succeeded");
			expect(listed.result).toContain("glasses");
			expect(await run(app, "costume", { item: "glasses" }, ctx)).toMatchObject({ status: "not_started" });
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("reload：重载并核验绑定；重载后身份不符报 unadapted", async () => {
		const { app, fake, ctx } = await harness();
		try {
			const res = await run(app, "reload", {}, ctx);
			expect(res.status).toBe("succeeded");
			expect((res.details as { effectStatus: string }).effectStatus).toBe("accepted");
			expect(fake.state.reloadCalls).toBe(1);

			fake.state.profile = makeProfile("another-model");
			expect((await run(app, "reload", {}, ctx)).details).toMatchObject({ reason: "unadapted" });
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("status/diagnose：JSON 可解析且包含 P4-1 新事实（published/authorSession/catalog）", async () => {
		const { app, ctx } = await harness({ published: false });
		try {
			const status = JSON.parse((await run(app, "status", {}, ctx)).result) as Record<string, unknown>;
			expect(status).toMatchObject({ world: "live2d", published: false, authorSession: false });
			expect(status.catalog).toMatchObject({ motions: ["nod"], postures: ["lean"], expressions: ["brighten"] });
			const diag = JSON.parse((await run(app, "diagnose", {}, ctx)).result) as Record<string, unknown>;
			expect(diag).toMatchObject({ published: false, clockRunning: false });
			expect(diag.director).toMatchObject({ attention: null });
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});
});

describe("compileCatalog 绑定期校验", () => {
	it("命名空间全局唯一：目录命名/别名/内置注视词表冲突即抛", () => {
		const rig = makeRig();
		expect(() =>
			compileCatalog(
				MODEL_ID,
				{
					motions: {
						lean: {
							description: "a",
							motion: motion(
								100,
								track("head.yaw", [
									[0, 1],
									[100, 1],
								]),
							),
						},
					},
					postures: { lean: { description: "b", values: { "head.yaw": 2 } } },
				},
				rig,
			),
		).toThrow(/命名冲突/);
		expect(() =>
			compileCatalog(
				MODEL_ID,
				{
					motions: {
						nod: {
							description: "a",
							aliases: ["nod2"],
							motion: motion(
								100,
								track("head.yaw", [
									[0, 1],
									[100, 1],
								]),
							),
						},
					},
					expressions: { nod2: { description: "b", values: { "head.yaw": 2 } } },
				},
				rig,
			),
		).toThrow(/命名冲突/);
		expect(() =>
			compileCatalog(MODEL_ID, { attentions: { user: { description: "x", target: { x: 0, y: 0 } } } }, rig),
		).toThrow(/内置词表冲突/);
	});

	it("轴值范围与未声明控制、模型身份不符即抛", () => {
		const rig = makeRig();
		expect(() =>
			compileCatalog(MODEL_ID, { postures: { bad: { description: "x", values: { "head.yaw": 99 } } } }, rig),
		).toThrow(/越界/);
		expect(() =>
			compileCatalog(MODEL_ID, { postures: { bad: { description: "x", values: { "arm.lift": 1 } } } }, rig),
		).toThrow(/未声明控制/);
		expect(() => compileCatalog("other-model", {}, rig)).toThrow(/身份不符/);
	});
});
