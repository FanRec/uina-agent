import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QqScheduler, type PendingCandidate } from "../.uina/worlds/qq/src/scheduler.js";
import { renderBatch } from "../.uina/worlds/qq/src/render.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import type { EventFact, MessageFact } from "../.uina/worlds/qq/src/types.js";

const SELF = "10001";
const GROUP = `qq-conversation:${SELF}:group:30003`;
const PRIVATE = `qq-conversation:${SELF}:private:20002`;

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "uina-qq-sched-"));
	const journal = new FactsJournal({ dataDir: dir, selfId: SELF });
	journal.recover();
	const clock = { now: Date.parse("2026-10-07T09:00:00Z") };
	const NOW = () => new Date(clock.now).toISOString();
	const control = new ControlStore({ dataDir: dir, selfId: SELF, now: NOW });
	control.load();
	const emitted: { id: string; text: string; conversationRef: string; cls: string }[] = [];
	let busy = false;
	const deps = {
		selfId: SELF,
		journal,
		control,
		now: NOW,
		// 真实呈现层（render.ts）：顺带覆盖集成形状
		renderBatch: (candidate: PendingCandidate) => renderBatch(candidate, { journal, control, now: NOW }),
		emit: async (input: { id: string; text: string; conversationRef: string; cls: string }) => {
			emitted.push(input);
		},
		isBusy: () => busy,
	};
	const scheduler = new QqScheduler(deps);
	/** 与真实摄取链一致：先落库，再通知调度。 */
	const pushMessage = (fact: Omit<MessageFact, "sequence">) => {
		clock.now += 1000;
		const stored = journal.appendMessage({ ...fact, time: fact.time || new Date(clock.now).toISOString() });
		scheduler.onFact({ kind: "message", fact: stored });
	};
	const pushEvent = (fact: EventFact) => {
		journal.appendEvent(fact);
		scheduler.onFact({ kind: "event", fact });
	};
	const groupFact = (overrides: Partial<Omit<MessageFact, "sequence">> = {}): Omit<MessageFact, "sequence"> => ({
		ref: `qq-message:${SELF}:g${clock.now}`,
		conversationRef: GROUP,
		senderRef: `qq-user:${SELF}:20002`,
		senderDisplayName: "小明",
		direction: "in",
		time: "",
		segments: [{ type: "text", text: "群消息" }],
		source: "platform",
		...overrides,
	});
	const privateFact = (overrides: Partial<Omit<MessageFact, "sequence">> = {}): Omit<MessageFact, "sequence"> => ({
		ref: `qq-message:${SELF}:p${clock.now}`,
		conversationRef: PRIVATE,
		senderRef: `qq-user:${SELF}:20002`,
		senderDisplayName: "小明",
		direction: "in",
		time: "",
		segments: [{ type: "text", text: "私聊" }],
		source: "platform",
		...overrides,
	});
	const close = () => {
		scheduler.stop();
		rmSync(dir, { recursive: true, force: true });
	};
	return {
		scheduler,
		journal,
		control,
		emitted,
		clock,
		NOW,
		deps,
		pushMessage,
		pushEvent,
		groupFact,
		privateFact,
		setBusy: (v: boolean) => (busy = v),
		close,
	};
}

