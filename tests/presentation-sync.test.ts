/**
 * 多前端同步协议与客户端状态机。
 *
 * 钉住的纪律：
 * 1. 信封 {v:1} 版本门：版本不匹配/未知 kind/形状违约一律拒绝（响亮失败）；
 * 2. 连接即同步：快照 restore 是唯一基线，事实只能在 synced 后 ingest；
 * 3. 任何疑虑（解析失败、时序违约、断开）唯一处理是重连，无带内修复机制。
 */
import { describe, expect, it, vi } from "vitest";
import type { HostEventRecord } from "../src/host/events.js";
import type { PresentationIntent } from "../src/presentation/actions.js";
import { PresentationController } from "../src/presentation/controller.js";
import {
	encodeClientMessage,
	encodeServerMessage,
	parseClientMessage,
	parseIntent,
	parseServerMessage,
	SYNC_PROTOCOL_VERSION,
	SyncClient,
	type SyncTransport,
} from "../src/presentation/sync.js";

function tick(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 单客户端内存传输：服务端行为由测试直接驱动。 */
function createFakeTransport() {
	const receivedFromClient: string[] = [];
	let onMessageHandler: ((data: string) => void) | undefined;
	let onCloseHandler: (() => void) | undefined;
	let closed = false;
	const transport: SyncTransport = {
		send: (data) => receivedFromClient.push(data),
		close: () => {
			if (closed) return;
			closed = true;
			onCloseHandler?.();
		},
		onMessage: (handler) => {
			onMessageHandler = handler;
		},
		onClose: (handler) => {
			onCloseHandler = handler;
		},
	};
	return {
		transport,
		receivedFromClient,
		isClosed: () => closed,
		serverSends: (data: string) => onMessageHandler?.(data),
		serverCloses: () => transport.close(),
	};
}

describe("同步协议信封", () => {
	it("hello/intent 与 snapshot/fact/error 编解码回环", () => {
		const hello = parseClientMessage(
			encodeClientMessage({
				v: SYNC_PROTOCOL_VERSION,
				kind: "hello",
				auth: "t",
				client: "web",
				capabilities: ["images"],
			}),
		);
		expect(hello).toMatchObject({ kind: "hello", auth: "t", client: "web", capabilities: ["images"] });

		const intent: PresentationIntent = { type: "input.submit", text: "你好", mode: "direct" };
		expect(parseClientMessage(encodeClientMessage({ v: SYNC_PROTOCOL_VERSION, kind: "intent", intent }))).toEqual({
			v: SYNC_PROTOCOL_VERSION,
			kind: "intent",
			intent,
		});

		const view = { transcript: [], trajectory: [] };
		expect(parseServerMessage(encodeServerMessage({ v: SYNC_PROTOCOL_VERSION, kind: "snapshot", view }))).toMatchObject(
			{ kind: "snapshot" },
		);

		const factRecord: HostEventRecord = { at: 123, event: { type: "notice", text: "hi" } };
		expect(
			parseServerMessage(encodeServerMessage({ v: SYNC_PROTOCOL_VERSION, kind: "fact", record: factRecord })),
		).toMatchObject({ kind: "fact", record: factRecord });

		expect(parseServerMessage(encodeServerMessage({ v: SYNC_PROTOCOL_VERSION, kind: "error", message: "x" }))).toEqual({
			v: SYNC_PROTOCOL_VERSION,
			kind: "error",
			message: "x",
		});
	});

	it("版本不匹配、坏 JSON、未知 kind、形状违约一律拒绝", () => {
		expect(parseServerMessage("not json")).toBeUndefined();
		expect(parseServerMessage(JSON.stringify({ v: 2, kind: "snapshot", view: {} }))).toBeUndefined();
		expect(parseServerMessage(JSON.stringify({ v: 1, kind: "telemetry" }))).toBeUndefined();
		expect(parseServerMessage(JSON.stringify({ v: 1, kind: "snapshot" }))).toBeUndefined();
		expect(parseServerMessage(JSON.stringify({ v: 1, kind: "fact", record: "str" }))).toBeUndefined();
		expect(parseClientMessage(JSON.stringify({ v: 1, kind: "hello", auth: "t" }))).toBeUndefined();
		expect(
			parseClientMessage(JSON.stringify({ v: 1, kind: "intent", intent: { type: "unknown.action" } })),
		).toBeUndefined();
	});

	it("parseIntent 穷尽动作词表并拒绝畸形载荷", () => {
		expect(parseIntent({ type: "input.submit", text: "hi", mode: "steer" })).toEqual({
			type: "input.submit",
			text: "hi",
			mode: "steer",
		});
		expect(parseIntent({ type: "input.submit", text: 42, mode: "direct" })).toBeUndefined();
		expect(parseIntent({ type: "input.submit", text: "hi", mode: "whenever" })).toBeUndefined();
		expect(parseIntent({ type: "turn.cancel", source: "escape" })).toEqual({ type: "turn.cancel", source: "escape" });
		expect(parseIntent({ type: "turn.cancel" })).toEqual({ type: "turn.cancel" });
		expect(parseIntent({ type: "turn.interruptAndDeliver", text: "插话" })).toEqual({
			type: "turn.interruptAndDeliver",
			text: "插话",
		});
		expect(parseIntent({ type: "queue.pullBack" })).toEqual({ type: "queue.pullBack" });
		expect(parseIntent({ type: "thinking.cycle" })).toEqual({ type: "thinking.cycle" });
		expect(parseIntent({ type: "ui.interaction" })).toEqual({ type: "ui.interaction" });
		expect(parseIntent("input.submit")).toBeUndefined();
		expect(parseIntent(undefined)).toBeUndefined();
	});
});

describe("SyncClient 状态机", () => {
	function setup() {
		const controller = new PresentationController();
		const errors: string[] = [];
		let factoryCalls = 0;
		let current = createFakeTransport();
		const client = new SyncClient(
			controller,
			() => {
				factoryCalls++;
				current = createFakeTransport();
				return current.transport;
			},
			{
				auth: "token",
				client: "test",
				backoffMs: () => 0,
				scheduler: {
					schedule: (delayMs, fn) => {
						const timer = setTimeout(fn, delayMs);
						return () => clearTimeout(timer);
					},
				},
				onError: (text) => errors.push(text),
			},
		);
		return {
			controller,
			errors,
			client,
			get current() {
				return current;
			},
			get factoryCalls() {
				return factoryCalls;
			},
		};
	}

	it("connect → hello → snapshot(restore) → synced；事实只能在 synced 后 ingest", async () => {
		const harness = setup();
		const restoreSpy = vi.spyOn(harness.controller, "restore");
		harness.client.start();
		await tick();
		expect(harness.factoryCalls).toBe(1);
		expect(harness.current.receivedFromClient).toHaveLength(1);
		expect(JSON.parse(harness.current.receivedFromClient[0]!)).toMatchObject({ kind: "hello", auth: "token" });
		expect(harness.client.state).toBe("connecting");

		// 快照前的事实 = 时序违约：响亮报错并断开重连
		harness.current.serverSends(
			encodeServerMessage({
				v: SYNC_PROTOCOL_VERSION,
				kind: "fact",
				record: { at: 1, event: { type: "notice", text: "x" } },
			}),
		);
		await tick();
		expect(harness.errors.some((text) => text.includes("快照之前收到事实"))).toBe(true);
		await tick();
		expect(harness.factoryCalls).toBe(2);

		harness.current.serverSends(
			encodeServerMessage({ v: SYNC_PROTOCOL_VERSION, kind: "snapshot", view: { transcript: [], trajectory: [] } }),
		);
		expect(harness.client.state).toBe("synced");
		expect(restoreSpy).toHaveBeenCalledTimes(1);

		const ingestSpy = vi.spyOn(harness.controller, "ingest");
		harness.current.serverSends(
			encodeServerMessage({
				v: SYNC_PROTOCOL_VERSION,
				kind: "fact",
				record: { at: 2, event: { type: "turn_start", turnNumber: 1, userText: "问题" } },
			}),
		);
		expect(ingestSpy).toHaveBeenCalledTimes(1);
		expect(harness.controller.view().transcript.map((node) => node.id)).toEqual(["turn:1"]);
	});

	it("意图只在 synced 后可发；未同步返回 false", async () => {
		const harness = setup();
		expect(harness.client.sendIntent({ type: "thinking.cycle" })).toBe(false);
		harness.client.start();
		await tick();
		expect(harness.client.sendIntent({ type: "thinking.cycle" })).toBe(false);
		harness.current.serverSends(
			encodeServerMessage({ v: SYNC_PROTOCOL_VERSION, kind: "snapshot", view: { transcript: [], trajectory: [] } }),
		);
		expect(harness.client.sendIntent({ type: "thinking.cycle" })).toBe(true);
		const sent = JSON.parse(harness.current.receivedFromClient.at(-1)!);
		expect(sent).toMatchObject({ kind: "intent", intent: { type: "thinking.cycle" } });
	});

	it("连接断开自动重连并重新取快照；stop 后不再重连", async () => {
		const harness = setup();
		const restoreSpy = vi.spyOn(harness.controller, "restore");
		harness.client.start();
		await tick();
		harness.current.serverSends(
			encodeServerMessage({ v: SYNC_PROTOCOL_VERSION, kind: "snapshot", view: { transcript: [], trajectory: [] } }),
		);
		expect(harness.client.state).toBe("synced");

		harness.current.serverCloses();
		await tick();
		expect(harness.client.state).toBe("connecting");
		await tick();
		expect(harness.factoryCalls).toBe(2);
		harness.current.serverSends(
			encodeServerMessage({ v: SYNC_PROTOCOL_VERSION, kind: "snapshot", view: { transcript: [], trajectory: [] } }),
		);
		expect(harness.client.state).toBe("synced");
		expect(restoreSpy).toHaveBeenCalledTimes(2);

		harness.client.stop();
		harness.current.serverCloses();
		await tick();
		await tick();
		expect(harness.client.state).toBe("stopped");
		expect(harness.factoryCalls).toBe(2);
	});

	it("无法解析的服务器消息 = 协议违约：报错、断开、重连", async () => {
		const harness = setup();
		harness.client.start();
		await tick();
		harness.current.serverSends("garbage");
		await tick();
		expect(harness.errors.some((text) => text.includes("无法解析"))).toBe(true);
		await tick();
		expect(harness.factoryCalls).toBe(2);
	});
});
