import { afterEach, describe, expect, it } from "vitest";
import { neutralFrame, encodeFrame, validateRig, type ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import { VTSClient, type WebSocketLike } from "../.uina/worlds/live2d/adapter/vts-client.js";
import type { ModelProfile } from "../.uina/worlds/live2d/adapter/profile.js";

/** 双轴汇入单输入的 rig：验证 max 聚合与端点裁剪在保活帧上生效。 */
const rig: ModelRig = {
	version: 3,
	modelID: "fixture",
	controls: {
		"head.yaw": { min: -30, max: 30, neutral: 0 },
		"mouth.open": { min: 0, max: 1, neutral: 0 },
		"mouth.form": { min: 0, max: 1, neutral: 0 },
	},
	bindings: {
		"head.yaw": [
			{
				parameter: "ParamAngleX",
				input: "FaceAngleX",
				points: [
					[-30, -30],
					[0, 0],
					[30, 30],
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
		"mouth.form": [
			{
				parameter: "ParamMouthForm",
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
	retargeting: { MouthOpen: { strategy: "max" } },
	external: { blink: "uina", breath: "none" },
};
validateRig(rig);

const profile: ModelProfile = {
	modelID: "fixture",
	modelName: "fixture",
	mappings: [],
	parameterRanges: {
		FaceAngleX: { min: -30, max: 30, defaultValue: 0 },
		MouthOpen: { min: 0, max: 1, defaultValue: 0 },
	},
	inputs: [
		{ name: "FaceAngleX", min: -30, max: 30, defaultValue: 0 },
		{ name: "MouthOpen", min: 0, max: 1, defaultValue: 0 },
	],
	physicsOutputs: [],
	sources: [],
	activeExpressions: [],
};

/** 独立假体：按请求类型同步回包，记录注入帧。 */
class Device implements WebSocketLike {
	readyState = 1;
	bufferedAmount = 0;
	onopen: WebSocketLike["onopen"] = null;
	onclose: WebSocketLike["onclose"] = null;
	onerror: WebSocketLike["onerror"] = null;
	onmessage: WebSocketLike["onmessage"] = null;
	requests: { requestID: string; messageType: string; data: Record<string, unknown> }[] = [];
	send(raw: string, cb?: (err?: Error) => void): void {
		const r = JSON.parse(raw);
		this.requests.push(r);
		cb?.();
		let data: unknown = {};
		switch (r.messageType) {
			case "AuthenticationRequest":
				data = { authenticated: true };
				break;
			case "CurrentModelRequest":
				data = { modelLoaded: true, modelID: "fixture", timeSinceModelLoaded: 10 };
				break;
			case "InputParameterListRequest":
				data = { defaultParameters: profile.inputs };
				break;
			case "Live2DParameterListRequest":
				data = {
					parameters: Object.entries(profile.parameterRanges!).map(([name, m]) => ({ name, ...m })),
				};
				break;
			case "HotkeysInCurrentModelRequest":
				data = { availableHotkeys: [] };
				break;
			case "InjectParameterDataRequest":
				this.reply(r.requestID, "InjectParameterDataResponse", {});
				return;
		}
		this.reply(r.requestID, r.messageType.replace("Request", "Response"), data);
	}
	reply(requestID: string, messageType: string, data: unknown = {}): void {
		this.onmessage?.({ data: JSON.stringify({ requestID, messageType, data }) });
	}
	pushEvent(messageType: string, data: unknown = {}): void {
		this.onmessage?.({ data: JSON.stringify({ messageType, data }) });
	}
	close(): void {
		this.readyState = 3;
		this.onclose?.({});
	}
	get injections() {
		return this.requests.filter((r) => r.messageType === "InjectParameterDataRequest");
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function flush(): Promise<void> {
	for (let i = 0; i < 60; i++) await Promise.resolve();
}

/** 工厂经 getter 取假体：重连时测试换入新 Device。 */
function makeRuntime(getDevice: () => Device) {
	const client = new VTSClient({
		token: "fixture",
		webSocketFactory: () => getDevice(),
		profileLoader: async () => profile,
		reconnectIntervalMs: 10,
		maxReconnectIntervalMs: 50,
	});
	const runtime = new Live2DRuntime({ client, rig, tickIntervalMs: 5 });
	return { client, runtime };
}

const liveRuntimes: Live2DRuntime[] = [];
afterEach(() => {
	for (const rt of liveRuntimes.splice(0)) void rt.stop();
});

describe("live2d 保活注入与断线恢复（P1-3）", () => {
	it("encodeFrame/neutralFrame：中性帧、端点裁剪、max 聚合", () => {
		expect(neutralFrame(rig)).toEqual({ "head.yaw": 0, "mouth.open": 0, "mouth.form": 0 });
		// 中性帧 → 每个输入取曲线在中性处的值。
		expect(encodeFrame(rig, neutralFrame(rig))).toEqual([
			{ id: "FaceAngleX", value: 0 },
			{ id: "MouthOpen", value: 0 },
		]);
		// 端点裁剪：超出曲线末端强制夹到端点，严禁外推。
		expect(
			encodeFrame(rig, { "head.yaw": 45, "mouth.open": 0, "mouth.form": 0 }).find((p) => p.id === "FaceAngleX"),
		).toEqual({ id: "FaceAngleX", value: 30 });
		// 多轴汇入同一输入：max 聚合。
		expect(
			encodeFrame(rig, { "head.yaw": 0, "mouth.open": 0.8, "mouth.form": 0.2 }).find((p) => p.id === "MouthOpen"),
		).toEqual({ id: "MouthOpen", value: 0.8 });
	});

	it("保活时钟：就绪后按步长注入中性流（faceFound:true + mode:set），stop 后零输出", async () => {
		let device = new Device();
		const { runtime } = makeRuntime(() => device);
		liveRuntimes.push(runtime);
		await runtime.start({ signal: new AbortController().signal });
		device.onopen?.({});
		await flush();
		await sleep(40);
		expect(device.injections.length).toBeGreaterThanOrEqual(1);
		const frame = device.injections[0]!;
		expect(frame.data.faceFound).toBe(true);
		expect(frame.data.mode).toBe("set");
		expect(frame.data.parameterValues).toEqual([
			{ id: "FaceAngleX", value: 0 },
			{ id: "MouthOpen", value: 0 },
		]);

		const countAtStop = device.injections.length;
		await runtime.stop();
		await sleep(30);
		expect(device.injections.length).toBe(countAtStop);
	});

	it("断线恢复（引擎 #14 / 边界 #7）：断线时钟即停，重连就绪后基座流恢复", async () => {
		let device = new Device();
		const { client, runtime } = makeRuntime(() => device);
		liveRuntimes.push(runtime);
		await runtime.start({ signal: new AbortController().signal });
		device.onopen?.({});
		await flush();
		await sleep(30);
		expect(device.injections.length).toBeGreaterThanOrEqual(1);
		const dead = device;
		const countBeforeDrop = dead.injections.length;

		// 断线：onclose → 清理 + 停时钟；随后立即换入新假体承接重连。
		dead.close();
		await flush();
		expect(client.isConnected()).toBe(false);
		device = new Device();
		await sleep(60); // reconnectIntervalMs=10 → 已对新假体重新 connect
		// 旧假体在此窗口零新增注入（时钟已停 + 孤立引用）。
		expect(dead.injections.length).toBe(countBeforeDrop);

		device.onopen?.({});
		await flush();
		expect(client.isConnected()).toBe(true);
		const countAfterResume = device.injections.length;
		await sleep(30);
		expect(device.injections.length).toBeGreaterThan(countAfterResume);
	});

	it("换模型代次失效（引擎 #11 / 边界 #8）：重连后注入挂新代次，旧代次迟到消息被丢弃", async () => {
		let device = new Device();
		const { client, runtime } = makeRuntime(() => device);
		liveRuntimes.push(runtime);
		await runtime.start({ signal: new AbortController().signal });
		device.onopen?.({});
		await flush();
		await sleep(30);
		const generationBefore = client.getInjectionStats().generation;

		// 模型切换事件：ready 立即撤销；50ms 后清理并安排重连。
		device.pushEvent("ModelLoadedEvent", { modelLoaded: true });
		await flush();
		expect(client.isConnected()).toBe(false);
		// 旧代次的迟到消息在旧假体上不产生任何效果。
		const dead = device;
		const staleCount = dead.requests.length;
		dead.reply("stale", "InjectParameterDataResponse", {});
		expect(dead.requests.length).toBe(staleCount);

		// 换入新假体，等待清理（50ms）与重连退避完成后开启连接。
		device = new Device();
		await sleep(100);
		device.onopen?.({});
		await flush();
		expect(client.isConnected()).toBe(true);
		const stats = client.getInjectionStats();
		expect(stats.generation).toBeGreaterThan(generationBefore);
		await sleep(30);
		expect(device.injections.length).toBeGreaterThan(0);
		expect(client.getInjectionStats().generation).toBe(stats.generation);
	});

	it("未就绪零输出：连接未就绪时 tick 不注入", async () => {
		const device = new Device();
		const { runtime } = makeRuntime(() => device);
		liveRuntimes.push(runtime);
		await runtime.start({ signal: new AbortController().signal });
		// 不触发 onopen：连接未就绪。
		await sleep(30);
		expect(device.injections.length).toBe(0);
	});
});
