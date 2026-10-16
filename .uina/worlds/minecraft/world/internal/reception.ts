/**
 * Driver → World 证据接收引擎（docs/proposals/mc/modules/world.md §5）。
 *
 * 关键不变量：
 * - 接收前缀的每个序号必须有实际载荷或可解析的显式缺口；绝不用最大序号冒充连续确认。
 * - through=null 的未知后缀缺口不授权越过无限序号；封口（evidence_end）后才闭合为有限区间。
 * - 同一 (stream, E) 的重传必须同载荷；同身份不同载荷是源协议故障，不覆盖。
 * - 接收代次的 R 只分配给新接纳项（载荷或 gap）；重传重复项不分配。
 * - durableThrough ≤ receivedThrough；D 只在连续前缀持久后推进，MAX(已写 R) 不是水位。
 * - reset 不清除已捕获证据；迟到旧流材料可补历史，不恢复当前覆盖。
 */

import type { CapturedClientFact, ClientEvidenceAck, ClientFactNotice } from "../../contracts/client-facts.js";
import type { Ref } from "../../contracts/values.js";

export interface GapRecord {
	ref: Ref;
	stream: Ref;
	after: number;
	/** null 表示末端未知。 */
	through: number | null;
	reason: string;
}

export type AcceptedEntry =
	| { kind: "fact"; receiveSeq: number; record: CapturedClientFact }
	| { kind: "gap"; receiveSeq: number; gap: GapRecord };

export interface ReceptionEvents {
	/** 新接纳项（含 gap）进入待落盘队列；实现负责持久化并在提交后回报 committed。 */
	accepted(entries: AcceptedEntry[]): void;
	/** ACK 已更新（receivedThrough/durableThrough 前进或 gaps 变化）。 */
	ackReady(ack: ClientEvidenceAck): void;
	/** 同身份不同载荷等源协议故障；保留诊断，不覆盖。 */
	protocolFault(message: string): void;
}

interface StreamReception {
	/** 连续已对账前缀。 */
	receivedThrough: number;
	/** 已收载荷（含前缀内与前缀外的缓冲）。 */
	payloads: Map<number, CapturedClientFact>;
	/** 登记的缺口。 */
	gaps: Map<Ref, GapRecord>;
	/** 流封口（evidence_end.through）；null 表示未封口。 */
	endedThrough: number | null;
	/** 已接纳的 gap 区间（用于判断 gap ref 重复/冲突）。 */
	nextReceiveSeq: number;
}

export class ReceptionEngine {
	private streams = new Map<string, StreamReception>();
	/** 接收代次内单调 R；已在待落盘队列、尚未回报持久的条目。 */
	private pending: AcceptedEntry[] = [];
	private closed = false;

	constructor(
		private readonly receiver: Ref,
		private readonly events: ReceptionEvents,
	) {}

	/** durable 水位：连续持久前缀（含 gap 入项）。 */
	get durableThroughByStream(): Map<string, number> {
		return this.durableThroughCache;
	}

	private durableThroughCache = new Map<string, number>();

	handleNotice(notice: ClientFactNotice): void {
		if (this.closed) return;
		if (notice.kind === "evidence") {
			for (const record of notice.records) this.acceptFact(record);
		} else if (notice.kind === "evidence_gap") {
			this.acceptGap({
				ref: notice.ref,
				stream: notice.stream,
				after: notice.after,
				through: notice.through,
				reason: notice.reason,
			});
		} else if (notice.kind === "evidence_end") {
			this.endStream(notice.through.stream, notice.through.sequence);
		}
	}

	private streamState(stream: string): StreamReception {
		let state = this.streams.get(stream);
		if (!state) {
			state = { receivedThrough: 0, payloads: new Map(), gaps: new Map(), endedThrough: null, nextReceiveSeq: 0 };
			this.streams.set(stream, state);
			this.durableThroughCache.set(stream, 0);
		}
		return state;
	}

	private acceptFact(record: CapturedClientFact): void {
		const state = this.streamState(record.mark.stream);
		const seq = record.mark.sequence;
		if (!Number.isSafeInteger(seq) || seq < 1) {
			this.events.protocolFault(`证据序号非法：stream=${record.mark.stream} seq=${seq}`);
			return;
		}
		const existing = state.payloads.get(seq);
		if (existing) {
			if (existing.ref !== record.ref) {
				this.events.protocolFault(
					`同身份不同载荷：stream=${record.mark.stream} seq=${seq} ref=${existing.ref} vs ${record.ref}`,
				);
				return;
			}
			// 重传去重：不分配新 R，重新确认即可。
			this.publishAck(record.mark.stream);
			return;
		}
		// 未知后缀缺口只覆盖封口前的区间；其后到达的新捕获是正常新证据。
		state.payloads.set(seq, record);
		const entry: AcceptedEntry = { kind: "fact", receiveSeq: ++state.nextReceiveSeq, record };
		this.pending.push(entry);
		this.events.accepted([entry]);
		this.advance(state, record.mark.stream);
	}

	private acceptGap(gap: GapRecord): void {
		const state = this.streamState(gap.stream);
		const existing = state.gaps.get(gap.ref);
		if (existing) {
			// 同身份重传：区间必须一致；不一致是源协议故障。
			if (existing.after !== gap.after || existing.through !== gap.through) {
				this.events.protocolFault(
					`同 gap ref 区间变化：ref=${gap.ref} (${existing.after},${existing.through}] vs (${gap.after},${gap.through}]`,
				);
				return;
			}
			this.publishAck(gap.stream);
			return;
		}
		state.gaps.set(gap.ref, gap);
		const entry: AcceptedEntry = { kind: "gap", receiveSeq: ++state.nextReceiveSeq, gap };
		this.pending.push(entry);
		this.events.accepted([entry]);
		this.advance(state, gap.stream);
	}

