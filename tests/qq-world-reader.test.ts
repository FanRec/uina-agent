import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleQqCall, type QqAppDeps } from "../.uina/worlds/qq/src/app.js";
import { AttentionModel } from "../.uina/worlds/qq/src/attention.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { ConversationLocks } from "../.uina/worlds/qq/src/conversation-lock.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { OperationLog } from "../.uina/worlds/qq/src/operation-log.js";
import { qqStatusLines } from "../.uina/worlds/qq/src/reader.js";
import { consumptionThrough, pendingCountOf } from "../.uina/worlds/qq/src/consumption.js";
import type { TransportCallOutcome } from "../.uina/worlds/qq/src/transport.js";
import { conversationRef, messageRef, userRef, type MessageFact } from "../.uina/worlds/qq/src/types.js";

/**
 * 查询与消费积木（设计 §4.1~§4.5 / T03/T04A/B/T05/T06/T07A/T15）：
 * 断言信息存在、禁止项不存在、性质成立（呈现词序/排版不是逐字标准）。
 */

const SELF = "10001";
const G1 = conversationRef("group", "30001");
const P1 = conversationRef("private", "20002");
const NOW = "2026-10-11T12:00:00Z";

let dir: string, deps: QqAppDeps, journal: FactsJournal, control: ControlStore;
let platformCalls: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "uina-qq-reader-"));
	journal = new FactsJournal({ dataDir: dir, selfId: SELF });
	journal.recover();
	control = new ControlStore({ dataDir: dir, selfId: SELF, now: () => NOW });
	control.load();
	const ops = new OperationLog({ dataDir: dir, selfId: SELF });
	ops.recover();
	platformCalls = [];
	deps = {
		selfId: SELF,
		journal,
		control,
		ops,
		now: () => NOW,
		attention: new AttentionModel(),
		locks: new ConversationLocks(),
		grants: { grants: ["observation", "attention.manage"] },
		transport: {
			start: async () => ({ selfId: Number(SELF) }),
			stop: async () => {},
			onEvent: () => () => {},
			onRaw: () => () => {},
			onStatus: () => () => {},
			call: async (action) => {
				platformCalls.push(action);
				if (action === "get_friend_list" || action === "get_group_list")
					return { status: "ok", data: [] } as TransportCallOutcome;
				return { status: "failed", kind: "rejected", reason: "test-transport-offline" } as TransportCallOutcome;
			},
		},
	};
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function call(action: string, params: Record<string, unknown>): ReturnType<typeof handleQqCall> {
	return handleQqCall(deps, action, params);
}

let clock = 0;
function message(text = "hello", conversationRef = P1, overrides: Partial<MessageFact> = {}): MessageFact {
	clock += 1;
	return journal.appendMessage({
		ref: messageRef(9000 + clock),
		conversationRef,
		senderRef: userRef("20002"),
		senderDisplayName: "小明",
		direction: "in",
		time: new Date(Date.parse(NOW) + clock * 1000).toISOString(),
		segments: [{ type: "text", text }],
		source: "platform",
		...overrides,
	});
}

/* ---------- P4.1 inbox（T06） ---------- */

describe("inbox 读写合一（T06）", () => {
	it("focus 原子替换、[] 放下全部；省略 focus/push 零副作用", async () => {
		const set = await call("inbox", { focus: [P1, G1] });
		expect(set.status).toBe("succeeded");
		expect(deps.attention.focusList()).toEqual([P1, G1]);

		const replace = await call("inbox", { focus: [G1] });
		expect(replace.status).toBe("succeeded");
		expect(deps.attention.focusList()).toEqual([G1]);

		const revisionBefore = control.revision;
		const query = await call("inbox", {});
		expect(query.status).toBe("succeeded");
		// 纯查询：不隐式清空关注、不写控制状态（省略严格 = 不动）。
		expect(deps.attention.focusList()).toEqual([G1]);
		expect(control.revision).toBe(revisionBefore);

		const clear = await call("inbox", { focus: [] });
		expect(clear.status).toBe("succeeded");
		expect(deps.attention.focusList()).toEqual([]);
	});

	it("push 会话级/账号级静音写入；effectivePush 实时派生，focus 不改偏好", async () => {
		await call("inbox", { focus: [P1] });
		await call("inbox", { push: { target: "account", off: true } });
		expect(control.effectivePush("account").off).toBe(true);
		expect(control.effectivePush(P1).off).toBe(true); // 账号静音传导

		// 会话显式 off=false 解除不了账号静音；账号解除后回落 on。
		await call("inbox", { push: { target: P1, off: false } });
		expect(control.effectivePush(P1).off).toBe(true);
		expect(control.effectivePush(G1).off).toBe(true);
		await call("inbox", { push: { target: "account", off: false } });
		expect(control.effectivePush(P1).off).toBe(false);
		expect(control.effectivePush(G1).off).toBe(false);
		expect(deps.attention.focusList()).toEqual([P1]); // 静音操作不动窗口
	});

	it("行内如实返回待处理/封存/推送/关注字段；pendingOnly 过滤", async () => {
		control.ensureBaseline(P1, 0);
		for (let i = 0; i < 5; i++) message(`m${i}`);
		journal.recordDispatched(P1, 2, "read", NOW); // 消费位 2 → 待处理 3，封存 0（基线 0）
		control.ensureBaseline(G1, 3);
		for (let i = 0; i < 4; i++) message(`g${i}`, G1); // 基线 3 → 封存 3，待处理 1

		const result = await call("inbox", { pendingOnly: true });
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain(P1);
		expect(text).toContain("待处理 3 条");
		expect(text).toContain(G1);
		expect(text).toContain("封存 3 条");
		expect(text).toContain("push=on");
		expect(text).toContain("窗口=关");
		// 消费位口径：不因通知位推进而少算待处理。
		expect(pendingCountOf(journal, control, P1)).toBe(3);
	});
});

