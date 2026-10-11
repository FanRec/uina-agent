import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	REF_PATTERNS,
	sameAttachment,
	type EventFact,
	type IngestedFact,
	type MediaFact,
	type MessageFact,
	type RequestFact,
} from "./types.js";
import { recoverJsonlLines, readJsonlLines } from "./jsonl-log.js";

/**
 * QQ 平台事实日志：JSONL 追加，进程内同步写（单线程天然串行）。
 * 只记录"外部观察事实"与通知计账；恢复时重建，尾部 partial 行截断，中段损坏明确失败。
 * v2 账号目录与日志所有者保证隔离；错误账号与旧格式明确失败。
 */

export type FactRecord =
	| { kind: "header"; version: 2; selfId: string }
	| { kind: "counter"; type: "media" | "event" | "request"; sequence: number; platformFlag?: string }
	| IngestedFact
	| { kind: "media_locator"; ref: string; fact: MediaFact }
	/** input_settled(committed) 后的主场景通知位置；只表示正文已交给 canonical 输入。 */
	| { kind: "notified"; conversationRef: string; throughSequence: number; inputId: string; at: string }
	/** body_dispatched 正文派发消费边界（R4①）；与 notified 分轨，单调回放。 */
	| {
			kind: "dispatched";
			conversationRef: string;
			throughSequence: number;
			source: "read" | "follow";
			inputId?: string;
			at: string;
	  }
	/** backlog_skipped 主动放下事实（§2）：跳过区间审计 + 消费位推进（Math.max 单调）。 */
	| { kind: "skipped"; conversationRef: string; throughSequence: number; reason: string; at: string }
	/** retention 归档起点：此时刻之前的事实可能已不可寻址。 */
	| { kind: "archive"; beforeTime: string }
	| { kind: "coverage_gap"; id: string; from: string; to: string | null; reason: string; conversationRef?: string };

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
	/** body_dispatched 正文派发消费边界（per-conversation，单调不减）。 */
	dispatchedThrough: Map<string, number>;
	archiveBefore: string | null;
	coverageGaps: { id: string; from: string; to: string | null; reason: string; conversationRef?: string }[];
	/** backlog_skipped 审计（追加序）；qq_status 呈现，消费位本身见 dispatchedThrough。 */
	skips: { conversationRef: string; throughSequence: number; reason: string; at: string }[];
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
	private nextEventSequence = 0;
	private nextRequestSequence = 0;
	private readonly requestByFlag = new Map<string, string>();

	constructor(private readonly options: FactsJournalOptions) {
		this.filePath = join(options.dataDir, "qq-facts.jsonl");
		this.state = {
			messages: new Map(),
			events: new Map(),
			accountEvents: [],
			requests: new Map(),
			notifiedThrough: new Map(),
			notifiedAt: new Map(),
			dispatchedThrough: new Map(),
			archiveBefore: null,
			coverageGaps: [],
			skips: [],
		};
	}

	get selfId(): string {
		return this.options.selfId;
	}

	get dataDir(): string {
		return this.options.dataDir;
	}

	get snapshot(): FactsSnapshot {
		return this.state;
	}

	/** 启动恢复；返回截断的尾部 partial 行数（诊断，不算错误）。 */
	recover(readOnly = false): { truncatedTailLines: number } {
		if (!readOnly) mkdirSync(this.options.dataDir, { recursive: true });
		const { records, truncatedTailLines } = (readOnly ? readJsonlLines<FactRecord> : recoverJsonlLines<FactRecord>)(
			this.filePath,
			"QQ facts journal ",
		);
		if (records.length > 0) {
			const header = records[0];
			if (header?.kind !== "header" || header.version !== 2 || header.selfId !== this.selfId) {
				throw new Error("QQ facts journal v2 账号元信息不匹配或格式非法");
			}
			for (const record of records.slice(1)) this.apply(record);
		} else if (!readOnly) this.append({ kind: "header", version: 2, selfId: this.selfId });
		return { truncatedTailLines };
	}

	private apply(record: FactRecord): void {
		switch (record.kind) {
			case "header":
				if (record.version !== 2 || record.selfId !== this.selfId) throw new Error("QQ facts journal 账号不匹配");
				return;
			case "counter": {
				if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) throw new Error("QQ 引用计数非法");
				if (record.type === "media") this.nextMediaSequence = Math.max(this.nextMediaSequence, record.sequence);
				else if (record.type === "event") this.nextEventSequence = Math.max(this.nextEventSequence, record.sequence);
				else if (record.type === "request" && record.platformFlag) {
					this.nextRequestSequence = Math.max(this.nextRequestSequence, record.sequence);
					this.requestByFlag.set(record.platformFlag, `r${record.sequence}`);
				} else throw new Error("QQ 引用计数形状非法");
				return;
			}
			case "message": {
				const fact = record.fact;
				if (!REF_PATTERNS.conversation.test(fact.conversationRef)) throw new Error("QQ 会话引用非法");
				const list = this.state.messages.get(fact.conversationRef) ?? [];
				list.push(fact);
				this.state.messages.set(fact.conversationRef, list);
				this.byMessageRef.set(fact.ref, fact);
				this.indexMedia(fact);
				const seen = this.nextSequence.get(fact.conversationRef) ?? 0;
				if (fact.sequence > seen) this.nextSequence.set(fact.conversationRef, fact.sequence);
				return;
			}
			case "media_locator": {
				if (!REF_PATTERNS.media.test(record.ref) || !["image", "audio", "video", "file"].includes(record.fact.type))
					throw new Error("QQ 附件定位记录非法");
				this.mediaIndex.set(record.ref, record.fact);
				this.nextMediaSequence = Math.max(this.nextMediaSequence, Number(record.ref.slice(1)));
				return;
			}
			case "event": {
				const fact = record.fact;
				if (!REF_PATTERNS.event.test(fact.ref)) throw new Error("QQ 事件引用非法");
				this.nextEventSequence = Math.max(this.nextEventSequence, Number(fact.ref.slice(1)));
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
				if (!REF_PATTERNS.request.test(fact.ref) || !fact.platformFlag) throw new Error("QQ 请求事实非法");
				this.nextRequestSequence = Math.max(this.nextRequestSequence, Number(fact.ref.slice(1)));
				this.requestByFlag.set(fact.platformFlag, fact.ref);
				this.state.requests.set(fact.ref, fact);
				return;
			}
			case "notified": {
				if (!REF_PATTERNS.conversation.test(record.conversationRef)) throw new Error("QQ 会话引用非法");
				const seen = this.state.notifiedThrough.get(record.conversationRef) ?? 0;
				if (record.throughSequence > seen) {
					this.state.notifiedThrough.set(record.conversationRef, record.throughSequence);
					this.state.notifiedAt.set(record.conversationRef, record.at);
				}
				return;
			}
			case "dispatched": {
				if (!REF_PATTERNS.conversation.test(record.conversationRef)) throw new Error("QQ 会话引用非法");
				const seen = this.state.dispatchedThrough.get(record.conversationRef) ?? 0;
				if (record.throughSequence > seen) {
					this.state.dispatchedThrough.set(record.conversationRef, record.throughSequence);
				}
				return;
			}
			case "skipped": {
				if (!REF_PATTERNS.conversation.test(record.conversationRef)) throw new Error("QQ 会话引用非法");
				const seen = this.state.dispatchedThrough.get(record.conversationRef) ?? 0;
				if (record.throughSequence > seen) {
					this.state.dispatchedThrough.set(record.conversationRef, record.throughSequence);
				}
				this.state.skips.push({
					conversationRef: record.conversationRef,
					throughSequence: record.throughSequence,
					reason: record.reason,
					at: record.at,
				});
				return;
			}
			case "coverage_gap": {
				const index = this.state.coverageGaps.findIndex((gap) => gap.id === record.id);
				if (index < 0) this.state.coverageGaps.push(record);
				else this.state.coverageGaps[index] = record;
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
		this.apply(record);
	}

	/** 会话当前最新入站序号（调度层派发冻结记账用；未知会话为 0）。 */
	latestSequence(conversationRef: string): number {
		return this.nextSequence.get(conversationRef) ?? 0;
	}

	/** 分配会话内入站序号并持久化。 */
	appendMessage(fact: Omit<MessageFact, "sequence">): MessageFact {
		const conversationRef = fact.conversationRef;
		if (!REF_PATTERNS.conversation.test(conversationRef) || !REF_PATTERNS.message.test(fact.ref))
			throw new Error("QQ 消息引用非法");
		const sequence = (this.nextSequence.get(conversationRef) ?? 0) + 1;
		const complete: MessageFact = { ...fact, sequence };
		this.append({ kind: "message", fact: complete });
		return complete;
	}

	private indexMedia(fact: MessageFact): void {
		for (const [segmentIndex, seg] of fact.segments.entries()) {
			if (!("mediaRef" in seg) || !seg.mediaRef || !REF_PATTERNS.media.test(seg.mediaRef)) continue;
			this.mediaIndex.set(seg.mediaRef, {
				type: seg.type,
				url: seg.url,
				fileName: seg.fileName,
				locator: seg.locator,
				origin: { messageRef: fact.ref, conversationRef: fact.conversationRef, segmentIndex },
			});
			const sequence = Number(seg.mediaRef.slice(1));
			if (Number.isSafeInteger(sequence) && sequence > this.nextMediaSequence) this.nextMediaSequence = sequence;
		}
	}

	mintMediaRef(): string {
		const sequence = this.nextMediaSequence + 1;
		this.append({ kind: "counter", type: "media", sequence });
		return `a${sequence}`;
	}

	mintEventRef(): string {
		const sequence = this.nextEventSequence + 1;
		this.append({ kind: "counter", type: "event", sequence });
		return `e${sequence}`;
	}

	mintRequestRef(platformFlag: string): string {
		if (!platformFlag) throw new Error("QQ 请求 flag 不能为空");
		const existing = this.requestByFlag.get(platformFlag);
		if (existing) return existing;
		const sequence = this.nextRequestSequence + 1;
		this.append({ kind: "counter", type: "request", sequence, platformFlag });
		return `r${sequence}`;
	}

	getMedia(ref: string): MediaFact | null {
		return this.mediaIndex.get(ref) ?? null;
	}

	/** Read-only platform snapshots may contribute addressing evidence, never arrivals. */
	saveMediaLocator(ref: string | undefined, fact: MediaFact): string {
		const saved = ref ? this.mediaIndex.get(ref) : undefined;
		if (saved && !sameAttachment(saved, fact)) throw new Error("QQ 附件引用不能指向另一个对象");
		const existing = ref ?? [...this.mediaIndex].find(([, value]) => sameAttachment(value, fact))?.[0];
		const mediaRef = existing ?? `a${this.nextMediaSequence + 1}`;
		if (JSON.stringify(this.mediaIndex.get(mediaRef)) !== JSON.stringify(fact))
			this.append({ kind: "media_locator", ref: mediaRef, fact });
		return mediaRef;
	}

	appendEvent(fact: EventFact): void {
		if (!REF_PATTERNS.event.test(fact.ref)) throw new Error("QQ 事件引用非法");
		this.append({ kind: "event", fact });
	}

	appendRequest(fact: RequestFact): void {
		if (!REF_PATTERNS.request.test(fact.ref) || !fact.platformFlag) throw new Error("QQ 请求事实非法");
		this.append({ kind: "request", fact });
	}

	recordNotified(conversationRef: string, throughSequence: number, inputId: string, at: string): void {
		this.append({ kind: "notified", conversationRef, throughSequence, inputId, at });
	}

	/** body_dispatched 书签推进（R4①）；Math.max 单调回放，绝不向后倒退。 */
	recordDispatched(
		conversationRef: string,
		throughSequence: number,
		source: "read" | "follow",
		at: string,
		inputId?: string,
	): void {
		this.append({
			kind: "dispatched",
			conversationRef,
			throughSequence,
			source,
			...(inputId ? { inputId } : {}),
			at,
		});
	}

	/** 会话当前 body_dispatched 消费边界（未知会话为 0）。 */
	dispatchedThroughOf(conversationRef: string): number {
		return this.state.dispatchedThrough.get(conversationRef) ?? 0;
	}

	/**
	 * backlog_skipped（§2/T04）：审计记录 + 消费位推进；Math.max 单调，绝不向后倒退。
	 * 无实际推进（throughSequence ≤ 当前消费位）由调用方判定，不落记录。
	 */
	recordSkipped(conversationRef: string, throughSequence: number, reason: string, at: string): void {
		this.append({ kind: "skipped", conversationRef, throughSequence, reason, at });
	}

	/** 跳过审计（追加序）；conversationRef 缺省返回全部。 */
	skipRecords(
		conversationRef?: string,
	): readonly { conversationRef: string; throughSequence: number; reason: string; at: string }[] {
		return conversationRef === undefined
			? this.state.skips
			: this.state.skips.filter((s) => s.conversationRef === conversationRef);
	}

	/**
	 * 消息引用 → 本地 sequence（R3）：`m<platform_id>` 直引经事实索引映射；
	 * 引用不存在或不属目标会话均显式失败，绝不靠字符串字典序推导先后。
	 */
	resolveMessageSequence(conversationRef: string, messageRef: string): number {
		const fact = this.byMessageRef.get(messageRef);
		if (!fact || fact.conversationRef !== conversationRef) {
			throw new Error(`消息引用不存在或不属目标会话: ${messageRef} @ ${conversationRef}`);
		}
		return fact.sequence;
	}

	recordCoverageGap(gap: FactsSnapshot["coverageGaps"][number]): void {
		this.append({ kind: "coverage_gap", ...gap });
	}

	recordArchive(beforeTime: string): void {
		this.append({ kind: "archive", beforeTime });
	}

	/** request 状态流转（如好友申请被接受）：追加新版本，恢复取最后一条。 */
	updateRequest(fact: RequestFact): void {
		this.appendRequest(fact);
	}

	/** 按 ref 查消息（reply 属主核验、messages scope 用；索引 O(1)）。 */
	getMessage(ref: string): MessageFact | null {
		return this.byMessageRef.get(ref) ?? null;
	}

	/** 已知会话 ref 列表（conversations scope 本地兜底）。 */
	listConversationRefs(): string[] {
		return [...new Set([...this.state.messages.keys(), ...this.state.events.keys()])];
	}
}
