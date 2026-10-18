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
