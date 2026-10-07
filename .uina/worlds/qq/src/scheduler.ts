import type { FactsJournal } from "./facts-journal.js";
import type { ControlStore } from "./control-store.js";
import type { EventFact, MessageFact, RequestFact } from "./types.js";

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
	/** 私聊/temp（quiet/maxWait）。 */
	readonly private: readonly [number, number];
	/** 群真实 @/reply（direct）。 */
	readonly direct: readonly [number, number];
	/** 普通群合并。 */
	readonly ordinary: readonly [number, number];
	/** 好友申请/群邀请。 */
	readonly request: readonly [number, number];
}

export const DEFAULT_TIMING: TimingWindows = {
	private: [700, 2000],
	direct: [250, 1000],
	ordinary: [1800, 5000],
	request: [500, 1500],
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
	/** 本批最新会话序号（合并取 max）；渲染窗口与冻结记账同源于此。 */
	readonly toSeq: number;
	/** direct 候选的触发原因。 */
	readonly trigger?: "private" | "at_self" | "reply_self" | "poke" | "recall";
}

export interface SchedulerDeps {
	readonly selfId: string;
	readonly journal: FactsJournal;
	readonly control: ControlStore;
	readonly now: () => string;
	/** 投递世界事件（emitEvent 包装 submitInput）；单占位由 scheduler 保证。 */
	readonly emit: (input: { id: string; text: string; conversationRef: string; cls: CandidateClass }) => Promise<void>;
	readonly isBusy?: () => boolean;
	/** 批次正文渲染（呈现层唯一出口，render.ts 提供）。 */
	readonly renderBatch: (candidate: PendingCandidate) => string;
}

interface IngestedItem {
	kind: "message" | "event" | "request";
	fact: MessageFact | EventFact | RequestFact;
}

export class QqScheduler {
	private readonly pending = new Map<string, PendingCandidate>();
	private placeholder: { inputId: string; conversationRef: string; throughSequence: number } | null = null;
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** 每个候选窗口的首条到达时刻（maxWait 自此起算）。 */
	private windowStart = new Map<string, number>();
	private recheckTimer: ReturnType<typeof setTimeout> | null = null;

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
		} catch {
			// 单条事实分类失败不阻断摄取主链。
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
				return [this.makeCandidate(fact.conversationRef, "direct", fact.time, 1, "private", fact.sequence)];
			}
			// 群：真实 @self / reply 已核验自己的消息 → direct；其余普通合并。
			const atSelf = fact.segments.some((seg) => seg.type === "mention" && seg.userRef === `qq-user:${selfId}:${selfId}`);
			const replySelf = fact.replyTo !== undefined && this.isOwnMessage(fact.replyTo);
			if (atSelf || replySelf) {
				return [this.makeCandidate(fact.conversationRef, "direct", fact.time, 1, atSelf ? "at_self" : "reply_self", fact.sequence)];
			}
			if (attention.mode === "direct_only") return []; // 普通群消息只在 normal 模式合并
			return [this.makeCandidate(fact.conversationRef, "ordinary", fact.time, 1, undefined, fact.sequence)];
		}
		if (item.kind === "event") {
			const fact = item.fact as EventFact;
			if (fact.kind === "poke" && fact.targetRef === `qq-user:${selfId}:${selfId}` && fact.conversationRef) {
				const attention = control.effectiveAttention(fact.conversationRef);
				if (attention.mode === "silent") return [];
				return [this.makeCandidate(fact.conversationRef, "direct", fact.time, 1, "poke")];
			}
			if (fact.kind === "recall" && fact.conversationRef) {
				const attention = control.effectiveAttention(fact.conversationRef);
				if (attention.mode === "silent") return [];
				// 影响当前交互/证据的 recall 允许提醒；这里保守视为 direct 短批次。
				return [this.makeCandidate(fact.conversationRef, "direct", fact.time, 1, "recall")];
			}
			if (fact.kind === "bot_status" || fact.kind === "bot_offline") {
				return [this.makeCandidate("qq-event-account", "internal", fact.time, 1)];
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

	private makeCandidate(
		conversationRef: string,
		cls: CandidateClass,
		time: string,
		count: number,
		trigger?: PendingCandidate["trigger"],
		toSeq = 0,
	): PendingCandidate {
		return { key: `${cls}:${conversationRef}`, conversationRef, cls, oldestAt: time, count, toSeq, trigger };
	}

	/** 装配层轮询 dueFollowUps 后调用；到期事项走 internal 候选，派发成功即计账。 */
	notifyFollowUpDue(): void {
		const due = this.deps.control.dueFollowUps();
		if (due.length === 0) return;
		this.offer(this.makeCandidate("qq-follow-ups", "internal", this.deps.now(), due.length));
	}

	/**
	 * 窗口语义（交互合同 §4 初值）：quiet = 自最近一次事实到达的去抖；
	 * maxWait = 自窗口首条事实起算的上限，防止持续聊天永不结束窗口。
	 * 占位占用时不设窗口（候选只保留，结算后统一重选）。
	 */
	private offer(candidate: PendingCandidate): void {
		const existing = this.pending.get(candidate.key);
		if (existing) {
			// 合并：普通候选累加计数、toSeq 取 max；direct 只保留最老到达时间。
			this.pending.set(candidate.key, {
				...existing,
				count: existing.cls === "ordinary" ? existing.count + candidate.count : existing.count,
				toSeq: Math.max(existing.toSeq, candidate.toSeq),
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
			default:
				return this.timing.private;
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
		const { conversationRef, throughSequence } = this.placeholder;
		if (committed) {
			// 只冻结在派发时已交付的序号；派发后新到消息留给下一批，不偷记已通知。
			const through = this.deps.journal.snapshot.notifiedThrough.get(conversationRef) ?? 0;
			if (throughSequence > through) {
				this.deps.journal.recordNotified(conversationRef, throughSequence, inputId, this.deps.now());
			}
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
		const inputId = `qq:${candidate.cls}:${candidate.conversationRef}:${this.deps.now()}`;
		const text = this.deps.renderBatch(candidate);
		// 冻结本批交付到的会话序号：与渲染同源（candidate.toSeq），input_settled(committed) 只推进到这里。
		this.placeholder = { inputId, conversationRef: candidate.conversationRef, throughSequence: candidate.toSeq };
		this.pending.delete(candidate.key);
		try {
			await this.deps.emit({ id: inputId, text, conversationRef: candidate.conversationRef, cls: candidate.cls });
			// follow_up 到期：通知过就不再因只改 note 再提醒（改 reviewAt 才重建预约）。
			if (candidate.conversationRef === "qq-follow-ups") {
				for (const item of this.deps.control.dueFollowUps()) this.deps.control.markReviewNotified(item.ref);
			}
		} catch (error) {
			// 投递/渲染失败：释放占位，允许以后重复提醒；渲染 bug 静默会表现为
			// "永远不提醒"，必须留可见痕迹。
			console.warn(`[qq] 批次投递失败（${candidate.conversationRef}）:`, error instanceof Error ? error.message : error);
			this.placeholder = null;
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
