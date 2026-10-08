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
const GROUP = `g30003`;
const PRIVATE = `p20002`;

function setup(options: { isRecallRelevant?: (fact: EventFact) => boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "uina-qq-sched-"));
	const journal = new FactsJournal({ dataDir: dir, selfId: SELF });
	journal.recover();
	const clock = { now: Date.parse("2026-10-07T09:00:00Z") };
	const NOW = () => new Date(clock.now).toISOString();
	const control = new ControlStore({ dataDir: dir, selfId: SELF, now: NOW });
	control.load();
	const emitted: { id: string; text: string; conversationRef: string; cls: string; origin?: string }[] = [];
	let busy = false;
	const deps = {
		selfId: SELF,
		journal,
		control,
		now: NOW,
		// 真实呈现层（render.ts）：顺带覆盖集成形状
		renderBatch: (candidate: PendingCandidate) => renderBatch(candidate, { journal, control, now: NOW }),
		emit: async (input: { id: string; text: string; conversationRef: string; cls: string; origin?: string }) => {
			emitted.push(input);
		},
		isBusy: () => busy,
		...(options.isRecallRelevant ? { isRecallRelevant: options.isRecallRelevant } : {}),
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
		ref: `m${clock.now}`,
		conversationRef: GROUP,
		senderRef: `u20002`,
		senderDisplayName: "小明",
		direction: "in",
		time: "",
		segments: [{ type: "text", text: "群消息" }],
		source: "platform",
		...overrides,
	});
	const privateFact = (overrides: Partial<Omit<MessageFact, "sequence">> = {}): Omit<MessageFact, "sequence"> => ({
		ref: `m${clock.now}`,
		conversationRef: PRIVATE,
		senderRef: `u20002`,
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

	it("群内全体提及包含当前账号，走direct窗口", async () => {
		ctx.pushMessage(ctx.groupFact({ segments: [{ type: "mention_all" }, { type: "text", text: "集合" }] }));
		await vi.advanceTimersByTimeAsync(1000);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.cls).toBe("direct");
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
					{ type: "mention", userRef: `u${SELF}` },
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
				ref: `m900`,
				direction: "out",
				senderRef: `u${SELF}`,
				source: "echo",
			}),
		);
		expect(ctx.emitted).toHaveLength(0);
		ctx.pushMessage(
			ctx.groupFact({
				ref: `m901`,
				replyTo: `m900`,
			}),
		);
		await vi.advanceTimersByTimeAsync(600);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.text).toContain("trigger=reply_self");
	});

	it("poke 批次捎带的会话正文如实记账，不重复投递", async () => {
		// 普通群消息先到（ordinary 候选待窗口）
		ctx.pushMessage(ctx.groupFact({ ref: `m902` }));
		// poke 到自己：direct 候选优先派发，批次渲染该会话全部未通知正文
		ctx.pushEvent({
			ref: `e1`,
			kind: "poke",
			conversationRef: GROUP,
			time: new Date(ctx.clock.now).toISOString(),
			targetRef: `u${SELF}`,
			actorRef: `u20002`,
			source: "platform",
		});
		await vi.advanceTimersByTimeAsync(2000);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.text).toContain("trigger=poke");
		expect(ctx.emitted[0]!.text).toContain("群消息");
		ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, true);
		// 记账推进到派发时最新序号：下一批不再重复呈现该正文
		ctx.pushMessage(ctx.groupFact({ ref: `m903`, segments: [{ type: "text", text: "poke 后新消息" }] }));
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(2);
		expect(ctx.emitted[1]!.text).toContain("poke 后新消息");
		expect(ctx.emitted[1]!.text).not.toContain("群消息");
	});
});

