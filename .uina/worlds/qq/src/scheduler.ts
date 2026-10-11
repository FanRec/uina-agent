import { parseConversationRef, parseUserRef, userRef, conversationRef } from "./types.js";
import type { FactsJournal } from "./facts-journal.js";
import type { ControlStore } from "./control-store.js";
import type { AttentionModel } from "./attention.js";
import type { ConversationLocks } from "./conversation-lock.js";
import type { EventFact, IngestedFact, MessageFact, OperationRecord } from "./types.js";

import {
	pendingCountOf,
	consumptionThrough,
	followPressure,
	pendingConversations,
	pendingFacts,
} from "./consumption.js";
import type { ReadWindowResult } from "./render.js";
import { randomUUID } from "node:crypto";

/** One deferred mailbox input; runtime FIFO owns timing. Payload and accounting share a snapshot. */
export const REVIVAL_SILENCE_MS = 600_000;

export interface TimingWindows {
	/** 消息类统一短脉冲 [去抖 quiet, 自首条起算上限 maxWait]。 */
	readonly pulse: readonly [number, number];
	/** 好友申请/群邀请。 */
	readonly request: readonly [number, number];
	/** internal 候选（连接状态/到期事项/迟到回执/暂停摘要）。 */
	readonly internal: readonly [number, number];
}

export const DEFAULT_TIMING: TimingWindows = {
	pulse: [1200, 2000],
	request: [500, 1500],
	internal: [700, 2000],
};

export type CandidateClass = "follow" | "direct" | "ordinary" | "request" | "internal";

export interface PendingCandidate {
	readonly key: string;
	readonly conversationRef: string;
	readonly cls: CandidateClass;
	/** 最老未通知事实时间（ISO）；同类按此排序。 */
	readonly oldestAt: string;
	/** 普通候选合并计数。 */
	readonly count: number;
	/** direct 候选的触发原因。 */
	readonly trigger?: "private" | "at_self" | "reply_self" | "poke" | "recall" | "revival";
	/** 世界事件 origin（入站表：bot_status/offline 为 external，连接故障与到期事项为 internal）；makeCandidate 保证必填。 */
	readonly origin: "external" | "internal";
	readonly eventRefs?: readonly string[];
	readonly messageRefs?: readonly string[];
	readonly requestRefs?: readonly string[];
	readonly related?: readonly PendingCandidate[];
}

export interface SchedulerDeps {
	readonly selfId: string;
	readonly signal?: AbortSignal;
	readonly journal: FactsJournal;
	readonly control: ControlStore;
	readonly attention: AttentionModel;
	readonly locks: ConversationLocks;
	readonly now: () => string;
	/**
	 * 投递世界事件（emitEvent 包装 submitInput）；单占位由 scheduler 保证。
	 * render 为延迟求值闭包（§5.3）：Core 出队提交前才调用，never journaled；
	 * 返回 null 触发 empty_render 退役。调度器保证闭包永不抛出（R7）。
	 */
	readonly emit: (input: {
		id: string;
		conversationRef: string;
		cls: CandidateClass;
		origin: "external" | "internal";
		render: () => Promise<string | null>;
	}) => Promise<void>;
	/** 通知批次正文渲染（呈现层唯一出口，render.ts 提供）。 */
	readonly renderBatch: (candidate: PendingCandidate) => string;
	/** 跟读正文流渲染（cls=follow 派发用；render.ts 提供）。 */
	readonly renderReadWindow: (conversationRef: string) => ReadWindowResult;
	/**
	 * recall 是否"影响当前交互或事项证据"（合同 §4 只允许此类 recall 提醒）。
	 * 判定语义由装配层注入（自身发言被撤 / open 事项证据被撤 / 连续性窗口内最近批次）；
	 * 未注入时保守不提醒（事实保存可查）。
	 */
	readonly isRecallRelevant?: (fact: EventFact) => boolean;
	readonly isRequestPending?: (ref: string) => boolean;
}

/** 派发占位：input_settled 后按 committed 结算通知记账。 */
interface Materialization {
	readonly text: string;
	readonly notified: ReadonlyMap<string, number>;
	readonly followUpRefs: readonly string[];
	readonly operationRefs: readonly string[];
}