/* ---------- P4.2 read（T03/T07A） ---------- */

describe("read 顺序消费（T03）", () => {
	it("从消费位接续整屏交付并推进书签；第二次调用无遗漏无重复", async () => {
		control.ensureBaseline(P1, 0);
		const facts = Array.from({ length: 25 }, () => message());
		const first = await call("read", { conversationRef: P1, limit: 20 });
		expect(first.status).toBe("succeeded");
		const firstText = String(first.result);
		expect(firstText).toContain(facts[0]!.ref);
		expect(firstText).toContain(facts[19]!.ref);
		expect(firstText).not.toContain(facts[20]!.ref); // 只交付一屏
		expect(firstText).toMatch(/剩余待处理 5 条/);
		expect(journal.dispatchedThroughOf(P1)).toBe(20); // body_dispatched 单调推进
		expect(journal.skipRecords()).toHaveLength(0);

		const second = await call("read", { conversationRef: P1 });
		const secondText = String(second.result);
		expect(secondText).toContain(facts[20]!.ref);
		expect(secondText).toContain(facts[24]!.ref);
		expect(secondText).not.toContain(facts[0]!.ref);
		expect(journal.dispatchedThroughOf(P1)).toBe(25);
	});

	it("超长文本折叠 hasMoreSegment，不阻塞书签推进（T03）", async () => {
		control.ensureBaseline(P1, 0);
		const long = message("长".repeat(3000));
		const next = message("after");
		const result = await call("read", { conversationRef: P1 });
		const text = String(result.result);
		expect(text).toContain("hasMoreSegment: true");
		expect(text).toContain(JSON.stringify({ action: "browse", params: { messageRefs: [long.ref] } }));
		expect(journal.dispatchedThroughOf(P1)).toBe(next.sequence); // 折叠不阻塞推进
		expect((await call("read", { conversationRef: P1 })).result).toMatch(/无未消费正文/);
		void long;
	});

	it("软预算截断：未呈现的消息不算交付，书签只推进到最后一条完整交付", async () => {
		control.ensureBaseline(P1, 0);
		const facts = Array.from({ length: 4 }, () => message("x".repeat(400)));
		const result = await call("read", { conversationRef: P1, budgetChars: 700 });
		const text = String(result.result);
		expect(text).toMatch(/余下 \d+ 条未交付/);
		const delivered = journal.dispatchedThroughOf(P1);
		expect(delivered).toBeGreaterThan(0);
		expect(delivered).toBeLessThan(4);
		const deliveredRef = String(
			result.details ? (result.details as { deliveredThrough?: string }).deliveredThrough : "",
		);
		expect(facts.map((f) => f.ref)).toContain(deliveredRef);
	});

	it("省略 conversationRef：恰关注一个会话可直读；多关注/无关注显式失败", async () => {
		message();
		control.ensureBaseline(P1, 0);
		const none = await call("read", {});
		expect(none.status).toBe("failed");

		deps.attention.setFocus([P1]);
		const ok = await call("read", {});
		expect(ok.status).toBe("succeeded");

		deps.attention.setFocus([P1, G1]);
		const ambiguous = await call("read", {});
		expect(ambiguous.status).toBe("failed");
	});

	it("响铃已推进书签后，read 只交付增量，绝不重复（共书签）", async () => {
		control.ensureBaseline(P1, 0);
		const facts = Array.from({ length: 5 }, () => message());
		// 模拟响铃自动正文已交付前三条（锁内同路径记账）。
		journal.recordDispatched(P1, facts[2]!.sequence, "ring", NOW);
		const result = await call("read", { conversationRef: P1 });
		const text = String(result.result);
		expect(text).not.toContain(facts[0]!.ref);
		expect(text).not.toContain(facts[2]!.ref);
		expect(text).toContain(facts[3]!.ref);
		expect(journal.dispatchedThroughOf(P1)).toBe(facts[4]!.sequence);
	});

	it("并发 read 经消费锁串行：交付区间不相交", async () => {
		control.ensureBaseline(P1, 0);
		Array.from({ length: 6 }, () => message());
		const [a, b] = await Promise.all([
			call("read", { conversationRef: P1, limit: 100 }),
			call("read", { conversationRef: P1, limit: 100 }),
		]);
		expect(a.status).toBe("succeeded");
		expect(b.status).toBe("succeeded");
		const counts = [a, b].map((r) => (r.details as { deliveredCount?: number }).deliveredCount ?? -1);
		expect(counts[0]! + counts[1]!).toBe(6); // 无重复派发
		expect(journal.dispatchedThroughOf(P1)).toBe(6);
	});
});

