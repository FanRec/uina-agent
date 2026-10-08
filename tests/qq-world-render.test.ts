import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decodeCursor,
	encodeCursor,
	fingerprintCursor,
	oneBotSenderLabel,
	quote,
	renderBatch,
	renderConversationPage,
	renderForwardNodes,
	TimeView,
} from "../.uina/worlds/qq/src/render.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import type { PendingCandidate } from "../.uina/worlds/qq/src/scheduler.js";
import type { MessageFact } from "../.uina/worlds/qq/src/types.js";

const SELF = "10001";
const GROUP = `qq-conversation:${SELF}:group:30003`;

function makeJournal(messages: Partial<MessageFact>[]): { journal: FactsJournal; control: ControlStore } {
	const journal = new FactsJournal({ dataDir: mkdtempSync(join(tmpdir(), "uina-qq-render-")), selfId: SELF });
	// 直接操作内存快照：呈现层只读，不测持久化（持久化在 persistence.test）
	const list: MessageFact[] = [];
	messages.forEach((partial, index) => {
		list.push({
			ref: partial.ref ?? `qq-message:${SELF}:m${index}`,
			conversationRef: partial.conversationRef ?? GROUP,
			senderRef: partial.senderRef ?? `qq-user:${SELF}:20002`,
			senderDisplayName: partial.senderDisplayName ?? "小明",
			direction: partial.direction ?? "in",
			sequence: partial.sequence ?? index + 1,
			time: partial.time ?? `2026-10-07T0${(index % 9) + 1}:00:00Z`,
			segments: partial.segments ?? [{ type: "text", text: `消息${index}` }],
			replyTo: partial.replyTo,
			source: partial.source ?? "platform",
		} as MessageFact);
	});
	// 直接注入快照（呈现层契约：只读快照入参）
	(journal as unknown as { state: { messages: Map<string, MessageFact[]> } }).state.messages.set(GROUP, list);
	const control = new ControlStore({ dataDir: mkdtempSync(join(tmpdir(), "uina-qq-render-c-")), selfId: SELF });
	return { journal, control };
}

function candidate(overrides: Partial<PendingCandidate> = {}): PendingCandidate {
	return {
		key: `ordinary:${GROUP}`,
		conversationRef: GROUP,
		cls: "ordinary",
		oldestAt: "2026-10-07T01:00:00Z",
		count: 1,
		origin: "external",
		...overrides,
	};
}

describe("TimeView（时区仅渲染层转换）", () => {
	it("快照标题带偏移标注；行内时间同日只显 HH:mm、跨日显日期", () => {
		const view = new TimeView("Asia/Shanghai");
		const header = view.header("2026-10-07T07:00:00Z");
		expect(header).toMatch(/GMT\+08:00$/);
		expect(header).toContain("15:00");
		const sameDay = view.line("2026-10-07T07:30:00Z", "2026-10-07T07:00:00Z");
		expect(sameDay).toBe("15:30");
		const crossDay = view.line("2026-10-08T07:30:00Z", "2026-10-07T07:00:00Z");
		expect(crossDay).toMatch(/^2026-10-08/);
	});
});

describe("quote 转义（引号/换行不破坏行结构）", () => {
	it("含引号与换行的原文保持可解析结构", () => {
		const rendered = quote('他说"你好"\n第二行');
		expect(rendered).not.toContain("\n");
		expect(JSON.parse(rendered)).toBe('他说"你好"\n第二行');
	});
});

