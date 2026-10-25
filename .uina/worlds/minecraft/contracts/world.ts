/**
 * World 公共合同：读取、变化订阅与领域记录。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §5。World 实现端口；
 * Runtime/能力经 read/watch/writeRecord 使用；Watch 是复查提示不是事件日志。
 */

import type { ExactRef, JsonValue, Observation, ObservationCursor, Ref } from "./values.js";

export interface WorldQuery {
	ref: ExactRef;
	input: JsonValue;
}

export type WorldChange =
	| { kind: "changed"; cursor: ObservationCursor; changed: Ref[] }
	| {
			kind: "reset";
			reason: "stream_changed" | "epoch_changed" | "cursor_expired";
			cursor: ObservationCursor;
	  };

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

/** 只给实际持有跨库强引用的可信记录所有者；不注入 guest。 */
export interface WorldEvidencePort {
	retain(owner: Ref, evidence: Ref[]): Promise<void>;
	release(owner: Ref): Promise<void>;
}

export interface WorldAvailabilityValue {
	current: { state: "starting" | "ready" | "unavailable"; reason?: string };
	history: {
		state: "opening" | "ready" | "read_only" | "unavailable";
		reason?: string;
	};
	binding: {
		state: "bound" | "unbound";
		binding: Ref;
		world: Ref;
		worldRevision: Ref;
	};
}

/** 领域检查点 schema 注册项（DomainCheckpoint 用；ProgramCheckpoint 不进此表）。 */
export interface CheckpointSchemaDefinition {
	ref: ExactRef;
	value: import("./values.js").JsonSchema;
}

// ---- events@1（历史视图） ----

export type GameEventKind = "chat" | "damage" | "death" | "connection";

/** 一条已保存的客户端事件；顺序是本机接收/入账顺序，不是服务端全局因果顺序。 */
export interface GameEventRecord {
	ref: Ref;
	receivedAt: string;
	dimension: string | null;
	payload: JsonValue;
	evidence: Ref[];
}

/** 采集缺口：只描述本机选定保留范围内的已知丢失。 */
export interface EventGap {
	ref: Ref;
	reason: string;
	after: string | null;
	through: string | null;
}

/**
 * 一页事件。分页未读完时给 next（固定过滤与上界），读完后给 after
 * （指向本次扫描上界，用于后续增量读取）；两者互斥。
 */
export interface EventPage {
	events: GameEventRecord[];
	gaps: EventGap[];
	next?: string;
	after?: string;
}