describe("G5 follow_up 到期机会（internal 候选）", () => {
	it("到期 follow_up：committed 计账不重复提醒；retired 重新提醒", async () => {
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
			expect(ctx.emitted[0]!.text).toContain("ref=f1");
			// retired：正文未交付 canonical 输入，不计账——下次轮询重新提醒
			ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, false);
			ctx.scheduler.notifyFollowUpDue();
			await vi.advanceTimersByTimeAsync(2000);
			expect(ctx.emitted).toHaveLength(2);
			// committed：正文已交付，计账后不再重复提醒
			ctx.scheduler.onInputSettled(ctx.emitted[1]!.id, true);
			ctx.scheduler.notifyFollowUpDue();
			await vi.advanceTimersByTimeAsync(2000);
			expect(ctx.emitted).toHaveLength(2);
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
					ref: `m900`,
					direction: "out",
					senderRef: `u${SELF}`,
					source: "echo",
				}),
			);
			// 入站消息带 OneBot reply 分段（ingest 解析后 replyTo 指向自己的消息）
			ctx.pushMessage(
				ctx.groupFact({
					ref: `m904`,
					replyTo: `m900`,
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
			ctx.pushMessage(ctx.groupFact({ ref: `m905` }));
			await vi.advanceTimersByTimeAsync(6000);
			expect(ctx.emitted).toHaveLength(1);
			// 批次派发后、结算前，新消息到达（不属于本批）
			ctx.pushMessage(ctx.groupFact({ ref: `m906` }));
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
			ctx.pushMessage(ctx.privateFact({ ref: `m907` }));
			ctx.clock.now += 10000;
			ctx.pushMessage(
				ctx.groupFact({
					ref: `m908`,
					segments: [
						{ type: "mention", userRef: `u${SELF}` },
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
			ctx.pushMessage(ctx.groupFact({ ref: `m909` }));
			for (let i = 2; i <= 6; i++) {
				await vi.advanceTimersByTimeAsync(1000);
				ctx.pushMessage(ctx.groupFact({ ref: `m${1000 + i}` }));
			}
			// 自首条起 5000ms 内必须派发（尽管去抖一直被重置）
			expect(ctx.emitted).toHaveLength(1);
		} finally {
			ctx.close();
		}
	});
});

describe("暂停到期积压摘要（notifyControlTick）", () => {
	it("静音期事实保存不唤醒；暂停到期且无积压不造回合", async () => {
		vi.useFakeTimers();
		const ctx = setup();
		try {
			ctx.control.setAttention("account", { pausedUntil: "2026-10-07T09:30:00Z" });
			ctx.pushMessage(ctx.groupFact({ ref: `m910` }));
			await vi.advanceTimersByTimeAsync(6000);
			expect(ctx.emitted).toHaveLength(0); // 暂停中：事实保存、不产生自动机会
			ctx.clock.now = Date.parse("2026-10-07T09:40:00Z");
			// 无积压场景先用空 journal 分支验证：本会话有积压 → 应产生一次摘要
			ctx.scheduler.notifyControlTick();
			await vi.advanceTimersByTimeAsync(2000);
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.emitted[0]!.text).toContain("[QQ 暂停结束摘要]");
			expect(ctx.emitted[0]!.text).toContain("1 条未读");
			// 已处理：再次 tick 不重复摘要
			ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, true);
			ctx.scheduler.notifyControlTick();
			await vi.advanceTimersByTimeAsync(2000);
			expect(ctx.emitted).toHaveLength(1);
		} finally {
			ctx.close();
			vi.useRealTimers();
		}
	});

	it("恢复原规则后新消息正常产生自动机会", async () => {
		vi.useFakeTimers();
		const ctx = setup();
		try {
			ctx.control.setAttention("account", { pausedUntil: "2026-10-07T09:30:00Z" });
			ctx.clock.now = Date.parse("2026-10-07T09:40:00Z");
			ctx.scheduler.notifyControlTick(); // 到期处理（无积压不造回合）
			await vi.advanceTimersByTimeAsync(2000);
			expect(ctx.emitted).toHaveLength(0);
			ctx.pushMessage(ctx.groupFact({ ref: `m911` }));
			await vi.advanceTimersByTimeAsync(6000);
			expect(ctx.emitted).toHaveLength(1); // 恢复 normal：正常批次
			expect(ctx.emitted[0]!.conversationRef).toBe(GROUP);
		} finally {
			ctx.close();
			vi.useRealTimers();
		}
	});
});

