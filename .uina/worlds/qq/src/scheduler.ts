import { parseConversationRef, parseUserRef, userRef, conversationRef } from "./types.js";
import type { FactsJournal } from "./facts-journal.js";
import type { ControlStore } from "./control-store.js";
import type { AttentionModel } from "./attention.js";
import type { EventFact, IngestedFact, OperationRecord } from "./types.js";
import { pendingCountOf } from "./consumption.js";
import type { ReadWindowResult } from "./render.js";
import { randomUUID } from "node:crypto";

/**
 * 调度器（v3 哑手机）：世界零注意力政策，只剩"响/不响 + 去抖 + 合并"。
 * - ring 响铃：私聊/temp 消息、focused 会话的一切消息 → 交付整屏待读窗口并推进书签。
 * - tap 拍肩：群 @self / reply_self / poke / 相关 recall / 好友申请 → 单条交付，书签不动。
 * - internal 内部：follow_up 到期 / 连接状态 / bot_status / 迟到回执升级 → 一行式注记。
 * 单占位派发；批次内多候选合并，整会话预算封顶，装不下的留待下轮。
 * 记账（recordDispatched / markReviewNotified / settledUnknowns）只在 committed 后进行。
 */

/** 去抖窗口：自最近一次事实到达 quiet 毫秒派发；自窗口首条起 maxWait 封顶。 */
export const RING_WINDOW: readonly [number, number] = [1200, 2000];
/** 批次软预算（字符）：整会话粒度，超出留待下轮。 */
export const RING_BUDGET_CHARS = 14_000;

export type CandidateClass = "ring" | "tap" | "internal";

export interface PendingCandidate {
	readonly key: string;
	readonly conversationRef: string;
	readonly cls: CandidateClass;
	/** 同类按此排序（最老优先）。 */
	readonly oldestAt: string;
	/** 世界事件 origin（bot_status/offline 为 external，连接故障与内部 tick 为 internal）。 */
	readonly origin: "external" | "internal";
	/** 拍肩触发的消息引用（ring 不需要：窗口自书签推导）。 */
	readonly messageRefs?: readonly string[];
	readonly eventRefs?: readonly string[];
	readonly requestRefs?: readonly string[];
}

export interface SchedulerDeps {
	readonly selfId: string;
	readonly signal?: AbortSignal;
	readonly journal: FactsJournal;
	readonly control: ControlStore;
	readonly attention: AttentionModel;
	readonly now: () => string;
	/**
	 * 投递世界事件（emitEvent 包装 submitInput）；单占位由 scheduler 保证。
	 * render 为延迟求值闭包：Core 出队提交前才调用，never journaled；
	 * 返回 null 触发 empty_render 退役。调度器保证闭包永不抛出。
	 */
	readonly emit: (input: {
		id: string;
		conversationRef: string;
		cls: CandidateClass;
		origin: "external" | "internal";
		render: () => Promise<string | null>;
	}) => Promise<void>;
	/** 窗口正文渲染（响铃即开窗；render.ts 提供）。 */
	readonly renderRingWindow: (conversationRef: string) => ReadWindowResult;
	/** 拍肩与内部事件渲染（一行式/单条式，书签不动；render.ts 提供）。 */
	readonly renderCandidate: (candidate: PendingCandidate) => string;
	/** recall 是否"影响当前交互或事项证据"；未注入时保守不唤醒。 */
	readonly isRecallRelevant?: (fact: EventFact) => boolean;
	readonly isRequestPending?: (ref: string) => boolean;
}

/** 派发占位：input_settled 后按 committed 结算记账。 */
interface Materialization {
	readonly text: string;
	/** ring 候选的正文交付边界（committed 后 recordDispatched）。 */
	readonly dispatches: ReadonlyMap<string, number>;
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
	/** 迟到回执升级的 unknown 操作（ref → record）；committed 后清理。 */
	private readonly settledUnknowns = new Map<string, OperationRecord>();

