/**
 * 多前端网关核心（传输无关面）。
 *
 * 钉住的纪律：
 * 1. hello 即快照：鉴权失败拒绝；握手期到达的事实进有界缓冲，快照后立刻排空；
 * 2. 意图归属：转发给宿主时携带 source.channel/actor（网关身份，不由客户端自报）；
 * 3. 策略在网关：斜杠命令与队列撤回明确拒绝（远程面没有这些本地语义）。
 */
import { describe, expect, it } from "vitest";
import { FrontendGatewayCore } from "../src/cli/frontend-gateway.js";
import type { HostEvent, HostEventRecord } from "../src/host/events.js";
import type { UinaHost } from "../src/host/host.js";
import { SYNC_PROTOCOL_VERSION } from "../src/presentation/sync.js";
import type { SessionEntry } from "../src/session/types.js";

interface FakeHostCalls {
	submitText: Array<{ text: string; mode: string; source: unknown }>;
	interrupts: number;
	cycles: number;
}

function createFakeHost(entries: readonly SessionEntry[] = []) {
	const listeners = new Set<(record: HostEventRecord) => void>();
	const calls: FakeHostCalls = { submitText: [], interrupts: 0, cycles: 0 };
	const state = { busy: false };
	const snapshot = { modelName: "test-model", busy: false, queue: [], queueDepth: 0 };
	const host = {
		restoredEntries: entries,
		restoredAuxiliary: [],
		onEventRecord: (listener: (record: HostEventRecord) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		isBusy: () => state.busy,
		submitText: async (text: string, mode: string, source: unknown) => {
			calls.submitText.push({ text, mode, source });
		},
		pushInput: async () => {},
		interrupt: () => {
			calls.interrupts++;
		},
		waitForIdle: async () => {},
		snapshot: () => snapshot,
		cycleThinkingLevel: () => {
			calls.cycles++;
		},
	};
	return {
		host: host as unknown as UinaHost,
		calls,
		setBusy: (busy: boolean) => {
			state.busy = busy;
		},
		emit: (event: HostEvent, at = 1000) => {
			for (const l of [...listeners]) l({ at, event });
		},
	};
}

function createClient(core: FrontendGatewayCore) {
	const received: unknown[] = [];
	const id = core.attachConnection((data) => {
		received.push(JSON.parse(data));
		return true;
	});
	return {
		id,
		received,
		send: (message: unknown) => core.handleMessage(id, JSON.stringify(message)),
		raw: (data: string) => core.handleMessage(id, data),
	};
}

const hello = (auth = "secret") => ({
	v: SYNC_PROTOCOL_VERSION,
	kind: "hello",
	auth,
	client: "测试面",
	capabilities: ["images"],
});

describe("FrontendGatewayCore：握手与快照", () => {
	it("hello 即快照：恢复基线进入视图；鉴权失败拒绝", () => {
		const entries: SessionEntry[] = [
			{ kind: "message", message: { role: "user", content: "历史问题" } },
			{ kind: "message", message: { role: "assistant", content: "历史回答" } },
		];
		const { host } = createFakeHost(entries);
		const core = new FrontendGatewayCore(host, "secret");
		const client = createClient(core);

		client.send(hello("wrong"));
		expect(client.received).toEqual([{ v: 1, kind: "error", message: "鉴权失败" }]);

		client.received.length = 0;
		client.send(hello());
		expect(client.received[0]).toMatchObject({ kind: "snapshot" });
		const view = (client.received[0] as { view: { transcript: Array<{ kind: string; text?: string }> } }).view;
		expect(view.transcript.map((node) => node.kind)).toEqual(["turn", "assistant"]);
		expect(view.transcript[1]?.text).toBe("历史回答");
	});

	it("握手期事实进缓冲，快照后立即排空，不丢不重", () => {
		const { host, emit } = createFakeHost();
		const core = new FrontendGatewayCore(host, "secret");
		const client = createClient(core);

		emit({ type: "notice", text: "握手前" }, 1001);
		client.send(hello());
		const kinds = client.received.map((m) => (m as { kind: string }).kind);
		// 快照先于缓冲事实：客户端按 snapshot→fact 顺序重建
		expect(kinds[0]).toBe("snapshot");
		expect(kinds.slice(1)).toEqual(["fact"]);
		expect((client.received[1] as { record: { event: { type: string; text: string } } }).record.event).toEqual({
			type: "notice",
			text: "握手前",
		});

		// joined 后事件直接扇出
		emit({ type: "notice", text: "握手后" }, 1002);
		const last = client.received.at(-1) as { kind: string; record: { event: { text: string } } };
		expect(last.kind).toBe("fact");
		expect(last.record.event.text).toBe("握手后");
	});

	it("无法解析的消息回错误且不断连；断开后不再扇出", () => {
		const { host, emit } = createFakeHost();
		const core = new FrontendGatewayCore(host, "secret");
		const client = createClient(core);
		client.raw("garbage");
		expect(client.received).toEqual([{ v: 1, kind: "error", message: "无法解析的消息" }]);

		client.send(hello());
		core.handleClose(client.id);
		emit({ type: "notice", text: "已断开" }, 1003);
		expect(client.received).toHaveLength(2);
	});
});

describe("FrontendGatewayCore：意图路径", () => {
	it("input.submit 携带网关归属转发宿主；斜杠命令明确拒绝", async () => {
		const { host, calls } = createFakeHost();
		const core = new FrontendGatewayCore(host, "secret");
		const client = createClient(core);
		client.send(hello());

		client.send({
			v: SYNC_PROTOCOL_VERSION,
			kind: "intent",
			intent: { type: "input.submit", text: "  你好  ", mode: "steer" },
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(calls.submitText).toHaveLength(1);
		const forwarded = calls.submitText[0]!;
		expect(forwarded.text).toBe("你好");
		expect(forwarded.mode).toBe("steer");
		const source = forwarded.source as { channel: string; actor: { label: string; relation: string } };
		expect(source.channel).toMatch(/^gateway:[0-9a-f-]+$/);
		expect(source.actor).toMatchObject({ label: "测试面", relation: "operator" });

		client.received.length = 0;
		client.send({
			v: SYNC_PROTOCOL_VERSION,
			kind: "intent",
			intent: { type: "input.submit", text: "/quit", mode: "direct" },
		});
		await Promise.resolve();
		expect(client.received).toEqual([{ v: 1, kind: "error", message: "远程端暂不支持斜杠命令，请在本机终端使用" }]);
	});

	it("turn.cancel 转发 interrupt；未握手意图不受理；畸形意图回错误", async () => {
		const { host, calls, setBusy } = createFakeHost();
		setBusy(true);
		const core = new FrontendGatewayCore(host, "secret");
		const client = createClient(core);

		client.send({ v: SYNC_PROTOCOL_VERSION, kind: "intent", intent: { type: "turn.cancel" } });
		await Promise.resolve();
		expect(calls.interrupts).toBe(0);
		expect(client.received.at(-1)).toMatchObject({ kind: "error", message: "未握手，意图不受理" });

		client.send(hello());
		client.send({ v: SYNC_PROTOCOL_VERSION, kind: "intent", intent: { type: "turn.cancel" } });
		await Promise.resolve();
		expect(calls.interrupts).toBe(1);

		client.received.length = 0;
		client.send({ v: SYNC_PROTOCOL_VERSION, kind: "intent", intent: { type: "teleport.now" } });
		expect(client.received.at(-1)).toMatchObject({ kind: "error" });
	});

	it("thinking.cycle 无能力元数据时拒绝；queue.pullBack 明确拒绝", async () => {
		const { host, calls } = createFakeHost();
		const core = new FrontendGatewayCore(host, "secret");
		const client = createClient(core);
		client.send(hello());

		client.send({ v: SYNC_PROTOCOL_VERSION, kind: "intent", intent: { type: "thinking.cycle" } });
		await Promise.resolve();
		expect(calls.cycles).toBe(0);
		expect(client.received.at(-1)).toMatchObject({
			kind: "error",
			message: "当前 Provider 未提供 thinking 能力元数据，无法循环档位",
		});

		client.send({ v: SYNC_PROTOCOL_VERSION, kind: "intent", intent: { type: "queue.pullBack" } });
		await Promise.resolve();
		expect(client.received.at(-1)).toMatchObject({
			kind: "error",
			message: "远程端暂不支持队列撤回，请在本机终端操作",
		});
	});

	it("dispose 摘除宿主订阅", () => {
		const { host, emit } = createFakeHost();
		const core = new FrontendGatewayCore(host, "secret");
		const client = createClient(core);
		client.send(hello());
		core.dispose();
		const before = client.received.length;
		emit({ type: "notice", text: "dispose 后" }, 1004);
		expect(client.received).toHaveLength(before);
	});
});
