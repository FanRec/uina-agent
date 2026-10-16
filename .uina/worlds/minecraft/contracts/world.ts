/**
 * World 读取、变化订阅与领域记录合同（lead 固定合同）。
 * 唯一设计来源：docs/proposals/mc/public-api.md §5。
 */

import type { ExactRef, JsonValue, Observation, ObservationCursor, Ref } from "./values.js";

export interface WorldQuery {
	ref: ExactRef;
	input: JsonValue;
}

export type WorldChange =
	| { kind: "changed"; cursor: ObservationCursor; changed: Ref[] }
	| { kind: "reset"; reason: "stream_changed" | "epoch_changed" | "cursor_expired"; cursor: ObservationCursor };

export interface WorldWatch {
	next(after: ObservationCursor, signal: AbortSignal): Promise<WorldChange>;
	close(): Promise<void>;
}

export interface DomainRecord {
	ref: Ref;
	schema: ExactRef;
	world: Ref;
	worldRevision: Ref;
	revision: number;
	value: JsonValue;
	evidence: Ref[];
}

export interface WorldReadPort {
	read<T>(query: WorldQuery): Promise<Observation<T>>;
	watch(query: WorldQuery, after: ObservationCursor, signal: AbortSignal): Promise<WorldWatch>;
	readRecord(ref: Ref): Promise<DomainRecord>;
}

/**
 * writeRecord 只供绑定领域所有者的 CallContext；
 * World 从真实当前调用核验存活、act/schema 所有权、分区及 CAS revision。
 */
export interface WorldPort extends WorldReadPort {
	writeRecord(change: {
		ref?: Ref;
		schema: ExactRef;
		world: Ref;
		worldRevision: Ref;
		expectedRevision: number | null;
		value: JsonValue;
		evidence: Ref[];
	}): Promise<DomainRecord>;
}

/** 仅注入 Runtime、Assets 等持久记录所有者，不属于脚本/普通能力写口。 */
export interface WorldEvidencePort {
	retain(owner: Ref, evidence: Ref[]): Promise<void>;
	release(owner: Ref): Promise<void>;
}

export interface WorldAvailabilityValue {
	current: { state: "starting" | "ready" | "unavailable"; reason?: string };
	history: { state: "opening" | "ready" | "read_only" | "unavailable"; reason?: string };
	binding: { state: "bound" | "unbound"; binding: Ref; world: Ref; worldRevision: Ref };
}
