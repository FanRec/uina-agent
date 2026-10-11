import { describe, expect, it } from "vitest";
import { createLive2DApp } from "../.uina/worlds/live2d/index.js";
import type { ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { compileCatalog } from "../.uina/worlds/live2d/authoring/catalog.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

/**
 * P4-5：独占资源工具（边界 #9）。
 * spatial 绝对位姿 + 回读核实；costume 独占 effect:* + 热键触发；
 * model:transform 互斥（spatial 并发冲突）；safeStop 等待清理完成、未确认抛错（§6.2/6.4）。
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

interface FakeState {
	connected: boolean;
	pose: { positionX: number; positionY: number; rotation: number; size: number };
	hotkeyIDs: string[];
	triggered: string[];
	moveCalls: Array<Record<string, unknown>>;
	hangMove: boolean;
	slowHotkey?: { resolve: () => void };
}

const makeFake = (state: FakeState): VTSClient =>
	({
		isConnected: () => state.connected,
		getModelProfile: () => ({ modelID: MODEL_ID }),
		injectParameters: () => {},
		setConnectionChangeListener: () => {},
		connect: () => {},
		disconnect: () => {},
		getConnectionStatus: () => ({ connected: state.connected }),
		getFault: () => undefined,
		getModelPosition: async () => ({ ...state.pose }),
		moveModel: async (options: Record<string, unknown>) => {
			state.moveCalls.push(options);
			if (state.hangMove) return new Promise(() => {});
			if (options.valuesAreRelativeToModel === false) {
				if (options.positionX !== undefined) state.pose.positionX = options.positionX as number;
				if (options.positionY !== undefined) state.pose.positionY = options.positionY as number;
				if (options.rotation !== undefined) state.pose.rotation = options.rotation as number;
				if (options.size !== undefined) state.pose.size = options.size as number;
			}
		},
		triggerHotkey: async (hotkeyID: string) => {
			if (state.slowHotkey) {
				await new Promise<void>((resolve) => {
					state.slowHotkey!.resolve = resolve;
				});
			}
			state.triggered.push(hotkeyID);
		},
		findHotkey: (query: string) => {
			const exact = state.hotkeyIDs.find((id) => id === query);
			if (exact) return { hotkeyID: exact, name: exact };
			return state.hotkeyIDs.length ? { hotkeyID: state.hotkeyIDs[0]!, name: state.hotkeyIDs[0]! } : undefined;
		},
	}) as unknown as VTSClient;

const makeRuntime = (state: FakeState, cleanupTimeoutMs?: number) =>
	new Live2DRuntime({
		client: makeFake(state),
		rig: makeRig(),
		...(cleanupTimeoutMs !== undefined ? { cleanupTimeoutMs } : {}),
		catalog: compileCatalog(
			MODEL_ID,
			{
				costumes: [{ id: "cute", description: "可爱", hotkeyID: "hk-1" }],
			},
			makeRig(),
		),
	});

const startApp = async (rt: Live2DRuntime) => {
	const app = createLive2DApp({ instance: rt });
	await app.onStart!({ expose: () => () => {} } as unknown as ServiceCompanionContext);
	return app;
};

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("独占资源工具（P4-5，边界 #9）", () => {
	it("model:transform 互斥：spatial 进行中另一个 spatial → resource_conflict；结束后可再用", async () => {
		const state: FakeState = {
			connected: true,
			pose: { positionX: 0, positionY: 0, rotation: 10, size: 1 },
			hotkeyIDs: [],
			triggered: [],
			moveCalls: [],
			hangMove: false,
		};
		const rt = makeRuntime(state);
		const app = await startApp(rt);
		try {
			const firstP = rt.spatial({ x: 0.5, duration: 0.8 }, {});
			await tick(); // first 已持有声明
			const secondP = rt.spatial({ x: 0.3 }, {});
			const secondResult = await secondP;
			expect(secondResult.status).toBe("failed");
			expect(secondResult.details).toMatchObject({ reason: "resource_conflict" });
			const firstResult = await firstP;
			expect(firstResult.status).toBe("succeeded");

			// 结束后资源可用。
			const again = await rt.spatial({ x: 0.3, duration: 0.1 }, {});
			expect(again.status).toBe("succeeded");
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("safeStop 期间等待在途归位清理完成，完成后暂停生效；此后工具 paused 拒绝", async () => {
		const state: FakeState = {
			connected: true,
			pose: { positionX: 0, positionY: 0, rotation: 10, size: 1 },
			hotkeyIDs: [],
			triggered: [],
			moveCalls: [],
			hangMove: false,
		};
		const rt = makeRuntime(state);
		const app = await startApp(rt);
		try {
			let finishCleanup: (val: boolean) => void = () => {};
			const cleanupPromise = new Promise<boolean>((resolve) => {
				finishCleanup = resolve;
			});
			rt.trackCleanup(cleanupPromise);
			const stopP = rt.safeStop();
			await tick();
			expect(rt.isPaused).toBe(true);
			finishCleanup(true);
			await stopP;
			expect(rt.endpoint.state().paused).toBe(true);
			const spatialP = await rt.spatial({ x: 0.3 }, {});
			expect(spatialP.details).toMatchObject({ reason: "paused" });
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("safeStop 清理未确认（超时）→ 抛错（§6.4）", async () => {
		const state: FakeState = {
			connected: true,
			pose: { positionX: 0, positionY: 0, rotation: 10, size: 1 },
			hotkeyIDs: [],
			triggered: [],
			moveCalls: [],
			hangMove: false,
		};
		const rt = makeRuntime(state, 50);
		const app = await startApp(rt);
		try {
			rt.trackCleanup(new Promise<boolean>(() => {})); // 永不结算的清理
			await expect(rt.safeStop()).rejects.toThrow("归位清理尚未确认");
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("costume：热键触发 succeeded/accepted；不在目录 unknown_costume；VTS 未登记 hotkey_missing", async () => {
		const state: FakeState = {
			connected: true,
			pose: { positionX: 0, positionY: 0, rotation: 0, size: 1 },
			hotkeyIDs: ["hk-1"],
			triggered: [],
			moveCalls: [],
			hangMove: false,
		};
		const rt = makeRuntime(state);
		const app = await startApp(rt);
		try {
			const ok = await rt.costume({ item: "cute" }, {});
			expect(ok.status).toBe("succeeded");
			expect(ok.details).toMatchObject({ effectStatus: "accepted" });
			expect(state.triggered).toEqual(["hk-1"]);

			const unknown = await rt.costume({ item: "nope" }, {});
			expect(unknown.details).toMatchObject({ reason: "unknown_costume" });

			state.hotkeyIDs = [];
			const missing = await rt.costume({ item: "cute" }, {});
			expect(missing.details).toMatchObject({ reason: "hotkey_missing" });
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("effect:* 互斥：前一个 costume 触发未返回时，后一个 → resource_conflict", async () => {
		const state: FakeState = {
			connected: true,
			pose: { positionX: 0, positionY: 0, rotation: 0, size: 1 },
			hotkeyIDs: ["hk-1"],
			triggered: [],
			moveCalls: [],
			hangMove: false,
			slowHotkey: { resolve: () => {} },
		};
		const rt = makeRuntime(state);
		const app = await startApp(rt);
		try {
			const first = rt.costume({ item: "cute" }, {});
			await tick(); // 进入挂起的 triggerHotkey
			const second = await rt.costume({ item: "cute" }, {});
			expect(second.details).toMatchObject({ reason: "resource_conflict" });
			state.slowHotkey?.resolve();
			expect((await first).status).toBe("succeeded");
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});
});