	private endStream(stream: string, through: number): void {
		const state = this.streamState(stream);
		if (state.endedThrough !== null && state.endedThrough !== through) {
			this.events.protocolFault(`evidence_end 区间变化：stream=${stream} ${state.endedThrough} vs ${through}`);
			return;
		}
		state.endedThrough = through;
		this.advance(state, stream);
	}

	/** 尝试推进连续前缀并发布 ACK。 */
	private advance(state: StreamReception, stream: string): void {
		for (;;) {
			const next = state.receivedThrough + 1;
			if (state.payloads.has(next)) {
				state.receivedThrough = next;
				continue;
			}
			const covered = this.gapCovering(state, next);
			if (covered) {
				// 有限区间缺口直接覆盖；未知后缀缺口只在封口后覆盖 (after, endedThrough]。
				state.receivedThrough = covered;
				continue;
			}
			break;
		}
		this.publishAck(stream);
	}

	private gapCovering(state: StreamReception, seq: number): number | null {
		let furthest: number | null = null;
		for (const gap of state.gaps.values()) {
			if (gap.through !== null) {
				if (seq > gap.after && seq <= gap.through) furthest = Math.max(furthest ?? 0, gap.through);
				continue;
			}
			// 未知后缀：只有封口后才解析为有限区间 (after, endedThrough]。
			if (state.endedThrough !== null && seq > gap.after && seq <= state.endedThrough) {
				furthest = Math.max(furthest ?? 0, state.endedThrough);
			}
		}
		return furthest;
	}

	private publishAck(stream: string): void {
		const state = this.streams.get(stream);
		if (!state) return;
		const gaps: Ref[] = [];
		for (const gap of state.gaps.values()) {
			// 只列出与已确认前缀相交的缺口。
			const upper = gap.through ?? state.endedThrough ?? Number.POSITIVE_INFINITY;
			if (gap.after < state.receivedThrough && upper > 0) gaps.push(gap.ref);
		}
		const durable = this.durableThroughCache.get(stream) ?? 0;
		this.events.ackReady({
			receiver: this.receiver,
			stream,
			receivedThrough: state.receivedThrough,
			durableThrough: Math.min(durable, state.receivedThrough),
			gaps,
		});
	}

	/**
	 * 存储回报：这批条目已持久提交。durable 以源 E 计——推进到"每个 E 都有已持久载荷
	 * 或已持久缺口覆盖"的最大连续位置（与 receivedThrough 同一覆盖规则）；
	 * 返回本次有推进的 (stream → durableThrough)，供上层在同一同步步裁剪 tail 并发布。
	 */
	committed(entries: readonly AcceptedEntry[]): Map<string, number> {
		const advanced = new Set<string>();
		for (const entry of entries) {
			const stream = entry.kind === "fact" ? entry.record.mark.stream : entry.gap.stream;
			if (entry.kind === "fact") {
				let set = this.persistedFacts.get(stream);
				if (!set) {
					set = new Set();
					this.persistedFacts.set(stream, set);
				}
				set.add(entry.record.mark.sequence);
			} else {
				let set = this.persistedGaps.get(stream);
				if (!set) {
					set = new Set();
					this.persistedGaps.set(stream, set);
				}
				set.add(entry.gap.ref);
			}
			advanced.add(stream);
		}
		for (const stream of advanced) {
			const state = this.streams.get(stream)!;
			let durable = this.durableThroughCache.get(stream) ?? 0;
			for (;;) {
				const next = durable + 1;
				const payloadPersisted = this.persistedFacts.get(stream)?.has(next) ?? false;
				const gapCovered = this.persistedGapCovering(state, stream, next);
				if (!payloadPersisted && !gapCovered) break;
				durable = gapCovered ? Math.max(durable, gapCovered) : next;
			}
			const before = this.durableThroughCache.get(stream) ?? 0;
			if (durable > before) {
				this.durableThroughCache.set(stream, durable);
				this.publishAck(stream);
			}
		}
		return new Map(this.durableThroughCache);
	}

	/** 已持久缺口对指定 E 的覆盖（与 gapCovering 相同的封口规则）。 */
	private persistedGapCovering(state: StreamReception, stream: string, seq: number): number | null {
		const persisted = this.persistedGaps.get(stream);
		if (!persisted) return null;
		let furthest: number | null = null;
		for (const gap of state.gaps.values()) {
			if (!persisted.has(gap.ref)) continue;
			if (gap.through !== null) {
				if (seq > gap.after && seq <= gap.through) furthest = Math.max(furthest ?? 0, gap.through);
				continue;
			}
			if (state.endedThrough !== null && seq > gap.after && seq <= state.endedThrough) {
				furthest = Math.max(furthest ?? 0, state.endedThrough);
			}
		}
		return furthest;
	}

	private persistedFacts = new Map<string, Set<number>>();
	private persistedGaps = new Map<string, Set<string>>();

	/** 待落盘条目（不可变引用，供存储层批量提交）。 */
	takePending(): AcceptedEntry[] {
		return this.pending;
	}

	/** 指定流的未持久区间 (D, R]。历史切面固定时引用对应条目。 */
	tailSlice(stream: string, afterDurable: number, upToReceived: number): AcceptedEntry[] {
		return this.pending.filter((entry) => {
			const entryStream = entry.kind === "fact" ? entry.record.mark.stream : entry.gap.stream;
			if (entryStream !== stream) return false;
			return entry.receiveSeq > afterDurable && entry.receiveSeq <= upToReceived;
		});
	}

	close(): void {
		this.closed = true;
	}
}
