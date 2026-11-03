import { describe, expect, test } from "vitest";
import type { ClientFactNotice } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import { makeFactsHarness } from "./mc-fake.js";

/**
 * client.event@1 断线与聊天分类回归（public-api §events / driver.md §11）。
 *
 * 两个历史缺陷：
 * 1. FactsSource 的 bot end 监听注册晚于 ClientHost，断线时 attachedBot 已被清空，
 *    disconnected 证据在 captureEvent 守卫处空转——断线从不入库，通知分支死路。
 * 2. 聊天采集把 channel 写死 "public"，违反 channel 合同枚举；private 分支永不可达。
 */

interface ChatPayload {
	kind: "chat";
	channel: string;
	text: string;
	sender: { name: string | null; uuid: string | null } | null;
	recipient: string | null;
	self: boolean | null;
}

function chatRecords(notices: ClientFactNotice[]): ChatPayload[] {
	const values: ChatPayload[] = [];
	for (const notice of notices)
		if (notice.kind === "evidence")
			for (const record of notice.records) {
				const value = record.fact.value as unknown as ChatPayload;
				if (value?.kind === "chat") values.push(value);
			}
	return values;
}

function connectionRecords(notices: ClientFactNotice[]): { state: string; reason: string | null }[] {
	const values: { state: string; reason: string | null }[] = [];
	for (const notice of notices)
		if (notice.kind === "evidence")
			for (const record of notice.records) {
				const value = record.fact.value as unknown as { kind?: string; state?: string; reason?: string | null };
				if (value?.kind === "connection") values.push({ state: value.state!, reason: value.reason ?? null });
			}
	return values;
}

describe("断线证据", () => {
	test("断线先捕获证据再封流：disconnected 记录落旧流并先于 evidence_end/reset", () => {
		const h = makeFactsHarness({ disconnectFacts: { reason: "kicked: bye" } });
		const notices: ClientFactNotice[] = [];
		// 用消费方订阅（带回放）：与历史存储同形，能收到构造期的 connected 记录。
		h.facts.subscribe((notice) => notices.push(notice), { consumesEvidence: true });
		h.emitMessage("hello");
		const streamBefore = h.facts.evidenceThrough.stream;
		h.disconnect();

		const connections = connectionRecords(notices);
		expect(connections).toEqual([
			{ state: "connected", reason: null },
			{ state: "disconnected", reason: "kicked: bye" },
		]);
		const kinds = notices.map((notice) => notice.kind);
		// 顺序合同：证据 → 流封口 → 源重置；reset 只发生一次（无双 resetSource）。
		expect(kinds.indexOf("evidence_end")).toBeGreaterThan(kinds.indexOf("evidence"));
		expect(kinds.indexOf("reset")).toBeGreaterThan(kinds.indexOf("evidence_end"));
		expect(kinds.filter((kind) => kind === "reset").length).toBe(1);
		// disconnected 记录属于断线前的证据流，不落到新 epoch。
		const disconnected = notices.find(
			(notice): notice is Extract<ClientFactNotice, { kind: "evidence" }> =>
				notice.kind === "evidence" &&
				(notice.records[0]?.fact.value as unknown as { state?: string } | null)?.state === "disconnected",
		);
		expect(disconnected?.records[0]?.mark.stream).toBe(streamBefore);
	});

	test("从未 attach 过的 faulted 不伪造已断开的会话", () => {
		const h = makeFactsHarness({ state: "faulted" });
		const notices: ClientFactNotice[] = [];
		h.facts.subscribe((notice) => notices.push(notice));
		h.setState("faulted");
		expect(connectionRecords(notices)).toEqual([]);
		expect(notices.filter((notice) => notice.kind === "evidence").length).toBe(0);
	});
});

describe("聊天分类", () => {
	test("whisper 分流为 private 并带 recipient；同一入包的 messagestr 按对象身份跳过", () => {
		const h = makeFactsHarness();
		const notices: ClientFactNotice[] = [];
		h.facts.subscribe((notice) => notices.push(notice));
		const raw = { translate: "chat.type.text" };
		// 真实时序：插件的 messagestr 匹配器先于本采集器执行，whisper 在 messagestr
		// 派发中途同步发出——替身按"whisper 已先于本 messagestr 处理器发生"模拟。
		h.bot().emit("whisper", "steve", "psst", null, raw);
		h.bot().emit("messagestr", "steve whispers: psst", "chat", raw, "sender-uuid", true);

		const chats = chatRecords(notices);
		expect(chats).toEqual([
			{
				kind: "chat",
				channel: "private",
				text: "psst",
				sender: { name: "steve", uuid: null, entity: null },
				recipient: "uina",
				self: false,
			},
		]);
	});

	test("chat 事件分流为 public；side 的 private 过滤谓词恰能命中 whisper 记录", () => {
		const h = makeFactsHarness();
		const notices: ClientFactNotice[] = [];
		h.facts.subscribe((notice) => notices.push(notice));
		const raw = {};
		h.bot().emit("chat", "alex", "hello", null, raw);
		h.bot().emit("messagestr", "<alex> hello", "chat", raw, "sender-uuid", true);
		// 真实私聊（对照）：满足 companion/side.ts importantEvents 的过滤分支。
		const raw2 = {};
		h.bot().emit("whisper", "alex", "meet me", null, raw2);

		const chats = chatRecords(notices);
		expect(chats[0]).toMatchObject({
			channel: "public",
			text: "hello",
			sender: { name: "alex" },
			recipient: null,
			self: false,
		});
		const privateChat = chats.find((chat) => chat.channel === "private")!;
		expect(privateChat).toMatchObject({ kind: "chat", channel: "private", self: false });
	});

	test("未匹配的 messagestr 按 position 归位；玩家位格式未解析记 unknown + uuid", () => {
		const h = makeFactsHarness();
		const notices: ClientFactNotice[] = [];
		h.facts.subscribe((notice) => notices.push(notice));
		h.bot().emit("messagestr", "[Server] welcome", "system", {}, null);
		h.bot().emit("messagestr", "tip text", "game_info", {}, null);
		h.bot().emit("messagestr", "custom formatted chat", "chat", {}, "sender-uuid", true);

		const chats = chatRecords(notices);
		expect(chats.map((chat) => chat.channel)).toEqual(["system", "action_bar", "unknown"]);
		expect(chats[2]?.sender).toEqual({ name: null, uuid: "sender-uuid", entity: null });
	});

	test("去重按原始消息对象身份：相同文本的两条独立私聊互不吞", () => {
		const h = makeFactsHarness();
		const notices: ClientFactNotice[] = [];
		h.facts.subscribe((notice) => notices.push(notice));
		for (let i = 0; i < 2; i++) {
			const raw = { nonce: i };
			h.bot().emit("whisper", "steve", "same text", null, raw);
			h.bot().emit("messagestr", "steve whispers: same text", "chat", raw, "sender-uuid", true);
		}
		expect(chatRecords(notices).length).toBe(2);
	});

	test("我方回声不重复捕获", () => {
		const h = makeFactsHarness();
		const notices: ClientFactNotice[] = [];
		h.facts.subscribe((notice) => notices.push(notice));
		h.bot().emit("chat", "uina", "my own", null, {});
		h.bot().emit("messagestr", "<uina> my own", "chat", { other: true }, "uina");
		h.emitMessage("someone else"); // 对照：他人消息照常入库
		const chats = chatRecords(notices);
		expect(chats.length).toBe(1);
		expect(chats[0]?.channel).toBe("unknown");
	});
});