interface Placeholder {
	readonly inputId: string;
	result: Materialization | null;
	failed: boolean;
	settled: boolean;
}

export class QqScheduler {
	private stopped = false;
	private readonly pending = new Map<string, PendingCandidate>();
	private placeholder: Placeholder | null = null;
	private retryDelivery: { candidate: PendingCandidate; result: Materialization } | null = null;
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** 每个候选窗口的首条到达时刻（maxWait 自此起算）。 */
	private readonly windowStart = new Map<string, number>();
	private recheckTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly accounting = new Map<string, Materialization>();
	private failure: string | null = null;
	/** 已处理过的暂停到期事件（target:pausedUntil）；进程内存续，重启至多重放一次摘要（偏差登记）。 */
	private readonly processedPauseExpiries = new Set<string>();
	/** R1 退让后挂起跟读的会话：待处理缓冲回落预算内自动解除。 */
	private readonly suspendedFollow = new Set<string>();
	/** 迟到回执升级的 unknown 操作（ref → record）；committed 后清理，retired 保留待重提醒。 */
	private readonly settledUnknowns = new Map<string, OperationRecord>();

	constructor(
		private readonly deps: SchedulerDeps,
		private readonly timing: TimingWindows = DEFAULT_TIMING,
	) {}

	get pendingCandidates(): PendingCandidate[] {
		return [...this.pending.values()].sort((a, b) => a.oldestAt.localeCompare(b.oldestAt));
	}

	get inFlight(): string | null {
		return this.placeholder?.inputId ?? null;
	}

	/** World 停止：取消全部窗口与 recheck，不再产生新机会。 */
	stop(): void {
		this.stopped = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.windowStart.clear();
		if (this.recheckTimer) clearTimeout(this.recheckTimer);
		this.recheckTimer = null;
		this.pending.clear();
		this.accounting.clear();
		this.suspendedFollow.clear();
		this.placeholder = null;
		this.retryDelivery = null;
	}

	/** 摄取层每追加一条事实后调用；不等待、不抛错。 */
	onFact(item: IngestedFact): void {
		if (this.stopped) return;
		try {
			for (const candidate of this.classify(item))
				this.offer(item.kind === "message" ? { ...candidate, messageRefs: [item.fact.ref] } : candidate);
		} catch (error) {
			// 单条事实分类失败不阻断摄取主链，但必须留可见痕迹（静默=永远不提醒）。
			console.warn(`[qq] 事实分类失败（kind=${item.kind}）:`, error instanceof Error ? error.message : error);
		}
	}

