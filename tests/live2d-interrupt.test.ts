import { unconfirmedInjections } from "./live2d-injection-fixture.js";
import { describe, expect, it } from "vitest";
import type { BodyEndpoint } from "../src/extensions/world-framework/seams.js";
import { activateEmbodimentExtension } from "../.uina/extensions/embodiment/index.js";
import { BodyRouter } from "../.uina/extensions/embodiment/body-router.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";
import { compileMotion, motion, track, type CompiledMotion } from "../.uina/worlds/live2d/authoring/motion.js";
import { compileCatalog } from "../.uina/worlds/live2d/authoring/catalog.js";
import { createLive2DApp } from "../.uina/worlds/live2d/index.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import type { ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";

/**
 * P4-8：打断语义（边界 #4）——turn_aborted → interruptAll → endpoint.interrupt。
 * 瞬时动作经 fade 结算 cancelled、槽位与自律保持、身体不进入 paused、emitCue 仍可受理；
 * safeStop（显式暂停）后 emitCue 才拒绝。
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

/** 原始定义（CatalogSource 输入用）。 */
const headTrack = (durationMs: number, value: number) =>
	motion(
		durationMs,
		track("head.yaw", [
			[0, value],
			[durationMs, value],
		]),
	);

/** 编译产物（director.play 直播用）。 */
const compile = (durationMs: number, value: number): CompiledMotion =>
	compileMotion(headTrack(durationMs, value), makeRig().controls);

const stepMs = (d: MotionDirector, totalMs: number, step = 16): void => {
	for (let i = 0; i < Math.ceil(totalMs / step); i++) d.step(step);
};

interface FakeState {
	connected: boolean;
}

const makeRuntime = (state: FakeState) => {
	const client = {
		...unconfirmedInjections(),
		isConnected: () => state.connected,
		getModelProfile: () => ({ modelID: MODEL_ID }),
		injectParameters: () => {},
		setConnectionChangeListener: () => {},
		connect: () => {},
		disconnect: () => {},
		getConnectionStatus: () => ({ connected: state.connected }),
		getFault: () => undefined,
	} as unknown as VTSClient;
	return new Live2DRuntime({
		client,
		rig: makeRig(),
		catalog: compileCatalog(
			MODEL_ID,
			{
				motions: { long: { description: "长动作", motion: headTrack(3000, 6) } },
				postures: { lean: { description: "侧倾", values: { "head.yaw": 4 } } },
			},
			makeRig(),
		),
	});
};

describe("director.interruptTransient（P4-8）", () => {
	it("Voluntary 与 Transition（thinking 类）fade 收势结算 cancelled（reason=interrupted）；reflex 与槽位保持；不冻结", async () => {
		const d = new MotionDirector(makeRig().controls);
		void d.setPosture({ "head.yaw": 4 }); // 槽位：打断后保持
		const voluntary = d.play(compile(3000, 6), { category: "voluntary" });
		const thinking = d.play(compile(5000, -3), { category: "transition" });
		const reflex = d.play(compile(5000, 2), { category: "reflex" });

		d.interruptTransient("turn_aborted");
		expect(voluntary.status).not.toBe("playing");
		expect(thinking.status).not.toBe("playing");
		expect(reflex.status).toBe("playing"); // reflex 不被打断

		stepMs(d, 300); // fadeOut 250ms 收势完成
		expect(await voluntary.finished).toMatchObject({ status: "cancelled", reason: "turn_aborted" });
		expect(await thinking.finished).toMatchObject({ status: "cancelled", reason: "turn_aborted" });
		expect(d.currentFrame["head.yaw"]).toBeCloseTo(2, 0); // reflex 值接管（fade 交还连续性）

		// 槽位保持：reflex 移除且 600ms 槽位过渡完成后，槽位值可见。
		reflex.stop("cut");
		stepMs(d, 1000); // 过渡 600ms + 弹簧收敛；空闲期 sway ±1.2
		expect(Math.abs(d.currentFrame["head.yaw"]! - 4)).toBeLessThan(1.5);
	});

	it("口型包络立即清零（不走 50ms 释放；§4 急停第三层）", () => {
		const d = new MotionDirector(makeRig().controls);
		d.setSpeechLevel(1);
		stepMs(d, 50);
		expect(d.currentFrame["mouth.open"]).toBeGreaterThan(0.5);
		d.interruptTransient();
		d.step(16);
		expect(d.currentFrame["mouth.open"]).toBe(0); // 当帧即 0，而非 50ms 线性下降
	});
});

