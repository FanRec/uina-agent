import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { refBelongsToAccount, REF_PATTERNS, type EventFact, type MediaFact, type MessageFact, type RequestFact } from "./types.js";
import { recoverJsonlLines } from "./jsonl-log.js";

/**
 * QQ 平台事实日志：JSONL 追加，进程内同步写（单线程天然串行）。
 * 只记录"外部观察事实"与通知计账；恢复时重建，尾部 partial 行截断，中段损坏明确失败。
 * 账号边界：绑定账号变更后旧记录不迁移，恢复时按账号段过滤。
 */

export type FactRecord =
	| { kind: "message"; fact: MessageFact }
	| { kind: "event"; fact: EventFact }
	| { kind: "request"; fact: RequestFact }
	/** input_settled(committed) 后的主场景通知位置；只表示正文已交给 canonical 输入。 */
	| { kind: "notified"; conversationRef: string; throughSequence: number; inputId: string; at: string }
	/** retention 归档起点：此时刻之前的事实可能已不可寻址。 */
	| { kind: "archive"; beforeTime: string };

export interface FactsSnapshot {
	/** 按会话组织、按 sequence 升序的入站消息。 */
	messages: Map<string, MessageFact[]>;
	/** 按会话组织的近期事件（入站顺序）。 */
	events: Map<string, EventFact[]>;
	/** 账号级事件（无会话归属）。 */
	accountEvents: EventFact[];
	requests: Map<string, RequestFact>;
	notifiedThrough: Map<string, number>;
	/** 各会话最近一次 committed 通知时刻（recall 连续性窗口判定用）。 */
	notifiedAt: Map<string, string>;
	archiveBefore: string | null;
	/** 恢复期被账号边界排除的记录数（诊断）。 */
	excludedForeignAccount: number;
}

export interface FactsJournalOptions {
	readonly dataDir: string;
	readonly selfId: string;
}

export class FactsJournal {
	private readonly filePath: string;
	private readonly state: FactsSnapshot;
	private nextSequence = new Map<string, number>();
	private readonly mediaIndex = new Map<string, MediaFact>();
	/** 消息 ref → fact 索引（reply 核验/点查热路径，O(1)）。 */
	private readonly byMessageRef = new Map<string, MessageFact>();
	private nextMediaSequence = 0;

	constructor(private readonly options: FactsJournalOptions) {
		this.filePath = join(options.dataDir, "qq-facts.jsonl");
		this.state = {
			messages: new Map(),
			events: new Map(),
			accountEvents: [],
			requests: new Map(),
			notifiedThrough: new Map(),
			notifiedAt: new Map(),
			archiveBefore: null,
			excludedForeignAccount: 0,
		};
	}

	get snapshot(): FactsSnapshot {
		return this.state;
	}

	/** 启动恢复；返回截断的尾部 partial 行数（诊断，不算错误）。 */
	recover(): { truncatedTailLines: number } {
		mkdirSync(this.options.dataDir, { recursive: true });
		const { records, truncatedTailLines } = recoverJsonlLines<FactRecord>(this.filePath, "QQ facts journal ");
		for (const record of records) this.apply(record);
		return { truncatedTailLines };
	}

	private belongsToAccount(ref: string): boolean {
		return refBelongsToAccount(ref, this.options.selfId);
	}

	private apply(record: FactRecord): void {
		switch (record.kind) {
			case "message": {
				const fact = record.fact;
				if (!this.belongsToAccount(fact.conversationRef)) {
					this.state.excludedForeignAccount++;
					return;
				}
				const list = this.state.messages.get(fact.conversationRef) ?? [];
				list.push(fact);
				this.state.messages.set(fact.conversationRef, list);
				this.byMessageRef.set(fact.ref, fact);
				this.indexMedia(fact);
				const seen = this.nextSequence.get(fact.conversationRef) ?? 0;
				if (fact.sequence > seen) this.nextSequence.set(fact.conversationRef, fact.sequence);
				return;
			}
			case "event": {
				const fact = record.fact;
				if (fact.ref.split(":")[1] !== this.options.selfId) {
					this.state.excludedForeignAccount++;
					return;
				}
				if (fact.conversationRef) {
					const list = this.state.events.get(fact.conversationRef) ?? [];
					list.push(fact);
					this.state.events.set(fact.conversationRef, list);
				} else {
					this.state.accountEvents.push(fact);
				}
				return;
			}
			case "request": {
				const fact = record.fact;
				if (fact.ref.split(":")[1] !== this.options.selfId) {
					this.state.excludedForeignAccount++;
					return;
				}
				this.state.requests.set(fact.ref, fact);
				return;
			}
			case "notified": {
				if (!this.belongsToAccount(record.conversationRef)) return;
				const seen = this.state.notifiedThrough.get(record.conversationRef) ?? 0;
				if (record.throughSequence > seen) {
					this.state.notifiedThrough.set(record.conversationRef, record.throughSequence);
					this.state.notifiedAt.set(record.conversationRef, record.at);
				}
				return;
			}
			case "archive": {
				if (!this.state.archiveBefore || record.beforeTime > this.state.archiveBefore) {
					this.state.archiveBefore = record.beforeTime;
				}
				return;
			}
		}
	}

