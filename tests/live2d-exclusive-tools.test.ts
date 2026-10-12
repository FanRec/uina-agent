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
	/** tintModel 派发延迟（ms）：模拟效果请求往返耗时。 */
	tintDelayMs?: number;
	/** 可用后处理预设清单（模拟 VTS Effects 环境文件；undefined = 清单未知，核验放行）。 */
	presets?: string[];
	updatePostCalls: Array<Record<string, unknown> | undefined>;
	/** 每次 moveModel / getModelPosition 的 performance.now() 时间戳，用于段间等待时序断言。 */
	moveTimes: number[];
	readTimes: number[];
	/** 回读不结算次数：前 N 次发生在 moveModel 之后的回读返回扰动位姿（模拟 VTS 插值未落地）。 */
	unsettledReads?: number;
	moved?: boolean;
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
		getModelPosition: async () => {
			state.readTimes.push(performance.now());
			// 模拟 VTS 插值未落地：移动发出后的前 N 次回读返回偏移位姿，之后如实结算。
			if (state.moved && (state.unsettledReads ?? 0) > 0) {
				state.unsettledReads = (state.unsettledReads ?? 0) - 1;
				return { ...state.pose, rotation: state.pose.rotation + 5 };
			}
			return { ...state.pose };
		},
		moveModel: async (options: Record<string, unknown>) => {
			state.moveCalls.push(options);
			state.moveTimes.push(performance.now());
			state.moved = true;
			if (state.hangMove) return new Promise(() => {});
			if (options.valuesAreRelativeToModel === false) {
				if (options.positionX !== undefined) state.pose.positionX = options.positionX as number;
				if (options.positionY !== undefined) state.pose.positionY = options.positionY as number;
				if (options.rotation !== undefined) state.pose.rotation = options.rotation as number;
				if (options.size !== undefined) state.pose.size = options.size as number;
			}
		},
		tintModel: async (tint: Record<string, unknown>) => {
			if (state.tintDelayMs) await new Promise((r) => setTimeout(r, state.tintDelayMs));
			return tint;
		},
		updatePostProcessing: async (opts?: Record<string, unknown>) => {
			state.updatePostCalls.push(opts);
		},
		readPostProcessing: async () => ({ active: false, activePreset: null }),
		getPostProcessingPresets: () => state.presets ?? [],
		refreshPostProcessingPresets: async () => {},
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

/** 段[0] 携带 postProcessing 预设引用的 spin 目录：预设前瞻校验专用。 */
const presetRuntime = (state: FakeState, preset: string) =>
	new Live2DRuntime({
		client: makeFake(state),
		rig: makeRig(),
		catalog: compileCatalog(
			MODEL_ID,
			{
				motions: {
					spin: {
						description: "石化特技",
						motion: motion(
							100,
							track("head.yaw", [
								[0, 0],
								[100, 0],
							]),
						),
						spatial: {
							segments: [
								{
									delta: { rotation: 200 },
									durationMs: 100,
									effects: { postProcessing: { on: true, preset, fadeTime: 0.15 } },
								},
								{ delta: { rotation: 0 }, durationMs: 200 },
							],
						},
					},
				},
			},
			makeRig(),
		),
	});

