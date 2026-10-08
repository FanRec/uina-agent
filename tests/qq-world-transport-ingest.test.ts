import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OneBotTransport } from "../.uina/worlds/qq/src/transport.js";
import { QqIngestion } from "../.uina/worlds/qq/src/ingest.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import type { MessageFact } from "../.uina/worlds/qq/src/types.js";

/* ---------- 假 WebSocket（SDK 注入接缝） ---------- */

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	readyState = 0;
	sent: string[] = [];
	private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

	constructor(public url: string) {
		FakeWebSocket.instances.push(this);
	}
	addEventListener(event: string, listener: (...args: unknown[]) => void) {
		const set = this.listeners.get(event) ?? new Set();
		set.add(listener);
		this.listeners.set(event, set);
	}
	removeEventListener(event: string, listener: (...args: unknown[]) => void) {
		this.listeners.get(event)?.delete(listener);
	}
	emit(event: string, ...args: unknown[]) {
		for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.readyState = 3;
		this.emit("close", { code: 1000, reason: "test" });
	}
	open() {
		this.readyState = 1;
		this.emit("open");
	}
	injectMessage(raw: unknown) {
		this.emit("message", typeof raw === "string" ? raw : JSON.stringify(raw));
	}
	lastEcho(): unknown {
		const last = this.sent[this.sent.length - 1];
		return last ? (JSON.parse(last) as { echo: unknown }).echo : undefined;
	}
}

beforeEach(() => {
	FakeWebSocket.instances = [];
});
afterEach(() => {
	FakeWebSocket.instances = [];
});

const baseConnection = {
	url: "ws://127.0.0.1:3001",
	role: "Universal" as const,
	accessToken: "tok",
	requestTimeoutMs: 200,
	reconnect: { retries: 0, minDelayMs: 10, maxDelayMs: 20 },
};

const wait = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** 连接并完成 get_login_info 握手，返回可用的 transport 与 socket。 */
async function startTransport(connection = baseConnection) {
	const transport = new OneBotTransport({ connection, webSocketFactory: FakeWebSocket });
	const started = transport.start();
	let socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
	while (!socket) {
		await wait();
		socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
	}
	socket.open();
	while (socket.sent.length < 1) await wait();
	socket.injectMessage({
		status: "ok",
		retcode: 0,
		echo: socket.lastEcho(),
		data: { user_id: 10001, nickname: "Uina" },
	});
	const { selfId } = await started;
	expect(selfId).toBe(10001);
	return { transport, socket };
}

describe("OneBotTransport（G6 传输故障组合）", () => {
	it("SnowLuma bridge ACTION_FAILED receipt is unconfirmed, BAD_REQUEST is a definite rejection", async () => {
		const { transport, socket } = await startTransport();
		try {
			const failed = transport.call("send_private_msg", { user_id: 20002, message: "hi" });
			await wait();
			socket.injectMessage({
				status: "failed",
				retcode: 100,
				echo: socket.lastEcho(),
				wording: "bridge timed out",
				data: null,
			});
			expect(await failed).toMatchObject({ status: "failed", kind: "unconfirmed" });
			const rejected = transport.call("send_private_msg", { user_id: 20002, message: "hi" });
			await wait();
			socket.injectMessage({
				status: "failed",
				retcode: 1400,
				echo: socket.lastEcho(),
				wording: "invalid message",
				data: null,
			});
			expect(await rejected).toMatchObject({ status: "failed", kind: "rejected" });
		} finally {
			await transport.stop();
		}
	});
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "uina-qq-transport-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("start 连接并核验登录身份；call 往返成功", async () => {
		const { transport, socket } = await startTransport();
		const pending = transport.call("get_version_info");
		await wait();
		socket.injectMessage({ status: "ok", retcode: 0, echo: socket.lastEcho(), data: { app_name: "SnowLuma" } });
		const outcome = await pending;
		expect(outcome).toEqual({ status: "ok", data: { app_name: "SnowLuma" } });
	});

	it("回执超时 → failed/timeout（不推断为确定未发送）", async () => {
		const { transport } = await startTransport();
		const outcome = await transport.call("send_private_msg", { user_id: 20002, message: "hi" });
		expect(outcome.status).toBe("failed");
		expect(outcome.status === "failed" && outcome.kind === "timeout").toBe(true);
		expect(transport.connectionError).toBeNull();
	});

	it("迟到回执只出现在 raw，不归并进 pending 调用", async () => {
		const { transport, socket } = await startTransport();
		const rawFrames: unknown[] = [];
		transport.onRaw((raw) => rawFrames.push(raw));
		const echoOf = (frame: unknown) => (JSON.parse(String(frame)) as { echo?: string }).echo;
		void transport.call("send_private_msg", { user_id: 20002, message: "hi" });
		await wait();
		const sentEcho = socket.lastEcho();
		// 一条 echo 无 pending 匹配的响应：SDK 会丢弃，只能从 raw 观察
		socket.injectMessage({ status: "ok", retcode: 0, echo: "late-echo-x", data: { message_id: 43 } });
		expect(echoOf(rawFrames[rawFrames.length - 1]!)).toBe("late-echo-x");
		// 原调用按期限以 timeout 结算，不因迟到回执复活
		const pending = transport.call("send_private_msg", { user_id: 20002, message: "hi2" });
		await wait();
		socket.injectMessage({ status: "ok", retcode: 0, echo: sentEcho, data: { message_id: 43 } });
		const outcome = await pending;
		expect(outcome).toMatchObject({ status: "failed", kind: "timeout" });
		// sentEcho 的迟到回执仍可在 raw 中观察（供 operation log 归并）
		socket.injectMessage({ status: "ok", retcode: 0, echo: sentEcho, data: { message_id: 43 } });
		expect(echoOf(rawFrames[rawFrames.length - 1]!)).toBe(sentEcho);
	});

	it("stop 后 call 返回 connection 失败，不再连接", async () => {
		const { transport } = await startTransport();
		await transport.stop();
		const outcome = await transport.call("get_login_info");
		expect(outcome).toMatchObject({ status: "failed", kind: "not_connected" });
	});
});

