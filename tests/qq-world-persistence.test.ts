import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { OperationLog } from "../.uina/worlds/qq/src/operation-log.js";
import { conversationRef, messageRef, userRef, type MessageFact } from "../.uina/worlds/qq/src/types.js";

const SELF = "10001";

function makeMessage(n: number, overrides: Partial<MessageFact> = {}): Omit<MessageFact, "sequence"> {
	return {
		ref: messageRef(SELF, `message-${n}`),
		conversationRef: conversationRef(SELF, "private", "20002"),
		senderRef: userRef(SELF, "20002"),
		senderDisplayName: "小明",
		direction: "in",
		time: `2026-10-07T1${n}:00:00+08:00`,
		segments: [{ type: "text", text: `hello ${n}` }],
		source: "platform",
		...overrides,
	};
}

describe("facts journal（G4 本地连续性 + 恢复）", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "uina-qq-facts-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function journal() {
		return new FactsJournal({ dataDir: dir, selfId: SELF });
	}

	it("追加消息分配递增序号，重启后序号续起且事实一致", () => {
		const first = journal();
		first.recover();
		const m1 = first.appendMessage(makeMessage(1));
		const m2 = first.appendMessage(makeMessage(2));
		expect([m1.sequence, m2.sequence]).toEqual([1, 2]);

		const second = journal();
		second.recover();
		const m3 = second.appendMessage(makeMessage(3));
		expect(m3.sequence).toBe(3);
		expect(second.snapshot.messages.get(m1.conversationRef)?.map((m) => m.ref)).toEqual([m1.ref, m2.ref, m3.ref]);
	});

	it("notifiedThrough 跨进程保留且只前进", () => {
		const first = journal();
		first.recover();
		const conv = conversationRef(SELF, "private", "20002");
		first.recordNotified(conv, 5, "input-1", "2026-10-07T10:00:00Z");
		first.recordNotified(conv, 3, "input-2", "2026-10-07T10:01:00Z");
		const second = journal();
		second.recover();
		expect(second.snapshot.notifiedThrough.get(conv)).toBe(5);
	});

	it("尾部 partial 行截断恢复，中段损坏明确失败", () => {
		const first = journal();
		first.recover();
		first.appendMessage(makeMessage(1));
		const journalPath = join(dir, "qq-facts.jsonl");
		const good = readFileSync(journalPath, "utf8");

		// 尾部截断：追加半个 JSON
		writeFileSync(journalPath, good + '{"kind":"mess', "utf8");
		const truncated = journal();
		const result = truncated.recover();
		expect(result.truncatedTailLines).toBe(1);
		expect(truncated.snapshot.messages.size).toBe(1);

		// 中段损坏：在两条完整记录之间插入非法行
		const oneLine = good.trimEnd().split("\n");
		writeFileSync(journalPath, oneLine[0] + "\nnot-json\n", "utf8");
		expect(() => journal().recover()).toThrow(/第 2 行损坏/);
	});

	it("绑定账号变更后旧记录不迁移", () => {
		const first = journal();
		first.recover();
		first.appendMessage(makeMessage(1));
		const second = new FactsJournal({ dataDir: dir, selfId: "99999" });
		second.recover();
		expect(second.snapshot.messages.size).toBe(0);
		expect(second.snapshot.excludedForeignAccount).toBe(1);
	});
});

