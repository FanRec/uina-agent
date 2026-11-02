/**
 * 世界历史存储 Worker：node:sqlite 单连接，运行 world-history.db。
 *
 * 唯一定义来源：docs/proposals/mc/modules/world.md §5.3、§5.6、§11.2、§13.1。
 * 每条消息是一个原子边界；打开握手显式置 journal_mode=WAL + synchronous=FULL
 * 并回报实际生效值，不符即失败（不退化内存库）。durable 只推进"载荷或已持久
 * 缺口覆盖"的连续前缀，绝不用 MAX(已收序号) 越洞；入库前核对身份——同
 * (stream, seq) 必须同载荷 ref、同 gap ref 必须同区间，一致才幂等跳过，不一致
 * 报源协议冲突（不入库、不冒认持久）。流封口（evidence_end + fence）把
 * through=null 的未知尾后缀解析为有限区间后，durable 无需新提交即可推进。
 * Worker 文件经 tsx 以 .ts 源解析；构建产物必须携带本文件（I2 前接线，
 * §11.2：缺资产明确失败，不静默退化成内存实现）。
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";
import type { CapturedClientFact } from "../contracts/client-facts.js";
import type { JsonValue } from "../contracts/values.js";
import type { EventGap, WorldHistoryPrune, WorldHistoryPruneResult } from "../contracts/world.js";
import type { ContainerEvidence, ContainerQueryParams } from "./containers.js";
import type { EventQueryParams, EventQueryResult, EventRow } from "./events.js";

export interface AppendEvidenceItem {
	kind: "evidence";
	record: CapturedClientFact;
}

export interface AppendGapItem {
	kind: "gap";
	ref: string;
	stream: string;
	after: number;
	/** null = 末端未知（仅覆盖已知单个丢项 after+1；封口后按 fence 解析）。 */
	through: number | null;
	reason: string;
}

export type AppendItem = AppendEvidenceItem | AppendGapItem;

/** 领域记录写入（public-api §5）：CAS 与分区校验在 worker 单事务内完成。 */
export interface RecordWrite {
	ref?: string;
	schema: string;
	world: string;
	worldRevision: string;
	expectedRevision: number | null;
	value: JsonValue;
	evidence: string[];
}

export interface StoredRecordRow {
	ref: string;
	schema: string;
	world: string;
	worldRevision: string;
	revision: number;
	value: JsonValue;
	evidence: string[];
}

export interface RecordReadParams {
	world: string;
	worldRevision: string;
	ref: string;
}

/** 按确切 schema 列出分区记录（places@1 的存储面；kind/near 过滤在 World 值层做）。 */
export interface RecordsListParams {
	schema: string;
	world: string;
	worldRevision: string;
}

export interface RecordsListResult {
	rows: StoredRecordRow[];
	recordVersion: number;
}

export type WorkerRequest =
	| { type: "open"; dbPath: string }
	| { type: "append"; items: AppendItem[] }
	| { type: "streamEnd"; stream: string; fence: number }
	/** 提交屏障：worker 串行处理消息，回执即"此前消息都已提交"。 */
	| { type: "barrier"; id: number }
	| { type: "readEvents"; id: number; params: EventQueryParams }
	| { type: "readContainer"; id: number; params: ContainerQueryParams }
	| { type: "writeRecord"; id: number; change: RecordWrite }
	| { type: "readRecord"; id: number; params: RecordReadParams }
	| { type: "readRecords"; id: number; params: RecordsListParams }
	| { type: "removeRecord"; id: number; params: RecordReadParams }
	| { type: "retain"; id: number; owner: string; evidence: string[] }
	| { type: "release"; id: number; owner: string }
	| { type: "prune"; id: number; options: WorldHistoryPrune }
	| { type: "close" };

export interface DurableAck {
	stream: string;
	durableThrough: number;
}

export type WorkerResponse =
	| {
			type: "opened";
			journalMode: string;
			synchronousMode: string;
			watermarks: Record<string, number>;
			storage: string;
			version: number;
			recordVersion: number;
	  }
	| { type: "durable"; acks: DurableAck[]; version: number }
	| { type: "barrierReached"; id: number }
	| { type: "eventsPage"; id: number; result: EventQueryResult }
	| { type: "queryFailed"; id: number; code: string; message: string }
	| { type: "containerLast"; id: number; result: ContainerEvidence | null }
	| { type: "recordWritten"; id: number; record: StoredRecordRow; recordVersion: number }
	| { type: "recordResult"; id: number; record: StoredRecordRow | null }
	| { type: "recordsPage"; id: number; result: RecordsListResult }
	| { type: "recordRemoved"; id: number; removed: boolean; recordVersion: number }
	| { type: "retained"; id: number }
	| { type: "pruned"; id: number; result: WorldHistoryPruneResult }
	| { type: "conflict"; message: string }
	| { type: "fatal"; message: string }
	| { type: "closed" };

