import { parseConversationRef, parseUserRef, userRef, conversationRef } from "./types.js";
import type { FactsJournal } from "./facts-journal.js";
import type { ControlStore } from "./control-store.js";
import type { AttentionModel } from "./attention.js";
import type { ConversationLocks } from "./conversation-lock.js";
import type { EventFact, IngestedFact, MessageFact, OperationRecord } from "./types.js";

/**
 * 通知与跟读调度（设计 §5.1/§5.3/§5.4）：
 * - 统一 1~2s 短脉冲防抖（打字喘气合并）；request/internal 保留独立窗口。
 * - 触发判定（纯物理事实）：① 首次未读 0→1（消费位口径）；② 直接互动（@/戳/引用自身/相关 recall）特许穿透；
 *   ③ 私聊沉寂复苏（与上一条消息间隔 ≥10min）；④ 群聊增量闲聊静默记账绝不催更。
 * - 跟读（follow）：effectiveFollow 命中走正文直读派发，与通知轨分轨；锁内渲染并推进
 *   dispatchedThrough 书签；缓冲超预算自动退让为降压摘要并挂起（R1，唯一权威 = 消费位缓冲深度）。
 * - 延迟渲染（§5.3）：派发只投唤醒占位 + render 闭包；出队时才求值最新快照，已清空返回 null
 *   由 Core empty_render 退役（T12）；闭包永不抛出（R7）。
 * - 通知路径只消费 push 偏好（R5：不双读旧 attention 字段）；mode off / 暂停即静默，
 *   filter "direct" 只放行直接互动类。
 * - 通知基准 = max(lastNotifiedSeq, 冷启动基线)；消费位 = max(dispatchedThrough, 基线)。两轨分离（§2）。
 * - 单占位串行；飞行期间到达的消息不补发纸条（群静默/私聊靠复苏穿透，T01A 规则的必然推论）。
 */

/** 私聊沉寂复苏间隔（设计 §5.1：客观时间阈值，摒弃意图分析）。 */
export const REVIVAL_SILENCE_MS = 600_000;
/** R1 过载退让阈值：未消费缓冲条数上限（约 14,000 字符或 30 条取先到）。 */
export const FOLLOW_BACKLOG_LIMIT = 30;

/* ---------- 消费位（§6.4 单一事实源：调度器、呈现层与消费工具共用） ---------- */

/** 消费位置 = max(throughSeq 正文派发书签, 冷启动基线)。基线即书签的初始对齐值。 */
export function consumptionThrough(
	journal: Pick<FactsJournal, "dispatchedThroughOf">,
	control: Pick<ControlStore, "baselineOf">,
	conversationRef: string,
): number {
	return Math.max(journal.dispatchedThroughOf(conversationRef), control.baselineOf(conversationRef) ?? 0);
}

/** 待处理条数（消费位口径）：通知纸条只呈现态势、不推进消费位——两轨分离（§2）。 */
export function pendingCountOf(
	journal: Pick<FactsJournal, "dispatchedThroughOf" | "snapshot">,
	control: Pick<ControlStore, "baselineOf">,
	conversationRef: string,
): number {
	const through = consumptionThrough(journal, control, conversationRef);
	return (journal.snapshot.messages.get(conversationRef) ?? []).filter((m) => m.sequence > through).length;
}

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
	readonly requestRefs?: readonly string[];
}

export interface SchedulerDeps {
	readonly selfId: string;
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
	readonly isBusy?: () => boolean;
	/** 通知批次正文渲染（呈现层唯一出口，render.ts 提供）。 */
	readonly renderBatch: (candidate: PendingCandidate) => string;
	/** 跟读正文流渲染（cls=follow 派发用；render.ts 提供）。 */
	readonly renderFollowBody: (conversationRef: string) => string;
	/**
	 * recall 是否"影响当前交互或事项证据"（合同 §4 只允许此类 recall 提醒）。
	 * 判定语义由装配层注入（自身发言被撤 / open 事项证据被撤 / 连续性窗口内最近批次）；
	 * 未注入时保守不提醒（事实保存可查）。
	 */
	readonly isRecallRelevant?: (fact: EventFact) => boolean;
	readonly isRequestPending?: (ref: string) => boolean;
}