describe("G5 消息/队列", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		vi.useFakeTimers();
		ctx = setup();
	});
	afterEach(() => {
		ctx.close();
		vi.useRealTimers();
	});

	it("普通群消息按窗口合并为一次投递", async () => {
		ctx.pushMessage(ctx.groupFact());
		ctx.pushMessage(ctx.groupFact());
		ctx.pushMessage(ctx.groupFact());
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.text).toContain(`conversationRef=${GROUP}`);
	});

	it("silent 模式不产生自动机会", async () => {
		ctx.control.setAttention("account", { mode: "silent" });
		ctx.pushMessage(ctx.groupFact());
		ctx.pushMessage(ctx.privateFact());
		await vi.advanceTimersByTimeAsync(10000);
		expect(ctx.emitted).toHaveLength(0);
	});

	it("direct_only 挡普通群消息、放私聊 direct", async () => {
		ctx.control.setAttention(GROUP, { mode: "direct_only" });
		ctx.pushMessage(ctx.groupFact());
		ctx.pushMessage(ctx.privateFact());
		await vi.advanceTimersByTimeAsync(10000);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.conversationRef).toBe(PRIVATE);
	});

	it("单占位：占位期间新事实不投递，结算后下一批优先 Direct B", async () => {
		ctx.pushMessage(ctx.groupFact());
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(1);
		// 占位未结算，Direct B（私聊）与普通 C 到达：都只保留候选
		ctx.pushMessage(ctx.privateFact());
		ctx.pushMessage(ctx.groupFact());
		await vi.advanceTimersByTimeAsync(20000);
		expect(ctx.emitted).toHaveLength(1);
		// A 结算（committed）：下一提交优先 B（direct），不是 C（ordinary）
		ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, true);
		await vi.advanceTimersByTimeAsync(200);
		expect(ctx.emitted).toHaveLength(2);
		expect(ctx.emitted[1]!.conversationRef).toBe(PRIVATE);
	});

	it("input_settled(committed) 推进 notifiedThrough；retired 不推进", async () => {
		ctx.pushMessage(ctx.groupFact());
		await vi.advanceTimersByTimeAsync(6000);
		ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, true);
		const through = ctx.journal.snapshot.notifiedThrough.get(GROUP);
		expect(through).toBeGreaterThan(0);
		ctx.pushMessage(ctx.groupFact());
		await vi.advanceTimersByTimeAsync(6000);
		ctx.scheduler.onInputSettled(ctx.emitted[1]!.id, false);
		expect(ctx.journal.snapshot.notifiedThrough.get(GROUP)).toBe(through);
	});

	it("agent_settled 后不忙才 recheck 派发", async () => {
		ctx.setBusy(true);
		ctx.pushMessage(ctx.groupFact());
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(0); // 忙时留在事实存储
		ctx.setBusy(false);
		ctx.scheduler.onAgentSettled();
		await vi.advanceTimersByTimeAsync(200);
		expect(ctx.emitted).toHaveLength(1);
	});

	it("群真实 @self 走 direct 短窗口", async () => {
		ctx.pushMessage(
			ctx.groupFact({
				segments: [
					{ type: "mention", userRef: `qq-user:${SELF}:${SELF}` },
					{ type: "text", text: "在吗" },
				],
			}),
		);
		await vi.advanceTimersByTimeAsync(600);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.text).toContain("trigger=at_self");
	});

	it("reply 已核验自己的消息走 direct；self 回送本身不唤醒", async () => {
		ctx.pushMessage(
			ctx.groupFact({
				ref: `qq-message:${SELF}:own-1`,
				direction: "out",
				senderRef: `qq-user:${SELF}:${SELF}`,
				source: "echo",
			}),
		);
		expect(ctx.emitted).toHaveLength(0);
		ctx.pushMessage(
			ctx.groupFact({
				ref: `qq-message:${SELF}:reply-1`,
				replyTo: `qq-message:${SELF}:own-1`,
			}),
		);
		await vi.advanceTimersByTimeAsync(600);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.text).toContain("trigger=reply_self");
	});
});

describe("G5 follow_up 到期机会（internal 候选）", () => {
	it("到期 follow_up 派发一次", async () => {
		vi.useFakeTimers();
		const ctx = setup();
		try {
			ctx.control.createFollowUp({
				targetRef: PRIVATE,
				note: "整理完资料再联系小明",
				reviewAt: "2026-10-07T16:30:00+08:00",
			});
			expect(ctx.control.dueFollowUps()).toHaveLength(1);
			// 到期走 internal 通知（装配层轮询 dueFollowUps 后调用）
			ctx.scheduler.notifyFollowUpDue();
			await vi.advanceTimersByTimeAsync(2000);
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.emitted[0]!.text).toContain("qq-follow-up:");
			// 派发即计账：不再重复提醒
			ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, false);
			await vi.advanceTimersByTimeAsync(200);
			ctx.scheduler.notifyFollowUpDue();
			await vi.advanceTimersByTimeAsync(200);
			expect(ctx.emitted).toHaveLength(1);
		} finally {
			ctx.close();
			vi.useRealTimers();
		}
	});
});