describe("endpoint.interrupt（边界 #4）", () => {
	it("打断：瞬时动作 fade 结算、槽位保持、不进入 paused、emitCue 仍可受理；safeStop 后 emitCue 才拒绝", async () => {
		const state: FakeState = { connected: true };
		const rt = makeRuntime(state);
		const app = createLive2DApp({ instance: rt });
		await app.onStart!({ expose: () => () => {} } as unknown as ServiceCompanionContext);
		const endpoint = rt.endpoint;
		try {
			endpoint.emitCue("long");
			for (let i = 0; i < 10; i++) rt.composeTick(16);
			expect(rt.director!.currentFrame["head.yaw"]).toBeGreaterThan(3);

			endpoint.interrupt!();
			expect(endpoint.state().paused).toBe(false); // 不进入 paused
			for (let i = 0; i < 20; i++) rt.composeTick(16); // fade 250ms
			await new Promise((r) => setImmediate(r));
			const record = endpoint.lastCue().at(-1)!;
			expect(record).toMatchObject({ id: "long", state: "finished", reason: "turn_aborted" });

			// emitCue 仍可受理（打断不暂停身体）：姿态 cue 正常生效。
			endpoint.emitCue("lean");
			for (let i = 0; i < 45; i++) rt.composeTick(16);
			await new Promise((r) => setImmediate(r));
			expect(Math.abs(rt.director!.currentFrame["head.yaw"]! - 4)).toBeLessThan(1.5); // sway ±1.2

			// 对照：safeStop（显式暂停）后 emitCue 才拒绝。
			await endpoint.safeStop();
			expect(endpoint.state().paused).toBe(true);
			endpoint.emitCue("lean");
			await new Promise((r) => setImmediate(r));
			expect(endpoint.lastCue().at(-1)).toMatchObject({ state: "rejected", reason: "paused" });
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});
});

describe("BodyRouter.interruptAll（§5 分发改造）", () => {
	it("优先端点 interrupt（不调用 safeStop）；未实现 interrupt 的端点回退 safeStop", async () => {
		const router = new BodyRouter();
		const calls: string[] = [];
		const withInterrupt: BodyEndpoint = {
			bodyId: "a",
			bodyType: "avatar_2d",
			affordance: () => ({ bodyId: "a", bodyType: "avatar_2d", description: "", cues: [] }),
			state: () => ({ online: true, paused: false }),
			emitCue: () => {},
			safeStop: async () => {
				calls.push("a.safeStop");
			},
			resume: async () => {},
			interrupt: () => calls.push("a.interrupt"),
		};
		const withoutInterrupt: BodyEndpoint = {
			bodyId: "b",
			bodyType: "avatar_2d",
			affordance: () => ({ bodyId: "b", bodyType: "avatar_2d", description: "", cues: [] }),
			state: () => ({ online: true, paused: false }),
			emitCue: () => {},
			safeStop: async () => {
				calls.push("b.safeStop");
			},
			resume: async () => {},
		};
		router.registerEndpoint(withInterrupt);
		router.registerEndpoint(withoutInterrupt);
		await router.interruptAll();
		expect(calls).toEqual(["a.interrupt", "b.safeStop"]);
	});
});

describe("turn_aborted → interruptAll 分发（embodiment 集成）", () => {
	it("turn_aborted 事件触发 interrupt 路径：动作取消、身体不暂停（不再走 safeStop 急停）", async () => {
		const state: FakeState = { connected: true };
		const rt = makeRuntime(state);
		const app = createLive2DApp({ instance: rt });
		await app.onStart!({ expose: () => () => {} } as unknown as ServiceCompanionContext);
		try {
			const handlers = new Map<string, (event: object) => void>();
			const sharedFeed = { names: () => [] as string[], get: () => undefined, subscribe: () => () => {} };
			const fakePi = {
				on: (type: string, cb: (event: object) => void) => {
					handlers.set(type, cb);
					return () => {};
				},
				onHook: () => () => {},
				shared: () => sharedFeed,
				share: () => () => {},
				registerTool: () => () => {},
				registerMarkdownTransformer: () => () => {},
				signal: new AbortController().signal,
				appendEntry: async () => {},
				reportError: () => {},
			};
			const { router } = activateEmbodimentExtension(fakePi as never);
			router.registerEndpoint(rt.endpoint);

			rt.endpoint.emitCue("long");
			for (let i = 0; i < 10; i++) rt.composeTick(16);
			expect(rt.director!.currentFrame["head.yaw"]).toBeGreaterThan(3);

			handlers.get("turn_aborted")!({});
			for (let i = 0; i < 20; i++) rt.composeTick(16); // fade 收势
			await new Promise((r) => setImmediate(r));
			expect(rt.endpoint.lastCue().at(-1)).toMatchObject({ id: "long", state: "finished", reason: "turn_aborted" });
			expect(rt.endpoint.state().paused).toBe(false); // interrupt 而非 safeStop
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});
});
