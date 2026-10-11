import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QqScheduler, type PendingCandidate } from "../.uina/worlds/qq/src/scheduler.js";
import { renderBatch, renderFollowBody } from "../.uina/worlds/qq/src/render.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { AttentionModel } from "../.uina/worlds/qq/src/attention.js";
import { ConversationLocks } from "../.uina/worlds/qq/src/conversation-lock.js";
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
	const attention = new AttentionModel({ control });
	const locks = new ConversationLocks();
	const deps = {
		selfId: SELF,
		journal,
		control,
		attention,
		locks,
		now: NOW,
		// 真实呈现层（render.ts）：顺带覆盖集成形状
		renderBatch: (candidate: PendingCandidate) => renderBatch(candidate, { journal, control, now: NOW }),
		renderFollowBody: (conversationRef: string) => renderFollowBody(conversationRef, { journal, control, now: NOW }),
		emit: async (input: {
			id: string;
			conversationRef: string;
			cls: string;
			origin?: string;
			render: () => Promise<string | null>;
		}) => {
			// 测试近似出队：emit 时立即求值 render（真实路径由 Core 出队时调用，T02/T12 用自定义 emit 单测）。
			const text = (await input.render()) ?? "";
			emitted.push({
				id: input.id,
				text,
				conversationRef: input.conversationRef,
				cls: input.cls,
				origin: input.origin,
			});
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
		await vi.advanceTimersByTimeAsync(2500);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.cls).toBe("direct");
	});

	it("push off（静音/暂停）不产生自动机会", async () => {
		ctx.control.setPush("account", { mode: "off" });
		ctx.pushMessage(ctx.groupFact());
		ctx.pushMessage(ctx.privateFact());
		await vi.advanceTimersByTimeAsync(10000);
		expect(ctx.emitted).toHaveLength(0);
	});

	it("filter direct 挡普通消息首条、放直接互动（账号级）", async () => {
		ctx.control.setPush("account", { filter: "direct" });
		ctx.pushMessage(ctx.groupFact());
		ctx.pushMessage(ctx.privateFact());
		await vi.advanceTimersByTimeAsync(10000);
		expect(ctx.emitted).toHaveLength(0);
		ctx.pushMessage(
			ctx.groupFact({
				segments: [
					{ type: "mention", userRef: `u${SELF}` },
					{ type: "text", text: "点名" },
				],
			}),
		);
		await vi.advanceTimersByTimeAsync(2500);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.cls).toBe("direct");
	});

	it("群聊增量闲聊静默：0→1 后持续到达绝不催更（§5.1 规则④）", async () => {
		ctx.pushMessage(ctx.groupFact());
		await vi.advanceTimersByTimeAsync(2500);
		expect(ctx.emitted).toHaveLength(1);
		ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, true);
		for (let i = 0; i < 5; i++) {
			ctx.pushMessage(ctx.groupFact({ ref: `m${9100 + i}` }));
			await vi.advanceTimersByTimeAsync(3000);
		}
		expect(ctx.emitted).toHaveLength(1); // 1→100 静默记账
	});

	it("私聊沉寂复苏：持续闲聊静默，≥10 分钟间隔后新消息穿透（§5.1 规则③）", async () => {
		ctx.pushMessage(ctx.privateFact());
		await vi.advanceTimersByTimeAsync(2500);
		expect(ctx.emitted).toHaveLength(1);
		ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, true);
		// 间隔 <10min：不催更
		ctx.pushMessage(ctx.privateFact({ ref: `m9200` }));
		await vi.advanceTimersByTimeAsync(3000);
		expect(ctx.emitted).toHaveLength(1);
		// 沉寂 ≥10min 后新消息：复苏穿透
		ctx.clock.now += 10 * 60_000;
		ctx.pushMessage(ctx.privateFact({ ref: `m9201` }));
		await vi.advanceTimersByTimeAsync(2500);
		expect(ctx.emitted).toHaveLength(2);
		expect(ctx.emitted[1]!.text).toContain("trigger=revival");
	});

	it("冷启动基线封存：基线前历史不参与 0→1 也不重复呈现（§6.4）", async () => {
		// 预置存量历史（不经调度链，模拟升级前的旧数据）
		for (let i = 0; i < 10; i++) {
			ctx.journal.appendMessage(ctx.groupFact({ ref: `m${9300 + i}` }));
		}
		// 装配层启动路径：以当前 latestSequence 封存基线
		ctx.control.ensureBaseline(GROUP, ctx.journal.latestSequence(GROUP));
		// 基线后首条消息：消费位=基线 → 0→1 触发，且只呈现新鲜消息
		ctx.pushMessage(ctx.groupFact({ ref: `m9400` }));
		await vi.advanceTimersByTimeAsync(2500);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.text).toContain("m9400");
		expect(ctx.emitted[0]!.text).not.toContain("hello 1");
	});

	it("单占位：占位期间新事实不投递，结算后下一批优先 Direct B", async () => {
		ctx.pushMessage(ctx.groupFact());
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(1);
		// 占位未结算，Direct B（私聊 0→1）到达：保留候选；群 C 为增量闲聊不产生候选
		ctx.pushMessage(ctx.privateFact());
		ctx.pushMessage(ctx.groupFact());
		await vi.advanceTimersByTimeAsync(20000);
		expect(ctx.emitted).toHaveLength(1);
		// A 结算（committed）：下一提交优先 B（direct）
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
		// 群增量静默无新批次；用 @self（直接互动恒穿透）产生第二批次验证 retired 语义
		ctx.pushMessage(
			ctx.groupFact({
				ref: `m950`,
				segments: [
					{ type: "mention", userRef: `u${SELF}` },
					{ type: "text", text: "再看一眼" },
				],
			}),
		);
		await vi.advanceTimersByTimeAsync(2500);
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
		await vi.advanceTimersByTimeAsync(2500);
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
		await vi.advanceTimersByTimeAsync(2500);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.text).toContain("trigger=reply_self");
	});

	it("poke 批次捎带的会话正文如实记账；群增量静默不催更（§5.1 规则④）", async () => {
		// 普通群消息先到（0→1 ordinary 候选待窗口）
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
		await vi.advanceTimersByTimeAsync(2500);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.text).toContain("trigger=poke");
		expect(ctx.emitted[0]!.text).toContain("群消息");
		ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, true);
		// 记账推进到派发时最新序号；ordinary 候选已无新可呈现内容 → 退役，不重复投递
		await vi.advanceTimersByTimeAsync(200);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.scheduler.pendingCandidates).toHaveLength(0);
		// 群增量闲聊：待处理未清空（消费轨未推进），绝不催更新纸条
		ctx.pushMessage(ctx.groupFact({ ref: `m903`, segments: [{ type: "text", text: "poke 后新消息" }] }));
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(1);
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
			await vi.advanceTimersByTimeAsync(2500);
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

	it("同类候选按等待年龄排序（R2：preferred 偏置已废弃，年龄即唯一序）", async () => {
		const ctx = setup();
		try {
			// B 私聊早 10 秒；A 群@self 刚到——同为 direct，更老的 B 先派发
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
			await vi.advanceTimersByTimeAsync(2500);
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.emitted[0]!.conversationRef).toBe(PRIVATE);
		} finally {
			ctx.close();
		}
	});

	it("quiet 去抖 + maxWait 封顶：持续到达不会无限推迟", async () => {
		const ctx = setup();
		try {
			// 普通群：pulse quiet=1200，maxWait=2000；每 1000ms 到一条（< quiet，持续重置去抖）
			ctx.pushMessage(ctx.groupFact({ ref: `m909` }));
			for (let i = 2; i <= 6; i++) {
				await vi.advanceTimersByTimeAsync(1000);
				ctx.pushMessage(ctx.groupFact({ ref: `m${1000 + i}` }));
			}
			// 自首条起 maxWait（2000ms）内必须派发（尽管去抖一直被重置）
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
			ctx.control.setPush("account", { pausedUntil: "2026-10-07T09:30:00Z" });
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
			ctx.control.setPush("account", { pausedUntil: "2026-10-07T09:30:00Z" });
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
			await vi.advanceTimersByTimeAsync(3200);
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

describe("P3 派发链路：延迟渲染与跟读（§5.3/§5.4）", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	/** 覆盖 emit：只收集 render 闭包不求值——模拟"占位入队、出队时才 render"。 */
	function deferEmit(ctx: ReturnType<typeof setup>): (() => Promise<string | null>)[] {
		const renders: (() => Promise<string | null>)[] = [];
		ctx.deps.emit = async (input: { render: () => Promise<string | null> }) => {
			renders.push(input.render);
		};
		return renders;
	}

	it("T02 排队期间延迟求值：出队 render 直接呈现最新快照（含新到直接互动现场）", async () => {
		const ctx = setup();
		try {
			const renders = deferEmit(ctx);
			ctx.pushMessage(ctx.groupFact({ ref: `m900` }));
			await vi.advanceTimersByTimeAsync(2500); // 派发占位入队，render 未求值
			expect(renders).toHaveLength(1);
			// 排队期间 @self 直接到达：只落事实（占位占用），不产生新占位
			ctx.pushMessage(
				ctx.groupFact({
					ref: `m901`,
					segments: [
						{ type: "mention", userRef: `u${SELF}` },
						{ type: "text", text: "插队呼叫" },
					],
				}),
			);
			expect(ctx.scheduler.inFlight).not.toBeNull();
			// 出队求值：一次性呈现排队期间的全部新鲜现场
			const text = await renders[0]!();
			expect(text).toContain("m900");
			expect(text).toContain("插队呼叫");
		} finally {
			ctx.close();
		}
	});

	it("T12 排队期间消费清空：render 返回 null（Core empty_render 退役）", async () => {
		const ctx = setup();
		try {
			const renders = deferEmit(ctx);
			ctx.pushMessage(ctx.privateFact());
			await vi.advanceTimersByTimeAsync(2500);
			expect(renders).toHaveLength(1);
			// 主体已消费（模拟 qq_read 推进消费书签）
			ctx.journal.recordDispatched(PRIVATE, 1, "read", ctx.NOW());
			await expect(renders[0]!()).resolves.toBeNull();
		} finally {
			ctx.close();
		}
	});

	it("R7 render 闭包内部错误被吞掉返回 null，绝不向上抛", async () => {
		const ctx = setup();
		try {
			const renders = deferEmit(ctx);
			ctx.deps.renderBatch = () => {
				throw new Error("boom");
			};
			ctx.pushMessage(ctx.privateFact());
			await vi.advanceTimersByTimeAsync(2500);
			await expect(renders[0]!()).resolves.toBeNull();
			// 占位仍在，等待 input_settled 释放（Core 对 null 走 empty_render retired）
			expect(ctx.scheduler.inFlight).not.toBeNull();
		} finally {
			ctx.close();
		}
	});

	it("follow 连续交付：正文流派发、消费书签推进、后续消息不再走通知轨", async () => {
		const ctx = setup();
		try {
			ctx.control.setPush(PRIVATE, { mode: "follow" });
			ctx.deps.attention.setFocus([PRIVATE]);
			ctx.pushMessage(ctx.privateFact({ ref: `m960` }));
			await vi.advanceTimersByTimeAsync(2500);
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.emitted[0]!.cls).toBe("follow");
			expect(ctx.emitted[0]!.text).toContain("[QQ 跟读]");
			ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, true);
			expect(ctx.journal.dispatchedThroughOf(PRIVATE)).toBe(1);
			// 主体注视下连续到达：直接正文派发，不经 0→1 通知
			ctx.pushMessage(ctx.privateFact({ ref: `m961` }));
			await vi.advanceTimersByTimeAsync(2500);
			expect(ctx.emitted).toHaveLength(2);
			expect(ctx.emitted[1]!.cls).toBe("follow");
			expect(ctx.emitted[1]!.text).not.toContain("m960");
		} finally {
			ctx.close();
		}
	});

	it("R1 缓冲超限：降压摘要 + 跟读挂起；消费回落预算内自动解除", async () => {
		const ctx = setup();
		try {
			ctx.control.setPush(PRIVATE, { mode: "follow" });
			ctx.deps.attention.setFocus([PRIVATE]);
			for (let i = 0; i < 31; i++) {
				ctx.pushMessage(ctx.privateFact({ ref: `m${970 + i}` }));
			}
			await vi.advanceTimersByTimeAsync(2500);
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.emitted[0]!.text).toContain("自动正文已暂停灌注");
			// 退让不动书签：未交付消息保持待处理
			expect(ctx.journal.dispatchedThroughOf(PRIVATE)).toBe(0);
			ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, true);
			// 挂起中：新消息静默记账，不再派发正文
			ctx.pushMessage(ctx.privateFact({ ref: `m${970 + 31}` }));
			await vi.advanceTimersByTimeAsync(2500);
			expect(ctx.emitted).toHaveLength(1);
			// 主体消费（模拟 qq_read）使缓冲回落 → 自动解除挂起，后续恢复正文派发
			ctx.journal.recordDispatched(PRIVATE, ctx.journal.latestSequence(PRIVATE), "read", ctx.NOW());
			ctx.pushMessage(ctx.privateFact({ ref: `m${970 + 32}` }));
			await vi.advanceTimersByTimeAsync(2500);
			expect(ctx.emitted).toHaveLength(2);
			expect(ctx.emitted[1]!.text).toContain("[QQ 跟读]");
		} finally {
			ctx.close();
		}
	});

	it("全局态势概览：通知纸条呈现所有待处理会话一瞥（§5.2）", async () => {
		const ctx = setup();
		try {
			// 私聊先到（0→1 触发前先挂起其候选窗口），群消息到达后概览应同时呈现两会话
			ctx.pushMessage(ctx.privateFact({ ref: `m980` }));
			ctx.pushMessage(ctx.groupFact({ ref: `m981` }));
			await vi.advanceTimersByTimeAsync(2500);
			// direct（私聊）优先派发，纸条概览应包含群会话待处理态势
			expect(ctx.emitted[0]!.conversationRef).toBe(PRIVATE);
			expect(ctx.emitted[0]!.text).toContain("当前待处理概览");
			expect(ctx.emitted[0]!.text).toContain(GROUP);
		} finally {
			ctx.close();
		}
	});
});