/** 派发占位：input_settled 后按 committed 结算通知记账。 */
interface Placeholder {
	readonly inputId: string;
	readonly conversationRef: string;
	/**
	 * 冻结槽位：render 闭包求值成功时写入本批交付到的会话序号（§5.3 延迟渲染下
	 * 冻结点从 emit 时刻移至 render 求值时刻）；retired/未求值则保持 null 不记账。
	 */
	readonly throughSlot: { value: number } | null;
	/** follow_up 批次派发时渲染的到期事项；committed 后才计账（retired 允许重提醒）。 */
	readonly followUpRefs?: readonly string[];
	/** 迟到回执更新批次派发时呈现的操作；committed 后清理。 */
	readonly operationRefs?: readonly string[];
}

export class QqScheduler {
	private stopped = false;
	private readonly pending = new Map<string, PendingCandidate>();
	private placeholder: Placeholder | null = null;
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** 每个候选窗口的首条到达时刻（maxWait 自此起算）。 */
	private readonly windowStart = new Map<string, number>();
	private recheckTimer: ReturnType<typeof setTimeout> | null = null;
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
		this.suspendedFollow.clear();
		this.placeholder = null;
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
					if (this.pendingCount(fact.conversationRef) <= FOLLOW_BACKLOG_LIMIT) {
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
			if (m.sequence > through) count++;
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
		if (candidate.cls === "ordinary") return true;
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
			if (this.deps.journal.hasUnread()) {
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

	/** input_settled(committed/retired) 回调：释放占位并按冻结槽位推进通知位置。 */
	onInputSettled(inputId: string, committed: boolean): void {
		if (this.stopped) return;
		if (!this.placeholder || this.placeholder.inputId !== inputId) return;
		const { conversationRef, throughSlot, followUpRefs, operationRefs } = this.placeholder;
		if (committed && throughSlot) {
			// 只冻结在 render 求值时已交付的序号；出队后新到消息留给下一批，不偷记已通知。
			const through = this.deps.journal.snapshot.notifiedThrough.get(conversationRef) ?? 0;
			if (throughSlot.value > through) {
				this.deps.journal.recordNotified(conversationRef, throughSlot.value, inputId, this.deps.now());
			}
		}
		if (committed) {
			// follow_up 通知计账：committed 才算"已交给 canonical 输入"。
			for (const ref of followUpRefs ?? []) {
				const item = this.deps.control.getFollowUp(ref);
				if (item?.state === "open") this.deps.control.markReviewNotified(ref);
			}
			// 迟到回执更新：committed 后清理，retired 保留待重提醒。
			for (const ref of operationRefs ?? []) this.settledUnknowns.delete(ref);
		}
		this.placeholder = null;
		void this.tryDispatch();
	}

	/** agent_settled 通知：单个可取消 recheck（不 await Subject 空闲）。 */
	onAgentSettled(): void {
		if (this.stopped) return;
		if (this.recheckTimer || this.placeholder) return;
		this.recheckTimer = setTimeout(() => {
			this.recheckTimer = null;
			if (!this.placeholder && this.pending.size > 0 && !(this.deps.isBusy?.() ?? false)) {
				void this.tryDispatch();
			}
		}, 50);
	}

	/** 选择与派发：串行；占位占用直接返回。 */
	private async tryDispatch(): Promise<void> {
		if (this.stopped) return;
		if (this.placeholder || this.pending.size === 0) return;
		if (this.deps.isBusy?.() ?? false) return; // 忙时普通活动留在事实存储
		let candidate = this.select();
		if (!candidate) return;
		if (candidate.cls === "request" && candidate.requestRefs?.length) {
			const requestRefs = candidate.requestRefs.filter((ref) => this.deps.isRequestPending?.(ref) !== false);
			if (requestRefs.length === 0) {
				this.pending.delete(candidate.key);
				void this.tryDispatch();
				return;
			}
			candidate = { ...candidate, requestRefs };
		}
		const push = this.deps.control.effectivePush(candidate.conversationRef);
		if (push.mode === "off") {
			this.pending.delete(candidate.key);
			return;
		}
		// 消息派生候选派发前重验（消费位/呈现位双口径）：正文若已被其他批次交付并推进
		// 相应书签，空转候选直接退役，不产生空批次（poke/recall/request/internal 携带自身
		// 载荷，不受此限；follow 只看消费位——呈现位可能已被旧纸条推进但正文未消费）。
		if (this.isMessageDerived(candidate)) {
			const stale =
				candidate.cls === "follow"
					? this.pendingCount(candidate.conversationRef) === 0
					: this.pendingCount(candidate.conversationRef) === 0 ||
						this.noticeFreshCount(candidate.conversationRef) === 0;
			if (stale) {
				this.pending.delete(candidate.key);
				return;
			}
		}
		const inputId = `qq:${candidate.cls}:${candidate.conversationRef}:${this.deps.now()}`;
		const conv = candidate.conversationRef;
		this.pending.delete(candidate.key);
		// §5.3 延迟渲染：派发只投唤醒占位 + render 闭包；冻结槽位由闭包求值成功时写入，
		// retired/未求值不记账（T12 空退役、排队期间消费清空均落在同一条路径）。
		const throughSlot: { value: number } | null = conv.startsWith("qq-") ? null : { value: 0 };
		const render = async (): Promise<string | null> => {
			try {
				// 出队时刻新鲜度重验（T12）：排队期间已被 read/skip 消费或呈现完毕 → 空退役。
				if (this.isMessageDerived(candidate)) {
					const stale =
						candidate.cls === "follow"
							? this.pendingCount(conv) === 0
							: this.pendingCount(conv) === 0 || this.noticeFreshCount(conv) === 0;
					if (stale) return null;
				}
				if (candidate.cls === "follow") {
					// 锁内渲染 + 书签推进（§2.1）：与后续 qq_read/qq_skip 串行互斥，根绝重复派发。
					return await this.deps.locks.run(conv, async () => {
						const pending = this.pendingCount(conv);
						if (pending > FOLLOW_BACKLOG_LIMIT) {
							// R1 过载退让：切断连续正文灌注，转降压摘要；不动书签、不冻结槽位
							// （未交付的消息保持 pending 且未通知，恢复后仍可完整呈现）。
							this.suspendedFollow.add(conv);
							return `[QQ 动态提示] 关注会话 ${conv} 出现高频积压（${pending} 条未消费）；自动正文已暂停灌注。你可以主动调用 qq_read 阅读，或调用 qq_skip 放下积压。`;
						}
						const body = this.deps.renderFollowBody(conv);
						const through = this.deps.journal.latestSequence(conv);
						this.deps.journal.recordDispatched(conv, through, "follow", this.deps.now(), inputId);
						if (throughSlot) throughSlot.value = through;
						return body;
					});
				}
				const text = this.deps.renderBatch(candidate);
				if (throughSlot) throughSlot.value = this.deps.journal.latestSequence(conv);
				return text;
			} catch (error) {
				// R7：render 闭包永不向上抛（Core 对抛错的处理是条目回退邮箱无限重试）。
				console.warn(`[qq] 延迟渲染失败（${conv}）:`, error instanceof Error ? error.message : error);
				return null;
			}
		};
		try {
			// follow_up 到期：派发时先捕获渲染的到期列表，committed 结算后才计账——
			// retired/claimed 不标记，轮询自然重新提醒（合同：记录失败允许以后重复提醒）。
			const followUpRefs =
				conv === "qq-follow-ups" ? this.deps.control.dueFollowUps().map((item) => item.ref) : undefined;
			const operationRefs = conv === "qq-operations" ? [...this.settledUnknowns.keys()] : undefined;
			this.placeholder = {
				inputId,
				conversationRef: conv,
				throughSlot,
				...(followUpRefs ? { followUpRefs } : {}),
				...(operationRefs ? { operationRefs } : {}),
			};
			await this.deps.emit({ id: inputId, conversationRef: conv, cls: candidate.cls, origin: candidate.origin, render });
		} catch (error) {
			if (this.stopped) return;
			// 投递/渲染失败：释放占位并恢复候选（合同：允许以后重复提醒）；
			// 确定性渲染 bug 会以窗口节奏重试并持续留可见痕迹，不静默丢失。
			console.warn(
				`[qq] 批次投递失败（${candidate.conversationRef}）:`,
				error instanceof Error ? error.message : error,
			);
			this.placeholder = null;
			this.offer(candidate);
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
