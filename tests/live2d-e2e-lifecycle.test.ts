import { describe, expect, it } from "vitest";
import { createLive2DApp } from "../.uina/worlds/live2d/index.js";
import type { ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { motion, track } from "../.uina/worlds/live2d/authoring/motion.js";
import { compileCatalog } from "../.uina/worlds/live2d/authoring/catalog.js";
import type { SpeechConfig } from "../.uina/worlds/live2d/speech-level.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

/**
 * P4-7 假体端到端（边界 #3/#7/#8 全链路）：
 * 断线 → 零注入 → 重连恢复；safeStop 保持帧注入 + 口型归中 → resume 恢复；
 * 目录代次端到端：旧代次 in-flight 失效 → 新目录 cue 可用。
 * 本机 VTS 画面验收由操作员执行（checklist P4-7）。
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

const makeCatalog = (entries: Record<string, number>) =>
	compileCatalog(
		MODEL_ID,
		{
			motions: Object.fromEntries(
				Object.entries(entries).map(([name, value]) => [name, { description: name, motion: headTrack(3000, value) }]),
			),
		},
		makeRig(),
	);

const SPEECH: SpeechConfig = {
	points: [
		[0.1, 0],
		[1, 1],
	],
	staleMs: 500,
};

interface FakeState {
	connected: boolean;
	injects: Array<Array<{ id: string; value: number }>>;
	listener?: (connected: boolean) => void;
}

const makeRuntime = (state: FakeState, speech?: SpeechConfig) => {
	const client = {
		isConnected: () => state.connected,
		getModelProfile: () => ({ modelID: MODEL_ID }),
		injectParameters: (payload: Array<{ id: string; value: number }>) => {
			state.injects.push(payload);
		},
		setConnectionChangeListener: (listener: (connected: boolean) => void) => {
			state.listener = listener;
		},
		connect: () => {},
		disconnect: () => {},
		getConnectionStatus: () => ({ connected: state.connected }),
		getFault: () => undefined,
	} as unknown as VTSClient;
	return new Live2DRuntime({
		client,
		rig: makeRig(),
		...(speech ? { speech } : {}),
		published: true,
		catalog: makeCatalog({ long: 6 }),
	});
};

const startApp = async (rt: Live2DRuntime) => {
	const app = createLive2DApp({ instance: rt });
	await app.onStart!({ expose: () => () => {} } as unknown as ServiceCompanionContext);
	return app;
};

const stepMs = (rt: Live2DRuntime, totalMs: number, step = 16): void => {
	for (let i = 0; i < Math.ceil(totalMs / step); i++) rt.composeTick(step);
};
const flush = () => new Promise((r) => setImmediate(r));
const lastMouth = (state: FakeState): number | undefined =>
	state.injects.at(-1)?.find((entry) => entry.id === "MouthOpen")?.value;

describe("生命周期端到端（P4-7 假体，#3/#7/#8）", () => {
	it("断线 → 停止注入（零输出）+ 工具 model_not_ready → 重连恢复合成", async () => {
		const state: FakeState = { connected: true, injects: [] };
		const rt = makeRuntime(state);
		const app = await startApp(rt);
		try {
			rt.endpoint.emitCue("long");
			stepMs(rt, 160);
			const count = state.injects.length;
			expect(count).toBeGreaterThan(5); // 正常注入中

			state.connected = false;
			state.listener?.(false); // 断线事实
			stepMs(rt, 160);
			expect(state.injects.length).toBe(count); // 零输出
			const offline = await rt.express({ motion: "long" }, {});
			expect(offline.details).toMatchObject({ reason: "model_not_ready" });

			state.connected = true;
			state.listener?.(true); // 重连
			stepMs(rt, 160);
			expect(state.injects.length).toBeGreaterThan(count); // 恢复合成
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("safeStop：说话中暂停 → 保持帧持续注入且口型归中、cue 拒绝 paused → resume 电平恢复", async () => {
		const state: FakeState = { connected: true, injects: [] };
		const rt = makeRuntime(state, SPEECH);
		const app = await startApp(rt);
		try {
			rt.levelSink!.processLevel({ rms: 1 });
			stepMs(rt, 80);
			expect(lastMouth(state)!).toBeGreaterThan(0.5); // 口型跟随中

			await rt.safeStop();
			const count = state.injects.length;
			stepMs(rt, 80);
			expect(state.injects.length).toBeGreaterThan(count); // 暂停期注入不停止
			expect(lastMouth(state)).toBe(0); // 保持帧口型归中
			rt.endpoint.emitCue("long");
			await flush();
			expect(rt.endpoint.lastCue().at(-1)).toMatchObject({ id: "long", state: "rejected", reason: "paused" });

			await rt.resume();
			rt.levelSink!.processLevel({ rms: 1 });
			stepMs(rt, 80);
			expect(lastMouth(state)!).toBeGreaterThan(0.5); // 电平恢复跟随
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("代次端到端：目录更新 → 旧代次 in-flight 结算 cancelled → 新目录 cue 正常播放", async () => {
		const state: FakeState = { connected: true, injects: [] };
		const rt = makeRuntime(state);
		const app = await startApp(rt);
		try {
			rt.endpoint.emitCue("long");
			stepMs(rt, 80);

			rt.setCatalog(makeCatalog({ long2: -6 })); // 代次递增 + 旧代次失效
			stepMs(rt, 100);
			await flush();
			const old = rt.endpoint.lastCue().find((record) => record.id === "long")!;
			expect(old.state).toBe("finished");
			expect(old.reason).toBe("catalog changed");

			rt.endpoint.emitCue("long2"); // 新目录 cue 可用
			stepMs(rt, 200);
			expect(rt.director!.currentFrame["head.yaw"]).toBeLessThan(-4); // 新动作值 -6（播放中）
			stepMs(rt, 3200); // 播放至 3000ms 自然结束
			await flush();
			expect(rt.endpoint.lastCue().at(-1)).toMatchObject({ id: "long2", state: "finished" });
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});
});
