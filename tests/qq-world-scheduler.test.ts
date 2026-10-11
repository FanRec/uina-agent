import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QqScheduler, RING_BUDGET_CHARS, type PendingCandidate } from "../.uina/worlds/qq/src/scheduler.js";
import { renderCandidate as renderTapCandidate, renderReadWindow } from "../.uina/worlds/qq/src/render.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { AttentionModel } from "../.uina/worlds/qq/src/attention.js";
import type { EventFact, MessageFact } from "../.uina/worlds/qq/src/types.js";

const SELF = "10001";
const GROUP = `g30003`;
const PRIVATE = `p20002`;
const PRIVATE_B = `p20003`;

function setup(options: { isRecallRelevant?: (fact: EventFact) => boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "uina-qq-sched-"));
	const journal = new FactsJournal({ dataDir: dir, selfId: SELF });
	journal.recover();
	const clock = { now: Date.parse("2026-10-07T09:00:00Z") };
	const NOW = () => new Date(clock.now).toISOString();
	const control = new ControlStore({ dataDir: dir, selfId: SELF, now: NOW });
	control.load();
	const emitted: { id: string; text: string; conversationRef: string; cls: string; origin?: string }[] = [];
	const attention = new AttentionModel();
	const deps = {
		selfId: SELF,
		journal,
		control,
		attention,
		now: NOW,
		// 真实呈现层（render.ts）：顺带覆盖集成形状
		renderRingWindow: (conversationRef: string) =>
			renderReadWindow(conversationRef, { journal, control, now: NOW }, { limit: 30, budgetChars: RING_BUDGET_CHARS }),
		renderCandidate: (candidate: PendingCandidate) => renderTapCandidate(candidate, { journal, control, now: NOW }),
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
		attention,
		emitted,
		clock,
		NOW,
		deps,
		pushMessage,
		pushEvent,
		groupFact,
		privateFact,
		close,
	};
}