describe("QqIngestion（OneBot 事件 → 规范 facts）", () => {
	let dir: string;
	let journal: FactsJournal;
	let ingestion: QqIngestion;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "uina-qq-ingest-"));
		journal = new FactsJournal({ dataDir: dir, selfId: "10001" });
		journal.recover();
		ingestion = new QqIngestion("10001", journal);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function messagesOf(conv: string): MessageFact[] {
		return journal.snapshot.messages.get(conv) ?? [];
	}

	it("群消息入库并分配递增序号", () => {
		ingestion.handleEvent({
			post_type: "message",
			message_type: "group",
			sub_type: "normal",
			time: 1791468000,
			self_id: 10001,
			message_id: 42,
			group_id: 30003,
			user_id: 20002,
			message: [{ type: "text", data: { text: "大家好" } }],
			raw_message: "大家好",
			font: 0,
			sender: { user_id: 20002, nickname: "小明", card: "小明（主持人）", role: "admin" },
		});
		const facts = messagesOf("qq-conversation:10001:group:30003");
		expect(facts).toHaveLength(1);
		expect(facts[0]).toMatchObject({
			ref: "qq-message:10001:42",
			senderRef: "qq-user:10001:20002",
			senderDisplayName: "小明（主持人）",
			direction: "in",
			sequence: 1,
		});
	});

	it("未识别分段入库为 unknown 段（只存 rawType），呈现文字由 render 单源", () => {
		ingestion.handleEvent({
			post_type: "message",
			message_type: "group",
			sub_type: "normal",
			time: 1791468050,
			self_id: 10001,
			message_id: 46,
			group_id: 30003,
			user_id: 20013,
			message: [{ type: "bubble_face", data: { face_id: "x" } }],
			raw_message: "",
			font: 0,
			sender: { user_id: 20013, nickname: "新类型", role: "member" },
		});
		const facts = messagesOf("qq-conversation:10001:group:30003");
		const fact = facts.find((m) => m.ref === "qq-message:10001:46");
		expect(fact?.segments).toEqual([{ type: "unknown", rawType: "bubble_face" }]);
	});

	it("json/xml 卡片与 forward 段入库为结构化分段，不再落入未知", () => {
		ingestion.handleEvent({
			post_type: "message",
			message_type: "group",
			sub_type: "normal",
			time: 1791468040,
			self_id: 10001,
			message_id: 45,
			group_id: 30003,
			user_id: 20012,
			message: [
				{ type: "json", data: { data: '{"alert":{"title":"分享"}}' } },
				{ type: "xml", data: { data: "<msg>...</msg>" } },
				{ type: "forward", data: { id: "res-9" } },
			],
			raw_message: "",
			font: 0,
			sender: { user_id: 20012, nickname: "卡哥", role: "member" },
		});
		const facts = messagesOf("qq-conversation:10001:group:30003");
		const fact = facts.find((m) => m.ref === "qq-message:10001:45");
		expect(fact?.segments).toEqual([
			{ type: "json", data: '{"alert":{"title":"分享"}}' },
			{ type: "xml", data: "<msg>...</msg>" },
			{ type: "forward", resId: "res-9" },
		]);
	});

	it("群名片为空串时回落昵称（card='' 非 nullish，?? 不回落）", () => {
		ingestion.handleEvent({
			post_type: "message",
			message_type: "group",
			sub_type: "normal",
			time: 1791468030,
			self_id: 10001,
			message_id: 44,
			group_id: 30003,
			user_id: 20011,
			message: [{ type: "text", data: { text: "无名片成员" } }],
			raw_message: "无名片成员",
			font: 0,
			sender: { user_id: 20011, nickname: "真实昵称", card: "", role: "member" },
		});
		const facts = messagesOf("qq-conversation:10001:group:30003");
		const fact = facts.find((m) => m.ref === "qq-message:10001:44");
		expect(fact?.senderDisplayName).toBe("真实昵称");
	});

	it("temp 消息保留源群（SnowLuma: sub_type=group + sender.group_id）", () => {
		ingestion.handleEvent({
			post_type: "message",
			message_type: "private",
			sub_type: "group",
			time: 1791468000,
			self_id: 10001,
			message_id: 43,
			user_id: 20009,
			message: [],
			raw_message: "",
			font: 0,
			sender: { user_id: 20009, nickname: "陌生人", group_id: 30003 },
		});
		expect(messagesOf("qq-conversation:10001:temp:20009-g30003")).toHaveLength(1);
	});

	it("self 私聊回送指向 target_id 对方，不把 sender 当对方", () => {
		ingestion.handleEvent({
			post_type: "message_sent",
			message_type: "private",
			sub_type: "friend",
			time: 1791468000,
			self_id: 10001,
			message_id: 44,
			user_id: 10001,
			target_id: 20002,
			message: [{ type: "text", data: { text: "我整理好了" } }],
			raw_message: "",
			font: 0,
			sender: { user_id: 10001, nickname: "Uina" },
		});
		const facts = messagesOf("qq-conversation:10001:private:20002");
		expect(facts[0]).toMatchObject({ direction: "out", source: "echo", senderRef: "qq-user:10001:10001" });
	});

	it("poke/recall/请求事件入库", () => {
		ingestion.handleEvent({
			post_type: "notice",
			notice_type: "notify",
			sub_type: "poke",
			time: 1791468000,
			self_id: 10001,
			group_id: 30003,
			user_id: 20002,
			target_id: 10001,
		});
		ingestion.handleEvent({
			post_type: "notice",
			notice_type: "group_recall",
			time: 1791468001,
			self_id: 10001,
			group_id: 30003,
			user_id: 20002,
			message_id: 42,
		});
		ingestion.handleEvent({
			post_type: "request",
			request_type: "friend",
			flag: "flag-1",
			time: 1791468002,
			self_id: 10001,
			user_id: 20009,
			comment: "我是读书会的小王",
		});
		const events = journal.snapshot.events.get("qq-conversation:10001:group:30003") ?? [];
		expect(events.map((e) => e.kind)).toContain("poke");
		expect(events.map((e) => e.kind)).toContain("recall");
		expect(events.find((e) => e.kind === "recall")?.messageRef).toBe("qq-message:10001:42");
		expect(journal.snapshot.requests.get("qq-request:10001:flag-1")).toMatchObject({
			kind: "friend",
			state: "pending",
			requesterRef: "qq-user:10001:20009",
			comment: "我是读书会的小王",
		});
	});

	it("账号不匹配事件不入库；未识别事件计数", () => {
		ingestion.handleEvent({
			post_type: "message",
			message_type: "group",
			sub_type: "normal",
			time: 1791468000,
			self_id: 99999,
			message_id: 1,
			group_id: 1,
			user_id: 2,
			message: [],
			raw_message: "",
			font: 0,
			sender: { user_id: 2, nickname: "x" },
		});
		ingestion.handleEvent({ post_type: "whatever", self_id: 10001, time: 0 });
		expect(journal.snapshot.messages.size).toBe(0);
		expect(ingestion.totals.unrecognized).toBe(1);
	});
});

describe("审查修复回归：reply 分段解析", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "uina-qq-ingest-reply-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("OneBot reply 分段提取为 replyTo，不进正文分段", () => {
		const journal = new FactsJournal({ dataDir: dir, selfId: "10001" });
		journal.recover();
		const ingestion = new QqIngestion("10001", journal);
		ingestion.handleEvent({
			post_type: "message",
			message_type: "group",
			sub_type: "normal",
			time: 1791468000,
			self_id: 10001,
			message_id: 50,
			group_id: 30003,
			user_id: 20002,
			font: 0,
			message: [
				{ type: "reply", data: { id: 42 } },
				{ type: "at", data: { qq: 10001 } },
				{ type: "text", data: { text: "好的" } },
			],
			raw_message: "",
			sender: { user_id: 20002, nickname: "小明" },
		});
		const fact = journal.snapshot.messages.get("qq-conversation:10001:group:30003")![0]!;
		expect(fact.replyTo).toBe("qq-message:10001:42");
		expect(fact.segments.map((s) => s.type)).toEqual(["mention", "text"]);
		// mention 引用带正确账号边界（不是 "?"）
		expect(fact.segments[0]).toMatchObject({ type: "mention", userRef: "qq-user:10001:10001" });
	});
});
