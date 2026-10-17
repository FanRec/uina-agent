/**
 * Driver → World 证据接收引擎（docs/proposals/mc/modules/world.md §5）。
 *
 * 关键不变量：
 * - 接收前缀的每个序号必须有实际载荷或可解析的显式缺口；绝不用最大序号冒充连续确认。
 * - through=null 的未知后缀缺口不授权越过无限序号；封口（evidence_end）后才闭合为有限区间。
 * - 同一 (stream, E) 的重传必须同载荷；同身份不同载荷是源协议故障，不覆盖。
 * - durable 只在连续前缀持久后推进（每个序号都有已持久载荷或已持久缺口覆盖）；
 *   durable 单调不回退，MAX(已收序号) 不是水位。
 * - reset 不清除已捕获证据；迟到旧流材料可补历史，不恢复当前覆盖。
 *
 * 对外 ACK 只有 durableThrough 一层（同域部署无第二消费者）；received 前缀、
 * 缺口账本与去重是内部事实，不进入公共合同。跨域重传协议留待真正拆域时引入。
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

export type AcceptedEntry = { kind: "fact"; record: CapturedClientFact } | { kind: "gap"; gap: GapRecord };

export interface ReceptionEvents {
	/** 新接纳项（含 gap）进入待落盘队列；实现负责持久化并在提交后回报 committed。 */
	accepted(entries: AcceptedEntry[]): void;
	/** durable ACK 已更新（前缀持久推进）。 */
	ackReady(ack: ClientEvidenceAck): void;
	/** 同身份不同载荷等源协议故障；保留诊断，不覆盖。 */
	protocolFault(message: string): void;
}

interface StreamReception {
	/** 连续已对账前缀（内部：驱动缺口解析与 durable 覆盖判断）。 */
	receivedThrough: number;
	/** 已收载荷（含前缀内与前缀外的缓冲）。 */
	payloads: Map<number, CapturedClientFact>;
	/** 登记的缺口。 */
	gaps: Map<Ref, GapRecord>;
	/** 流封口（evidence_end.through）；null 表示未封口。 */
	endedThrough: number | null;
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
			state = { receivedThrough: 0, payloads: new Map(), gaps: new Map(), endedThrough: null };
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
		const entry: AcceptedEntry = { kind: "fact", record };
		this.pending.push(entry);
		this.events.accepted([entry]);
		this.advance(state, record.mark.stream);
	}

	private acceptGap(gap: GapRecord): void {
		const state = this.streamState(gap.stream);
		if (
			!Number.isSafeInteger(gap.after) ||
			gap.after < 0 ||
			(gap.through !== null && (!Number.isSafeInteger(gap.through) || gap.through <= gap.after))
		) {
			this.events.protocolFault(`缺口区间非法：ref=${gap.ref} (${gap.after},${gap.through}]`);
			return;
		}
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
		const entry: AcceptedEntry = { kind: "gap", gap };
		this.pending.push(entry);
		this.events.accepted([entry]);
		this.advance(state, gap.stream);
	}

	private endStream(stream: string, through: number): void {
		if (!Number.isSafeInteger(through) || through < 1) {
			this.events.protocolFault(`evidence_end 非法：stream=${stream} through=${through}`);
			return;
		}
		const state = this.streamState(stream);
		if (state.endedThrough !== null && state.endedThrough !== through) {
			this.events.protocolFault(`evidence_end 区间变化：stream=${stream} ${state.endedThrough} vs ${through}`);
			return;
		}
		state.endedThrough = through;
		this.advance(state, stream);
		// 封口可能把已持久缺口解析为有限区间 → durable 无需新提交即可推进。
		this.advanceDurable(stream);
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
		const durable = this.durableThroughCache.get(stream) ?? 0;
		this.events.ackReady({
			receiver: this.receiver,
			stream,
			durableThrough: durable,
		});
	}

	/**
	 * 存储回报：这批条目已持久提交。durable 以源 E 计——推进到"每个 E 都有已持久载荷
	 * 或已持久缺口覆盖"的最大连续位置；同一续体内发布 durable ACK。
	 */
	committed(entries: readonly AcceptedEntry[]): Map<string, number> {
		const committed = new Set(entries);
		// 发布 (v, D) 与从待落盘队列移除对应项在同一同步步完成（world.md §5.6）。
		this.pending = this.pending.filter((entry) => !committed.has(entry));
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
		for (const stream of advanced) this.advanceDurable(stream);
		return new Map(this.durableThroughCache);
	}

	/**
	 * 重算 durable：推进到"每个序号都有已持久载荷或已持久缺口覆盖"的最大连续位置；
	 * 有推进则发布 durable ACK。提交完成与流封口两个时机调用。
	 */
	private advanceDurable(stream: string): void {
		const state = this.streams.get(stream);
		if (!state) return;
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

	/** 待落盘条目（不可变引用快照；持久提交成功后由 committed 移除）。 */
	takePending(): AcceptedEntry[] {
		return [...this.pending];
	}

	/** 指定证据 ref 是否在待落盘队列（存在性校验用）。 */
	hasPendingRef(ref: Ref): boolean {
		return this.pending.some((entry) => (entry.kind === "fact" ? entry.record.ref : entry.gap.ref) === ref);
	}

	/**
	 * 崩溃恢复：从存储播种已持久事实/gap，使新接收代次的 durable ACK 从真实持久状态起步
	 * （不继承旧进程 RAM ACK；receivedThrough 由源重放重建，重传去重不重复入库）。
	 */
	restore(stream: string, persisted: { factSeqs: number[]; gapRefs: string[] }): void {
		this.streamState(stream);
		this.persistedFacts.set(stream, new Set(persisted.factSeqs));
		this.persistedGaps.set(stream, new Set(persisted.gapRefs));
		const state = this.streams.get(stream)!;
		let durable = 0;
		for (;;) {
			const next = durable + 1;
			const payloadPersisted = this.persistedFacts.get(stream)?.has(next) ?? false;
			const gapCovered = this.persistedGapCovering(state, stream, next);
			if (!payloadPersisted && !gapCovered) break;
			durable = gapCovered ? Math.max(durable, gapCovered) : next;
		}
		this.durableThroughCache.set(stream, durable);
	}

	close(): void {
		this.closed = true;
	}
}