/* ---------- P4.3 skip（T04A/T04B） ---------- */

describe("skip 放下积压（T04A/T04B）", () => {
	it("T04A 部分跳过：剩余待处理重算，不归零", async () => {
		control.ensureBaseline(G1, 0);
		const facts = Array.from({ length: 10 }, () => message("g", G1));
		const result = await call("skip", { conversationRef: G1, throughMessageRef: facts[6]!.ref, reason: "太水了" });
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain("skippedCount=7");
		expect(text).toContain("remainingPendingCount=3");
		expect(consumptionThrough(journal, control, G1)).toBe(facts[6]!.sequence);
		// 审计事实留存：区间与原因可回放。
		const skips = journal.skipRecords(G1);
		expect(skips).toHaveLength(1);
		expect(skips[0]!.throughSequence).toBe(facts[6]!.sequence);
		expect(skips[0]!.reason).toBe("太水了");
	});

	it("T04B 一键抹平：缺省 latest，剩余归零", async () => {
		control.ensureBaseline(G1, 0);
		const facts = Array.from({ length: 4 }, () => message("g", G1));
		const result = await call("skip", { conversationRef: G1 });
		expect(result.status).toBe("succeeded");
		expect(String(result.result)).toContain("remainingPendingCount=0");
		expect(consumptionThrough(journal, control, G1)).toBe(facts.at(-1)!.sequence);
		expect(pendingCountOf(journal, control, G1)).toBe(0);
	});

	it("跳过不回退消费位；未知消息引用显式失败；skip 后 read 从新位接续", async () => {
		control.ensureBaseline(P1, 0);
		const facts = Array.from({ length: 6 }, () => message());
		journal.recordDispatched(P1, facts[3]!.sequence, "read", NOW); // 已读到 4
		const rewind = await call("skip", { conversationRef: P1, throughMessageRef: facts[1]!.ref });
		expect(rewind.status).toBe("succeeded");
		expect(consumptionThrough(journal, control, P1)).toBe(facts[3]!.sequence); // Math.max 底线
		expect(journal.skipRecords()).toHaveLength(0); // 无推进不落审计

		const bad = await call("skip", { conversationRef: P1, throughMessageRef: "m999999" });
		expect(bad.status).toBe("failed");

		const result = await call("read", { conversationRef: P1 });
		expect(String(result.result)).toContain(facts[4]!.ref);
	});
});

/* ---------- P4.4 browse（T05/T15） ---------- */

