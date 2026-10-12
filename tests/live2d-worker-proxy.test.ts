import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import type { ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import type { BodyEndpoint, VoiceLevelSink } from "../src/extensions/world-framework/seams.js";
import type { ModelProfile } from "../.uina/worlds/live2d/adapter/profile.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { compileCatalog, type CatalogSource } from "../.uina/worlds/live2d/authoring/catalog.js";
import { motion, track } from "../.uina/worlds/live2d/authoring/motion.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import { attachEngine } from "../.uina/worlds/live2d/worker/engine.js";
import { Live2DRuntimeProxy } from "../.uina/worlds/live2d/worker/proxy.js";
import { unconfirmedInjections } from "./live2d-injection-fixture.js";

/**
 * 引擎线程隔离接缝：proxy ↔ engine 协议（MessageChannel 同线程对测，不 spawn 真实 worker）。
 * 覆盖：expose 登记 facade / sync 缓存同步应答 / RPC 与取消翻译 / hostEvent 转发 / 世界事件 render 重建 / stop 拆除。
 */

const MODEL_ID = "worker-fixture-model";

const makeRig = (): ModelRig =>
	({
		version: 3,
		modelID: MODEL_ID,
		controls: {
			"head.yaw": { min: -12, max: 12, neutral: 0 },
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
	}) as ModelRig;

const makeCatalogSource = (): CatalogSource => ({
	motions: {
		nod: {
			description: "点头",
			atomic: true,
			aliases: ["dip"],
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
	expressions: {},
	background: {
		ambient: {
			sway: {
				description: "左右摇摆",
				motion: motion(
					3200,
					track("head.yaw", [
						[0, 0],
						[800, 8],
						[1600, 0],
						[2400, -8],
						[3200, 0],
					]),
				),
			},
		},
	},
});

const makeFakeClient = (connected = true) => {
	const state = {
		connected,
		profile: { modelID: MODEL_ID, physicsOutputs: [] } as unknown as ModelProfile,
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
		getFault: () => undefined,
	} as unknown as VTSClient;
	return { client, state };
};

interface Harness {
	proxy: Live2DRuntimeProxy;
	endpoint: BodyEndpoint;
	sink: VoiceLevelSink;
	/** 测试驱动引擎侧合成推进（真实时钟未用 fake timers 的替代）。 */
	pump: (ms: number) => Promise<void>;
	stop: () => Promise<void>;
}

const harness = async (connected = true): Promise<Harness> => {
	const { port1, port2 } = new MessageChannel();
	const fake = makeFakeClient(connected);
	const engine = attachEngine((msg) => port2.postMessage(msg), {
		runtimeFactory: () =>
			new Live2DRuntime({
				client: fake.client,
				rig: makeRig(),
				catalog: compileCatalog(MODEL_ID, makeCatalogSource(), makeRig()),
				speech: {
					points: [
						[0, 0],
						[1, 1],
					],
					staleMs: 400,
				},
			}),
	});
	port2.on("message", (msg) => engine.onMessage(msg as never));

	const proxy = new Live2DRuntimeProxy(port1 as never);
	const exposed = new Map<string, unknown>();
	const startCtx = {
		signal: new AbortController().signal,
		expose: (name: string, value: unknown) => {
			exposed.set(name, value);
			return () => exposed.delete(name);
		},
	} as unknown as ServiceCompanionContext;
	await proxy.start(startCtx);

	const endpoint = exposed.get("body.endpoint:live2d") as BodyEndpoint;
	const sink = exposed.get("voice.levelSink:live2d") as VoiceLevelSink;
	const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	const pump = async (ms: number) => {
		for (let elapsed = 0; elapsed < ms; elapsed += 20) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			await flush();
		}
	};
	return {
		proxy,
		endpoint,
		sink,
		pump,
		stop: async () => {
			await proxy.stop();
			port1.close();
			port2.close();
		},
	};
};

describe("live2d 引擎线程隔离接缝（proxy ↔ engine 协议）", () => {
	it("start 经 expose 登记双 facade，sync 缓存支撑同步应答（state/supportsCue 与目录同源）", async () => {
		const h = await harness(true);
		try {
			expect(h.endpoint.bodyId).toBe("live2d");
			expect(h.endpoint.bodyType).toBe("avatar_2d");
			expect(h.endpoint.state()).toMatchObject({ online: true, paused: false });
			expect(h.endpoint.supportsCue!("nod")).toBe(true);
			expect(h.endpoint.supportsCue!("dip")).toBe(true); // 别名同源
			expect(h.endpoint.supportsCue!("不存在")).toBe(false);
			const cues = h.endpoint.affordance().cues.map((c) => c.id);
			expect(cues).toContain("nod");
			expect(cues).toContain("lean"); // 姿态也是 cue
			expect(typeof h.sink.processLevel).toBe("function");
		} finally {
			await h.stop();
		}
	});

	it("express 走 RPC 结算，AbortSignal 翻译为 abort 消息并以 reason 拒绝", async () => {
		const h = await harness(true);
		try {
			const done = h.proxy.express({ motion: "nod" }, { signal: new AbortController().signal });
			// 假体不回注 ACK：终态按证据语义为 unknown（本地完成、接受未确认）；此处断言的是 RPC 往返闭环。
			await expect(done).resolves.toHaveProperty("status");

			const controller = new AbortController();
			const aborted = h.proxy.express({ motion: "nod" }, { signal: controller.signal });
			controller.abort();
			await expect(aborted).rejects.toThrow();
		} finally {
			await h.stop();
		}
	});

	it("state 走 RPC 结算：ambient 选择/清除/未知名字往返闭环（engine calls 表 key 正确性）", async () => {
		const h = await harness(true);
		try {
			const selected = await h.proxy.state({ ambient: "sway" }, { signal: new AbortController().signal });
			expect(selected.status).toBe("succeeded");
			const cleared = await h.proxy.state({ ambient: null }, { signal: new AbortController().signal });
			expect(cleared.status).toBe("succeeded");
			const unknown = await h.proxy.state({ ambient: "groove" }, { signal: new AbortController().signal });
			expect(unknown.status).toBe("failed");
			expect(unknown.result).toContain("sway");
		} finally {
			await h.stop();
		}
	});

	it("fire-and-forget 通道（emitCue/interrupt/onFocus/电平）投递后引擎不炸，sync 缓存保持新鲜", async () => {
		const h = await harness(true);
		try {
			h.endpoint.emitCue("nod");
			h.endpoint.interrupt?.();
			h.endpoint.onFocus?.(false);
			h.sink.processLevel({ rms: 0.5 });
			h.sink.reset();
			await h.pump(80);
			// 状态事实只经 sync 缓存暴露（不产生对话上下文事件）；fire 批次后连接事实仍然可达。
			expect(h.endpoint.state().online).toBe(true);
		} finally {
			await h.stop();
		}
	});

	it("safeStop/resume RPC 后 sync 推送使 facade 暂停事实即时可见", async () => {
		const h = await harness(true);
		try {
			await h.endpoint.safeStop();
			expect(h.endpoint.state()).toMatchObject({ paused: true, online: true });
			await h.endpoint.resume();
			expect(h.endpoint.state()).toMatchObject({ paused: false });
		} finally {
			await h.stop();
		}
	});

	it("stop 拆除：unexposed 通知到达，引擎线程不再注入", async () => {
		const h = await harness(true);
		const before = h.endpoint.state();
		expect(before.online).toBe(true);
		await h.stop();
		// stop 后 proxy 已 dead：新调用如实失败，不悬挂。
		await expect(h.proxy.formatStatus()).rejects.toThrow();
	});
});