	private classify(item: IngestedFact): PendingCandidate[] {
		const { selfId, control } = this.deps;
		if (item.kind === "message") {
			const fact = item.fact;
			if (fact.direction === "out") return []; // self 回送：与真实回执归并，不自动唤醒
			const parsed = parseConversationRef(fact.conversationRef);
			if (!parsed) return [];
			const { kind } = parsed;
			const push = control.effectivePush(fact.conversationRef);
			if (push.mode === "off") return []; // 静默/暂停：事实仍可查
			// 跟读直读（§5.4）：effectiveFollow 命中 → 正文流派发（与通知轨分轨）。
			// R1 退让挂起中且缓冲仍超预算 → 静默记账；回落预算内自动解除挂起。
			if (this.deps.attention.effectiveFollow(fact.conversationRef)) {
				if (this.suspendedFollow.has(fact.conversationRef)) {
					if (!followPressure(this.deps.journal, control, fact.conversationRef)) {
						this.suspendedFollow.delete(fact.conversationRef);
					} else return [];
				}
				return [this.makeCandidate(fact.conversationRef, "follow", fact.time, 1)];
			}
			const replySelf = fact.replyTo !== undefined && this.isOwnMessage(fact.replyTo);
			const pendingBefore = this.pendingCount(fact.conversationRef) - 1;
			if (kind !== "group") {
				// 私聊/temp：0→1 或 沉寂复苏 穿透；持续闲聊静默记账（§5.1 规则②③）。
				if (replySelf) return [this.makeCandidate(fact.conversationRef, "direct", fact.time, 1, "reply_self")];
				if (push.filter === "direct") return []; // filter=direct：仅直接互动（复苏亦不放行，偏差登记）
				if (pendingBefore === 0) return [this.makeCandidate(fact.conversationRef, "direct", fact.time, 1, "private")];
				if (this.isRevival(fact)) {
					return [this.makeCandidate(fact.conversationRef, "direct", fact.time, 1, "revival")];
				}
				return [];
			}
			// 群：@self / 引用自身 → 直接互动特许穿透，无视 filter（§5.1 规则②）。
			const atSelf = fact.segments.some(
				(seg) => seg.type === "mention_all" || (seg.type === "mention" && seg.userRef === userRef(selfId)),
			);
			if (atSelf || replySelf) {
				return [this.makeCandidate(fact.conversationRef, "direct", fact.time, 1, atSelf ? "at_self" : "reply_self")];
			}
			// 群聊仅 0→1 触发一次全局态势纸条；增量闲聊静默记账（§5.1 规则④）。
			if (push.filter === "direct") return [];
			if (pendingBefore === 0) return [this.makeCandidate(fact.conversationRef, "ordinary", fact.time, 1)];
			return [];
		}
		if (item.kind === "event") {
			const fact = item.fact;
			if (fact.kind === "poke" && fact.targetRef === userRef(selfId)) {
				const push = control.effectivePush(fact.conversationRef ?? "account");
				if (push.mode === "off") return [];
				// 群 poke 携带会话现场；好友 poke 从 actor（对方）推导私聊会话——fact 字段已知，非猜测。
				const convRef = fact.conversationRef ?? this.privateRefFromActor(fact.actorRef);
				if (!convRef) return [];
				return [{ ...this.makeCandidate(convRef, "direct", fact.time, 1, "poke"), eventRefs: [fact.ref] }];
			}
			if (fact.kind === "recall" && fact.conversationRef) {
				const push = control.effectivePush(fact.conversationRef);
				if (push.mode === "off") return [];
				// 合同 §4：仅"影响当前交互或事项证据"的 recall 允许提醒；判定注入，缺省不唤醒。
				if (!this.deps.isRecallRelevant?.(fact)) return [];
				return [
					{ ...this.makeCandidate(fact.conversationRef, "direct", fact.time, 1, "recall"), eventRefs: [fact.ref] },
				];
			}
			if (fact.kind === "bot_status" || fact.kind === "bot_offline") {
				// 入站表：bot_status/offline 属平台事实，origin=external；连接故障与恢复由装配层状态机放行。
				return [
					{
						...this.makeCandidate("qq-event-account", "internal", fact.time, 1, undefined, "external"),
						eventRefs: [fact.ref],
					},
				];
			}
			if (fact.kind === "transport_disconnected" || fact.kind === "transport_recovered") {
				// 一次性语义（只报一次/恢复只对已报故障）由装配层的 onStatus 状态机保证；
				// 调度器只负责把已放行的事实变成 internal 候选。
				return [{ ...this.makeCandidate("qq-event-account", "internal", fact.time, 1), eventRefs: [fact.ref] }];
			}
			return []; // 一般成员变化/reaction/profile_like 保存可查，不默认唤醒
		}
		// request：好友申请与已确认目标群邀请允许提醒。
		const fact = item.fact;
		if (fact.state !== "pending" || this.deps.isRequestPending?.(fact.ref) === false) return [];
		if (fact.kind === "friend" || (fact.kind === "group_invite" && fact.targetConversationRef !== undefined)) {
			if (control.effectivePush("account").mode === "off") return [];
			return [
				{
					...this.makeCandidate(fact.targetConversationRef ?? "qq-request-account", "request", fact.time, 1),
					requestRefs: [fact.ref],
				},
			];
		}
		return [];
	}

	/**
	 * 消费位置（§6.4）：max(throughSeq 正文派发书签, 冷启动基线)。基线即书签的初始对齐值；
	 * 通知纸条只呈现态势、不推进消费位——通知轨与消费轨严格分轨（§2）。
	 * 0→1 触发以此为准：会话此前待处理清空（pendingCount-1===0）才触发首批纸条。
	 */
	private pendingCount(conversationRef: string): number {
		return pendingCountOf(this.deps.journal, this.deps.control, conversationRef);
	}