	constructor(private readonly deps: SchedulerDeps) {}

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
		this.placeholder = null;
		this.retryDelivery = null;
	}

	/** 摄取层每追加一条事实后调用；不等待、不抛错。 */
	onFact(item: IngestedFact): void {
		if (this.stopped) return;
		try {
			for (const candidate of this.classify(item)) this.offer(candidate);
		} catch (error) {
			// 单条事实分类失败不阻断摄取主链，但必须留可见痕迹（静默=永远不提醒）。
			console.warn(`[qq] 事实分类失败（kind=${item.kind}）:`, error instanceof Error ? error.message : error);
		}
	}

	/** 到期事项走 internal 候选（控制 tick 轮询；启动即查一次）。 */
	notifyFollowUpDue(): void {
		if (this.stopped) return;
		if (this.deps.control.dueFollowUps().length === 0) return;
		this.offer(this.makeCandidate("qq-follow-ups", "internal", this.deps.now(), "internal"));
	}

	/** 控制状态 tick：follow_up 到期。暂停到期无特例——门铃自然恢复。 */
	notifyControlTick(): void {
		if (this.stopped) return;
		this.notifyFollowUpDue();
	}

	/** 迟到回执把 unknown 升级为确定结论后调用（internal；同 operation 更新，无新派发）。 */
	notifyOperationSettled(record: OperationRecord): void {
		if (this.stopped) return;
		this.settledUnknowns.set(record.ref, record);
		this.offer(this.makeCandidate("qq-operations", "internal", this.deps.now(), "internal"));
	}

	/** 渲染层消费：当前待呈现的已升级操作。 */
	listSettledUnknowns(): OperationRecord[] {
		return [...this.settledUnknowns.values()];
	}

	/* ---------- 分类：响 / 不响（世界唯一的"判断"，且全部是人也会被响的事） ---------- */

	private classify(item: IngestedFact): PendingCandidate[] {
		const { selfId, control, attention } = this.deps;
		if (item.kind === "message") {
			const fact = item.fact;
			if (fact.direction === "out") return []; // self 回送：不唤醒
			const parsed = parseConversationRef(fact.conversationRef);
			if (!parsed) return [];
			const focused = attention.isFocused(fact.conversationRef);
			if (parsed.kind !== "group") {
				// 私聊/temp：有人对你说话，说话即入耳（静音且不在场才不响）。
				if (!focused && control.effectivePush(fact.conversationRef).off) return [];
				return [this.makeCandidate(fact.conversationRef, "ring", fact.time, "external")];
			}
			// 群 = 场所：默认零注入；在场则一切消息入耳。
			if (focused) return [this.makeCandidate(fact.conversationRef, "ring", fact.time, "external")];
			if (control.effectivePush(fact.conversationRef).off) return [];
			const atSelf = fact.segments.some((seg) => seg.type === "mention" && seg.userRef === userRef(selfId));
			const replySelf = fact.replyTo !== undefined && this.isOwnMessage(fact.replyTo);
			if (atSelf || replySelf) {
				// 有人喊你的名字：拍肩，书签不动。
				return [
					this.makeCandidate(fact.conversationRef, "tap", fact.time, "external", { messageRefs: [fact.ref] }),
				];
			}
			return [];
		}
		if (item.kind === "event") {
			const fact = item.fact;
			if (fact.kind === "poke" && fact.targetRef === userRef(selfId)) {
				// 群 poke 携带会话现场；好友 poke 从 actor（对方）推导私聊会话——fact 字段已知，非猜测。
				const convRef = fact.conversationRef ?? this.privateRefFromActor(fact.actorRef);
				if (!convRef) return [];
				if (control.effectivePush(convRef).off) return [];
				return [this.makeCandidate(convRef, "tap", fact.time, "external", { eventRefs: [fact.ref] })];
			}
			if (fact.kind === "recall" && fact.conversationRef) {
				if (control.effectivePush(fact.conversationRef).off) return [];
				if (!this.deps.isRecallRelevant?.(fact)) return [];
				return [this.makeCandidate(fact.conversationRef, "tap", fact.time, "external", { eventRefs: [fact.ref] })];
			}
			if (fact.kind === "bot_status" || fact.kind === "bot_offline") {
				return [
					this.makeCandidate("qq-event-account", "internal", fact.time, "external", { eventRefs: [fact.ref] }),
				];
			}
			if (fact.kind === "transport_disconnected" || fact.kind === "transport_recovered") {
				// 一次性语义（只报一次/恢复只对已报故障）由装配层 onStatus 状态机保证。
				return [
					this.makeCandidate("qq-event-account", "internal", fact.time, "internal", { eventRefs: [fact.ref] }),
				];
			}
			return []; // 一般成员变化/reaction/profile_like 保存可查，不默认唤醒
		}
		const fact = item.fact;
		if (fact.state !== "pending" || this.deps.isRequestPending?.(fact.ref) === false) return [];
		if (fact.kind === "friend" || (fact.kind === "group_invite" && fact.targetConversationRef !== undefined)) {
			if (control.effectivePush("account").off) return [];
			return [
				this.makeCandidate(fact.targetConversationRef ?? "qq-request-account", "tap", fact.time, "external", {
					requestRefs: [fact.ref],
				}),
			];
		}
		return [];
	}

	private makeCandidate(
		conversationRef: string,
		cls: CandidateClass,
		time: string,
		origin: "external" | "internal",
		refs?: { messageRefs?: readonly string[]; eventRefs?: readonly string[]; requestRefs?: readonly string[] },
	): PendingCandidate {
		return {
			key: `${cls}:${conversationRef}`,
			conversationRef,
			cls,
			oldestAt: time,
			origin,
			...(refs?.messageRefs?.length ? { messageRefs: refs.messageRefs } : {}),
			...(refs?.eventRefs?.length ? { eventRefs: refs.eventRefs } : {}),
			...(refs?.requestRefs?.length ? { requestRefs: refs.requestRefs } : {}),
		};
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

	/* ---------- 窗口、合并与派发 ---------- */

	private offer(candidate: PendingCandidate): void {
		if (this.stopped) return;
		const existing = this.pending.get(candidate.key);
		if (existing) {
			this.pending.set(candidate.key, {
				...existing,
				oldestAt: existing.oldestAt <= candidate.oldestAt ? existing.oldestAt : candidate.oldestAt,
				messageRefs: [...new Set([...(existing.messageRefs ?? []), ...(candidate.messageRefs ?? [])])],
				eventRefs: [...new Set([...(existing.eventRefs ?? []), ...(candidate.eventRefs ?? [])])],
				requestRefs: [...new Set([...(existing.requestRefs ?? []), ...(candidate.requestRefs ?? [])])],
			});
		} else {
			this.pending.set(candidate.key, candidate);
		}
		this.scheduleWindow(candidate.key);
	}

	private scheduleWindow(key: string): void {
		const candidate = this.pending.get(key);
		if (!candidate || this.placeholder) return;
		const nowMs = Date.parse(this.deps.now());
		const startMs = this.windowStart.get(key) ?? nowMs;
		this.windowStart.set(key, startMs);
		// maxWait 封顶：距首条超过上限立即到期，否则重置去抖窗口。
		const waitMs = Math.max(0, Math.min(RING_WINDOW[0], startMs + RING_WINDOW[1] - nowMs));
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
		if (slot.failed || this.accounting.size > 0) this.retry(this.failure ?? "ring accounting/render");
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
			if (this.accounting.size > 0) this.retry(this.failure ?? "ring accounting");
			else void this.tryDispatch();
		}, 2000);
	}

	private flushAccounting(): void {
		const hadAccounting = this.accounting.size > 0;
		for (const [inputId, result] of this.accounting) {
			try {
				for (const [conv, through] of result.dispatches) {
					if (through > this.deps.journal.dispatchedThroughOf(conv)) {
						this.deps.journal.recordDispatched(conv, through, "ring", this.deps.now(), inputId);
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

	/** 派发前重验：静音（focus 例外）、窗口空、事项已结、申请已处理 → 静默退役。 */
	private current(candidate: PendingCandidate): PendingCandidate | null {
		const { control, attention } = this.deps;
		const focused = attention.isFocused(candidate.conversationRef);
		if (candidate.cls === "internal") {
			if (candidate.conversationRef === "qq-follow-ups" && control.dueFollowUps().length === 0) return null;
			if (candidate.conversationRef === "qq-operations" && this.settledUnknowns.size === 0) return null;
			return candidate;
		}
		const push = control.effectivePush(candidate.conversationRef);
		if (push.off && !focused) return null;
		if (candidate.cls === "ring" && pendingCountOf(this.deps.journal, control, candidate.conversationRef) === 0) {
			return null;
		}
		if (candidate.requestRefs?.length) {
			const refs = candidate.requestRefs.filter((ref) => this.deps.isRequestPending?.(ref) !== false);
			return refs.length > 0 ? { ...candidate, requestRefs: refs } : null;
		}
		return candidate;
	}

	private async materialize(slot: Placeholder): Promise<string | null> {
		if (this.stopped || this.deps.signal?.aborted) return null;
		if (slot.result) return slot.result.text;
		return this.buildMaterialization(slot);
	}

	/** No awaits: payload and accounting references come from the same snapshot. */
	private buildMaterialization(slot: Placeholder): string | null {
		if (this.stopped || this.deps.signal?.aborted) return null;
		if (slot.result) return slot.result.text;
		const captured = [...this.pending.values()];
		const valid: PendingCandidate[] = [];
		for (const candidate of captured) {
			const checked = this.current(candidate);
			if (!checked) {
				if (this.pending.get(candidate.key) === candidate) this.pending.delete(candidate.key);
			} else valid.push(checked);
		}
		valid.sort((a, b) => this.rank(a) - this.rank(b) || a.oldestAt.localeCompare(b.oldestAt));
		const parts: string[] = [];
		const dispatches = new Map<string, number>();
		const followUpRefs: string[] = [];
		const operationRefs: string[] = [];
		const handled = new Set<string>();
		for (const candidate of valid) {
			let text: string;
			if (candidate.cls === "ring") {
				const window = this.deps.renderRingWindow(candidate.conversationRef);
				if (window.delivered.length === 0) {
					handled.add(candidate.key);
					continue;
				}
				text = window.text;
				dispatches.set(
					candidate.conversationRef,
					Math.max(dispatches.get(candidate.conversationRef) ?? 0, window.deliveredThrough),
				);
			} else {
				text = this.deps.renderCandidate(candidate);
			}
			if (parts.length > 0 && [...parts, text].join("\n").length > RING_BUDGET_CHARS) break; // 整会话留待下轮
			parts.push(text);
			handled.add(candidate.key);
			if (candidate.conversationRef === "qq-follow-ups") {
				followUpRefs.push(...this.deps.control.dueFollowUps().map((item) => item.ref));
			}
			if (candidate.conversationRef === "qq-operations") operationRefs.push(...this.settledUnknowns.keys());
		}
		if (parts.length === 0) return null;
		const result: Materialization = { text: parts.join("\n"), dispatches, followUpRefs, operationRefs };
		slot.result = result;
		for (const key of handled) this.pending.delete(key);
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

	/** 批次装配顺序：内部注记 → 私聊响铃 → 拍肩 → 群/focus 响铃；同类按等待年龄。 */
	private rank(candidate: PendingCandidate): number {
		if (candidate.cls === "internal") return 0;
		if (candidate.cls === "tap") return 2;
		const parsed = parseConversationRef(candidate.conversationRef);
		return parsed?.kind === "group" ? 3 : 1;
	}

	private select(): PendingCandidate | null {
		const candidates = this.pendingCandidates;
		if (candidates.length === 0) return null;
		return (
			[...candidates].sort((a, b) => this.rank(a) - this.rank(b) || a.oldestAt.localeCompare(b.oldestAt))[0] ?? null
		);
	}
}
