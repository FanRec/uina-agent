import { unconfirmedInjections } from "./live2d-injection-fixture.js";
import { describe, expect, it, vi } from "vitest";
import type { ActionContext, ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../src/tools/broker.js";
import type { ModelProfile } from "../.uina/worlds/live2d/adapter/profile.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { compileCatalog, type CatalogSnapshot, type CatalogSource } from "../.uina/worlds/live2d/authoring/catalog.js";
import { motion, keys, absolute } from "../.uina/worlds/live2d/authoring/index.js";
import { createLive2DApp } from "../.uina/worlds/live2d/index.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

/**
 * ambient 环境循环：目录词表编译（含全局命名空间 claim）+ 运行时静止态槽位生命周期
 * （选择替换 idle / 清除回落 / 幂等 / interrupt 不影响 / 目录更替清空）+ 工具面接线。
 *
 * 合成推进纯函数化：composeTick 手工步进；客户端用鸭子类型假体。
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

const swayLoop = (amplitude: number) =>
	motion(3200, {
		"head.yaw": absolute(
			keys([
				[0, 0],
				[800, amplitude],
				[1600, 0],
				[2400, -amplitude],
				[3200, 0],
			]),
		),
	});

const makeCatalogSource = (): CatalogSource => ({
	motions: {
		nod: {
			description: "点头",
			motion: motion(500, {
				"head.yaw": absolute(
					keys([
						[0, 6],
						[500, 6],
					]),
				),
			}),
		},
	},
	background: {
		idle: swayLoop(3),
		ambient: {
			sway: { description: "左右摇摆", aliases: ["摇摆"], motion: swayLoop(8) },
		},
	},
});

const makeCatalog = (source = makeCatalogSource()): CatalogSnapshot => compileCatalog(MODEL_ID, source, makeRig());

const makeProfile = (modelID = MODEL_ID): ModelProfile => ({ modelID, physicsOutputs: [] }) as unknown as ModelProfile;

type BackgroundStatus = { default: "idle" | null; current: string | null; running: boolean };

/** 鸭子类型假客户端：记录注入帧序列供幅值断言。 */
const makeFakeClient = (options: { connected?: boolean; modelID?: string } = {}) => {
	const state = {
		connected: options.connected ?? true,
		profile: makeProfile(options.modelID),
		injected: [] as { id: string; value: number }[][],
		listener: undefined as ((connected: boolean) => void) | undefined,
	};
	const client = {
		...unconfirmedInjections(),
		isConnected: () => state.connected,
		getModelProfile: () => state.profile,
		injectParameters: (frame: { id: string; value: number }[]) => {
			state.injected.push(frame);
		},
		setConnectionChangeListener: (listener: (connected: boolean) => void) => {
			state.listener = listener;
		},
		connect: () => {},
		disconnect: () => {},
		getConnectionStatus: () => ({ connected: state.connected }),
		findHotkey: () => undefined,
		reloadCurrentModel: async () => {},
	} as unknown as VTSClient;
	return { client, state };
};

const harness = async (catalog: CatalogSnapshot = makeCatalog(), seed = 0) => {
	const fake = makeFakeClient();
	const runtime = new Live2DRuntime({ client: fake.client, rig: makeRig(), catalog, seed });
	const app = createLive2DApp({ instance: runtime });
	const startCtx = {
		expose: () => () => {},
		signal: new AbortController().signal,
	} as unknown as ServiceCompanionContext;
	await app.onStart!(startCtx);
	const ctx = { signal: new AbortController().signal, operationIdentity: {} } as unknown as ActionContext;
	const run = (action: string, args: Record<string, unknown>): Promise<ToolExecutionResult> =>
		app.actions[action]!.run(args, ctx) as Promise<ToolExecutionResult>;
	const status = async () =>
		JSON.parse(await runtime.formatStatus()) as {
			background: BackgroundStatus;
			catalog: { ambient: { available: { id: string; description: string }[]; current: string | null } };
		};
	const stepMs = (totalMs: number, step = 16): void => {
		for (let i = 0; i < Math.ceil(totalMs / step); i++) runtime.composeTick(step);
	};
	/** 稳定后采样一个完整循环周期的 FaceAngleX 幅值。 */
	const yawAmplitude = (): number => {
		const from = fake.state.injected.length;
		stepMs(3200);
		const values = fake.state.injected
			.slice(from)
			.flatMap((frame) => frame.filter((p) => p.id === "FaceAngleX").map((p) => Math.abs(p.value)));
		return Math.max(...values);
	};
	return { app, runtime, fake, run, status, stepMs, yawAmplitude };
};

describe("live2d ambient 环境循环", () => {
	it("status distinguishes the default running idle from an unselected ambient, in both status views", async () => {
		const h = await harness();
		try {
			h.stepMs(1200);
			const basic = JSON.parse((await h.run("status", {})).result);
			const detail = JSON.parse((await h.run("status", { detail: true })).result);
			expect(basic.catalog.ambient.current).toBeNull();
			expect(basic.background).toEqual({ default: "idle", current: "idle", running: true });
			expect(detail.background).toEqual(basic.background);
			expect(
				h.fake.state.injected.some((frame) => frame.some((p) => p.id === "FaceAngleX" && Math.abs(p.value) > 1)),
			).toBe(true);
		} finally {
			await h.runtime.stop();
		}
	});

	it("background status follows ambient selection, clearing and the active thinking loop", async () => {
		const source = makeCatalogSource();
		source.background!.thinking = swayLoop(2);
		const h = await harness(makeCatalog(source));
		try {
			h.stepMs(16);
			await h.run("state", { ambient: "sway" });
			expect((await h.status()).background).toEqual({ default: "idle", current: "sway", running: true });
			h.runtime.setThinking(true);
			expect((await h.status()).background).toEqual({ default: "idle", current: "thinking", running: true });
			expect((await h.status()).catalog.ambient.current).toBe("sway");
			h.runtime.setThinking(false);
			expect((await h.status()).background).toEqual({ default: "idle", current: "sway", running: true });
			await h.run("state", { ambient: null });
			expect((await h.status()).background).toEqual({ default: "idle", current: "idle", running: true });
		} finally {
			await h.runtime.stop();
		}
	});

	it("background does not claim clock advancement before start or without an authored loop", async () => {
		const fake = makeFakeClient();
		const runtime = new Live2DRuntime({ client: fake.client, rig: makeRig(), catalog: makeCatalog() });
		expect(JSON.parse(runtime.formatStatus()).background).toEqual({ default: "idle", current: null, running: false });
		const h = await harness(makeCatalog({ background: {} }));
		try {
			h.stepMs(16);
			expect((await h.status()).background).toEqual({ default: null, current: null, running: false });
		} finally {
			await h.runtime.stop();
		}
	});

	it("background retains its loop selection but reports no advancement while disconnected, mismatched, unfocused or paused", async () => {
		const h = await harness();
		try {
			await h.run("state", { ambient: "sway" });
			h.stepMs(16);
			h.fake.state.connected = false;
			h.fake.state.listener!(false);
			expect((await h.status()).background).toEqual({ default: "idle", current: "sway", running: false });
			h.fake.state.connected = true;
			h.fake.state.listener!(true);
			h.fake.state.profile = makeProfile("other-model");
			expect((await h.status()).background.running).toBe(false);
			h.fake.state.profile = makeProfile();
			h.runtime.setFocused(false);
			expect((await h.status()).background).toEqual({ default: "idle", current: "sway", running: false });
			h.runtime.setFocused(true);
			expect((await h.status()).background.running).toBe(true);
			await h.runtime.safeStop();
			expect((await h.status()).background).toEqual({ default: "idle", current: null, running: false });
			expect((await h.status()).catalog.ambient.current).toBe("sway");
			await h.runtime.resume();
			h.stepMs(16);
			expect((await h.status()).background).toEqual({ default: "idle", current: "sway", running: true });
		} finally {
			await h.runtime.stop();
		}
		expect((await h.status()).background.running).toBe(false);
	});

	it("compileCatalog：ambient 条目编译入快照并保留描述", () => {
		const catalog = makeCatalog();
		expect(catalog.resolve("ambient", "sway")?.entry).toMatchObject({ description: "左右摇摆" });
	});

	it("compileCatalog：ambient 命名与动作冲突即拒绝（全局唯一命名空间）", () => {
		const source = makeCatalogSource();
		source.background!.ambient!.nod = { description: "冲突", motion: swayLoop(1) };
		expect(() => makeCatalog(source)).toThrow(/命名冲突/);
	});

	it("compileCatalog：ambient 别名与内置注视词表冲突即拒绝", () => {
		const source = makeCatalogSource();
		source.background!.ambient!.sway.aliases = ["用户"];
		expect(() => makeCatalog(source)).toThrow(/命名冲突/);
	});

	it("默认静止态播放 idle；选择 sway 后替换为环境循环（幅值显著增大）", async () => {
		const h = await harness();
		h.stepMs(1200); // idle 已在播（fade 450ms + 弹簧收敛）
		const idleAmplitude = h.yawAmplitude();
		const selected = await h.run("state", { ambient: "sway" });
		expect(selected.status).toBe("succeeded");
		expect((await h.status()).catalog.ambient.current).toBe("sway");
		h.stepMs(1200); // 换播 fade-in + 弹簧收敛
		expect(h.yawAmplitude()).toBeGreaterThan(idleAmplitude * 1.5);
	});

	it("清除后回落 idle；status 词表列出可用环境循环", async () => {
		const h = await harness();
		await h.run("state", { ambient: "sway" });
		h.stepMs(1200);
		const swayAmplitude = h.yawAmplitude();
		const cleared = await h.run("state", { ambient: null });
		expect(cleared.status).toBe("succeeded");
		expect((await h.status()).catalog.ambient.current).toBeNull();
		h.stepMs(1200);
		expect(h.yawAmplitude()).toBeLessThan(swayAmplitude / 1.5);
		const { catalog } = await h.status();
		expect(catalog.ambient.available).toEqual([{ id: "sway", description: "左右摇摆", aliases: ["摇摆"] }]);
	});

	it("interrupt 不影响持续环境循环（与姿态同级的持续状态）", async () => {
		const h = await harness();
		await h.run("state", { ambient: "sway" });
		h.stepMs(1200);
		h.runtime.interrupt();
		expect((await h.status()).catalog.ambient.current).toBe("sway");
		h.stepMs(600);
		expect(h.fake.state.injected.length).toBeGreaterThan(0);
	});

	it("幂等：重复选择同名不重建，重复清除同样幂等", async () => {
		const h = await harness();
		await h.run("state", { ambient: "sway" });
		const again = await h.run("state", { ambient: "sway" });
		expect(again.result).toBe("sway OK");
		const clear = await h.run("state", { ambient: null });
		expect(clear.status).toBe("succeeded");
		const clearAgain = await h.run("state", { ambient: null });
		expect(clearAgain.result).toBe("cleared OK");
	});

	it("短 sway 动作组在片段边界选不同轨迹，不连续重复上一段", async () => {
		const phrase = (value: number) =>
			motion(100, {
				"head.yaw": absolute(
					keys([
						[0, value],
						[100, value],
					]),
				),
			});
		const phrases = [phrase(2), phrase(5), phrase(8)];
		const catalog = makeCatalog({
			background: {
				ambient: {
					sway: {
						description: "短动作组",
						motion: phrases[0]!,
						variants: phrases.slice(1),
					},
				},
			},
		});
		const h = await harness(catalog, 0);
		const play = vi.spyOn(h.runtime.director!, "play");
		await h.run("state", { ambient: "sway" });
		const first = play.mock.calls.at(-1)?.[0];
		h.stepMs(180);
		const second = play.mock.calls.at(-1)?.[0];
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		expect(first?.durationMs).toBe(100);
		expect(second?.durationMs).toBe(100);
	});

	it("未知名字拒绝并列出可用词表；非法参数拒绝", async () => {
		const h = await harness();
		const unknown = await h.run("state", { ambient: "groove" });
		expect(unknown.status).toBe("failed");
		expect(unknown.result).toContain("groove");
		expect(unknown.result).toContain("sway");
		const invalid = await h.run("state", { ambient: "" });
		expect(invalid.status).toBe("failed");
	});

	it("目录更替清空选中（新快照可能无同名项，诚实回落 idle）", async () => {
		const h = await harness();
		await h.run("state", { ambient: "sway" });
		expect((await h.status()).catalog.ambient.current).toBe("sway");
		h.runtime.setCatalog(makeCatalog({ motions: {}, background: { idle: swayLoop(3) } }));
		expect((await h.status()).catalog.ambient.current).toBeNull();
	});

	it("thinking 与 ambient 共存：思考循环在选中 sway 期间照常叠加（transition 层不受影响）", async () => {
		const source = makeCatalogSource();
		source.background!.thinking = motion(3600, {
			"head.yaw": absolute(
				keys([
					[0, 2],
					[2400, 2],
					[3600, 2],
				]),
			),
		});
		const a = await harness();
		const b = await harness(makeCatalog(source));
		await a.run("state", { ambient: "sway" });
		await b.run("state", { ambient: "sway" });
		a.stepMs(1200); // sway fade-in + 弹簧收敛，两侧对齐
		b.stepMs(1200);
		b.runtime.setThinking(true);
		a.stepMs(1000); // thinking fade-in 350ms 完成，恒定 +2 增量
		b.stepMs(1000);
		const seq = (h: Awaited<ReturnType<typeof harness>>) =>
			h.fake.state.injected
				.slice(-40)
				.flatMap((frame) => frame.filter((p) => p.id === "FaceAngleX").map((p) => p.value));
		const [sa, sb] = [seq(a), seq(b)];
		expect(sb.some((v, i) => Math.abs(v - sa[i]!) > 1)).toBe(true); // thinking 增量经注入映射 ~+5
		expect((await b.status()).catalog.ambient.current).toBe("sway");
	});

	it("safeStop → resume 后环境循环续播（暂停期保持帧静止，恢复后 tick 重建背景）", async () => {
		const h = await harness();
		await h.run("state", { ambient: "sway" });
		h.stepMs(600);
		await h.runtime.safeStop();
		h.stepMs(320);
		const frozenFrom = h.fake.state.injected
			.slice(-20)
			.flatMap((frame) => frame.filter((p) => p.id === "FaceAngleX").map((p) => p.value));
		expect(new Set(frozenFrom).size).toBe(1); // 暂停期注入保持帧，值恒定
		await h.runtime.resume();
		h.stepMs(1200);
		expect(h.yawAmplitude()).toBeGreaterThan(10); // sway 幅值 8 → 注入 ~20，恢复后重新活跃
		expect((await h.status()).catalog.ambient.current).toBe("sway");
	});

	it("失焦不影响环境循环（失焦只取消空间特技独占）", async () => {
		const h = await harness();
		await h.run("state", { ambient: "sway" });
		h.stepMs(600);
		const before = h.fake.state.injected.length;
		h.runtime.setFocused(false);
		h.stepMs(400);
		expect(h.fake.state.injected.length).toBeGreaterThan(before + 20); // 持续注入
		expect((await h.status()).catalog.ambient.current).toBe("sway");
	});
});