	/** 通知呈现新鲜度（lastNotifiedSeq 口径）：派发前重验"还有没有可呈现的新内容"。 */
	private noticeFreshCount(conversationRef: string): number {
		const baseline = this.deps.control.baselineOf(conversationRef) ?? 0;
		const through = Math.max(this.deps.journal.snapshot.notifiedThrough.get(conversationRef) ?? 0, baseline);
		let count = 0;
		for (const m of this.deps.journal.snapshot.messages.get(conversationRef) ?? []) {
			if (
				m.direction === "in" &&
				m.sequence > Math.max(through, consumptionThrough(this.deps.journal, this.deps.control, conversationRef))
			)
				count++;
		}
		return count;
	}

	/** 私聊沉寂复苏（§5.1 规则③）：当前消息与上一条消息间隔 ≥ REVIVAL_SILENCE_MS。 */
	private isRevival(fact: MessageFact): boolean {
		const list = this.deps.journal.snapshot.messages.get(fact.conversationRef) ?? [];
		const prev = list.length >= 2 ? list[list.length - 2] : undefined;
		if (!prev) return false;
		return Date.parse(fact.time) - Date.parse(prev.time) >= REVIVAL_SILENCE_MS;
	}

	private isOwnMessage(ref: string): boolean {
		const fact = this.deps.journal.getMessage(ref);
		return fact?.direction === "out";
	}

	/** 好友 poke 无会话现场：从 actor（对方）推导私聊会话 ref；actor 缺失或是自己则放弃唤醒。 */
	private privateRefFromActor(actorRef: string | undefined): string | undefined {
		if (!actorRef) return undefined;
		const parsed = parseUserRef(actorRef);
		if (!parsed || parsed.uin === this.deps.selfId) return undefined;
		return conversationRef("private", parsed.uin);
	}

	/** 候选是否仅由会话消息派生（无自身载荷，空转即无意义）。 */
	private isMessageDerived(candidate: PendingCandidate): boolean {
		if (candidate.eventRefs?.length || candidate.requestRefs?.length) return false;
		if (candidate.cls === "ordinary" || candidate.cls === "follow") return true;
		if (candidate.cls === "direct") return candidate.trigger !== "poke" && candidate.trigger !== "recall";
		return false;
	}

	private makeCandidate(
		conversationRef: string,
		cls: CandidateClass,
		time: string,
		count: number,
		trigger?: PendingCandidate["trigger"],
		origin?: PendingCandidate["origin"],
	): PendingCandidate {
		return {
			key: `${cls}:${conversationRef}`,
			conversationRef,
			cls,
			oldestAt: time,
			count,
			trigger,
			origin: origin ?? (cls === "internal" ? "internal" : "external"),
		};
	}

	notifyConsumption(conversationRef: string): void {
		if (this.stopped || followPressure(this.deps.journal, this.deps.control, conversationRef)) return;
		this.suspendedFollow.delete(conversationRef);
		if (this.deps.attention.effectiveFollow(conversationRef) && this.pendingCount(conversationRef) > 0) {
			this.offer(this.makeCandidate(conversationRef, "follow", this.deps.now(), this.pendingCount(conversationRef)));
		}
	}

	/** 装配层轮询 dueFollowUps 后调用；到期事项走 internal 候选，派发成功即计账。 */
	notifyFollowUpDue(): void {
		if (this.stopped) return;
		const due = this.deps.control.dueFollowUps();
		if (due.length === 0) return;
		this.offer(this.makeCandidate("qq-follow-ups", "internal", this.deps.now(), due.length));
	}