	private append(record: FactRecord): void {
		appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf8");
	}

	/** 会话当前最新入站序号（调度层派发冻结记账用；未知会话为 0）。 */
	latestSequence(conversationRef: string): number {
		return this.nextSequence.get(conversationRef) ?? 0;
	}

	/** 分配会话内入站序号并持久化。 */
	appendMessage(fact: Omit<MessageFact, "sequence">): MessageFact {
		const conversationRef = fact.conversationRef;
		if (!this.belongsToAccount(conversationRef)) {
			throw new Error(`消息会话 ${conversationRef} 不属于绑定账号 ${this.options.selfId}`);
		}
		const sequence = (this.nextSequence.get(conversationRef) ?? 0) + 1;
		this.nextSequence.set(conversationRef, sequence);
		const complete: MessageFact = { ...fact, sequence };
		this.append({ kind: "message", fact: complete });
		const list = this.state.messages.get(conversationRef) ?? [];
		list.push(complete);
		this.state.messages.set(conversationRef, list);
		this.byMessageRef.set(complete.ref, complete);
		this.indexMedia(complete);
		return complete;
	}

	private indexMedia(fact: MessageFact): void {
		for (const seg of fact.segments) {
			if (!("mediaRef" in seg) || !seg.mediaRef || !REF_PATTERNS.media.test(seg.mediaRef) || !this.belongsToAccount(seg.mediaRef)) continue;
			this.mediaIndex.set(seg.mediaRef, { type: seg.type, url: seg.url, fileName: seg.fileName });
			const sequence = Number(seg.mediaRef.split(":")[2]);
			if (Number.isSafeInteger(sequence) && sequence > this.nextMediaSequence) this.nextMediaSequence = sequence;
		}
	}

	mintMediaRef(): string {
		return `qq-media:${this.options.selfId}:${++this.nextMediaSequence}`;
	}

	getMedia(ref: string): MediaFact | null {
		return this.mediaIndex.get(ref) ?? null;
	}

	appendEvent(fact: EventFact): void {
		this.append({ kind: "event", fact });
		this.apply({ kind: "event", fact });
	}

	appendRequest(fact: RequestFact): void {
		this.append({ kind: "request", fact });
		this.apply({ kind: "request", fact });
	}

	recordNotified(conversationRef: string, throughSequence: number, inputId: string, at: string): void {
		this.append({ kind: "notified", conversationRef, throughSequence, inputId, at });
		this.apply({ kind: "notified", conversationRef, throughSequence, inputId, at });
	}

	recordArchive(beforeTime: string): void {
		this.append({ kind: "archive", beforeTime });
		this.apply({ kind: "archive", beforeTime });
	}

	/** request 状态流转（如好友申请被接受）：追加新版本，恢复取最后一条。 */
	updateRequest(fact: RequestFact): void {
		this.appendRequest(fact);
	}

	/** 按 ref 查消息（reply 属主核验、messages scope 用；索引 O(1)）。 */
	getMessage(ref: string): MessageFact | null {
		return this.byMessageRef.get(ref) ?? null;
	}

	/** 未通知入站消息数（sequence > notifiedThrough；committed 记账后归零）。 */
	unreadCount(conversationRef: string): number {
		const through = this.state.notifiedThrough.get(conversationRef) ?? 0;
		let count = 0;
		for (const m of this.state.messages.get(conversationRef) ?? []) {
			if (m.sequence > through) count++;
		}
		return count;
	}

	/** 是否存在任意未通知消息（跨会话单遍；暂停到期摘要资格判定用）。 */
	hasUnread(): boolean {
		for (const [conv, list] of this.state.messages) {
			const through = this.state.notifiedThrough.get(conv) ?? 0;
			if (list.some((m) => m.sequence > through)) return true;
		}
		return false;
	}

	/** 最早未通知消息时间（无未通知为 null；暂停到期摘要呈现用）。 */
	firstUnreadTime(conversationRef: string): string | null {
		const through = this.state.notifiedThrough.get(conversationRef) ?? 0;
		for (const m of this.state.messages.get(conversationRef) ?? []) {
			if (m.sequence > through) return m.time;
		}
		return null;
	}

	/** 已知会话 ref 列表（conversations scope 本地兜底）。 */
	listConversationRefs(): string[] {
		return [
			...new Set([...this.state.messages.keys(), ...this.state.events.keys()]),
		];
	}
}