describe("browse 只读漫游（T05/T15）", () => {
	it("T05 锚点翻页：书签原封不动，方向窗口正确", async () => {
		control.ensureBaseline(P1, 0);
		const facts = Array.from({ length: 10 }, () => message());
		const before = await call("browse", {
			conversationRef: P1,
			direction: "before",
			anchorMessageRef: facts[7]!.ref,
			limit: 3,
		});
		expect(before.status).toBe("succeeded");
		const beforeText = String(before.result);
		for (const fact of facts.slice(4, 7)) expect(beforeText).toContain(fact.ref);
		expect(beforeText).not.toContain(facts[8]!.ref); // 窗口外消息不出现（锚点本身在头部回显）
		expect(beforeText).toContain("书签未移动");
		expect(consumptionThrough(journal, control, P1)).toBe(0);

		const after = await call("browse", {
			conversationRef: P1,
			direction: "after",
			anchorMessageRef: facts[1]!.ref,
			limit: 2,
		});
		const afterText = String(after.result);
		expect(afterText).toContain(facts[2]!.ref);
		expect(afterText).toContain(facts[3]!.ref);
		expect(afterText).not.toContain(facts[4]!.ref);
	});

	it("T15 传参冲突降级：contentTarget 严格优先于 direction", async () => {
		control.ensureBaseline(P1, 0);
		const fact = message("正文", P1, { segments: [{ type: "text", text: "一段".repeat(3000) }] });
		message("next");
		const result = await call("browse", {
			conversationRef: P1,
			direction: "latest",
			contentTarget: { messageRef: fact.ref, segmentIndex: 0 },
		});
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain(`messageRef=${fact.ref} segmentIndex=0`);
		expect(text).toContain("书签未移动");
		expect(consumptionThrough(journal, control, P1)).toBe(0);
	});

	it("messageRefs 点查：本地未持有如实标注，不伪造内容", async () => {
		const held = message("held");
		const result = await call("browse", { messageRefs: [held.ref, "m999999"] });
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain(held.ref);
		expect(text).toContain("m999999 | 本地未持有");
		expect(text).toContain("coverage=partial");
		expect(platformCalls).toEqual(["get_msg"]); // 缺失点查从平台补取
	});

	it("锚点不属于会话/缺失显式失败；direction=before 需要锚点", async () => {
		const inP = message("p");
		const inG = message("g", G1);
		const wrongConv = await call("browse", { conversationRef: G1, direction: "before", anchorMessageRef: inP.ref });
		expect(wrongConv.status).toBe("failed");
		const unknown = await call("browse", { conversationRef: P1, direction: "before", anchorMessageRef: "m999999" });
		expect(unknown.status).toBe("failed");
		const noAnchor = await call("browse", { conversationRef: P1, direction: "before" });
		expect(noAnchor.status).toBe("failed");
		void inG;
	});
});

/* ---------- grant 边界 ---------- */

describe("积木 grant 映射", () => {
	it("inbox 查询需要 observation，push 还需 attention.manage；skip 本地可用", async () => {
		deps = { ...deps, grants: { grants: [] } };
		const pushDenied = await call("inbox", { push: { target: "account", off: true } });
		expect(pushDenied.status).toBe("failed");
		expect(platformCalls).toHaveLength(0);
		const query = await call("inbox", {});
		expect(query.status).toBe("failed");
		expect(platformCalls).toHaveLength(0);
		message();
		const skip = await call("skip", { conversationRef: P1 });
		expect(skip.status).toBe("succeeded");
	});

	it("read.includeMedia 与 browse.contentTarget 需要 observation", async () => {
		deps = { ...deps, grants: { grants: [] } };
		message();
		const readDenied = await call("read", { conversationRef: P1, includeMedia: true });
		expect(readDenied.status).toBe("failed");
		const readOk = await call("read", { conversationRef: P1 });
		expect(readOk.status).toBe("succeeded");
		const fact = message("卡片", P1, { segments: [{ type: "json", data: "{}" }] });
		const browseDenied = await call("browse", { contentTarget: { messageRef: fact.ref } });
		expect(browseDenied.status).toBe("failed");
	});
});

/* ---------- skipped 记录持久化 ---------- */

describe("skipped 审计回放", () => {
	it("重启恢复后审计与消费位不丢", async () => {
		control.ensureBaseline(P1, 0);
		const facts = Array.from({ length: 3 }, () => message());
		await call("skip", { conversationRef: P1, throughMessageRef: facts[1]!.ref, reason: "先跳过" });
		const reborn = new FactsJournal({ dataDir: dir, selfId: SELF });
		reborn.recover();
		expect(reborn.dispatchedThroughOf(P1)).toBe(facts[1]!.sequence);
		expect(reborn.skipRecords(P1)).toHaveLength(1);
		expect(reborn.skipRecords(P1)[0]!.reason).toBe("先跳过");
	});
});

/* ---------- P4.5 qq_status（内部自检） ---------- */

describe("qqStatusLines 冒烟", () => {
	it("如实打印消费位/基线/待处理/push 与跳过审计", async () => {
		control.ensureBaseline(P1, 0);
		const facts = Array.from({ length: 3 }, () => message());
		await call("skip", { conversationRef: P1, throughMessageRef: facts[0]!.ref });
		const lines = qqStatusLines({ selfId: SELF, journal, control, ops: deps.ops }, deps.attention, deps.locks);
		const joined = lines.join("\n");
		expect(joined).toContain(`selfId=${SELF}`);
		expect(joined).toContain(`${P1} | 消费位=${facts[0]!.sequence}`);
		expect(joined).toContain(`待处理=2`);
		expect(joined).toContain("最近跳过审计");
	});
});