describe("G5 v3 哑手机：响 / 不响", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		vi.useFakeTimers();
		ctx = setup();
	});
	afterEach(() => {
		ctx.close();
		vi.useRealTimers();
	});

	it("私聊说话即入耳：响铃交付全文，多条消息合并为一次投递", async () => {
		ctx.pushMessage(ctx.privateFact());
		ctx.pushMessage(ctx.privateFact());
		ctx.pushMessage(ctx.privateFact());
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.cls).toBe("ring");
		expect(ctx.emitted[0]!.text).toContain("[QQ 阅读]");
		expect(ctx.emitted[0]!.text).toContain("私聊");
	});

	it("群是场所：不在场默认零注入，持续闲聊绝不催更", async () => {
		ctx.pushMessage(ctx.groupFact());
		for (let i = 2; i <= 6; i++) {
			await vi.advanceTimersByTimeAsync(1000);
			ctx.pushMessage(ctx.groupFact({ ref: `m${1000 + i}` }));
		}
		await vi.advanceTimersByTimeAsync(10000);
		expect(ctx.emitted).toHaveLength(0);
	});

	it("群 @self 拍肩（单条交付）；mention_all 不算点名", async () => {
		ctx.pushMessage(ctx.groupFact({ segments: [{ type: "mention_all" }, { type: "text", text: "集合" }] }));
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(0); // @全体成员不穿透
		ctx.pushMessage(
			ctx.groupFact({
				segments: [
					{ type: "mention", userRef: `u${SELF}` },
					{ type: "text", text: "在吗" },
				],
			}),
		);
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.cls).toBe("tap");
		expect(ctx.emitted[0]!.text).toContain("[QQ 拍肩]");
		expect(ctx.emitted[0]!.text).toContain("在吗");
	});

	it("reply 自己的消息拍肩；self 回送本身不唤醒", async () => {
		ctx.pushMessage(
			ctx.groupFact({
				ref: `m900`,
				direction: "out",
				senderRef: `u${SELF}`,
				source: "echo",
			}),
		);
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(0);
		ctx.pushMessage(
			ctx.groupFact({
				ref: `m901`,
				replyTo: `m900`,
			}),
		);
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.cls).toBe("tap");
		expect(ctx.emitted[0]!.text).toContain("m900"); // 必要前文
	});

	it("静音不响；focus 开窗无视静音", async () => {
		ctx.control.setPush("account", { off: true });
		ctx.pushMessage(ctx.privateFact());
		ctx.pushMessage(ctx.groupFact());
		await vi.advanceTimersByTimeAsync(10000);
		expect(ctx.emitted).toHaveLength(0);
		// 开窗 = 在场：私聊与群一切消息入耳（多候选合并为一批交付）
		ctx.attention.setFocus([PRIVATE, GROUP]);
		ctx.pushMessage(ctx.privateFact({ ref: `m950` }));
		ctx.pushMessage(ctx.groupFact({ ref: `m951` }));
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.cls).toBe("ring");
		expect(ctx.emitted[0]!.text).toContain("私聊");
		expect(ctx.emitted[0]!.text).toContain("群消息");
	});

	it("focused 群在场即流式入耳", async () => {
		ctx.attention.setFocus([GROUP]);
		ctx.pushMessage(ctx.groupFact());
		ctx.pushMessage(ctx.groupFact({ ref: `m960` }));
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.cls).toBe("ring");
		expect(ctx.emitted[0]!.text).toContain("群消息");
	});

	it("poke 拍肩：群内捎会话现场，好友 poke 从 actor 推导私聊", async () => {
		ctx.pushEvent({
			ref: `e1`,
			kind: "poke",
			conversationRef: GROUP,
			time: new Date(ctx.clock.now).toISOString(),
			targetRef: `u${SELF}`,
			actorRef: `u20002`,
			source: "platform",
		});
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0]!.cls).toBe("tap");
		expect(ctx.emitted[0]!.conversationRef).toBe(GROUP);
		ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, true); // 释放占位
		// 好友 poke：无会话现场，从 actor 推导
		ctx.pushEvent({
			ref: `e2`,
			kind: "poke",
			conversationRef: undefined,
			actorRef: `u20003`,
			targetRef: `u${SELF}`,
			time: new Date(ctx.clock.now).toISOString(),
			source: "platform",
		});
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(2);
		expect(ctx.emitted[1]!.conversationRef).toBe(PRIVATE_B);
	});

	it("好友 poke actor 是自己（无法推导对方）不唤醒", async () => {
		ctx.pushEvent({
			ref: `e1`,
			kind: "poke",
			conversationRef: undefined,
			actorRef: `u${SELF}`,
			targetRef: `u${SELF}`,
			time: "2026-10-07T09:06:00Z",
			source: "platform",
		});
		await vi.advanceTimersByTimeAsync(6000);
		expect(ctx.emitted).toHaveLength(0);
	});
});

describe("G5 记账与单占位", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("记账只在 committed 后：retired 不推进书签", async () => {
		const ctx = setup();
		try {
			ctx.pushMessage(ctx.privateFact());
			await vi.advanceTimersByTimeAsync(6000);
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.journal.dispatchedThroughOf(PRIVATE)).toBe(0); // 未结算不记账
			ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, true);
			expect(ctx.journal.dispatchedThroughOf(PRIVATE)).toBe(1);
			// 新消息再响一次（说话即入耳），retired 不推进
			ctx.pushMessage(ctx.privateFact({ ref: `m970` }));
			await vi.advanceTimersByTimeAsync(6000);
			expect(ctx.emitted).toHaveLength(2);
			ctx.scheduler.onInputSettled(ctx.emitted[1]!.id, false);
			expect(ctx.journal.dispatchedThroughOf(PRIVATE)).toBe(1);
		} finally {
			ctx.close();
		}
	});

	it("单占位：多会话候选合并为一批交付", async () => {
		const ctx = setup();
		try {
			ctx.pushMessage(ctx.privateFact()); // PRIVATE
			ctx.pushMessage({ ...ctx.privateFact(), ref: `m980`, conversationRef: PRIVATE_B }); // PRIVATE_B
			await vi.advanceTimersByTimeAsync(6000);
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.emitted[0]!.text).toContain(PRIVATE);
			expect(ctx.emitted[0]!.text).toContain(PRIVATE_B);
			ctx.scheduler.onInputSettled(ctx.emitted[0]!.id, true);
			expect(ctx.journal.dispatchedThroughOf(PRIVATE)).toBe(1);
			expect(ctx.journal.dispatchedThroughOf(PRIVATE_B)).toBe(1);
		} finally {
			ctx.close();
		}
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
			expect(ctx.emitted[0]!.cls).toBe("internal");
			expect(ctx.emitted[0]!.text).toContain("[QQ 待跟进]");
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

	it("判定为相关 → 拍肩唤醒", async () => {
		vi.useFakeTimers();
		const ctx = setup({
			isRecallRelevant: (fact) => fact.messageRef === `m912`,
		});
		try {
			ctx.pushMessage(ctx.groupFact({ ref: `m912` }));
			ctx.pushEvent(recallEvent(`m912`));
			await vi.advanceTimersByTimeAsync(2500);
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.emitted[0]!.cls).toBe("tap");
			expect(ctx.emitted[0]!.text).toContain("已撤回");
		} finally {
			ctx.close();
			vi.useRealTimers();
		}
	});

	it("bot_status 事件 origin=external（入站表）", async () => {
		vi.useFakeTimers();
		const ctx = setup();
		try {
			ctx.pushEvent({
				ref: `e1`,
				kind: "bot_status",
				time: "2026-10-07T09:06:00Z",
				source: "platform",
			});
			await vi.advanceTimersByTimeAsync(2500);
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.emitted[0]!.cls).toBe("internal");
			expect(ctx.emitted[0]!.origin).toBe("external");
			expect(ctx.emitted[0]!.text).toContain("[QQ 状态事件]");
		} finally {
			ctx.close();
			vi.useRealTimers();
		}
	});
});

