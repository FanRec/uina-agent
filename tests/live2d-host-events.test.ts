import { describe, expect, it } from "vitest";
import { createLive2DApp } from "../.uina/worlds/live2d/index.js";
import type { ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { motion, track } from "../.uina/worlds/live2d/authoring/motion.js";
import { compileCatalog } from "../.uina/worlds/live2d/authoring/catalog.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

/**
 * P4-4：宿主事件消费（§5 最小消费集）。
 * thinking 状态驱动幂等（false→true 启动一次）；turn 边界停止；turn_aborted → interrupt；
 * 未发布目录 no-op；stop 清理订阅。
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

const headTrack = (durationMs: number, value: number) =>
	motion(
		durationMs,
		track("head.yaw", [
			[0, value],
			[durationMs, value],
		]),
	);

const makeRuntime = (state: { connected: boolean }, published = true) => {
	const client = {
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
		published,
		catalog: compileCatalog(
			MODEL_ID,
			{
				motions: { long: { description: "长动作", motion: headTrack(3000, 6) } },
				background: { thinking: headTrack(3000, 5) },
			},
			makeRig(),
		),
	});
};

/** fake ctx：捕获 onHostEvent 监听器；返回退订是否被调用的探针。 */
const makeCtx = () => {
	const listeners: Array<(event: { type: string; channel?: string }) => void> = [];
	let unsubscribed = false;
	const ctx = {
		expose: () => () => {},
		onHostEvent: (listener: (event: { type: string; channel?: string }) => void) => {
			listeners.push(listener);
			return () => {
				unsubscribed = true;
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
	} as unknown as ServiceCompanionContext;
	const fire = (event: { type: string; channel?: string }) => {
		for (const l of listeners) l(event);
	};
	return { ctx, fire, isUnsubscribed: () => unsubscribed };
};

const stepMs = (rt: Live2DRuntime, totalMs: number, step = 16): void => {
	for (let i = 0; i < Math.ceil(totalMs / step); i++) rt.composeTick(step);
};
const flush = () => new Promise((r) => setImmediate(r));

describe("宿主事件消费（P4-4，§5）", () => {
	it("thinking 事件启动 background.thinking；重复事件幂等（单一实例）；turn_end fade 停止", async () => {
		const state = { connected: true };
		const rt = makeRuntime(state);
		const { ctx, fire } = makeCtx();
		const app = createLive2DApp({ instance: rt });
		await app.onStart!(ctx);
		try {
			fire({ type: "output_update", channel: "thinking" });
			fire({ type: "output_update", channel: "thinking" }); // 幂等：不重复启动
			stepMs(rt, 600); // fade-in 完成
			expect(rt.director!.currentFrame["head.yaw"]).toBeGreaterThan(3.5); // thinking 值 5（播放期 sway 被抑制）

			fire({ type: "turn_end" });
			stepMs(rt, 1000); // fade-out 250ms + 弹簧收敛；空闲 sway ±1.2
			expect(Math.abs(rt.director!.currentFrame["head.yaw"]!)).toBeLessThan(1.5);

			// turn_start 同样停止。
			fire({ type: "output_update", channel: "thinking" });
			stepMs(rt, 600);
			expect(rt.director!.currentFrame["head.yaw"]).toBeGreaterThan(3.5);
			fire({ type: "turn_start" });
			stepMs(rt, 1000);
			expect(Math.abs(rt.director!.currentFrame["head.yaw"]!)).toBeLessThan(1.5);
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("turn_aborted → interrupt：cue 结算 turn_aborted、不进 paused、thinking 复位后可重新启动", async () => {
		const state = { connected: true };
		const rt = makeRuntime(state);
		const { ctx, fire } = makeCtx();
		const app = createLive2DApp({ instance: rt });
		await app.onStart!(ctx);
		try {
			rt.endpoint.emitCue("long");
			fire({ type: "output_update", channel: "thinking" });
			stepMs(rt, 160);
			expect(rt.director!.currentFrame["head.yaw"]).toBeGreaterThan(3); // voluntary 播放中

			fire({ type: "turn_aborted" });
			stepMs(rt, 400); // fade 收势
			await flush();
			expect(rt.endpoint.lastCue().at(-1)).toMatchObject({ id: "long", state: "finished", reason: "turn_aborted" });
			expect(rt.endpoint.state().paused).toBe(false);

			// thinking 复位验证：interrupt 归零后再次 thinking=true 必须能重新点亮。
			fire({ type: "output_update", channel: "thinking" });
			stepMs(rt, 700);
			expect(rt.director!.currentFrame["head.yaw"]).toBeGreaterThan(3.5);
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("未发布目录：thinking 事件 no-op（catalogView 为空，启动失败不重试）", async () => {
		const state = { connected: true };
		const rt = makeRuntime(state, false);
		const { ctx, fire } = makeCtx();
		const app = createLive2DApp({ instance: rt });
		await app.onStart!(ctx);
		try {
			fire({ type: "output_update", channel: "thinking" });
			fire({ type: "turn_end" });
			stepMs(rt, 600);
			expect(Math.abs(rt.director!.currentFrame["head.yaw"]!)).toBeLessThan(1.5); // 空闲 sway
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("stop 清理订阅：退订函数被调用，事件不再消费", async () => {
		const state = { connected: true };
		const rt = makeRuntime(state);
		const { ctx, fire, isUnsubscribed } = makeCtx();
		const app = createLive2DApp({ instance: rt });
		await app.onStart!(ctx);
		await app.onStop?.({} as ServiceCompanionContext);
		expect(isUnsubscribed()).toBe(true);

		// 退订后事件不再驱动（director 仍在，但 thinking 不应被点亮）。
		fire({ type: "output_update", channel: "thinking" });
		stepMs(rt, 600);
		expect(Math.abs(rt.director!.currentFrame["head.yaw"]!)).toBeLessThan(1.5);
	});
});
