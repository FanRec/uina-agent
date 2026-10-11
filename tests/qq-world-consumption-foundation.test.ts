import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationLocks } from "../.uina/worlds/qq/src/conversation-lock.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { conversationRef, messageRef, userRef, type MessageFact } from "../.uina/worlds/qq/src/types.js";

const SELF = "10001";
const G1 = conversationRef("group", "30001");
const P1 = conversationRef("private", "20002");

function makeMessage(n: number, overrides: Partial<MessageFact> = {}): Omit<MessageFact, "sequence"> {
	return {
		ref: messageRef(n),
		conversationRef: P1,
		senderRef: userRef("20002"),
		senderDisplayName: "小明",
		direction: "in",
		time: `2026-10-11T10:${String(n).padStart(2, "0")}:00+08:00`,
		segments: [{ type: "text", text: `hello ${n}` }],
		source: "platform",
		...overrides,
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("body_dispatched 书签（R4①：dispatched 记录分轨单调回放）", () => {
	let dir: string;
	beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "uina-qq-dispatched-"))));
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("推进书签并持久化；Math.max 单调，回退写入不生效", () => {
		const journal = new FactsJournal({ dataDir: dir, selfId: SELF });
		journal.recover();
		const m1 = journal.appendMessage(makeMessage(1));
		const m2 = journal.appendMessage(makeMessage(2));

		journal.recordDispatched(P1, m2.sequence, "follow", "2026-10-11T10:02:00+08:00", "input-1");
		expect(journal.dispatchedThroughOf(P1)).toBe(2);

		journal.recordDispatched(P1, m1.sequence, "read", "2026-10-11T10:01:00+08:00");
		expect(journal.dispatchedThroughOf(P1)).toBe(2);

		const reborn = new FactsJournal({ dataDir: dir, selfId: SELF });
		reborn.recover();
		expect(reborn.dispatchedThroughOf(P1)).toBe(2);
		expect(journal.snapshot.notifiedThrough.get(P1)).toBeUndefined();
	});

	it("与 notified 书签分轨互不干扰", () => {
		const journal = new FactsJournal({ dataDir: dir, selfId: SELF });
		journal.recover();
		const m1 = journal.appendMessage(makeMessage(1));
		journal.recordNotified(P1, m1.sequence, "input-9", "2026-10-11T10:01:00+08:00");
		journal.recordDispatched(P1, m1.sequence, "read", "2026-10-11T10:01:30+08:00");
		expect(journal.snapshot.notifiedThrough.get(P1)).toBe(1);
		expect(journal.dispatchedThroughOf(P1)).toBe(1);
	});
});

describe("消息引用解析（R3：platform_id → 本地 sequence 映射）", () => {
	let dir: string;
	beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "uina-qq-ref-"))));
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("正/负平台 ID 均映射到本地 sequence", () => {
		const journal = new FactsJournal({ dataDir: dir, selfId: SELF });
		journal.recover();
		const a = journal.appendMessage({ ...makeMessage(1), ref: messageRef(897722166) });
		const b = journal.appendMessage({ ...makeMessage(2), ref: messageRef(-897722167) });
		expect(journal.resolveMessageSequence(P1, a.ref)).toBe(1);
		expect(journal.resolveMessageSequence(P1, b.ref)).toBe(2);
	});

	it("引用不存在或不属目标会话显式失败", () => {
		const journal = new FactsJournal({ dataDir: dir, selfId: SELF });
		journal.recover();
		const fact = journal.appendMessage(makeMessage(1));
		expect(() => journal.resolveMessageSequence(P1, "m999999")).toThrow();
		expect(() => journal.resolveMessageSequence(G1, fact.ref)).toThrow(/不属目标会话/);
	});
});

