import { unconfirmedInjections } from "./live2d-injection-fixture.js";
import { describe, expect, it } from "vitest";
import { createLive2DApp } from "../.uina/worlds/live2d/index.js";
import type { ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { compileCatalog, type CatalogSource } from "../.uina/worlds/live2d/authoring/catalog.js";
import { motion, track } from "../.uina/worlds/live2d/authoring/motion.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

/**
 * P4-5：独占资源（边界 #9）。
 * 空间特技手势（model:transform 独占）+ 回读核实；costume 独占 effect:* + 热键触发；
 * model:transform 互斥（空间手势并发冲突）；safeStop 等待清理完成、未确认抛错（§6.2/6.4）。
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

const makeFake = (state: FakeState): VTSClient => {
	let listener: ((connected: boolean) => void) | undefined;
	return {
		...unconfirmedInjections(),
		isConnected: () => state.connected,
		getModelProfile: () => ({ modelID: MODEL_ID }),
		injectParameters: () => {},
		setConnectionChangeListener: (l: (connected: boolean) => void) => {
			listener = l;
		},
		connect: () => {
			if (state.connected) listener?.(true);
		},
		disconnect: () => {
			listener?.(false);
		},
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
	} as unknown as VTSClient;
};

const makeRuntime = (state: FakeState, cleanupTimeoutMs?: number) =>
	new Live2DRuntime({
		client: makeFake(state),
		rig: makeRig(),
		...(cleanupTimeoutMs !== undefined ? { cleanupTimeoutMs } : {}),
		catalog: compileCatalog(
			MODEL_ID,
			{
				motions: {
					spin: {
						description: "旋转特技",
						motion: motion(
							100,
							track("head.yaw", [
								[0, 0],
								[100, 0],
							]),
						),
						spatial: {
							segments: [
								// base.rotation=10 + 200 = 210 ∈ ±360（组合前瞻校验会拒绝越界值）
								{ delta: { rotation: 200 }, durationMs: 100 },
								{ delta: { rotation: 0 }, durationMs: 100 },
							],
						},
					},
				},
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

describe("独占资源（P4-5，边界 #9）", () => {
	it("model:transform 互斥：空间特技手势进行中另一个空间特技 → resource_conflict；结束后可再用", async () => {
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
			const firstP = rt.express({ motion: "spin" }, {});
			await tick(); // first 已持有声明
			const secondP = rt.express({ motion: "spin" }, {});
			const secondResult = await secondP;
			expect(secondResult.status).toBe("failed");
			expect(secondResult.details).toMatchObject({ reason: "resource_conflict" });
			const firstResult = await firstP;
			expect(firstResult.status).toBe("unknown"); // 假体不确认参数输入。
			expect(firstResult.details).toMatchObject({ restored: true });

			// 结束后资源可用。
			const again = await rt.express({ motion: "spin" }, {});
			expect(again.status).toBe("unknown");
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("组合前瞻校验：位姿组合越界在发送前整体失败，零 moveModel、零归位", async () => {
		const state: FakeState = {
			connected: true,
			// wrapDeg(170)=170（正表示法下不折绕），170+200=370 > 360 → 越界
			pose: { positionX: 0, positionY: 0, rotation: 170, size: 1 },
			hotkeyIDs: [],
			triggered: [],
			moveCalls: [],
			hangMove: false,
		};
		const rt = makeRuntime(state);
		const app = await startApp(rt);
		try {
			const result = await rt.express({ motion: "spin" }, {});
			expect(result.status).toBe("failed");
			expect(result.details).toMatchObject({ reason: "invalid_motion", effectStatus: "not_started" });
			expect((result.details as { violations: string[] }).violations[0]).toContain("rotation=370");
			expect((result.details as { violations: string[] }).violations[0]).toContain("段[0]");
			expect(state.moveCalls).toEqual([]); // 未发送任何移动，无需归位
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("正表示法归一化：回读 rotation 348（= -12）合成前 wrapDeg，实发 188 而非 548", async () => {
		const state: FakeState = {
			connected: true,
			pose: { positionX: 0, positionY: 0, rotation: 348, size: 1 },
			hotkeyIDs: [],
			triggered: [],
			moveCalls: [],
			hangMove: false,
		};
		const rt = makeRuntime(state);
		const app = await startApp(rt);
		try {
			const result = await rt.express({ motion: "spin" }, {});
			expect(result.status).toBe("unknown"); // 假体不确认参数输入（既有语义）
			expect(state.moveCalls[0]).toMatchObject({ rotation: 188 }); // wrapDeg(348)=-12, -12+200=188
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("compileCatalog：delta 数值域 lint——超出 VTS 值域的偏移绑定期即拒", () => {
		const source = (delta: Record<string, number>): CatalogSource => ({
			motions: {
				spin: {
					description: "旋转特技",
					motion: motion(
						100,
						track("head.yaw", [
							[0, 0],
							[100, 0],
						]),
					),
					spatial: {
						segments: [
							{ delta, durationMs: 100 },
							{ delta: { rotation: 0 }, durationMs: 100 },
						],
					},
				},
			},
		});
		expect(() => compileCatalog(MODEL_ID, source({ rotation: 400, y: 0 }), makeRig())).toThrow(
			/VTS 值域.*rotation=400/,
		);
		expect(() => compileCatalog(MODEL_ID, source({ size: 150, y: 0 }), makeRig())).toThrow(/VTS 值域.*size=150/);
		expect(() => compileCatalog(MODEL_ID, source({ y: 0.09, rotation: 359 }), makeRig())).not.toThrow();
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
			const pausedP = await rt.express({ motion: "spin" }, {});
			expect(pausedP.details).toMatchObject({ reason: "paused" });
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
			await expect(app.onStop?.({} as ServiceCompanionContext)).rejects.toThrow("归位清理尚未确认");
			expect(rt.isStarted).toBe(false);
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
