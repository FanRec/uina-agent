import type { FactsJournal } from "./facts-journal.js";
import type { ControlStore } from "./control-store.js";
import type { EventFact, MessageFact, OperationRecord, RequestFact } from "./types.js";

/**
 * 朴素调度（设计 §4.1/4.2）：候选从事实与控制状态派生，单占位，串行选择。
 * - 同一会话普通事实合并为普通候选；direct 类候选不合并计数但同类按等待年龄排序。
 * - silent/pause 禁止自动机会（显式工具不受限）；direct_only 只允许 direct。
 * - preferred 只获得"提前一个普通合并窗口"的有限偏置；没有轮转或概率。
 * - ordinary A 已排队（占位）时新 Direct B 只保留候选，A 结算后下一提交优先 B。
 * - busy recheck：agent_settled 只通知待检查；在派发之外用单个可取消 recheck，
 *   绝不在回调内等待 Subject 空闲。
 */

export interface TimingWindows {
	/** direct 候选（私聊/temp/群 @/reply/poke/recall）。 */
	readonly direct: readonly [number, number];
	/** 普通群合并。 */
	readonly ordinary: readonly [number, number];
	/** 好友申请/群邀请。 */
	readonly request: readonly [number, number];
	/** internal 候选（连接状态/到期事项/迟到回执/暂停摘要）。 */
	readonly internal: readonly [number, number];
}

export const DEFAULT_TIMING: TimingWindows = {
	direct: [250, 1000],
	ordinary: [1800, 5000],
	request: [500, 1500],
	internal: [700, 2000],
};

export type CandidateClass = "direct" | "ordinary" | "request" | "internal";

export interface PendingCandidate {
	readonly key: string;
	readonly conversationRef: string;
	readonly cls: CandidateClass;
	/** 最老未通知事实时间（ISO）；同类按此排序。 */
	readonly oldestAt: string;
	/** 普通候选合并计数。 */
	readonly count: number;
	/** direct 候选的触发原因。 */
	readonly trigger?: "private" | "at_self" | "reply_self" | "poke" | "recall";
	/** 世界事件 origin（入站表：bot_status/offline 为 external，连接故障与到期事项为 internal）；makeCandidate 保证必填。 */
	readonly origin: "external" | "internal";
}

export interface SchedulerDeps {
	readonly selfId: string;
	readonly journal: FactsJournal;
	readonly control: ControlStore;
	readonly now: () => string;
	/** 投递世界事件（emitEvent 包装 submitInput）；单占位由 scheduler 保证。 */
	readonly emit: (input: { id: string; text: string; conversationRef: string; cls: CandidateClass; origin: "external" | "internal" }) => Promise<void>;
	readonly isBusy?: () => boolean;
	/** 批次正文渲染（呈现层唯一出口，render.ts 提供）。 */
	readonly renderBatch: (candidate: PendingCandidate) => string;
	/**
	 * recall 是否"影响当前交互或事项证据"（合同 §4 只允许此类 recall 提醒）。
	 * 判定语义由装配层注入（自身发言被撤 / open 事项证据被撤 / 连续性窗口内最近批次）；
	 * 未注入时保守不提醒（事实保存可查）。
	 */
	readonly isRecallRelevant?: (fact: EventFact) => boolean;
}

interface IngestedItem {
	kind: "message" | "event" | "request";
	fact: MessageFact | EventFact | RequestFact;
}

/** 派发占位：input_settled 后按 committed 结算通知记账。 */
interface Placeholder {
	readonly inputId: string;
	readonly conversationRef: string;
	/** 派发时刻该会话最新序号（render 与冻结同步执行）；非会话批次为 0。 */
	readonly throughSequence: number;
	/** follow_up 批次派发时渲染的到期事项；committed 后才计账（retired 允许重提醒）。 */
	readonly followUpRefs?: readonly string[];
	/** 迟到回执更新批次派发时呈现的操作；committed 后清理。 */
	readonly operationRefs?: readonly string[];
}