describe("recall 相关性门控（合同：仅影响当前交互或事项证据才提醒）", () => {
	const recallEvent = (messageRef: string): EventFact => ({
		ref: "e1",
		kind: "recall",
		conversationRef: GROUP,
		time: "2026-10-07T09:05:00Z",
		messageRef,
		actorRef: `u20002`,
		source: "platform",
	});

	it("未注入判定（缺省）→ 不唤醒，事实保存可查", async () => {
		vi.useFakeTimers();
		const ctx = setup();
		try {
			ctx.pushEvent(recallEvent(`m1`));
			await vi.advanceTimersByTimeAsync(6000);
			expect(ctx.emitted).toHaveLength(0);
		} finally {
			ctx.close();
			vi.useRealTimers();
		}
	});

	it("判定为相关 → direct 候选唤醒", async () => {
		vi.useFakeTimers();
		const ctx = setup({
			isRecallRelevant: (fact) => fact.messageRef === `m912`,
		});
		try {
			ctx.pushMessage(ctx.groupFact({ ref: `m912` }));
			ctx.pushEvent(recallEvent(`m912`));
			await vi.advanceTimersByTimeAsync(2000);
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.emitted[0]!.text).toContain("trigger=recall");
		} finally {
			ctx.close();
			vi.useRealTimers();
		}
	});

	it("bot_status 事件 origin=external（入站表）；连接故障保持 internal", async () => {
		vi.useFakeTimers();
		const ctx = setup();
		try {
			ctx.pushEvent({
				ref: `e1`,
				kind: "bot_status",
				time: "2026-10-07T09:06:00Z",
				source: "platform",
			});
			await vi.advanceTimersByTimeAsync(2000);
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.emitted[0]!.origin).toBe("external");
			expect(ctx.emitted[0]!.text).toContain("[QQ 状态事件]");
		} finally {
			ctx.close();
			vi.useRealTimers();
		}
	});
});

describe("审查后清理回归（批次A）", () => {
	it("投递失败恢复候选：emit 抛错后候选重排窗口，恢复后可重派", async () => {
		vi.useFakeTimers();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = setup();
		try {
			let failNext = true;
			const original = ctx.deps.emit;
			ctx.deps.emit = async (input) => {
				if (failNext) {
					failNext = false;
					throw new Error("transport down");
				}
				return original(input);
			};
			ctx.pushMessage(ctx.privateFact());
			// 首次派发失败（warn 留痕）→ 候选恢复重排窗口 → 重试成功，不静默丢失。
			await vi.advanceTimersByTimeAsync(2100);
			expect(warnSpy).toHaveBeenCalled();
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.scheduler.pendingCandidates).toHaveLength(0);
		} finally {
			warnSpy.mockRestore();
			ctx.close();
			vi.useRealTimers();
		}
	});

	it("好友 poke（无会话现场）从 actor 推导私聊会话 direct 唤醒", async () => {
		vi.useFakeTimers();
		const ctx = setup();
		try {
			ctx.pushEvent({
				ref: `e1`,
				kind: "poke",
				conversationRef: undefined,
				actorRef: `u20002`,
				targetRef: `u${SELF}`,
				time: "2026-10-07T09:06:00Z",
				source: "platform",
			});
			await vi.advanceTimersByTimeAsync(1500);
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.emitted[0]!.conversationRef).toBe(PRIVATE);
			expect(ctx.emitted[0]!.text).toContain("新增");
		} finally {
			ctx.close();
			vi.useRealTimers();
		}
	});

	it("好友 poke actor 是自己（无法推导对方）不唤醒", async () => {
		vi.useFakeTimers();
		const ctx = setup();
		try {
			ctx.pushEvent({
				ref: `e1`,
				kind: "poke",
				conversationRef: undefined,
				actorRef: `u${SELF}`,
				targetRef: `u${SELF}`,
				time: "2026-10-07T09:06:00Z",
				source: "platform",
			});
			await vi.advanceTimersByTimeAsync(1500);
			expect(ctx.emitted).toHaveLength(0);
		} finally {
			ctx.close();
			vi.useRealTimers();
		}
	});
});