const SCHEMA_VERSION = "4";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS streams (
	stream TEXT PRIMARY KEY,
	binding TEXT NOT NULL,
	world TEXT NOT NULL,
	world_revision TEXT NOT NULL,
	source TEXT NOT NULL,
	schema TEXT NOT NULL,
	opened_at TEXT NOT NULL,
	first_seq INTEGER NOT NULL,
	ended INTEGER NOT NULL DEFAULT 0,
	ended_through INTEGER
);
CREATE TABLE IF NOT EXISTS evidence (
	store_seq INTEGER PRIMARY KEY AUTOINCREMENT,
	stream TEXT NOT NULL,
	seq INTEGER NOT NULL,
	ref TEXT NOT NULL,
	schema TEXT NOT NULL,
	stamp TEXT NOT NULL,
	scope TEXT NOT NULL,
	fact TEXT NOT NULL,
	observed_at TEXT NOT NULL,
	UNIQUE (stream, seq),
	UNIQUE (ref)
);
CREATE TABLE IF NOT EXISTS evidence_gaps (
	stream TEXT NOT NULL,
	after INTEGER NOT NULL,
	through INTEGER,
	ref TEXT NOT NULL,
	reason TEXT NOT NULL,
 visible_version INTEGER NOT NULL,
	PRIMARY KEY (stream, after)
);
CREATE TABLE IF NOT EXISTS watermarks (
	stream TEXT PRIMARY KEY,
	durable_through INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence_holds (
	owner TEXT NOT NULL,
	ref TEXT NOT NULL REFERENCES evidence(ref),
	PRIMARY KEY (owner, ref)
);
-- Compact deletion identities prevent source replay from resurrecting removed payloads.
CREATE TABLE IF NOT EXISTS pruned_evidence (
	store_seq INTEGER PRIMARY KEY,
	stream TEXT NOT NULL,
	seq INTEGER NOT NULL,
	ref TEXT NOT NULL,
	schema TEXT NOT NULL,
	event_kind TEXT,
	visible_version INTEGER NOT NULL,
	UNIQUE (stream, seq),
	UNIQUE (ref)
);
CREATE TABLE IF NOT EXISTS retention_gaps (
	ref TEXT PRIMARY KEY,
	binding TEXT NOT NULL,
	world TEXT NOT NULL,
	world_revision TEXT NOT NULL,
	visible_version INTEGER NOT NULL,
	events INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS event_highwater (
	binding TEXT NOT NULL,
	world TEXT NOT NULL,
	world_revision TEXT NOT NULL,
	store_seq INTEGER NOT NULL,
	PRIMARY KEY (binding, world, world_revision)
);
-- 领域记录（world.md §11.1）：分区 = world + worldRevision；dimension 在记录值里，
-- 不做顶层分区列。只保留最新修订值与单调 revision 计数，修订历史不逐版追加（§10.1）。
CREATE TABLE IF NOT EXISTS records (
	ref TEXT NOT NULL,
	schema TEXT NOT NULL,
	world TEXT NOT NULL,
	world_revision TEXT NOT NULL,
	revision INTEGER NOT NULL,
	value TEXT NOT NULL,
	evidence TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (world, world_revision, ref)
);
CREATE INDEX IF NOT EXISTS idx_evidence_schema ON evidence (schema);
CREATE INDEX IF NOT EXISTS idx_holds_ref ON evidence_holds (ref);
CREATE INDEX IF NOT EXISTS idx_streams_partition ON streams (binding, world, world_revision);
CREATE INDEX IF NOT EXISTS idx_records_schema ON records (schema, world, world_revision);
`;

/** 源协议冲突：同身份不同载荷（§5.3/§5.6）。 */
class SourceConflict extends Error {}

type Row = Record<string, string | number | bigint | Uint8Array | null>;

interface OpenedStorage {
	db: DatabaseSync;
	journalMode: string;
	synchronousMode: string;
}

function openDatabase(dbPath: string): OpenedStorage {
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA synchronous=FULL");
	db.exec("PRAGMA foreign_keys=ON");
	const journalRow = db.prepare("PRAGMA journal_mode").get() as Row;
	const syncRow = db.prepare("PRAGMA synchronous").get() as Row;
	const journalMode = String(journalRow.journal_mode);
	const syncLevel = Number(syncRow.synchronous);
	const syncNames: Record<number, string> = { 0: "off", 1: "normal", 2: "full", 3: "extra" };
	if (journalMode.toLowerCase() !== "wal" || syncLevel !== 2) {
		db.close();
		throw new Error(
			`持久性配置未生效：journal_mode=${journalMode} synchronous=${syncLevel}（要求 WAL/FULL；不退化内存库）`,
		);
	}
	db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined;
	if (versionRow == null) {
		db.exec("BEGIN");
		db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
		db.prepare("INSERT INTO meta (key,value) VALUES (?,?)").run("storage_id", randomUUID());
		db.prepare("INSERT INTO meta (key,value) VALUES (?,?)").run("commit_version", "0");
		db.prepare("INSERT INTO meta (key,value) VALUES (?,?)").run("record_version", "0");
		db.exec(SCHEMA_SQL);
		db.exec("COMMIT");
	} else if (String(versionRow.value) !== SCHEMA_VERSION) {
		db.close();
		throw new Error(`历史库 schema 版本不兼容：库=${String(versionRow.value)} 期望=${SCHEMA_VERSION}`);
	}
	db.exec(SCHEMA_SQL);
	return { db, journalMode: journalMode.toLowerCase(), synchronousMode: syncNames[syncLevel] ?? String(syncLevel) };
}

function historyIdentity(db: DatabaseSync): { storage: string; version: number } {
	const meta = db.prepare("SELECT key,value FROM meta WHERE key IN ('storage_id','commit_version')").all() as Row[];
	const values = Object.fromEntries(meta.map((row) => [String(row.key), String(row.value)]));
	const version = Number(values.commit_version);
	if (!values.storage_id || !Number.isSafeInteger(version) || version < 0)
		throw new Error("invalid history identity/version");
	return { storage: values.storage_id, version };
}
function bumpVersion(db: DatabaseSync, version: number): void {
	if (!Number.isSafeInteger(version)) throw new Error("history commit version exhausted");
	db.prepare("UPDATE meta SET value=? WHERE key='commit_version'").run(String(version));
}

/** 记录版本：只随记录写推进，驱动 places@1 的观察失效；不复用 commit_version。 */
function recordVersionOf(db: DatabaseSync): number {
	const row = db.prepare("SELECT value FROM meta WHERE key='record_version'").get() as Row | undefined;
	return row == null ? 0 : Number(row.value);
}

function bumpRecordVersion(db: DatabaseSync): number {
	const next = recordVersionOf(db) + 1;
	if (!Number.isSafeInteger(next)) throw new Error("record version exhausted");
	db.prepare(
		"INSERT INTO meta (key, value) VALUES ('record_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
	).run(String(next));
	return next;
}

/** 首个证据登记源流元数据（绑定、采集 schema、源身份、起点，§5.3）；重复登记必须一致。 */
function ensureStream(db: DatabaseSync, record: CapturedClientFact, version: number): void {
	const existing = db
		.prepare("SELECT binding, world, world_revision, source, schema FROM streams WHERE stream = ?")
		.get(record.mark.stream) as Row | undefined;
	if (existing == null) {
		db.prepare(
			"INSERT INTO streams (stream, binding, world, world_revision, source, schema, opened_at, first_seq, ended, ended_through) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)",
		).run(
			record.mark.stream,
			record.scope.binding,
			record.scope.world,
			record.scope.worldRevision,
			record.stamp.source,
			record.schema,
			record.fact.observedAt,
			record.mark.sequence,
		);
		db.prepare("UPDATE evidence_gaps SET visible_version=? WHERE stream=?").run(version, record.mark.stream);
		return;
	}
	const sameIdentity =
		existing.binding === record.scope.binding &&
		existing.world === record.scope.world &&
		existing.world_revision === record.scope.worldRevision &&
		existing.source === record.stamp.source;
	// streams.schema describes the first record; evidence.schema is authoritative for each payload.
	// One ordered source stream can contain both client.event@1 and client.window@1.
	if (!sameIdentity) {
		throw new SourceConflict(`stream ${record.mark.stream} 元数据与已登记不一致`);
	}
}

/** 封口 fence（streams.ended_through）；through=null 的缺口按它解析为有限区间。 */
function streamFence(db: DatabaseSync, stream: string): number | null {
	const row = db.prepare("SELECT ended_through FROM streams WHERE stream = ?").get(stream) as Row | undefined;
	return row == null ? null : row.ended_through == null ? null : Number(row.ended_through);
}

/**
 * 连续持久水位推进：每序号都有已持久载荷，或已被已持久缺口记录覆盖（§5.4）。
 * 绝不用 MAX(已收序号) 越过洞。through=null 的缺口只覆盖已知单个丢项，
 * 封口后覆盖到 fence 为止。
 */
function advanceWatermark(db: DatabaseSync, stream: string, from: number): number {
	const fence = streamFence(db, stream);
	const selectEvidence = db.prepare("SELECT 1 AS one FROM evidence WHERE stream = ? AND seq = ?");
	const selectGap = db.prepare("SELECT after, through FROM evidence_gaps WHERE stream = ? AND after = ?");
	let watermark = from;
	for (;;) {
		const seq = watermark + 1;
		if (selectEvidence.get(stream, seq) != null) {
			watermark = seq;
			continue;
		}
		const gap = selectGap.get(stream, watermark) as { after: number; through: number | null } | undefined;
		if (gap != null) {
			const end = gap.through ?? fence ?? watermark + 1;
			if (end > watermark) {
				watermark = end;
				continue;
			}
		}
		break;
	}
	return watermark;
}

function computeAcks(db: DatabaseSync, streams: Iterable<string>): DurableAck[] {
	const acks: DurableAck[] = [];
	for (const stream of streams) {
		const row = db.prepare("SELECT durable_through FROM watermarks WHERE stream = ?").get(stream) as Row | undefined;
		const previous = row == null ? 0 : Number(row.durable_through);
		const next = advanceWatermark(db, stream, previous);
		if (next === previous) continue;
		db.prepare(
			"INSERT INTO watermarks (stream, durable_through) VALUES (?, ?) ON CONFLICT(stream) DO UPDATE SET durable_through = excluded.durable_through",
		).run(stream, next);
		acks.push({ stream, durableThrough: next });
	}
	return acks;
}

/**
 * 单事务批量提交；返回本批推进的 durable ACK（提交完成后同一续体内发布）。
 * 身份核对（§5.6）：同 (stream, seq) 必须同载荷 ref、同 gap 位必须同 gap ref；
 * 一致幂等跳过，不一致抛源协议冲突（整批回滚、不入库）。
 */
function appendBatch(db: DatabaseSync, items: AppendItem[]): DurableAck[] {
	db.exec("BEGIN");
	try {
		const touched = new Set<string>();
		const version = historyIdentity(db).version + 1;
		let changed = false;
		for (const item of items) {
			if (item.kind === "evidence") {
				const record = item.record;
				touched.add(record.mark.stream);
				ensureStream(db, record, version);
				const existing = db
					.prepare(
						"SELECT ref FROM evidence WHERE stream = ? AND seq = ? UNION ALL SELECT ref FROM pruned_evidence WHERE stream = ? AND seq = ?",
					)
					.get(record.mark.stream, record.mark.sequence, record.mark.stream, record.mark.sequence) as Row | undefined;
				if (existing != null) {
					if (existing.ref !== record.ref) {
						throw new SourceConflict(
							`evidence (${record.mark.stream}, ${record.mark.sequence}) 已存在且 ref 不同：${String(existing.ref)} != ${record.ref}`,
						);
					}
					continue;
				}
				changed = true;
				db.prepare(
					"INSERT INTO evidence (stream, seq, ref, schema, stamp, scope, fact, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				).run(
					record.mark.stream,
					record.mark.sequence,
					record.ref,
					record.schema,
					JSON.stringify(record.stamp),
					JSON.stringify(record.scope),
					JSON.stringify(record.fact),
					record.fact.observedAt,
				);
				if (record.schema === "client.event@1") {
					db.prepare(`INSERT INTO event_highwater (binding, world, world_revision, store_seq)
						VALUES (?, ?, ?, last_insert_rowid()) ON CONFLICT(binding,world,world_revision)
						DO UPDATE SET store_seq=excluded.store_seq`).run(
						record.scope.binding,
						record.scope.world,
						record.scope.worldRevision,
					);
				}
				continue;
			}
			touched.add(item.stream);
			const existing = db
				.prepare("SELECT ref FROM evidence_gaps WHERE stream = ? AND after = ?")
				.get(item.stream, item.after) as Row | undefined;
			if (existing != null) {
				if (existing.ref !== item.ref) {
					throw new SourceConflict(
						`gap (${item.stream}, after ${item.after}) 已存在且 ref 不同：${String(existing.ref)} != ${item.ref}`,
					);
				}
				continue;
			}
			changed = true;
			db.prepare(
				"INSERT INTO evidence_gaps (stream, after, through, ref, reason,visible_version) VALUES (?, ?, ?, ?, ?,?)",
			).run(item.stream, item.after, item.through, item.ref, item.reason, version);
		}
		const acks = computeAcks(db, touched);
		if (changed) bumpVersion(db, version);
		db.exec("COMMIT");
		return acks;
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

/** 流封口：登记 fence 并重算水位——已持久缺口解析为有限区间后可无需新提交推进（§5.6）。 */
function closeStream(db: DatabaseSync, stream: string, fence: number): DurableAck[] {
	db.exec("BEGIN");
	try {
		const row = db.prepare("SELECT ended FROM streams WHERE stream = ?").get(stream) as Row | undefined;
		if (row != null) {
			db.prepare("UPDATE streams SET ended = 1, ended_through = ? WHERE stream = ?").run(fence, stream);
		}
		const acks = computeAcks(db, [stream]);
		db.exec("COMMIT");
		return acks;
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

function loadWatermarks(db: DatabaseSync): Record<string, number> {
	const rows = db.prepare("SELECT stream, durable_through FROM watermarks").all() as Row[];
	const out: Record<string, number> = {};
	for (const row of rows) out[String(row.stream)] = Number(row.durable_through);
	return out;
}

/** Persistent scan upper bound: deleting the tail never rolls incremental cursors back. */
function eventScanUpper(db: DatabaseSync, scope: EventQueryParams["scope"]): number {
	const row = db
		.prepare(`SELECT store_seq AS upper FROM event_highwater WHERE binding = ? AND world = ? AND world_revision = ?`)
		.get(scope.binding, scope.world, scope.worldRevision) as Row | undefined;
	return row == null ? 0 : Number(row.upper);
}

/** 分区内已知缺口；顺序按入账顺序，ref 稳定（重复读取同一 ref 不是新丢失）。 */
function readEventGaps(db: DatabaseSync, params: EventQueryParams, upper: number): EventGap[] {
	const scope = params.scope;
	const rows = db
		.prepare(
			`SELECT g.ref AS ref, g.after AS afterSeq, g.through AS throughSeq, g.reason AS reason
			 FROM evidence_gaps g JOIN streams s ON s.stream = g.stream
			 WHERE s.binding = ? AND s.world = ? AND s.world_revision = ?
 AND g.visible_version > ? AND g.visible_version <= ?
			 ORDER BY g.rowid ASC`,
		)
		.all(scope.binding, scope.world, scope.worldRevision, params.gapAfter, upper) as Row[];
	const retained = db
		.prepare(`SELECT ref, 'history_retention' AS reason FROM retention_gaps
		WHERE binding=? AND world=? AND world_revision=? AND events=1
		AND visible_version>? AND visible_version<=? ORDER BY visible_version, ref`)
		.all(scope.binding, scope.world, scope.worldRevision, params.gapAfter, upper) as Row[];
	return [...rows, ...retained].map((row) => ({
		ref: String(row.ref),
		reason: String(row.reason),
		// Source evidence sequence numbers cannot be passed as EventAfter tokens.
		after: null,
		through: null,
	}));
}

/**
 * 事件页读取：一条消息内完成（页内一致）。
 * 无 after 时取最近 limit 条并保持接收顺序；有 after 时按 rowid 升序读至固定上界，
 * limit+1 用于判断是否还有下一页。kind 过滤走 json_extract，不改变扫描上界。
 */
function readEvents(db: DatabaseSync, params: EventQueryParams): EventQueryResult {
	const identity = historyIdentity(db);
	if (params.storage !== null && params.storage !== identity.storage)
		throw Object.assign(new Error("events token belongs to another history database"), { code: "SNAPSHOT_EXPIRED" });
	const gapUpper = params.gapUpper ?? identity.version;
	const upper = params.upper ?? eventScanUpper(db, params.scope);
	const kindArgs = params.kinds ?? [];
	// Completed after tokens are incremental and report new gaps. Only a fixed
	// page loses its snapshot when material in its unread range was deleted.
	if (params.upper !== null) {
		const kindClause = params.kinds == null ? "" : ` AND p.event_kind IN (${params.kinds.map(() => "?").join(",")})`;
		const deleted = db
			.prepare(`SELECT 1 FROM pruned_evidence p JOIN streams s ON s.stream=p.stream
			WHERE p.schema='client.event@1' AND s.binding=? AND s.world=? AND s.world_revision=?
			AND p.store_seq>? AND p.store_seq<=? AND p.visible_version>?${kindClause} LIMIT 1`)
			.get(
				params.scope.binding,
				params.scope.world,
				params.scope.worldRevision,
				params.afterRowid ?? 0,
				upper,
				gapUpper,
				...kindArgs,
			);
		if (deleted)
			throw Object.assign(new Error("events page material was removed by history retention"), {
				code: "SNAPSHOT_EXPIRED",
			});
	}
	const kindClause =
		params.kinds == null
			? ""
			: ` AND json_extract(e.fact, '$.value.kind') IN (${params.kinds.map(() => "?").join(", ")})`;
	const where = `FROM evidence e JOIN streams s ON s.stream = e.stream
		WHERE e.schema = 'client.event@1' AND s.binding = ? AND s.world = ? AND s.world_revision = ?
		AND e.store_seq <= ?${kindClause}`;
	const select =
		"SELECT e.store_seq AS rowid, e.ref AS ref, e.observed_at AS observed_at, e.scope AS scope, e.fact AS fact";
	const baseArgs = [params.scope.binding, params.scope.world, params.scope.worldRevision, upper, ...kindArgs];

	let raw: Row[];
	let hasMore = false;
	if (params.afterRowid == null) {
		// 最近窗口只取尾部；hasMore 不适用（尾部就是本次交付范围）。
		raw = db.prepare(`${select} ${where} ORDER BY e.store_seq DESC LIMIT ?`).all(...baseArgs, params.limit) as Row[];
		raw.reverse();
	} else {
		raw = db
			.prepare(`${select} ${where} AND e.store_seq > ? ORDER BY e.store_seq ASC LIMIT ?`)
			.all(...baseArgs, params.afterRowid, params.limit + 1) as Row[];
		if (raw.length > params.limit) {
			hasMore = true;
			raw = raw.slice(0, params.limit);
		}
	}

	const rows: EventRow[] = raw.map((row) => {
		const fact = JSON.parse(String(row.fact)) as { value?: JsonValue };
		const scope = JSON.parse(String(row.scope)) as { dimension?: string | null };
		return {
			rowid: Number(row.rowid),
			ref: String(row.ref),
			observedAt: String(row.observed_at),
			dimension: scope.dimension ?? null,
			payload: (fact.value ?? null) as unknown as EventRow["payload"],
		};
	});
	return {
		rows,
		gaps: readEventGaps(db, params, gapUpper),
		upper,
		hasMore,
		storage: identity.storage,
		version: identity.version,
		gapUpper,
	};
}

/** Latest committed observation in the explicit world/dimension/block, across capture bindings. */
function readContainer(db: DatabaseSync, params: ContainerQueryParams): ContainerEvidence | null {
	const row = db
		.prepare(`SELECT e.ref, e.fact FROM evidence e JOIN streams s ON s.stream = e.stream
		WHERE e.schema = 'client.window@1' AND s.world = ? AND s.world_revision = ?
		AND json_extract(e.fact, '$.value.target.place.world') = ?
		AND json_extract(e.fact, '$.value.target.place.worldRevision') = ?
		AND json_extract(e.fact, '$.value.target.place.dimension') = ?
		AND json_extract(e.fact, '$.value.target.block.x') = ?
		AND json_extract(e.fact, '$.value.target.block.y') = ?
		AND json_extract(e.fact, '$.value.target.block.z') = ?
		ORDER BY e.store_seq DESC LIMIT 1`)
		.get(
			params.world,
			params.worldRevision,
			params.world,
			params.worldRevision,
			params.dimension,
			params.block.x,
			params.block.y,
			params.block.z,
		) as Row | undefined;
	return row == null ? null : { ref: String(row.ref), fact: JSON.parse(String(row.fact)) as ContainerEvidence["fact"] };
}

function inputFailure(message: string, code = "INVALID_INPUT"): Error {
	return Object.assign(new Error(message), { code });
}

// ---- 领域记录（world.md §10；每条消息一个事务边界） ----

function validateRecordWrite(change: RecordWrite): void {
	if (
		typeof change.schema !== "string" ||
		!change.schema.trim() ||
		typeof change.world !== "string" ||
		!change.world.trim() ||
		typeof change.worldRevision !== "string" ||
		!change.worldRevision.trim()
	)
		throw inputFailure("record write requires nonempty schema/world/worldRevision");
	if (
		change.expectedRevision !== null &&
		(!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 1)
	)
		throw inputFailure("expectedRevision must be null (create) or a positive revision");
	if (change.value === undefined) throw inputFailure("record value is required");
	if (!Array.isArray(change.evidence) || change.evidence.some((ref) => typeof ref !== "string" || !ref.trim()))
		throw inputFailure("record evidence must be an array of nonempty immutable references");
	if (change.ref !== undefined && (typeof change.ref !== "string" || !change.ref.trim()))
		throw inputFailure("record ref must be a nonempty reference when provided");
}

function storedRecord(row: Row, partition: { world: string; worldRevision: string }): StoredRecordRow {
	return {
		ref: String(row.ref),
		schema: String(row.schema),
		world: partition.world,
		worldRevision: partition.worldRevision,
		revision: Number(row.revision),
		value: JSON.parse(String(row.value)) as JsonValue,
		evidence: JSON.parse(String(row.evidence)) as string[],
	};
}

function writeRecordOp(db: DatabaseSync, change: RecordWrite): { record: StoredRecordRow; recordVersion: number } {
	validateRecordWrite(change);
	db.exec("BEGIN");
	try {
		// §6.2：引用证据的记录写入不建立悬空持久引用——被引证据必须已在库。
		for (const ref of new Set(change.evidence)) {
			if (!db.prepare("SELECT 1 FROM evidence WHERE ref=?").get(ref))
				throw inputFailure(`evidence is unavailable: ${ref}`, "EVIDENCE_UNAVAILABLE");
		}
		const evidence = JSON.stringify([...new Set(change.evidence)]);
		const value = JSON.stringify(change.value);
		const now = new Date().toISOString();
		if (change.expectedRevision === null) {
			const ref = change.ref ?? `rec:${randomUUID()}`;
			const existing = db
				.prepare("SELECT 1 FROM records WHERE world=? AND world_revision=? AND ref=?")
				.get(change.world, change.worldRevision, ref);
			if (existing != null) throw inputFailure(`record already exists: ${ref}`, "CONFLICT");
			db.prepare(
				"INSERT INTO records (ref, schema, world, world_revision, revision, value, evidence, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
			).run(ref, change.schema, change.world, change.worldRevision, value, evidence, now);
			const recordVersion = bumpRecordVersion(db);
			db.exec("COMMIT");
			return {
				record: {
					ref,
					schema: change.schema,
					world: change.world,
					worldRevision: change.worldRevision,
					revision: 1,
					value: change.value,
					evidence: JSON.parse(evidence) as string[],
				},
				recordVersion,
			};
		}
		if (typeof change.ref !== "string") throw inputFailure("record update requires an explicit record ref");
		const existing = db
			.prepare("SELECT schema, revision FROM records WHERE world=? AND world_revision=? AND ref=?")
			.get(change.world, change.worldRevision, change.ref) as Row | undefined;
		if (existing == null) throw inputFailure(`record does not exist: ${change.ref}`, "NOT_FOUND");
		if (Number(existing.revision) !== change.expectedRevision)
			throw inputFailure(
				`record revision moved: expected ${change.expectedRevision}, actual ${Number(existing.revision)}`,
				"CONFLICT",
			);
		if (String(existing.schema) !== change.schema)
			throw inputFailure("record schema cannot change on revision", "CONFLICT");
		db.prepare(
			"UPDATE records SET revision=revision+1, value=?, evidence=?, updated_at=? WHERE world=? AND world_revision=? AND ref=? AND revision=?",
		).run(value, evidence, now, change.world, change.worldRevision, change.ref, change.expectedRevision);
		const recordVersion = bumpRecordVersion(db);
		db.exec("COMMIT");
		return {
			record: {
				ref: change.ref as string,
				schema: change.schema,
				world: change.world,
				worldRevision: change.worldRevision,
				revision: change.expectedRevision + 1,
				value: change.value,
				evidence: JSON.parse(evidence) as string[],
			},
			recordVersion,
		};
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

function readRecordOp(db: DatabaseSync, params: RecordReadParams): StoredRecordRow | null {
	const row = db
		.prepare("SELECT ref, schema, revision, value, evidence FROM records WHERE world=? AND world_revision=? AND ref=?")
		.get(params.world, params.worldRevision, params.ref) as Row | undefined;
	return row == null ? null : storedRecord(row, { world: params.world, worldRevision: params.worldRevision });
}

function readRecordsOp(db: DatabaseSync, params: RecordsListParams): RecordsListResult {
	if (typeof params.schema !== "string" || !params.schema.trim())
		throw inputFailure("record list requires a nonempty schema");
	const rows = db
		.prepare(
			"SELECT ref, schema, revision, value, evidence FROM records WHERE schema=? AND world=? AND world_revision=? ORDER BY ref ASC",
		)
		.all(params.schema, params.world, params.worldRevision) as Row[];
	const partition = { world: params.world, worldRevision: params.worldRevision };
	return { rows: rows.map((row) => storedRecord(row, partition)), recordVersion: recordVersionOf(db) };
}

function removeRecordOp(db: DatabaseSync, params: RecordReadParams): { removed: boolean; recordVersion: number } {
	db.exec("BEGIN");
	try {
		const result = db
			.prepare("DELETE FROM records WHERE world=? AND world_revision=? AND ref=?")
			.run(params.world, params.worldRevision, params.ref);
		const removed = Number(result.changes) > 0;
		const recordVersion = removed ? bumpRecordVersion(db) : recordVersionOf(db);
		db.exec("COMMIT");
		return { removed, recordVersion };
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

function checkOwner(owner: string): void {
	if (typeof owner !== "string" || !owner.trim()) throw inputFailure("a durable evidence owner is required");
}

/** Existence check and additive registration share the same writer transaction as prune. */
function retain(db: DatabaseSync, owner: string, evidence: string[]): void {
	checkOwner(owner);
	if (!Array.isArray(evidence) || evidence.some((ref) => typeof ref !== "string" || !ref.trim()))
		throw inputFailure("evidence must contain nonempty immutable references");
	db.exec("BEGIN");
	try {
		for (const ref of new Set(evidence)) {
			if (!db.prepare("SELECT 1 FROM evidence WHERE ref=?").get(ref))
				throw inputFailure(`evidence is unavailable: ${ref}`, "EVIDENCE_UNAVAILABLE");
			db.prepare("INSERT OR IGNORE INTO evidence_holds (owner, ref) VALUES (?, ?)").run(owner, ref);
		}
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

/** Explicit maintenance only. No wall-clock policy, background expiry or implicit data root. */
function prune(db: DatabaseSync, options: WorldHistoryPrune): WorldHistoryPruneResult {
	const { partition, beforeStoreSeq } = options;
	if (
		!partition ||
		[partition.binding, partition.world, partition.worldRevision].some(
			(value) => typeof value !== "string" || !value.trim(),
		) ||
		!Number.isSafeInteger(beforeStoreSeq) ||
		beforeStoreSeq < 0
	)
		throw inputFailure(
			"prune requires an explicit binding/world/worldRevision partition and nonnegative safe beforeStoreSeq",
		);
	let removed = 0;
	for (;;) {
		const batch = pruneBatch(db, options);
		removed += batch.removed;
		if (batch.removed < PRUNE_BATCH_SIZE) {
			const retained = db
				.prepare(`SELECT MIN(e.store_seq) AS oldest,
			SUM(CASE WHEN e.store_seq<? THEN 1 ELSE 0 END) AS protected
			FROM evidence e JOIN streams s ON s.stream=e.stream
			WHERE s.binding=? AND s.world=? AND s.world_revision=?
			AND e.schema IN ('client.event@1','client.window@1')`)
				.get(beforeStoreSeq, partition.binding, partition.world, partition.worldRevision);
			return {
				removed,
				version: batch.version,
				beforeStoreSeq,
				skippedRetained: Number(retained?.protected ?? 0),
				oldestRetainedStoreSeq: retained?.oldest == null ? null : Number(retained.oldest),
			};
		}
	}
}

/** Work chunk size bounds each transaction, never the caller's total retention range. */
const PRUNE_BATCH_SIZE = 256;

function pruneBatch(
	db: DatabaseSync,
	options: WorldHistoryPrune,
): Pick<WorldHistoryPruneResult, "removed" | "version"> {
	const { partition, beforeStoreSeq } = options;
	db.exec("BEGIN");
	try {
		// Current history reads copy their complete SQL result inside a worker message.
		// No read transaction/material pointer escapes that message, so this same
		// serialized writer boundary also protects every active read. Future pages
		// are validated against deletion identities instead of silently changing version.
		const rows = db
			.prepare(`SELECT e.store_seq, e.stream, e.seq, e.ref, e.schema,
			json_extract(e.fact, '$.value.kind') AS event_kind FROM evidence e JOIN streams s ON s.stream=e.stream
			WHERE s.binding=? AND s.world=? AND s.world_revision=? AND e.store_seq<?
			AND e.schema IN ('client.event@1','client.window@1')
			AND NOT EXISTS (SELECT 1 FROM evidence_holds h WHERE h.ref=e.ref)
			AND NOT (e.schema='client.window@1' AND COALESCE(json_type(e.fact,'$.value.target.block')='object',0)
				AND NOT EXISTS (SELECT 1 FROM evidence newer JOIN streams ns ON ns.stream=newer.stream
					WHERE newer.schema='client.window@1' AND newer.store_seq>e.store_seq
					AND ns.world=s.world AND ns.world_revision=s.world_revision
					AND json_extract(newer.fact,'$.value.target.place.world')=json_extract(e.fact,'$.value.target.place.world')
					AND json_extract(newer.fact,'$.value.target.place.worldRevision')=json_extract(e.fact,'$.value.target.place.worldRevision')
					AND json_extract(newer.fact,'$.value.target.place.dimension')=json_extract(e.fact,'$.value.target.place.dimension')
					AND json_extract(newer.fact,'$.value.target.block.x')=json_extract(e.fact,'$.value.target.block.x')
					AND json_extract(newer.fact,'$.value.target.block.y')=json_extract(e.fact,'$.value.target.block.y')
					AND json_extract(newer.fact,'$.value.target.block.z')=json_extract(e.fact,'$.value.target.block.z')))
			ORDER BY e.store_seq LIMIT ${PRUNE_BATCH_SIZE}`)
			.all(partition.binding, partition.world, partition.worldRevision, beforeStoreSeq) as Row[];
		const version = historyIdentity(db).version + (rows.length > 0 ? 1 : 0);
		for (const row of rows) {
			db.prepare(`INSERT INTO pruned_evidence (store_seq, stream, seq, ref, schema, event_kind, visible_version)
				VALUES (?,?,?,?,?,?,?)`).run(row.store_seq, row.stream, row.seq, row.ref, row.schema, row.event_kind, version);
			db.prepare("DELETE FROM evidence WHERE store_seq=?").run(row.store_seq);
		}
		if (rows.length > 0) {
			const ref = `retention:${historyIdentity(db).storage}:${version}`;
			db.prepare(
				`INSERT INTO retention_gaps (ref,binding,world,world_revision,visible_version,events) VALUES (?,?,?,?,?,?)`,
			).run(
				ref,
				partition.binding,
				partition.world,
				partition.worldRevision,
				version,
				rows.some((row) => row.schema === "client.event@1") ? 1 : 0,
			);
			bumpVersion(db, version);
		}
		db.exec("COMMIT");
		return { removed: rows.length, version };
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

if (parentPort == null) {
	throw new Error("sqlite-worker 必须以 worker_threads Worker 启动");
}
const port = parentPort;
let db: DatabaseSync | null = null;

port.on("message", (request: WorkerRequest) => {
	try {
		if (request.type === "open") {
			if (db != null) throw new Error("storage already opened");
			const opened = openDatabase(request.dbPath);
			db = opened.db;
			port.postMessage({
				type: "opened",
				journalMode: opened.journalMode,
				synchronousMode: opened.synchronousMode,
				watermarks: loadWatermarks(opened.db),
				...historyIdentity(opened.db),
				recordVersion: recordVersionOf(opened.db),
			} satisfies WorkerResponse);
			return;
		}
		if (db == null) throw new Error("storage is not opened");
		if (request.type === "append") {
			const acks = appendBatch(db, request.items);
			port.postMessage({ type: "durable", acks, version: historyIdentity(db).version } satisfies WorkerResponse);
			return;
		}
		if (request.type === "streamEnd") {
			const acks = closeStream(db, request.stream, request.fence);
			port.postMessage({ type: "durable", acks, version: historyIdentity(db).version } satisfies WorkerResponse);
			return;
		}
		if (request.type === "barrier") {
			port.postMessage({ type: "barrierReached", id: request.id } satisfies WorkerResponse);
			return;
		}
		if (request.type === "readEvents") {
			const result = readEvents(db, request.params);
			port.postMessage({ type: "eventsPage", id: request.id, result } satisfies WorkerResponse);
			return;
		}
		if (request.type === "readContainer") {
			port.postMessage({
				type: "containerLast",
				id: request.id,
				result: readContainer(db, request.params),
			} satisfies WorkerResponse);
			return;
		}
		if (request.type === "writeRecord") {
			const { record, recordVersion } = writeRecordOp(db, request.change);
			port.postMessage({ type: "recordWritten", id: request.id, record, recordVersion } satisfies WorkerResponse);
			return;
		}
		if (request.type === "readRecord") {
			port.postMessage({
				type: "recordResult",
				id: request.id,
				record: readRecordOp(db, request.params),
			} satisfies WorkerResponse);
			return;
		}
		if (request.type === "readRecords") {
			port.postMessage({
				type: "recordsPage",
				id: request.id,
				result: readRecordsOp(db, request.params),
			} satisfies WorkerResponse);
			return;
		}
		if (request.type === "removeRecord") {
			port.postMessage({
				type: "recordRemoved",
				id: request.id,
				...removeRecordOp(db, request.params),
			} satisfies WorkerResponse);
			return;
		}
		if (request.type === "retain" || request.type === "release") {
			if (request.type === "retain") retain(db, request.owner, request.evidence);
			else {
				checkOwner(request.owner);
				db.prepare("DELETE FROM evidence_holds WHERE owner=?").run(request.owner);
			}
			port.postMessage({ type: "retained", id: request.id } satisfies WorkerResponse);
			return;
		}
		if (request.type === "prune") {
			const result = prune(db, request.options);
			port.postMessage({ type: "pruned", id: request.id, result } satisfies WorkerResponse);
			return;
		}
		db.close();
		db = null;
		port.postMessage({ type: "closed" } satisfies WorkerResponse);
		port.close();
	} catch (err) {
		const code = (err as { code?: string }).code ?? "";
		const domainFailure =
			(request.type === "readEvents" && code === "SNAPSHOT_EXPIRED") ||
			((request.type === "retain" || request.type === "release" || request.type === "prune") &&
				["INVALID_INPUT", "EVIDENCE_UNAVAILABLE"].includes(code)) ||
			((request.type === "writeRecord" ||
				request.type === "readRecord" ||
				request.type === "readRecords" ||
				request.type === "removeRecord") &&
				["INVALID_INPUT", "EVIDENCE_UNAVAILABLE", "CONFLICT", "NOT_FOUND"].includes(code));
		if (domainFailure) {
			port.postMessage({
				type: "queryFailed",
				id: request.id,
				code,
				message: messageOf(err),
			} satisfies WorkerResponse);
		} else if (err instanceof SourceConflict) {
			port.postMessage({ type: "conflict", message: messageOf(err) } satisfies WorkerResponse);
		} else {
			port.postMessage({ type: "fatal", message: messageOf(err) } satisfies WorkerResponse);
		}
	}
});