export class QqScheduler {
	private readonly pending = new Map<string, PendingCandidate>();
	private placeholder: Placeholder | null = null;
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** 每个候选窗口的首条到达时刻（maxWait 自此起算）。 */
	private windowStart = new Map<string, number>();
	private recheckTimer: ReturnType<typeof setTimeout> | null = null;
	/** 已处理过的暂停到期事件（target:pausedUntil）；进程内存续，重启至多重放一次摘要（偏差登记）。 */
	private readonly processedPauseExpiries = new Set<string>();
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
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.windowStart.clear();
		if (this.recheckTimer) clearTimeout(this.recheckTimer);
		this.recheckTimer = null;
		this.pending.clear();
		this.placeholder = null;
	}

	/** 摄取层每追加一条事实后调用；不等待、不抛错。 */
	onFact(item: IngestedItem): void {
		try {
			for (const candidate of this.classify(item)) this.offer(candidate);
		} catch (error) {
			// 单条事实分类失败不阻断摄取主链，但必须留可见痕迹（静默=永远不提醒）。
			console.warn(
				`[qq] 事实分类失败（kind=${item.kind}）:`,
				error instanceof Error ? error.message : error,
			);
		}
	}

	private classify(item: IngestedItem): PendingCandidate[] {
		const { selfId, control } = this.deps;
		if (item.kind === "message") {
			const fact = item.fact as MessageFact;
			if (fact.direction === "out") return []; // self 回送：与真实回执归并，不自动唤醒
			const parsed = /:(private|group|temp):([^\s]+)$/.exec(fact.conversationRef);
			if (!parsed) return [];
			const [, kind] = parsed;
			const attention = control.effectiveAttention(fact.conversationRef);
			if (attention.mode === "silent") return []; // 不提醒；事实仍可查
			if (kind !== "group") {
				return [this.makeCandidate(fact.conversationRef, "direct", fact.time, 1, "private")];
			}
			// 群：真实 @self / reply 已核验自己的消息 → direct；其余普通合并。
			const atSelf = fact.segments.some((seg) => seg.type === "mention" && seg.userRef === `qq-user:${selfId}:${selfId}`);
			const replySelf = fact.replyTo !== undefined && this.isOwnMessage(fact.replyTo);
			if (atSelf || replySelf) {
				return [this.makeCandidate(fact.conversationRef, "direct", fact.time, 1, atSelf ? "at_self" : "reply_self")];
			}
			if (attention.mode === "direct_only") return []; // 普通群消息只在 normal 模式合并
			return [this.makeCandidate(fact.conversationRef, "ordinary", fact.time, 1)];
		}
		if (item.kind === "event") {
			const fact = item.fact as EventFact;
			if (fact.kind === "poke" && fact.targetRef === `qq-user:${selfId}:${selfId}`) {
				const attention = control.effectiveAttention(fact.conversationRef ?? "account");
				if (attention.mode === "silent") return [];
				// 群 poke 携带会话现场；好友 poke 从 actor（对方）推导私聊会话——fact 字段已知，非猜测。
				const convRef = fact.conversationRef ?? this.privateRefFromActor(fact.actorRef);
				if (!convRef) return [];
				return [this.makeCandidate(convRef, "direct", fact.time, 1, "poke")];
			}
			if (fact.kind === "recall" && fact.conversationRef) {
				const attention = control.effectiveAttention(fact.conversationRef);
				if (attention.mode === "silent") return [];
				// 合同 §4：仅"影响当前交互或事项证据"的 recall 允许提醒；判定注入，缺省不唤醒。
				if (!this.deps.isRecallRelevant?.(fact)) return [];
				return [this.makeCandidate(fact.conversationRef, "direct", fact.time, 1, "recall")];
			}
			if (fact.kind === "bot_status" || fact.kind === "bot_offline") {
				// 入站表：bot_status/offline 属平台事实，origin=external；初始化基线由装配层
				// 首连状态处理（connected 事件不产生候选）。
				return [this.makeCandidate("qq-event-account", "internal", fact.time, 1, undefined, "external")];
			}
			if (fact.kind === "transport_disconnected" || fact.kind === "transport_recovered") {
				// 一次性语义（只报一次/恢复只对已报故障）由装配层的 onStatus 状态机保证；
				// 调度器只负责把已放行的事实变成 internal 候选。
				return [this.makeCandidate("qq-event-account", "internal", fact.time, 1)];
			}
			return []; // 一般成员变化/reaction/profile_like 保存可查，不默认唤醒
		}
		// request：好友申请与已确认目标群邀请允许提醒。
		const fact = item.fact as RequestFact;
		if (fact.kind === "friend" || (fact.kind === "group_invite" && fact.targetConversationRef !== undefined)) {
			const attention = control.effectiveAttention("account");
			if (attention.mode === "silent") return [];
			return [this.makeCandidate(fact.targetConversationRef ?? "qq-request-account", "request", fact.time, 1)];
		}
		return [];
	}

	private isOwnMessage(ref: string): boolean {
		const fact = this.deps.journal.getMessage(ref);
		return fact?.direction === "out";
	}

	/** 好友 poke 无会话现场：从 actor（对方）推导私聊会话 ref；actor 缺失或是自己则放弃唤醒。 */
	private privateRefFromActor(actorRef: string | undefined): string | undefined {
		if (!actorRef) return undefined;
		const [, account, uin] = actorRef.split(":");
		if (account !== this.deps.selfId || uin === undefined || uin === this.deps.selfId) return undefined;
		return `qq-conversation:${this.deps.selfId}:private:${uin}`;
	}

	/** 候选是否仅由会话消息派生（无自身载荷，空转即无意义）。 */
	private isMessageDerived(candidate: PendingCandidate): boolean {
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
			origin: origin ?? (cls === "internal" ? ("internal" as const) : ("external" as const)),
		};
	}

	/** 装配层轮询 dueFollowUps 后调用；到期事项走 internal 候选，派发成功即计账。 */
	notifyFollowUpDue(): void {
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
		const existing = this.pending.get(candidate.key);
		if (existing) {
			// 合并：普通候选累加计数；direct 只保留最老到达时间。
			this.pending.set(candidate.key, {
				...existing,
				count: existing.cls === "ordinary" ? existing.count + candidate.count : existing.count,
			});
		} else {
			this.pending.set(candidate.key, candidate);
		}
		this.scheduleWindow(candidate.key);
	}

	private windowFor(candidate: PendingCandidate): readonly [number, number] {
		switch (candidate.cls) {
			case "direct":
				return this.timing.direct;
			case "request":
				return this.timing.request;
			case "ordinary":
				return this.timing.ordinary;
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

	/** input_settled(committed/retired) 回调：释放占位并推进通知位置。 */
	onInputSettled(inputId: string, committed: boolean): void {
		if (!this.placeholder || this.placeholder.inputId !== inputId) return;
		const { conversationRef, throughSequence, followUpRefs, operationRefs } = this.placeholder;
		if (committed) {
			// 只冻结在派发时已交付的序号；派发后新到消息留给下一批，不偷记已通知。
			const through = this.deps.journal.snapshot.notifiedThrough.get(conversationRef) ?? 0;
			if (throughSequence > through) {
				this.deps.journal.recordNotified(conversationRef, throughSequence, inputId, this.deps.now());
			}
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
		if (this.placeholder || this.pending.size === 0) return;
		if (this.deps.isBusy?.() ?? false) return; // 忙时普通活动留在事实存储
		const candidate = this.select();
		if (!candidate) return;
		const attention = this.deps.control.effectiveAttention(candidate.conversationRef);
		if (attention.mode === "silent") {
			this.pending.delete(candidate.key);
			return;
		}
		// 消息派生候选派发前重验新鲜度：正文若已被其他批次（如更早的 direct/poke 批）
		// 交付并记账，空转候选直接退役，不产生空批次（poke/recall/request/internal
		// 携带自身载荷，不受此限）。
		if (this.isMessageDerived(candidate) && this.deps.journal.unreadCount(candidate.conversationRef) === 0) {
			this.pending.delete(candidate.key);
			return;
		}
		const inputId = `qq:${candidate.cls}:${candidate.conversationRef}:${this.deps.now()}`;
		this.pending.delete(candidate.key);
		try {
			const text = this.deps.renderBatch(candidate);
			// 冻结本批交付到的会话序号：render 同步执行完取当刻最新序号，批次内渲染的
			// fresh（含事件候选捎带的会话正文）全部如实记账；非会话批次（follow-ups/
			// account 事件）无消息序号，latestSequence 自然为 0 不推进。
			const throughSequence = this.deps.journal.latestSequence(candidate.conversationRef);
			// follow_up 到期：派发时先捕获渲染的到期列表，committed 结算后才计账——
			// retired/claimed 不标记，轮询自然重新提醒（合同：记录失败允许以后重复提醒）。
			const followUpRefs =
				candidate.conversationRef === "qq-follow-ups" ? this.deps.control.dueFollowUps().map((item) => item.ref) : undefined;
			const operationRefs = candidate.conversationRef === "qq-operations" ? [...this.settledUnknowns.keys()] : undefined;
			this.placeholder = {
				inputId,
				conversationRef: candidate.conversationRef,
				throughSequence,
				...(followUpRefs ? { followUpRefs } : {}),
				...(operationRefs ? { operationRefs } : {}),
			};
			await this.deps.emit({
				id: inputId,
				text,
				conversationRef: candidate.conversationRef,
				cls: candidate.cls,
				origin: candidate.origin,
			});
		} catch (error) {
			// 投递/渲染失败：释放占位并恢复候选（合同：允许以后重复提醒）；
			// 确定性渲染 bug 会以窗口节奏重试并持续留可见痕迹，不静默丢失。
			console.warn(`[qq] 批次投递失败（${candidate.conversationRef}）:`, error instanceof Error ? error.message : error);
			this.placeholder = null;
			this.offer(candidate);
		}
	}

	/** 选择：direct 优先，同类按等待年龄；preferred 偏置 = 视作提前一个普通合并窗口（1800ms），有限。 */
	private select(): PendingCandidate | null {
		const nowMs = Date.parse(this.deps.now());
		const preferredBiasMs = this.timing.ordinary[0];
		const candidates = this.pendingCandidates;
		const effectiveAge = (candidate: PendingCandidate): number => {
			const attention = this.deps.control.effectiveAttention(candidate.conversationRef);
			const bias = attention.priority === "preferred" ? preferredBiasMs : 0;
			return nowMs - Date.parse(candidate.oldestAt) + bias;
		};
		const byAge = (a: PendingCandidate, b: PendingCandidate): number => effectiveAge(b) - effectiveAge(a);
		const direct = candidates.filter((c) => c.cls === "direct");
		if (direct.length > 0) return direct.sort(byAge)[0] ?? null;
		const request = candidates.filter((c) => c.cls === "request");
		if (request.length > 0) return request.sort(byAge)[0] ?? null;
		const internal = candidates.filter((c) => c.cls === "internal");
		if (internal.length > 0) return internal.sort(byAge)[0] ?? null;
		const ordinary = candidates.filter((c) => c.cls === "ordinary" && this.deps.control.effectiveAttention(c.conversationRef).mode === "normal");
		if (ordinary.length > 0) return ordinary.sort(byAge)[0] ?? null;
		return null;
	}

}