describe("审查后清理回归（批次A）", () => {
	it("投递失败恢复候选：emit 抛错后重试成功，不静默丢失", async () => {
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
			// 首次派发失败（warn 留痕）→ recheck 重试成功。
			await vi.advanceTimersByTimeAsync(6000);
			expect(warnSpy).toHaveBeenCalled();
			expect(ctx.emitted).toHaveLength(1);
			expect(ctx.scheduler.pendingCandidates).toHaveLength(0);
		} finally {
			warnSpy.mockRestore();
			ctx.close();
			vi.useRealTimers();
		}
	});
});

describe("P3 派发链路：延迟渲染（出队时才 render）", () => {
	/** 覆盖 emit：只收集 render 闭包不求值——模拟"占位入队、出队时才 render"。 */
	function deferEmit(ctx: ReturnType<typeof setup>): (() => Promise<string | null>)[] {
		const renders: (() => Promise<string | null>)[] = [];
		ctx.deps.emit = async (input: { render: () => Promise<string | null> }) => {
			renders.push(input.render);
		};
		return renders;
	}

	it("T02 排队期间延迟求值：出队 render 直接呈现最新快照", async () => {
		vi.useFakeTimers();
		const ctx = setup();
		try {
			const renders = deferEmit(ctx);
			ctx.pushMessage(ctx.privateFact({ ref: `m900` }));
			await vi.advanceTimersByTimeAsync(2500); // 派发占位入队，render 未求值
			expect(renders).toHaveLength(1);
			expect(ctx.scheduler.inFlight).not.toBeNull();
			// 排队期间新消息到达：只落事实，不产生新占位
			ctx.pushMessage(ctx.privateFact({ ref: `m901` }));
			// 出队求值：一次性呈现排队期间的全部新鲜现场
			const text = await renders[0]!();
			expect(text).toContain("m900");
			expect(text).toContain("m901");
		} finally {
			ctx.close();
			vi.useRealTimers();
		}
	});

	it("T12 排队期间消费清空：render 返回 null（empty_render 退役）", async () => {
		vi.useFakeTimers();
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
			vi.useRealTimers();
		}
	});

	it("R7 render 闭包内部错误被吞掉返回 null，绝不向上抛", async () => {
		vi.useFakeTimers();
		const ctx = setup();
		try {
			const renders = deferEmit(ctx);
			ctx.deps.renderRingWindow = () => {
				throw new Error("boom");
			};
			ctx.pushMessage(ctx.privateFact());
			await vi.advanceTimersByTimeAsync(2500);
			await expect(renders[0]!()).resolves.toBeNull();
			// 占位仍在，等待 input_settled 释放（Core 对 null 走 empty_render retired）
			expect(ctx.scheduler.inFlight).not.toBeNull();
		} finally {
			ctx.close();
			vi.useRealTimers();
		}
	});
});
