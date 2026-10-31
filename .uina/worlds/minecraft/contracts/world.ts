/**
 * World 公共合同：读取、变化订阅与领域记录。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §5。World 实现端口；
 * Runtime/能力经 read/watch/writeRecord 使用；Watch 是复查提示不是事件日志。
 */

import type { ExactRef, JsonValue, Observation, ObservationCursor, Ref, Vec3 } from "./values.js";

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
	/** 显式删除（forget@1）：按当前绑定分区；不存在返回 removed:false，能力据此转 NOT_FOUND。 */
	removeRecord(ref: Ref): Promise<{ removed: boolean }>;
}

/** 只给实际持有跨库强引用的可信记录所有者；不注入 guest。 */
export interface WorldEvidencePort {
	retain(owner: Ref, evidence: Ref[]): Promise<void>;
	release(owner: Ref): Promise<void>;
}

// ---- route.plan@1（试算；public-api §5） ----

export type RoutePlanAction = "walk" | "dig" | "place" | "jump";

export interface RoutePlanStep {
	at: Vec3;
	action: RoutePlanAction;
}

export interface RoutePlanBlocker {
	at: Vec3;
	reason: string;
}

export interface RoutePlanResult {
	ok: boolean;
	distance: number;
	steps: RoutePlanStep[];
	needs: { dig: number; place: number };
	blockers: RoutePlanBlocker[];
	/** 由寻路代价折算的估计值；上游不提供代价时如实 null。 */
	estTimeSec: number | null;
}

/**
 * route.plan@1 的窄计划端口：组合根用 Driver 受控寻路实现后注入 World；
 * World 只按 ref 分派，不依赖 Driver。计划是只读试算，不占控制、不产生效果。
 */
export interface WorldRoutePlanner {
	plan(query: WorldQuery): Promise<RoutePlanResult>;
}

// ---- surface@1 的窄探测端口（G3 站立/露天判据；public-api §5） ----

/**
 * surface@1 的窄探测端口：组合根用 Driver 客户端本地区块实现后注入能力层；
 * 能力只拿布尔/坐标结论，不触碰客户端对象。判据回答"能不能站/是否露天"，
 * 不替代 goto 的 GoalNear 完成语义（development-plan §10.6）。
 * 断线或未加载区块 → null（未知，不猜）；这不是失败，由调用方按未知处理。
 * 方法是异步的：本地列扫描可能上万次 blockAt，实现必须在列间让出事件循环，
 * 不能把心跳饿死（批11 经验 2 的翻版）。
 */
export interface SurfaceProbe {
	/** 站立判据：脚下实心、脚/头两格非固体且非液体。 */
	standable(at: Vec3): Promise<boolean | null>;
	/** 露天判据：所在柱自世界顶向下第一个实体块在头顶之上（天空可见，液体不遮天）。 */
	skyOpen(at: Vec3): Promise<boolean | null>;
	/** 半径内最近的露天可站整数格（脚位），螺旋就近早退；无 → null。 */
	findSkyAccess(center: Vec3, radius: number): Promise<Vec3 | null>;
}

/** Trusted maintenance only: exact capture partition and exclusive local storage cutoff. */
export interface WorldHistoryPrune {
	partition: { binding: Ref; world: Ref; worldRevision: Ref };
	beforeStoreSeq: number;
}

export interface WorldHistoryPruneResult {
	removed: number;
	skippedRetained: number;
	beforeStoreSeq: number;
	/** Earliest remaining selected evidence; gaps still describe holes after it. */
	oldestRetainedStoreSeq: number | null;
	version: number;
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
