import { describe, expect, it } from "vitest";
import { createLive2DApp } from "../.uina/worlds/live2d/index.js";
import type { ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { compileCatalog } from "../.uina/worlds/live2d/authoring/catalog.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

/**
 * P4-5：独占资源工具（边界 #9）。
 * flip 绝对轨迹 + 归位回读 + 带清理声明（取消后等待清理完成才结算、清理完成前资源不释放）；
 * spatial 绝对位姿 + 回读核实；costume 独占 effect:* + 热键触发；
 * model:transform 互斥（flip↔spatial）；safeStop 等待清理完成、未确认抛错（§6.2/6.4）。
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
	it("flip：绝对轨迹整圈旋转 + 归位回读核实 → succeeded/applied", async () => {
		const state: FakeState = {
			connected: true,
			pose: { positionX: 0.1, positionY: 0.2, rotation: 10, size: 1 },
			hotkeyIDs: [],
			triggered: [],
			moveCalls: [],
			hangMove: false,
		};
		const rt = makeRuntime(state);
		const app = await startApp(rt);
		try {
			const result = await rt.flip({}, {});
			expect(result.status).toBe("succeeded");
			expect(result.details).toMatchObject({ effectStatus: "applied" });
			expect(state.pose.rotation).toBeCloseTo(370, 5); // 10 + 360（绝对轨迹）
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("model:transform 互斥：flip 进行中 spatial → resource_conflict；结束后可再用", async () => {
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
			const flipP = rt.flip({}, {});
			await tick(); // flip 已持有声明
			const spatialP = rt.spatial({ x: 0.3 }, {});
			const spatialResult = await spatialP;
			expect(spatialResult.status).toBe("failed");
			expect(spatialResult.details).toMatchObject({ reason: "resource_conflict" });
			const flipResult = await flipP;
			expect(flipResult.status).toBe("succeeded");

			// 结束后资源可用。
			const again = await rt.spatial({ x: 0.3, duration: 0.1 }, {});
			expect(again.status).toBe("succeeded");
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("flip 取消：等待归位清理完成才结算 cancelled；清理完成前 spatial 仍 resource_conflict，完成后可用", async () => {
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
			const ac = new AbortController();
			const flipP = rt.flip({}, { signal: ac.signal });
			await tick(); // 进入播放等待段
			ac.abort();
			// 清理期间声明仍被持有：立即发起 spatial 必须冲突（#9：清理完成前资源不释放）。
			const during = await rt.spatial({ x: 0.3 }, {});
			expect(during.details).toMatchObject({ reason: "resource_conflict" });
			const result = await flipP;
			expect(result.status).toBe("cancelled");
			expect(result.details).toMatchObject({ effectStatus: "cancelled" });
			expect(state.pose.rotation).toBeCloseTo(10, 5); // 归位核实

			const after = await rt.spatial({ x: 0.3, duration: 0.1 }, {});
			expect(after.status).toBe("succeeded");
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("safeStop 期间 flip：等待归位清理完成后暂停生效，flip 结算 cancelled；此后工具 paused 拒绝", async () => {
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
			const flipP = rt.flip({}, {});
			await tick();
			await rt.safeStop(); // 等 awaitCleanups 返回即已清理完成
			const result = await flipP;
			expect(result.status).toBe("cancelled");
			expect(state.pose.rotation).toBeCloseTo(10, 5);
			expect(rt.endpoint.state().paused).toBe(true);
			const spatialP = await rt.spatial({ x: 0.3 }, {});
			expect(spatialP.details).toMatchObject({ reason: "paused" });
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("safeStop 清理未确认（挂起的归位 move）→ 抛错（§6.4）", async () => {
		const state: FakeState = {
			connected: true,
			pose: { positionX: 0, positionY: 0, rotation: 10, size: 1 },
			hotkeyIDs: [],
			triggered: [],
			moveCalls: [],
			hangMove: false,
		};
		const rt = makeRuntime(state, 150);
		const app = await startApp(rt);
		try {
			const flipP = rt.flip({}, {});
			await tick(); // 首次 moveModel 已完成（假体即时到位）
			state.hangMove = true; // 归位清理将挂起
			await expect(rt.safeStop()).rejects.toThrow("归位清理尚未确认");
			void flipP; // flip 悬挂在挂起的清理上，不 await（清理永不完成）
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
