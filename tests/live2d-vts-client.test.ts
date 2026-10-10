import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VTSClient, type VTSParamValue, type WebSocketLike } from "../.uina/worlds/live2d/adapter/vts-client.js";
import type { ModelProfile } from "../.uina/worlds/live2d/adapter/profile.js";

/** 独立 WebSocketLike 假体：按请求类型同步回包，记录全部上行帧。 */
class Device implements WebSocketLike {
	readyState = 1;
	bufferedAmount = 0;
	onopen: WebSocketLike["onopen"] = null;
	onclose: WebSocketLike["onclose"] = null;
	onerror: WebSocketLike["onerror"] = null;
	onmessage: WebSocketLike["onmessage"] = null;
	requests: { requestID: string; messageType: string; data: Record<string, unknown> }[] = [];
	/** InjectParameterDataRequest 不回包，模拟注入无响应。 */
	silentInject = false;
	tokenToIssue = "issued-token";
	authDenied = false;

	send(raw: string, cb?: (err?: Error) => void): void {
		const r = JSON.parse(raw);
		this.requests.push(r);
		cb?.();
		if (r.messageType === "InjectParameterDataRequest" && this.silentInject) return;
		let data: unknown = {};
		switch (r.messageType) {
			case "AuthenticationRequest":
				data = { authenticated: true };
				break;
			case "AuthenticationTokenRequest":
				if (this.authDenied) {
					this.reply(r.requestID, "APIError", { errorID: 51, message: "User declined" });
					return;
				}
				data = { authenticationToken: this.tokenToIssue };
				break;
			case "CurrentModelRequest":
				data = { modelLoaded: true, modelID: "fixture", timeSinceModelLoaded: 10 };
				break;
			case "InputParameterListRequest":
				data = { defaultParameters: [{ name: "drive:x", min: -1, max: 1, defaultValue: 0 }] };
				break;
			case "Live2DParameterListRequest":
				data = { parameters: [{ name: "drive:x", min: -1, max: 1, defaultValue: 0 }] };
				break;
			case "HotkeysInCurrentModelRequest":
				data = { availableHotkeys: [{ name: "Wave", hotkeyID: "hk_1" }] };
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
	}
	messages(type: string) {
		return this.requests.filter((r) => r.messageType === type);
	}
}

const profile: ModelProfile = {
	modelID: "fixture",
	modelName: "fixture",
	mappings: [],
	parameterRanges: { "drive:x": { min: -1, max: 1, defaultValue: 0 } },
	inputs: [{ name: "drive:x", min: -1, max: 1, defaultValue: 0 }],
	physicsOutputs: [],
	sources: [],
	activeExpressions: [],
};

function makeClient(device: Device, options: ConstructorParameters<typeof VTSClient>[0] = {}) {
	const client = new VTSClient({
		token: "fixture",
		webSocketFactory: () => device,
		profileLoader: async () => profile,
		reconnectIntervalMs: 60_000,
		...options,
	});
	return client;
}

async function flush(): Promise<void> {
	for (let i = 0; i < 60; i++) await Promise.resolve();
}

async function readyClient(device: Device, options?: ConstructorParameters<typeof VTSClient>[0]) {
	const client = makeClient(device, options);
	const events: boolean[] = [];
	client.setConnectionChangeListener((c) => events.push(c));
	client.connect();
	device.onopen?.({});
	await flush();
	return { client, device, events };
}

describe("live2d vts-client（移植行为验证）", () => {
	let tokenDir: string;
	beforeEach(() => {
		tokenDir = mkdtempSync(join(tmpdir(), "vts-token-"));
	});
	afterEach(() => {
		rmSync(tokenDir, { recursive: true, force: true });
	});

	it("全初始化链路到就绪：鉴权→订阅→参数→模型→热键，modelGeneration 递增", async () => {
		const device = new Device();
		const { client, events } = await readyClient(device);
		expect(client.isConnected()).toBe(true);
		expect(events).toEqual([true]);
		expect(client.getModelGeneration()).toBe(1);
		expect(device.messages("AuthenticationRequest")).toHaveLength(1);
		expect(device.messages("EventSubscriptionRequest")).toEqual([
			expect.objectContaining({ data: { eventName: "ModelLoadedEvent", subscribe: true } }),
		]);
		expect(device.messages("HotkeysInCurrentModelRequest")).toHaveLength(1);
		expect(client.findHotkey("wave")?.hotkeyID).toBe("hk_1");
		client.disconnect();
	});

	it("token 持久化：首次请求新 Token 并落盘，重启后直接用持久 Token 鉴权", async () => {
		const tokenPath = join(tokenDir, "vts-token.json");
		const device = new Device();
		const client = makeClient(device, { token: undefined, tokenPath });
		client.connect();
		device.onopen?.({});
		await flush();
		expect(existsSync(tokenPath)).toBe(true);
		expect(JSON.parse(readFileSync(tokenPath, "utf8")).token).toBe("issued-token");
		client.disconnect();

		const device2 = new Device();
		const client2 = makeClient(device2, { token: undefined, tokenPath });
		client2.connect();
		device2.onopen?.({});
		await flush();
		// 第二次连接不应再请求新 Token，直接 AuthenticationRequest 携带持久 Token。
		expect(device2.messages("AuthenticationTokenRequest")).toHaveLength(0);
		expect(device2.messages("AuthenticationRequest")[0]?.data.authenticationToken).toBe("issued-token");
		expect(client2.isConnected()).toBe(true);
		client2.disconnect();
	});

	it("授权被拒绝：authDenied 后不再安排重连", async () => {
		const device = new Device();
		device.authDenied = true;
		const client = makeClient(device, { token: undefined, tokenPath: join(tokenDir, "t.json") });
		client.connect();
		device.onopen?.({});
		await flush();
		expect(device.messages("AuthenticationTokenRequest")).toHaveLength(1);
		expect(client.getConnectionStatus().ready).toBe(false);
		expect(client.getFault()).toContain("拒绝");
		client.disconnect();
	});

	it("注入证据核算：accepted 记入 acceptedInputs，未知参数计入 filtered，不记 accepted", async () => {
		const device = new Device();
		const { client } = await readyClient(device);
		const lease = client.observeMotionInjections("lease-1");
		const frame: VTSParamValue[] = [
			{ id: "drive:x", value: 0.5 },
			{ id: "unknown:param", value: 1 },
			{ id: "drive:x", value: Number.NaN },
		];
		client.injectParameters(frame, [{ leaseID: "lease-1", inputs: ["drive:x", "unknown:param"] }]);
		const evidence = await lease.finish();
		expect(evidence.sent).toBe(1);
		expect(evidence.accepted).toBe(1);
		expect(evidence.failed).toBe(0);
		expect(evidence.dropped).toBe(0);
		expect(evidence.filtered).toBe(1); // unknown:param 被过滤
		expect(evidence.acceptedInputs).toEqual(["drive:x"]);
		client.disconnect();
	});

	it("单未确认帧 + 背压：pending 未结算或 bufferedAmount>0 时注入被丢弃", async () => {
		const device = new Device();
		device.silentInject = true; // 第一帧不回包 → injectionPending 挂起
		const { client } = await readyClient(device);
		const lease = client.observeMotionInjections("lease-2");
		const frame: VTSParamValue[] = [{ id: "drive:x", value: 1 }];
		client.injectParameters(frame, [{ leaseID: "lease-2", inputs: ["drive:x"] }]);
		expect(client.getInjectionStats().sent).toBe(1);

		// 单未确认帧：第二帧丢弃。
		client.injectParameters(frame, [{ leaseID: "lease-2", inputs: ["drive:x"] }]);
		expect(client.getInjectionStats().dropped).toBe(1);

		// 结算第一帧后，背压（bufferedAmount>0）同样丢弃。
		device.silentInject = false;
		device.reply(device.messages("InjectParameterDataRequest")[0]!.requestID, "InjectParameterDataResponse", {});
		await lease.finish();
		device.bufferedAmount = 1024;
		client.injectParameters(frame, [{ leaseID: "lease-2b", inputs: ["drive:x"] }]);
		expect(client.getInjectionStats().dropped).toBe(2);
		expect(device.messages("InjectParameterDataRequest")).toHaveLength(1);
		client.disconnect();
	});

	it("ModelLoadedEvent 代次失效：ready 撤销、modelGeneration 递增、连接回调 false", async () => {
		const device = new Device();
		const { client, events } = await readyClient(device);
		expect(client.isConnected()).toBe(true);
		const generationBefore = client.getModelGeneration();
		device.pushEvent("ModelLoadedEvent", { modelLoaded: true });
		await flush();
		expect(client.getModelGeneration()).toBe(generationBefore + 1);
		expect(client.isConnected()).toBe(false);
		expect(events[events.length - 1]).toBe(false);
		// 旧代次的上行消息不再被处理（60s 重连间隔内不会重连）。
		const sentBefore = device.requests.length;
		device.reply("stale-req", "InjectParameterDataResponse", {});
		expect(device.requests.length).toBe(sentBefore);
		client.disconnect();
	});

	it("假就绪防护：VTS 未加载模型时不进入就绪", async () => {
		const device = new Device();
		const originalSend = device.send.bind(device);
		device.send = (raw, cb) => {
			const r = JSON.parse(raw);
			if (r.messageType === "CurrentModelRequest") {
				device.requests.push(r);
				cb?.();
				device.reply(r.requestID, "CurrentModelResponse", { modelLoaded: false });
				return;
			}
			originalSend(raw, cb);
		};
		const { client } = await readyClient(device);
		expect(client.isConnected()).toBe(false);
		expect(client.getFault()).toContain("未加载模型");
		client.disconnect();
	});
});