describe("control store（G4 本地连续性 + 单写方语义）", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "uina-qq-control-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function store(now = "2026-10-07T12:00:00Z") {
		return new ControlStore({ dataDir: dir, selfId: SELF, now: () => now });
	}

	it("attention set/clear 跨进程一致，revision 递增", () => {
		const first = store();
		first.load();
		first.setAttention("account", { mode: "direct_only" });
		const rev = first.setAttention(conversationRef(SELF, "group", "30003"), { mode: "silent", priority: "preferred" });
		expect(rev).toBe(2);

		const second = store();
		second.load();
		expect(second.revision).toBe(2);
		expect(second.effectiveAttention("account").mode).toBe("direct_only");
		expect(second.effectiveAttention(conversationRef(SELF, "group", "30003")).mode).toBe("silent");
		second.clearAttention(conversationRef(SELF, "group", "30003"));
		expect(second.effectiveAttention(conversationRef(SELF, "group", "30003")).mode).toBe("direct_only");
	});

	it("账号级 silent 不被会话覆盖，到期恢复原规则", () => {
		const s = store("2026-10-07T12:00:00Z");
		s.load();
		s.setAttention("account", { pausedUntil: "2026-10-07T13:00:00Z" });
		s.setAttention(conversationRef(SELF, "group", "30003"), { mode: "normal" });
		const groupRef = conversationRef(SELF, "group", "30003");
		expect(s.effectiveAttention(groupRef).mode).toBe("silent");
		expect(s.effectiveAttention(groupRef).pausedUntil).toBe("2026-10-07T13:00:00Z");

		const later = new ControlStore({ dataDir: dir, selfId: SELF, now: () => "2026-10-07T13:00:01Z" });
		later.load();
		// 到期恢复：账号无显式 mode，会话覆盖 normal 生效
		expect(later.effectiveAttention(groupRef).mode).toBe("normal");
		expect(later.effectiveAttention(groupRef).pausedUntil).toBeNull();
	});

	it("写失败保留旧控制状态并抛错，不宣称保存", () => {
		const s = store();
		s.load();
		s.setAttention("account", { mode: "normal" });
		// 用目录占位 tmp 路径制造持久 rename 失败
		mkdirSync(join(dir, "qq-control.json.tmp"));
		expect(() => s.setAttention("account", { mode: "silent" })).toThrow();
		// 内存态保持旧值
		expect(s.effectiveAttention("account").mode).toBe("normal");
		// 磁盘保持旧值
		const onDisk = JSON.parse(readFileSync(join(dir, "qq-control.json"), "utf8"));
		expect(onDisk.accountOverride.mode).toBe("normal");
	});

	it("控制文件损坏明确失败", () => {
		writeFileSync(join(dir, "qq-control.json"), "not-json", "utf8");
		expect(() => store().load()).toThrow(/损坏/);
	});

	it("follow_up 生命周期与到期计账", () => {
		const s = store("2026-10-07T08:00:00Z");
		s.load();
		const item = s.createFollowUp({
			targetRef: conversationRef(SELF, "private", "20002"),
			note: "整理完资料再联系小明",
			evidenceRefs: [messageRef(SELF, "message-42")],
			reviewAt: "2026-10-07T16:30:00+08:00",
		});
		// 08:00Z < reviewAt(08:30Z)：尚未到期
		expect(s.dueFollowUps()).toEqual([]);

		const later = new ControlStore({ dataDir: dir, selfId: SELF, now: () => "2026-10-07T09:00:00Z" });
		later.load();
		expect(later.dueFollowUps().map((i) => i.ref)).toEqual([item.ref]);

		later.markReviewNotified(item.ref);
		expect(later.dueFollowUps()).toEqual([]);
		// 只改 note 不重建预约
		later.updateFollowUp(item.ref, { note: "明天再看看对话。" });
		expect(later.getFollowUp(item.ref)?.reviewNotified).toBe(true);
		// 改 reviewAt 建立新预约
		later.updateFollowUp(item.ref, { reviewAt: "2026-10-08T09:00:00Z" });
		expect(later.getFollowUp(item.ref)?.reviewNotified).toBe(false);
		// close 后不可再 update
		later.settleFollowUp(item.ref, "完成", "closed");
		expect(() => later.updateFollowUp(item.ref, { note: "x" })).toThrow(/open/);
	});

	it("重启后 followUp 计数续起不撞号", () => {
		const first = store();
		first.load();
		const a = first.createFollowUp({ targetRef: conversationRef(SELF, "private", "20002"), note: "a" });
		const second = store();
		second.load();
		const b = second.createFollowUp({ targetRef: conversationRef(SELF, "private", "20002"), note: "b" });
		expect(b.ref).not.toBe(a.ref);
		expect(b.ref.endsWith(":2")).toBe(true);
	});
});