describe("审查修复回归：窗口/偏置/冻结语义", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("reply 分段提取 replyTo → reply_self 走 direct 短窗口", async () => {
		const ctx = setup();
		try {
			// 自己发出的消息先入库
			ctx.pushMessage(
				ctx.groupFact({
					ref: `qq-message:${SELF}:own-1`,
					direction: "out",
					senderRef: `qq-user:${SELF}:${SELF}`,
					source: "echo",
				}),
			);
			// 入站消息带 OneBot reply 分段（ingest 解析后 replyTo 指向自己的消息）
			ctx.pushMessage(
				ctx.groupFact({
					ref: `qq-message:${SELF}:reply-9`,
					replyTo: `qq-message:${SELF}:own-1`,
				}),
			);
			await vi.advanceTimersByTimeAsync(600);
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.emitted[0]!.text).toContain("trigger=reply_self");
		} finally {
			ctx.close();
		}
	});

	it("notifiedThrough 冻结在派发时刻：批次后新到消息不偷记已通知", async () => {
		const ctx = setup();
		try {
			ctx.pushMessage(ctx.groupFact({ ref: `qq-message:${SELF}:f1` }));
			await vi.advanceTimersByTimeAsync(6000);
			expect(ctx.emitted).toHaveLength(1);
			// 批次派发后、结算前，新消息到达（不属于本批）
			ctx.pushMessage(ctx.groupFact({ ref: `qq-message:${SELF}:f2` }));
			ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, true);
			const through = ctx.journal.snapshot.notifiedThrough.get(GROUP)!;
			// 冻结值 = 派发时序号（f1），不含 f2
			expect(through).toBe(1);
		} finally {
			ctx.close();
		}
	});

	it("preferred 偏置有限（direct vs direct）：偏差不越过实际年龄差", async () => {
		const ctx = setup();
		try {
			ctx.control.setAttention(GROUP, { priority: "preferred" });
			// B 私聊（normal）早 10 秒；A 群@self（preferred）刚到——私聊也是 direct
			ctx.clock.now -= 10000;
			ctx.pushMessage(ctx.privateFact({ ref: `qq-message:${SELF}:old-direct` }));
			ctx.clock.now += 10000;
			ctx.pushMessage(
				ctx.groupFact({
					ref: `qq-message:${SELF}:pref-direct`,
					segments: [
						{ type: "mention", userRef: `qq-user:${SELF}:${SELF}` },
						{ type: "text", text: "在吗" },
					],
				}),
			);
			await vi.advanceTimersByTimeAsync(1500);
			expect(ctx.emitted).toHaveLength(1);
			// preferred 偏置 1800ms < 10000ms 实际年龄差：更老的 B 先派发
			expect(ctx.emitted[0]!.conversationRef).toBe(PRIVATE);
		} finally {
			ctx.close();
		}
	});

	it("quiet 去抖 + maxWait 封顶：持续到达不会无限推迟", async () => {
		const ctx = setup();
		try {
			// 普通群：quiet=1800，maxWait=5000；每 1000ms 到一条（< quiet，持续重置去抖）
			ctx.pushMessage(ctx.groupFact({ ref: `qq-message:${SELF}:s1` }));
			for (let i = 2; i <= 6; i++) {
				await vi.advanceTimersByTimeAsync(1000);
				ctx.pushMessage(ctx.groupFact({ ref: `qq-message:${SELF}:s${i}` }));
			}
			// 自首条起 5000ms 内必须派发（尽管去抖一直被重置）
			expect(ctx.emitted).toHaveLength(1);
		} finally {
			ctx.close();
		}
	});
});