	/**
	 * 控制状态 tick（装配层 60s 轮询）：暂停到期摘要 + follow_up 到期。
	 * 暂停结束固定恢复原规则并给一次允许的积压摘要（一次摘要，不逐条 replay；
	 * 无积压不制造回合，事实优先由 select() 的 direct > internal 顺序天然满足）。
	 */
	notifyControlTick(): void {
		if (this.stopped) return;
		for (const expiry of this.deps.control.expiredPauses()) {
			const key = `${expiry.target}:${expiry.pausedUntil}`;
			if (this.processedPauseExpiries.has(key)) continue;
			this.processedPauseExpiries.add(key);
			if (
				pendingConversations(this.deps.journal, this.deps.control).some(
					(ref) => expiry.target === "account" || ref === expiry.target,
				)
			) {
				this.offer(this.makeCandidate("qq-backlog", "internal", this.deps.now(), 1));
			}
		}
		this.notifyFollowUpDue();
	}

	/** 迟到回执把 unknown 升级为确定结论后调用（入站表：同 operation 更新，无新派发 | internal）。 */
	notifyOperationSettled(record: OperationRecord): void {
		if (this.stopped) return;
		this.settledUnknowns.set(record.ref, record);
		this.offer(this.makeCandidate("qq-operations", "internal", this.deps.now(), 1));
	}

	/** 渲染层消费：当前待呈现的已升级操作。 */
	listSettledUnknowns(): OperationRecord[] {
		return [...this.settledUnknowns.values()];
	}

	/**
	 * 窗口语义（交互合同 §4 初值）：quiet = 自最近一次事实到达的去抖；
	 * maxWait = 自窗口首条事实起算的上限，防止持续聊天永不结束窗口。
	 * 占位占用时不设窗口（候选只保留，结算后统一重选）。
	 */
	private offer(candidate: PendingCandidate): void {
		if (this.stopped) return;
		const existing = this.pending.get(candidate.key);
		if (existing) {
			// 合并：普通候选累加计数；direct 只保留最老到达时间。
			this.pending.set(candidate.key, {
				...existing,
				count: existing.cls === "ordinary" ? existing.count + candidate.count : existing.count,
				eventRefs: [...new Set([...(existing.eventRefs ?? []), ...(candidate.eventRefs ?? [])])],
				messageRefs: [...new Set([...(existing.messageRefs ?? []), ...(candidate.messageRefs ?? [])])],
				requestRefs: [...new Set([...(existing.requestRefs ?? []), ...(candidate.requestRefs ?? [])])],
			});
		} else {
			this.pending.set(candidate.key, candidate);
		}
		this.scheduleWindow(candidate.key);
	}

	private windowFor(candidate: PendingCandidate): readonly [number, number] {
		switch (candidate.cls) {
			case "follow":
			case "direct":
			case "ordinary":
				return this.timing.pulse;
			case "request":
				return this.timing.request;
			case "internal":
				return this.timing.internal;
		}
	}

