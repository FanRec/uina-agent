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

import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";
import type { CapturedClientFact } from "../contracts/client-facts.js";

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

export type WorkerRequest =
	| { type: "open"; dbPath: string }
	| { type: "append"; items: AppendItem[] }
	| { type: "streamEnd"; stream: string; fence: number }
	| { type: "close" };

export interface DurableAck {
	stream: string;
	durableThrough: number;
}

export type WorkerResponse =
	| { type: "opened"; journalMode: string; synchronousMode: string; watermarks: Record<string, number> }
	| { type: "durable"; acks: DurableAck[] }
	| { type: "conflict"; message: string }
	| { type: "fatal"; message: string }
	| { type: "closed" };

const SCHEMA_VERSION = "1";

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
	stream TEXT NOT NULL,
	seq INTEGER NOT NULL,
	ref TEXT NOT NULL,
	schema TEXT NOT NULL,
	stamp TEXT NOT NULL,
	scope TEXT NOT NULL,
	fact TEXT NOT NULL,
	observed_at TEXT NOT NULL,
	PRIMARY KEY (stream, seq)
);
CREATE TABLE IF NOT EXISTS evidence_gaps (
	stream TEXT NOT NULL,
	after INTEGER NOT NULL,
	through INTEGER,
	ref TEXT NOT NULL,
	reason TEXT NOT NULL,
	PRIMARY KEY (stream, after)
);
CREATE TABLE IF NOT EXISTS watermarks (
	stream TEXT PRIMARY KEY,
	durable_through INTEGER NOT NULL
);
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
	db.exec(SCHEMA_SQL);
	const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined;
	if (versionRow == null) {
		db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
	} else if (String(versionRow.value) !== SCHEMA_VERSION) {
		db.close();
		throw new Error(`历史库 schema 版本不兼容：库=${String(versionRow.value)} 期望=${SCHEMA_VERSION}`);
	}
	return { db, journalMode: journalMode.toLowerCase(), synchronousMode: syncNames[syncLevel] ?? String(syncLevel) };
}

/** 首个证据登记源流元数据（绑定、采集 schema、源身份、起点，§5.3）；重复登记必须一致。 */
function ensureStream(db: DatabaseSync, record: CapturedClientFact): void {
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
		return;
	}
	const sameIdentity =
		existing.binding === record.scope.binding &&
		existing.world === record.scope.world &&
		existing.world_revision === record.scope.worldRevision &&
		existing.source === record.stamp.source &&
		existing.schema === record.schema;
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
		for (const item of items) {
			if (item.kind === "evidence") {
				const record = item.record;
				touched.add(record.mark.stream);
				ensureStream(db, record);
				const existing = db
					.prepare("SELECT ref FROM evidence WHERE stream = ? AND seq = ?")
					.get(record.mark.stream, record.mark.sequence) as Row | undefined;
				if (existing != null) {
					if (existing.ref !== record.ref) {
						throw new SourceConflict(
							`evidence (${record.mark.stream}, ${record.mark.sequence}) 已存在且 ref 不同：${String(existing.ref)} != ${record.ref}`,
						);
					}
					continue;
				}
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
			db.prepare("INSERT INTO evidence_gaps (stream, after, through, ref, reason) VALUES (?, ?, ?, ?, ?)").run(
				item.stream,
				item.after,
				item.through,
				item.ref,
				item.reason,
			);
		}
		const acks = computeAcks(db, touched);
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
			} satisfies WorkerResponse);
			return;
		}
		if (db == null) throw new Error("storage is not opened");
		if (request.type === "append") {
			const acks = appendBatch(db, request.items);
			if (acks.length > 0) port.postMessage({ type: "durable", acks } satisfies WorkerResponse);
			return;
		}
		if (request.type === "streamEnd") {
			const acks = closeStream(db, request.stream, request.fence);
			if (acks.length > 0) port.postMessage({ type: "durable", acks } satisfies WorkerResponse);
			return;
		}
		db.close();
		db = null;
		port.postMessage({ type: "closed" } satisfies WorkerResponse);
		port.close();
	} catch (err) {
		if (err instanceof SourceConflict) {
			port.postMessage({ type: "conflict", message: messageOf(err) } satisfies WorkerResponse);
		} else {
			port.postMessage({ type: "fatal", message: messageOf(err) } satisfies WorkerResponse);
		}
	}
});