describe("renderBatch（首/续场景、去重、预算）", () => {
	it("首场景 ≤16 条：全部为新增，coverage 声明完整", () => {
		const { journal, control } = makeJournal(
			Array.from({ length: 16 }, (_, i) => ({ sequence: i + 1, ref: `qq-message:${SELF}:m${i}` })),
		);
		const text = renderBatch(candidate(), { journal, control, now: () => "2026-10-07T09:00:00Z" });
		expect(text).toContain("[QQ 群聊]");
		expect(text).toContain("conversationRef=");
		expect(text).toContain("新增：");
		expect(text).toContain("coverage=本次新增完整");
		expect(text).toContain("hasMore=false");
		expect(text).not.toContain("未呈现");
		// 尾部 16 条全部出现
		expect(text).toContain("消息0");
		expect(text).toContain("消息15");
	});

	it("首场景 >16 条：只呈现尾部 16，更早部分显式省略且 hasMore=true", () => {
		const { journal, control } = makeJournal(
			Array.from({ length: 18 }, (_, i) => ({ sequence: i + 1, ref: `qq-message:${SELF}:m${i}` })),
		);
		const text = renderBatch(candidate(), { journal, control, now: () => "2026-10-07T09:00:00Z" });
		// 尾部 16 条（m2..m17）出现，更早 2 条（m0/m1）不出正文
		expect(text).toContain("消息2");
		expect(text).toContain("消息17");
		expect(text).toContain("更早 2 条未呈现");
		expect(text).toMatch(/coverage=本次呈现尾部 16 条，更早 2 条已省略；hasMore=true/);
	});

	it("续场景：只呈现新增，reply anchor 进必要前文且正文不重复", () => {
		const { journal, control } = makeJournal([
			{ sequence: 1, ref: `qq-message:${SELF}:own`, direction: "out", source: "echo", time: "2026-10-07T01:00:00Z" },
			{ sequence: 2, ref: `qq-message:${SELF}:new`, replyTo: `qq-message:${SELF}:own`, time: "2026-10-07T02:00:00Z" },
		]);
		// 已通知到 seq 1
		(journal as unknown as { state: { notifiedThrough: Map<string, number> } }).state.notifiedThrough.set(GROUP, 1);
		const text = renderBatch(candidate(), { journal, control, now: () => "2026-10-07T09:00:00Z" });
		// anchor 正文恰好一次
		expect(text.split("消息0").length - 1).toBe(1);
		expect(text).toContain("replyTo=qq-message:10001:own");
		expect(text).toContain("必要前文：");
	});

	it("超预算：先丢背景，原文分片显式 truncated，coverage hasMore=true", () => {
		const { journal, control } = makeJournal([
			{ sequence: 1, time: "2026-10-07T01:00:00Z" },
			{ sequence: 2, time: "2026-10-07T02:00:00Z", segments: [{ type: "text", text: "长".repeat(20000) }] },
		]);
		const text = renderBatch(candidate(), {
			journal,
			control,
			now: () => "2026-10-07T09:00:00Z",
			display: { batchBudgetChars: 500 },
		});
		expect(text.length).toBeLessThan(500 + 400); // 软预算内（加头部/coverage 余量）
		expect(text).toContain("[truncated]");
		expect(text).toMatch(/coverage=因预算截断/);
		expect(text).toContain("hasMore=true");
	});
});

describe("cursor（编码往返；签名绑定过滤/窗口）", () => {
	it("编码往返；条件变化 → sig 不同", () => {
		const sig = fingerprintCursor({ scope: "conversation", conv: GROUP, limit: 20 });
		const cursor = encodeCursor({ v: 1, source: "platform", scope: "conversation", conv: GROUP, pos: 40, sig });
		const decoded = decodeCursor(cursor);
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(decoded.value.sig).toBe(sig);
		expect(decodeCursor("not-a-cursor").ok).toBe(false);
		// 条件变化 → sig 不同
		expect(fingerprintCursor({ scope: "conversation", conv: GROUP, limit: 50 })).not.toBe(sig);
	});
});

describe("renderConversationPage（coverage/source/事件页）", () => {
	it("平台快照标注来源；事件页独立段；末条引用返回", () => {
		const time = new TimeView("Asia/Shanghai");
		const page = renderConversationPage({
			conversationRef: GROUP,
			direction: "latest",
			source: "platform",
			time,
			lines: [
				{
					ref: `qq-message:${SELF}:1`,
					timeIso: "2026-10-07T01:00:00Z",
					sender: `qq-user:${SELF}:20002 "小明"`,
					text: "在不？",
				},
				{
					ref: `qq-message:${SELF}:2`,
					timeIso: "2026-10-07T01:05:00Z",
					sender: "我（已确认发言）",
					text: "在",
					replyTo: `qq-message:${SELF}:1`,
				},
			],
			events: [{ ref: `qq-event:${SELF}:e-1`, kind: "poke", timeIso: "2026-10-07T01:06:00Z" }],
		});
		expect(page.text).toContain("source=平台快照");
		expect(page.text).toContain("recentEvents：");
		expect(page.text).toContain("poke");
		expect(page.text).toContain("replyTo=qq-message:10001:1");
		expect(page.lastMessageRef).toBe(`qq-message:${SELF}:2`);
	});
});

describe("呈现层纯函数：sender label 与合并转发展开", () => {
	it("oneBotSenderLabel：空群名片回落昵称（与 ingest 入库规则一致）", () => {
		expect(oneBotSenderLabel({ user_id: 20002, nickname: "真实昵称", card: "" }, SELF)).toContain("真实昵称");
		expect(oneBotSenderLabel({ user_id: 20002, nickname: "昵称", card: "群名片" }, SELF)).toContain("群名片");
		expect(oneBotSenderLabel({ nickname: "   ", card: "  " }, SELF)).toContain('"?"');
		expect(oneBotSenderLabel(undefined, SELF)).toContain('"?"');
	});

	it("renderForwardNodes：节点渲染 + 超 30 条显式标注截断", () => {
		const nodes = Array.from({ length: 35 }, (_, i) => ({
			sender: { user_id: 20000 + i, nickname: `成员${i}`, card: "" },
			message: [{ type: "text", data: { text: `第 ${i} 条` } }],
		}));
		const lines = renderForwardNodes(nodes);
		expect(lines[0]).toContain("35 条");
		expect(lines.some((l) => l.includes("仅显示前 30 条"))).toBe(true);
		expect(lines.filter((l) => l.includes("成员"))).toHaveLength(30);
	});
});