	private scheduleWindow(key: string): void {
		const candidate = this.pending.get(key);
		if (!candidate || this.placeholder) return;
		const [quiet, maxWait] = this.windowFor(candidate);
		const nowMs = Date.parse(this.deps.now());
		const startMs = this.windowStart.get(key) ?? nowMs;
		this.windowStart.set(key, startMs);
		// maxWait 封顶：距首条超过上限立即到期，否则重置去抖窗口。
		const waitMs = Math.max(0, Math.min(quiet, startMs + maxWait - nowMs));
		const existing = this.timers.get(key);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.timers.delete(key);
			this.windowStart.delete(key);
			void this.tryDispatch();
		}, waitMs);
		this.timers.set(key, timer);
	}

	/** Release first: a failed local append must never hold the mailbox placeholder. */
	onInputSettled(inputId: string, committed: boolean): void {
		if (this.stopped || this.placeholder?.inputId !== inputId) return;
		const slot = this.placeholder;
		slot.settled = true;
		this.placeholder = null;
		if (committed && slot.result) this.accounting.set(inputId, slot.result);
		this.flushAccounting();
		if (slot.failed || this.accounting.size > 0) this.retry(this.failure ?? "notification accounting/render");
		else void this.tryDispatch();
	}

	private retry(reason: string): void {
		if (this.stopped) return;
		if (this.failure !== reason) console.warn(`[qq] 通知待重试：${reason}`);
		this.failure = reason;
		if (this.recheckTimer) return;
		this.recheckTimer = setTimeout(() => {
			this.recheckTimer = null;
			if (this.stopped) return;
			this.flushAccounting();
			if (this.accounting.size > 0) this.retry(this.failure ?? "notification accounting");
			else {
				void this.tryDispatch();
			}
		}, 2000);
	}

	private flushAccounting(): void {
		const hadAccounting = this.accounting.size > 0;
		for (const [inputId, result] of this.accounting) {
			try {
				for (const [conv, through] of result.notified) {
					if (through > (this.deps.journal.snapshot.notifiedThrough.get(conv) ?? 0)) {
						this.deps.journal.recordNotified(conv, through, inputId, this.deps.now());
					}
				}
				for (const ref of result.followUpRefs) {
					const item = this.deps.control.getFollowUp(ref);
					if (item?.state === "open" && !item.reviewNotified) this.deps.control.markReviewNotified(ref);
				}
				for (const ref of result.operationRefs) this.settledUnknowns.delete(ref);
				this.accounting.delete(inputId);
			} catch (error) {
				this.retry(error instanceof Error ? error.message : String(error));
			}
		}
		if (hadAccounting && this.accounting.size === 0) this.failure = null;
	}

	private current(candidate: PendingCandidate): PendingCandidate | null {
		const conv = candidate.conversationRef;
		const push = this.deps.control.effectivePush(conv);
		if (push.mode === "off") return null;
		if (candidate.cls === "follow" && !this.deps.attention.effectiveFollow(conv)) return null;
		if (candidate.cls === "ordinary" && push.filter === "direct") return null;
		if (
			candidate.cls === "direct" &&
			push.filter === "direct" &&
			(candidate.trigger === "private" || candidate.trigger === "revival")
		)
			return null;
		if (conv === "qq-follow-ups" && this.deps.control.dueFollowUps().length === 0) return null;
		if (conv === "qq-operations" && this.settledUnknowns.size === 0) return null;
		if (conv === "qq-backlog" && pendingConversations(this.deps.journal, this.deps.control).length === 0) return null;
		if (candidate.requestRefs?.length) {
			const refs = candidate.requestRefs.filter((ref) => this.deps.isRequestPending?.(ref) !== false);
			return refs.length > 0 ? { ...candidate, requestRefs: refs } : null;
		}
		if (
			this.isMessageDerived(candidate) &&
			(this.pendingCount(conv) === 0 || (candidate.cls !== "follow" && this.noticeFreshCount(conv) === 0))
		)
			return null;
		return candidate;
	}

	private async materialize(slot: Placeholder): Promise<string | null> {
		if (this.stopped || this.deps.signal?.aborted) return null;
		if (slot.result) return slot.result.text;
		const follow = [...this.pending.values()].find(
			(candidate) => candidate.cls === "follow" && this.current(candidate),
		);
		if (follow)
			return this.deps.locks.run(follow.conversationRef, async () =>
				this.buildMaterialization(slot, follow.conversationRef),
			);
		return this.buildMaterialization(slot);
	}

	/** No awaits: the payload and accounting references come from the same snapshot. */
	private buildMaterialization(slot: Placeholder, lockedConversation?: string): string | null {
		if (this.stopped || this.deps.signal?.aborted) return null;
		if (slot.result) return slot.result.text;
		const captured = [...this.pending.values()];
		const current = captured.flatMap((candidate) => {
			const valid = this.current(candidate);
			if (!valid && this.pending.get(candidate.key) === candidate) this.pending.delete(candidate.key);
			return valid ? [valid] : [];
		});
		const notices = current.filter((candidate) => candidate.cls !== "follow");
		notices.sort(
			(a, b) => Number(b.cls === "direct") - Number(a.cls === "direct") || a.oldestAt.localeCompare(b.oldestAt),
		);
		const follow = current.find(
			(candidate) => candidate.cls === "follow" && candidate.conversationRef === lockedConversation,
		);
		const handled = new Set(notices.map((candidate) => candidate.key));
		const notified = new Map<string, number>();
		const parts: string[] = [];
		if (notices.length > 0) {
			parts.push(this.deps.renderBatch({ ...notices[0]!, related: notices }));
			for (const conv of pendingConversations(this.deps.journal, this.deps.control)) {
				const last = pendingFacts(this.deps.journal, this.deps.control, conv).at(-1);
				if (last) notified.set(conv, last.sequence);
			}
		}
		const followUpRefs = notices.some((candidate) => candidate.conversationRef === "qq-follow-ups")
			? this.deps.control.dueFollowUps().map((item) => item.ref)
			: [];
		const operationRefs = notices.some((candidate) => candidate.conversationRef === "qq-operations")
			? [...this.settledUnknowns.keys()]
			: [];
		let window: ReadWindowResult | undefined;
		if (follow) {
			const conv = follow.conversationRef;
			if (followPressure(this.deps.journal, this.deps.control, conv)) {
				this.suspendedFollow.add(conv);
				parts.push(
					`[QQ 动态提示] ${conv} 缓冲超过 30 条或 14,000 字符；自动正文已暂停灌注。主动阅读：${JSON.stringify({ action: "read", params: { conversationRef: conv } })}`,
				);
				if (notices.length === 0) parts.push(this.deps.renderBatch({ ...follow, cls: "ordinary" }));
			} else {
				this.suspendedFollow.delete(conv);
				window = this.deps.renderReadWindow(conv);
				if (window.delivered.length > 0) {
					parts.push(window.text.replace("[QQ 阅读]", "[QQ 跟读]"));
					notified.set(conv, window.deliveredThrough);
				}
			}
			handled.add(follow.key);
		}
		if (parts.length === 0) return null;
		const result: Materialization = { text: parts.join("\n"), notified, followUpRefs, operationRefs };
		if (follow && window && window.delivered.length > 0) {
			this.deps.journal.recordDispatched(
				follow.conversationRef,
				window.deliveredThrough,
				"follow",
				this.deps.now(),
				slot.inputId,
			);
			if (window.remaining > 0)
				this.pending.set(follow.key, { ...follow, count: window.remaining, oldestAt: this.deps.now() });
		}
		slot.result = result;
		for (const candidate of captured) {
			if (handled.has(candidate.key) && this.pending.get(candidate.key) === candidate)
				this.pending.delete(candidate.key);
		}
		return result.text;
	}

	private async tryDispatch(): Promise<void> {
		if (this.stopped || this.placeholder || this.recheckTimer || (this.pending.size === 0 && !this.retryDelivery))
			return;
		for (const candidate of this.pending.values()) if (!this.current(candidate)) this.pending.delete(candidate.key);
		const replay = this.retryDelivery;
		const candidate = replay?.candidate ?? this.select();
		if (!candidate) return;
		const slot: Placeholder = {
			inputId: `qq:${randomUUID()}`,
			result: replay?.result ?? null,
			failed: false,
			settled: false,
		};
		this.retryDelivery = null;
		this.placeholder = slot;
		try {
			await this.deps.emit({
				id: slot.inputId,
				conversationRef: candidate.conversationRef,
				cls: candidate.cls,
				origin: candidate.origin,
				render: async () => {
					try {
						return await this.materialize(slot);
					} catch (error) {
						slot.failed = true;
						this.retry(error instanceof Error ? error.message : String(error));
						return null;
					}
				},
			});
		} catch (error) {
			if (this.stopped || slot.settled) return;
			if (this.placeholder === slot) this.placeholder = null;
			if (slot.result) this.retryDelivery = { candidate, result: slot.result };
			this.retry(error instanceof Error ? error.message : String(error));
		}
	}

	/** 选择：跟读（主体正注视的窗口）> direct > request > internal > ordinary；同类按等待年龄。 */
	private select(): PendingCandidate | null {
		const candidates = this.pendingCandidates;
		const byAge = (a: PendingCandidate, b: PendingCandidate): number => a.oldestAt.localeCompare(b.oldestAt);
		for (const cls of ["follow", "direct", "request", "internal", "ordinary"] as const) {
			const matching = candidates.filter((candidate) => candidate.cls === cls);
			if (matching.length > 0) return matching.sort(byAge)[0] ?? null;
		}
		return null;
	}
}