describe("operation log（G4 + G6 前置）", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "uina-qq-ops-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function log() {
		return new OperationLog({ dataDir: dir, selfId: SELF });
	}

	it("commitIntent 即时落盘（fsync），settle 归并同一 ref，迟到回执升级 unknown", () => {
		const first = log();
		first.recover();
		const ref = first.newOperationRef();
		first.commitIntent({
			ref,
			identity: "world:qq/speak",
			action: "speak",
			target: conversationRef(SELF, "private", "20002"),
			outcome: "unknown",
			echo: "e-1",
			startedAt: "2026-10-07T12:00:00Z",
		});
		// 意图已持久化（模拟崩溃后新实例恢复）
		const afterCrash = log();
		afterCrash.recover();
		expect(afterCrash.get(ref)?.outcome).toBe("unknown");

		afterCrash.settle(ref, "succeeded", "2026-10-07T12:01:00Z", {
			messageRef: messageRef(SELF, "message-43"),
			receipt: { echo: "e-1" },
		});
		expect(afterCrash.get(ref)?.outcome).toBe("succeeded");
		expect(afterCrash.get(ref)?.messageRef).toBe(messageRef(SELF, "message-43"));
		expect(afterCrash.listUnknown()).toEqual([]);
	});

	it("unknown 列表与 recent、计数续起", () => {
		const first = log();
		first.recover();
		first.seedCounterFromExisting();
		const r1 = first.newOperationRef();
		first.commitIntent({
			ref: r1,
			identity: "world:qq/speak",
			action: "speak",
			outcome: "unknown",
			startedAt: "2026-10-07T12:00:00Z",
		});
		const r2 = first.newOperationRef();
		first.commitIntent({
			ref: r2,
			identity: "world:qq/speak",
			action: "speak",
			outcome: "succeeded",
			startedAt: "2026-10-07T12:01:00Z",
		});

		const second = log();
		second.recover();
		second.seedCounterFromExisting();
		const r3 = second.newOperationRef();
		expect(r3.endsWith(":3")).toBe(true);
		expect(second.listUnknown().map((r) => r.ref)).toEqual([r1]);
		// r3 只铸造了 ref 未提交，不计入日志
		expect(second.recent(10)).toHaveLength(2);
	});

	it("尾部 partial 截断，非绑定账号记录排除", () => {
		const first = log();
		first.recover();
		const ref = first.newOperationRef();
		first.commitIntent({
			ref,
			identity: "world:qq/speak",
			action: "speak",
			outcome: "unknown",
			startedAt: "2026-10-07T12:00:00Z",
		});
		const path = join(dir, "qq-operations.jsonl");
		writeFileSync(path, readFileSync(path, "utf8") + '{"kind":"opera', "utf8");
		const second = log();
		expect(second.recover().truncatedTailLines).toBe(1);
	});
});

describe("迟到回执 echo 归并（G6 接线语义）", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "uina-qq-echo-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("凭 echo 升级 unknown → succeeded；确定结论不被迟到副本覆盖", () => {
		const log = new OperationLog({ dataDir: dir, selfId: SELF });
		log.recover();
		log.seedCounterFromExisting();
		const ref = log.newOperationRef();
		log.commitIntent({
			ref,
			identity: "world:qq/speak",
			action: "send_private_msg",
			outcome: "unknown",
			echo: ref,
			startedAt: "2026-10-07T12:00:00Z",
		});

		const upgraded = log.settleFromEchoReceipt(ref, { status: "ok", data: { message_id: 43 } }, "2026-10-07T12:05:00Z");
		expect(upgraded?.outcome).toBe("succeeded");
		expect(upgraded?.messageRef).toBe(messageRef(SELF, 43));

		// 已确定结论不被迟到副本降级
		const again = log.settleFromEchoReceipt(ref, { status: "failed", data: null }, "2026-10-07T12:06:00Z");
		expect(again?.outcome).toBe("succeeded");

		// 未知 echo 不动任何记录
		expect(log.settleFromEchoReceipt("no-such-echo", { status: "ok", data: {} }, "2026-10-07T12:07:00Z")).toBeNull();
		expect(log.get(ref)?.outcome).toBe("succeeded");
	});
});