describe("push 偏好与 R5 一次性迁移", () => {
	let dir: string;
	beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "uina-qq-push-"))));
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function store() {
		return new ControlStore({ dataDir: dir, selfId: SELF, now: () => "2026-10-11T12:00:00Z" });
	}

	it("旧 AttentionOverride 首次加载映射为 push 字段，旧字段不落盘，二次加载不重复迁移", () => {
		writeFileSync(
			join(dir, "qq-control.json"),
			JSON.stringify({
				version: 2,
				selfId: SELF,
				revision: 5,
				accountOverride: { mode: "silent" },
				conversationOverrides: { [G1]: { mode: "direct_only", priority: "preferred" }, [P1]: {} },
				followUps: {},
			}),
			"utf8",
		);
		const first = store();
		expect(first.load().followUps).toBe(0);
		expect(first.effectivePush("account").mode).toBe("off");
		expect(first.effectivePush(G1)).toMatchObject({ mode: "digest", filter: "direct" });
		expect(first.effectivePush(P1)).toMatchObject({ mode: "off", filter: "all" });

		const onDisk = JSON.parse(readFileSync(join(dir, "qq-control.json"), "utf8"));
		expect(onDisk.accountPush).toEqual({ mode: "off" });
		// 旧 action 退役（P6）：迁移后落盘只保留 push 偏好，不再携带旧覆盖字段
		expect(onDisk.accountOverride).toBeUndefined();
		expect(onDisk.conversationOverrides).toBeUndefined();

		const second = store();
		second.load();
		expect(second.effectivePush(G1)).toMatchObject({ mode: "digest", filter: "direct" });
	});

	it("setPush 只改提供字段；clearPush 回落账号继承", () => {
		const s = store();
		s.load();
		s.setPush("account", { mode: "follow" });
		s.setPush(G1, { filter: "direct" });
		expect(s.effectivePush(G1)).toMatchObject({ mode: "follow", filter: "direct" });
		s.clearPush(G1);
		expect(s.effectivePush(G1)).toMatchObject({ mode: "follow", filter: "all" });
	});

	it("inherit 链解析；账号 off 只压制 inherit 回落，不压制会话显式选择", () => {
		const s = store();
		s.load();
		s.setPush("account", { mode: "digest", filter: "direct" });
		s.setPush(G1, { mode: "inherit", filter: "inherit" });
		expect(s.effectivePush(G1)).toMatchObject({ mode: "digest", filter: "direct" });
		s.setPush("account", { mode: "off" });
		expect(s.effectivePush(G1).mode).toBe("off");
		s.setPush(P1, { mode: "follow" });
		expect(s.effectivePush(P1).mode).toBe("follow");
	});

	it("账号暂停压制局部；到期自动恢复", () => {
		const s = store();
		s.load();
		s.setPush("account", { pausedUntil: "2026-10-11T13:00:00Z" });
		s.setPush(G1, { mode: "follow" });
		expect(s.effectivePush(G1)).toMatchObject({ mode: "off", pausedUntil: "2026-10-11T13:00:00Z" });
		const later = new ControlStore({ dataDir: dir, selfId: SELF, now: () => "2026-10-11T14:00:00Z" });
		later.load();
		expect(later.effectivePush(G1).mode).toBe("follow");
	});
});

describe("冷启动基线（R4③：按会话封存，首见写入绝不覆盖）", () => {
	let dir: string;
	beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "uina-qq-baseline-"))));
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("首见写入 latestSequence；重复调用与重启均不覆盖", () => {
		const s = new ControlStore({ dataDir: dir, selfId: SELF, now: () => "2026-10-11T12:00:00Z" });
		s.load();
		expect(s.ensureBaseline(G1, 1200)).toBe(1200);
		expect(s.ensureBaseline(G1, 9999)).toBe(1200);
		expect(s.ensureBaseline(P1, 3)).toBe(3);

		const reborn = new ControlStore({ dataDir: dir, selfId: SELF, now: () => "2026-10-11T12:00:00Z" });
		reborn.load();
		expect(reborn.baselineOf(G1)).toBe(1200);
		expect(reborn.baselineOf(P1)).toBe(3);
		expect(reborn.baselineOf(conversationRef("group", "99999"))).toBeUndefined();
	});
});

describe("会话级消费串行锁（§2.1）", () => {
	it("同会话严格串行；异常照常释放且后继执行", async () => {
		const locks = new ConversationLocks();
		const order: string[] = [];
		const first = locks.run("g1", async () => {
			await delay(30);
			order.push("a");
			throw new Error("boom");
		});
		const second = locks.run("g1", async () => order.push("b"));
		await expect(first).rejects.toThrow("boom");
		await second;
		expect(order).toEqual(["a", "b"]);
		await locks.run("g1", async () => order.push("c"));
		expect(order).toEqual(["a", "b", "c"]);
	});

	it("异会话并行不互斥", async () => {
		const locks = new ConversationLocks();
		const order: string[] = [];
		const slow = locks.run("g1", async () => {
			await delay(30);
			order.push("slow");
		});
		const fast = locks.run("g2", async () => order.push("fast"));
		await fast;
		expect(order).toEqual(["fast"]);
		await slow;
		expect(order).toEqual(["fast", "slow"]);
	});
});