/** 段[0] 携带 postProcessing 直接效果值（灰度）的 spin 目录：values 模式专用。 */
const valuesRuntime = (state: FakeState) =>
	new Live2DRuntime({
		client: makeFake(state),
		rig: makeRig(),
		catalog: compileCatalog(
			MODEL_ID,
			{
				motions: {
					spin: {
						description: "石化特技",
						motion: motion(
							100,
							track("head.yaw", [
								[0, 0],
								[100, 0],
							]),
						),
						spatial: {
							segments: [
								{
									delta: { rotation: 200 },
									durationMs: 100,
									effects: {
										postProcessing: {
											on: true,
											values: [
												{ id: "ColorGrading_Strength", value: 1 },
												{ id: "ColorGrading_Saturation", value: -100 },
											],
											fadeTime: 0.15,
										},
									},
								},
								{ delta: { rotation: 0 }, durationMs: 200 },
							],
						},
					},
				},
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
			moveTimes: [],
			readTimes: [],
			updatePostCalls: [],
			moved: false,
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
			moveTimes: [],
			readTimes: [],
			updatePostCalls: [],
			moved: false,
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
			moveTimes: [],
			readTimes: [],
			updatePostCalls: [],
			moved: false,
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

	it("段间等待不被效果派发抢跑：带效果段 sleep 全额等待 durationMs 后才发下一段 moveModel", async () => {
		const state: FakeState = {
			connected: true,
			pose: { positionX: 0, positionY: 0, rotation: 10, size: 1 },
			hotkeyIDs: [],
			triggered: [],
			moveCalls: [],
			hangMove: false,
			moveTimes: [],
			readTimes: [],
			updatePostCalls: [],
			moved: false,
			tintDelayMs: 150,
		};
		// 段[0] 带效果且派发耗时（150ms）超过段时长（100ms）：旧实现从派发前计时扣除，
		// sleep 被抢跑至 0，两段 moveModel 几乎同时发出；修复后段间至少等满 100ms。
		const rt = new Live2DRuntime({
			client: makeFake(state),
			rig: makeRig(),
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
									{ delta: { rotation: 200 }, durationMs: 100, effects: { tint: { r: 120, g: 120, b: 128 } } },
									{ delta: { rotation: 0 }, durationMs: 200 },
								],
							},
						},
					},
				},
				makeRig(),
			),
		});
		const app = await startApp(rt);
		try {
			await rt.express({ motion: "spin" }, {});
			expect(state.moveTimes.length).toBe(2);
			expect(state.moveTimes[1]! - state.moveTimes[0]!).toBeGreaterThanOrEqual(100);
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("回读重试缓冲：VTS 插值未落地时首次回读不匹配，重试后结算匹配 → 如实判 restored", async () => {
		const state: FakeState = {
			connected: true,
			pose: { positionX: 0, positionY: 0, rotation: 10, size: 1 },
			hotkeyIDs: [],
			triggered: [],
			moveCalls: [],
			hangMove: false,
			moveTimes: [],
			readTimes: [],
			updatePostCalls: [],
			moved: false,
			unsettledReads: 1, // 移动后的首次回读返回扰动位姿（+5°），模拟插值未落地
		};
		const rt = makeRuntime(state);
		const app = await startApp(rt);
		try {
			const result = await rt.express({ motion: "spin" }, {});
			// 旧实现单次回读即判"正常回位未确认"且详情报陈旧 false；重试后如实结算。
			expect(result.status).toBe("unknown"); // 假体不确认参数输入（既有语义）
			expect(result.details).toMatchObject({ restored: true });
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("预设前瞻校验：preset 不在 VTS 可用清单 → 发送前整体拒绝，零 moveModel、零效果请求", async () => {
		const state: FakeState = {
			connected: true,
			pose: { positionX: 0, positionY: 0, rotation: 10, size: 1 },
			hotkeyIDs: [],
			triggered: [],
			moveCalls: [],
			hangMove: false,
			moveTimes: [],
			readTimes: [],
			updatePostCalls: [],
			moved: false,
			presets: ["Sepia", "Vintage"], // 环境里没有 Grayscale（petrify 1203 场景）
		};
		const rt = presetRuntime(state, "Grayscale");
		const app = await startApp(rt);
		try {
			const result = await rt.express({ motion: "spin" }, {});
			expect(result.status).toBe("failed");
			expect(result.details).toMatchObject({ reason: "preset_missing" });
			const details = result.details as { missingPresets: string[]; availablePresets: string[] };
			expect(details.missingPresets).toEqual(["Grayscale"]);
			expect(details.availablePresets).toEqual(["Sepia", "Vintage"]);
			expect(result.result).toContain("Sepia"); // 错误信息带可用清单，可直接照单改 catalog 或建预设
			expect(state.moveCalls).toEqual([]); // 未发送任何移动
			expect(state.updatePostCalls).toEqual([]); // 未发送任何效果请求（零半程特效）
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("预设前瞻校验：preset 在清单内正常放行；清单未知（空）时核验放行走运行时裁决", async () => {
		const withPreset: FakeState = {
			connected: true,
			pose: { positionX: 0, positionY: 0, rotation: 10, size: 1 },
			hotkeyIDs: [],
			triggered: [],
			moveCalls: [],
			hangMove: false,
			moveTimes: [],
			readTimes: [],
			updatePostCalls: [],
			moved: false,
			presets: ["Grayscale"],
		};
		const rt1 = presetRuntime(withPreset, "Grayscale");
		const app1 = await startApp(rt1);
		try {
			const r1 = await rt1.express({ motion: "spin" }, {});
			expect(r1.status).toBe("unknown"); // 通过核验，正常执行到终点（假体不确认注入）
			expect(withPreset.moveCalls.length).toBe(2);
		} finally {
			await app1.onStop?.({} as ServiceCompanionContext);
		}
		const unknown: FakeState = {
			connected: true,
			pose: { positionX: 0, positionY: 0, rotation: 10, size: 1 },
			hotkeyIDs: [],
			triggered: [],
			moveCalls: [],
			hangMove: false,
			moveTimes: [],
			readTimes: [],
			updatePostCalls: [],
			moved: false,
			presets: [], // 清单未知 → 核验放行，交运行时裁决（兼容旧版 VTS）
		};
		const rt2 = presetRuntime(unknown, "Grayscale");
		const app2 = await startApp(rt2);
		try {
			const r2 = await rt2.express({ motion: "spin" }, {});
			expect(r2.status).toBe("unknown");
			expect(unknown.moveCalls.length).toBe(2);
		} finally {
			await app2.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("后处理直接效果值（values）：段进入时实发 setPostProcessingValues 灰度 config，恢复走 setAllOtherValuesToDefault", async () => {
		const state: FakeState = {
			connected: true,
			pose: { positionX: 0, positionY: 0, rotation: 10, size: 1 },
			hotkeyIDs: [],
			triggered: [],
			moveCalls: [],
			hangMove: false,
			moveTimes: [],
			readTimes: [],
			updatePostCalls: [],
			moved: false,
		};
		const rt = valuesRuntime(state);
		const app = await startApp(rt);
		try {
			const result = await rt.express({ motion: "spin" }, {});
			expect(result.status).toBe("unknown"); // 假体不确认参数输入（既有语义）
			// 段[0] 进入：灰度 config 直接下发（目录值原样透传）
			expect(state.updatePostCalls[0]).toMatchObject({
				on: true,
				values: [
					{ id: "ColorGrading_Strength", value: 1 },
					{ id: "ColorGrading_Saturation", value: -100 },
				],
				fadeTime: 0.15,
			});
			// 守护复位：on=false（baseline 关闭态），全效果回默认
			const restore = state.updatePostCalls.at(-1);
			expect(restore).toMatchObject({ on: false });
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("compileCatalog：后处理 values 与 preset 互斥、values 非空、项形状校验", () => {
		// 故意传非法形状做 lint 断言：post 以 as never 注入字段位（运行时校验是被测对象）
		const base = (post: { on: boolean; values?: unknown; preset?: string; fadeTime?: number }): CatalogSource => ({
			motions: {
				spin: {
					description: "石化特技",
					motion: motion(
						100,
						track("head.yaw", [
							[0, 0],
							[100, 0],
						]),
					),
					spatial: {
						segments: [
							{ delta: { rotation: 200 }, durationMs: 100, effects: { postProcessing: post as never } },
							{ delta: { rotation: 0 }, durationMs: 100 },
						],
					},
				},
			},
		});
		expect(() =>
			compileCatalog(
				MODEL_ID,
				base({ on: true, values: [{ id: "ColorGrading_Strength", value: 1 }], preset: "Grayscale" }),
				makeRig(),
			),
		).toThrow(/values 与 preset 互斥/);
		expect(() => compileCatalog(MODEL_ID, base({ on: true, values: [] }), makeRig())).toThrow(/非空数组/);
		expect(() => compileCatalog(MODEL_ID, base({ on: true, values: [{ id: "", value: 1 }] }), makeRig())).toThrow(
			/缺少 configID/,
		);
		expect(() => compileCatalog(MODEL_ID, base({ on: true, values: [{ id: "X", value: null }] }), makeRig())).toThrow(
			/必须是 number 或 string/,
		);
		expect(() =>
			compileCatalog(MODEL_ID, base({ on: true, values: [{ id: "ColorGrading_Strength", value: 1 }] }), makeRig()),
		).not.toThrow();
	});

	it("safeStop 期间等待在途归位清理完成，完成后暂停生效；此后工具 paused 拒绝", async () => {
		const state: FakeState = {
			connected: true,
			pose: { positionX: 0, positionY: 0, rotation: 10, size: 1 },
			hotkeyIDs: [],
			triggered: [],
			moveCalls: [],
			hangMove: false,
			moveTimes: [],
			readTimes: [],
			updatePostCalls: [],
			moved: false,
		};
		const rt = makeRuntime(state);
		const app = await startApp(rt);
		try {
   state.hotkeyIDs = ["hk-1"]; state.slowHotkey = { resolve: () => {} };
   const pendingCostume = rt.costume({ item: "cute" }, {});
   await tick();
			const stopP = rt.safeStop();
			await tick();
			expect(rt.isPaused).toBe(true);
			state.slowHotkey.resolve();
 await pendingCostume;
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
			moveTimes: [],
			readTimes: [],
			updatePostCalls: [],
			moved: false,
		};
		const rt = makeRuntime(state, 50);
		const app = await startApp(rt);
		try {
			state.hotkeyIDs = ["hk-1"]; state.slowHotkey = { resolve: () => {} };
   void rt.costume({ item: "cute" }, {});
   await tick();
			await expect(rt.safeStop()).rejects.toThrow("归位清理尚未确认");
		} finally {
			await expect(app.onStop?.({} as ServiceCompanionContext)).rejects.toThrow("归位清理尚未确认");
			expect(rt.isStarted).toBe(false);
 state.slowHotkey?.resolve();
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
			moveTimes: [],
			readTimes: [],
			updatePostCalls: [],
			moved: false,
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
			moveTimes: [],
			readTimes: [],
			updatePostCalls: [],
			moved: false,
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
