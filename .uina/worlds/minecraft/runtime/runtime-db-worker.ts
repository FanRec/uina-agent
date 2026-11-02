/**
 * Runtime 存储 Worker：node:sqlite 单连接，运行 runtime.db。
 *
 * 唯一定义来源：docs/proposals/mc/modules/runtime.md §4.4、§5.3–§5.6。
 * 打开握手显式置 journal_mode=WAL + synchronous=FULL 并回报实际生效值，不符即
 * 失败（不退化内存库）；storage_id 首次写入、其后核对，身份不符明确失败。
 * 每条 apply 是一个原子事务：record_log(instance, seq) 幂等——同载荷跳过、
 * 异载荷冲突不入库；物化行（submissions/stop_intents/runs/segments/calls/
 * effects/records）按突变 upsert，effects 的事实按 effect 追加且首条固定
 * owner（晚到证据不换绑，§5.4）。ACK 按 writer 实例回报已提交上界。
 * opened 回带全量物化行（I1 规模）；恢复结算由引擎侧追加，不自动重放动作。
 * Worker 文件经 tsx 以 .ts 源解析；构建产物必须携带本文件（I2 前接线）。
 */

import { DatabaseSync } from "node:sqlite";
import { type AdmissionCommand, applyAdmission } from "./admission.js";

export type { AdmissionCommand } from "./admission.js";

import { parentPort } from "node:worker_threads";
import type { DriverExecutionFact, SafetyInterventionRecord } from "../contracts/runtime.js";
import { queryStorage, RECORD_SCHEMA, type StorageQuery, snapshotMutation } from "./storage-queries.js";

// ---- 行形状（引擎侧同构） ----

export interface SubmissionRow {
	owner: string;
	request_id: string;
	status: "accepted" | "cancelled" | "rejected";
	operation: string | null;
	segment: string | null;
	run: string | null;
	request: string;
	origin: string;
	record: string | null;
	error: string | null;
}

export interface StopIntentRow {
	record: string;
	stop_request_id: string;
	owner: string;
	target: string;
	control: string;
	created_at: string;
}

export interface RunRow {
	decision?: string | null;
	segment_request_id?: string;
	started?: number;
	run: string;
	owner: string;
	request_id: string;
	revision: number;
	segment: string | null;
	phase: string;
	waiting: string | null;
	outcome: string | null;
	value: string | null;
	error: string | null;
	completion_ref: string | null;
	control: string;
	unknown_effects: string;
	record: string;
	progress: string;
	completion_scope: string;
	completion_description: string;
}

export interface SegmentRow {
	checkpoint?: string | null;
	segment: string;
	run: string;
	revision: number;
	record: string;
	entry: string;
	input: string;
	environment: string | null;
	value: string | null;
	interrupted_children: string;
	evidence: string;
}

export interface CallRow {
	decision_request?: string | null;
	program?: string | null;
	call: string;
	run: string;
	segment: string;
	parent: string | null;
	record: string;
	ref: string;
	implementation: string;
	digest: string;
	access: string;
	input: string;
	execution: string;
	outcome: string | null;
	value: string | null;
	closed_by_parent: string | null;
	error: string | null;
	progress: string;
	effects: string;
	evidence: string;
	completion: string;
}

export interface EffectRow {
	effect: string;
	owner: string | null;
	operation: string;
	record: string;
	facts: string;
	verifications: string;
}

export interface RecordIndexRow {
	record: string;
	kind: string;
	object_ref: string;
}

// ---- 消息协议 ----

export interface ApplyItem {
	ticket: { instance: string; sequence: number };
	mutation:
		| { kind: "safety"; value: SafetyInterventionRecord }
		| { kind: "owner_state"; gates: string; revision: number }
		| { kind: "submission"; row: SubmissionRow }
		| { kind: "stop_intent"; row: StopIntentRow }
		| { kind: "run"; row: RunRow }
		| { kind: "segment"; row: SegmentRow }
		| { kind: "call"; row: CallRow }
		| { kind: "effect_fact"; row: EffectRow; fact: DriverExecutionFact }
		| {
				kind: "effect_verification";
				row: {
					effect: string;
					record: string;
					owner: string;
					facts: string;
					verifications: import("../contracts/runtime.js").EffectVerification[];
				};
		  };
}

export type WorkerRequest =
	| { type: "open"; dbPath: string; storageId: string; worldOwner: string }
	| { type: "apply"; items: ApplyItem[] }
	| { type: "query"; id: number; query: StorageQuery }
	| { type: "admit"; id: number; command: AdmissionCommand }
	| { type: "close" };

export interface RecoveredRows {
	safety?: SafetyInterventionRecord[];
	completions?: { segment: string; completionRef: string }[];
	ownerState?: { gates: string; revision: number };
	submissions: SubmissionRow[];
	stopIntents: StopIntentRow[];
	runs: RunRow[];
	segments: SegmentRow[];
	calls: CallRow[];
	effects: EffectRow[];
	records: RecordIndexRow[];
}

export type WorkerResponse =
	| {
			type: "opened";
			journalMode: string;
			synchronousMode: string;
			writerWatermarks: Record<string, number>;
			recovered: RecoveredRows;
	  }
	| { type: "durable"; instance: string; through: number }
	| { type: "conflict"; message: string }
	| { type: "fatal"; message: string }
	| { type: "query_reply"; id: number; value?: unknown; error?: { code: string; message: string } }
	| { type: "closed" };

const SCHEMA_VERSION = "6";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
	owner TEXT NOT NULL,
	request_id TEXT NOT NULL,
	status TEXT NOT NULL,
	operation TEXT,
	segment TEXT,
	run TEXT,
	request TEXT NOT NULL,
	origin TEXT NOT NULL,
	record TEXT,
	error TEXT,
	PRIMARY KEY (owner, request_id)
);
CREATE TABLE IF NOT EXISTS stop_intents (
	record TEXT PRIMARY KEY,
	stop_request_id TEXT NOT NULL,
	owner TEXT NOT NULL,
	target TEXT NOT NULL,
	control TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
	run TEXT PRIMARY KEY,
	owner TEXT NOT NULL,
	request_id TEXT NOT NULL,
	revision INTEGER NOT NULL,
	decision TEXT,
	segment_request_id TEXT NOT NULL DEFAULT '',
	started INTEGER NOT NULL DEFAULT 0,
	segment TEXT,
	phase TEXT NOT NULL,
	waiting TEXT,
	outcome TEXT,
	value TEXT,
	error TEXT,
	completion_ref TEXT,
	control TEXT NOT NULL,
	unknown_effects TEXT NOT NULL,
	record TEXT NOT NULL,
	progress TEXT NOT NULL,
	completion_scope TEXT NOT NULL,
	completion_description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
	checkpoint TEXT,
	segment TEXT PRIMARY KEY,
	run TEXT NOT NULL,
	revision INTEGER NOT NULL,
	record TEXT NOT NULL,
	entry TEXT NOT NULL,
	input TEXT NOT NULL,
	environment TEXT,
	value TEXT,
	interrupted_children TEXT NOT NULL,
	evidence TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
	decision_request TEXT,
	program TEXT,
	call TEXT PRIMARY KEY,
	run TEXT NOT NULL,
	segment TEXT NOT NULL,
	parent TEXT,
	record TEXT NOT NULL,
	ref TEXT NOT NULL,
	implementation TEXT NOT NULL,
	digest TEXT NOT NULL,
	access TEXT NOT NULL,
	input TEXT NOT NULL,
	execution TEXT NOT NULL,
	outcome TEXT,
	value TEXT,
	closed_by_parent TEXT,
	error TEXT,
	progress TEXT NOT NULL,
	effects TEXT NOT NULL,
	evidence TEXT NOT NULL,
	completion TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS effects (
	effect TEXT PRIMARY KEY,
	owner TEXT,
	operation TEXT NOT NULL,
	record TEXT NOT NULL,
	facts TEXT NOT NULL,
	verifications TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS record_log (
	instance TEXT NOT NULL,
	seq INTEGER NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (instance, seq)
);
`;

class StorageConflict extends Error {}

type Row = Record<string, string | number | bigint | Uint8Array | null>;

interface OpenedStorage {
	db: DatabaseSync;
	journalMode: string;
	synchronousMode: string;
}

function openDatabase(dbPath: string, storageId: string, worldOwner: string): OpenedStorage {
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
	// Inspect an existing schema before creating or changing any application table.
	const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
	if (hasMeta != null) {
		const prior = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as Row | undefined;
		if (prior == null || String(prior.value) !== SCHEMA_VERSION) {
			db.close();
			throw new Error(`runtime 库 schema 版本不兼容：库=${String(prior?.value)} 期望=${SCHEMA_VERSION}`);
		}
	}
	if (hasMeta == null) {
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec(SCHEMA_SQL);
			db.exec(RECORD_SCHEMA);
			const insert = db.prepare("INSERT INTO meta(key,value) VALUES(?,?)");
			insert.run("schema_version", SCHEMA_VERSION);
			insert.run("storage_id", storageId);
			insert.run("world_owner", worldOwner);
			insert.run("owner_gates", '["disabled"]');
			insert.run("owner_gate_revision", "0");
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			db.close();
			throw err;
		}
	} else {
		const id = db.prepare("SELECT value FROM meta WHERE key='storage_id'").get() as Row | undefined;
		const owner = db.prepare("SELECT value FROM meta WHERE key='world_owner'").get() as Row | undefined;
		if (id == null || String(id.value) !== storageId) {
			db.close();
			throw new Error("runtime storage_id mismatch or missing");
		}
		if (owner == null || String(owner.value) !== worldOwner) {
			db.close();
			throw new Error("runtime world_owner mismatch or missing");
		}
	}
	return { db, journalMode: journalMode.toLowerCase(), synchronousMode: syncNames[syncLevel] ?? String(syncLevel) };
}

function loadWatermarks(db: DatabaseSync): Record<string, number> {
	const rows = db.prepare("SELECT instance, MAX(seq) AS max_seq FROM record_log GROUP BY instance").all() as Row[];
	const out: Record<string, number> = {};
	for (const row of rows) out[String(row.instance)] = Number(row.max_seq);
	return out;
}

function loadRecovered(db: DatabaseSync): RecoveredRows {
	const all = (sql: string): Row[] => db.prepare(sql).all() as Row[];
	const str = (v: string | number | bigint | Uint8Array | null): string | null => (v == null ? null : String(v));
	const gates = db.prepare("SELECT value FROM meta WHERE key='owner_gates'").get() as Row;
	const revision = db.prepare("SELECT value FROM meta WHERE key='owner_gate_revision'").get() as Row;
	return {
		safety: all(
			"SELECT payload FROM records WHERE seq IN (SELECT MAX(seq) FROM records WHERE kind='safety' GROUP BY object_ref) ORDER BY seq",
		).map((r) => JSON.parse(String(r.payload)).value as SafetyInterventionRecord),
		completions: all("SELECT header FROM completions ORDER BY rowid").map((row) => {
			const header = JSON.parse(String(row.header));
			return { segment: String(header.segment), completionRef: String(header.completionRef) };
		}),
		ownerState: { gates: String(gates.value), revision: Number(revision.value) },
		submissions: all("SELECT * FROM submissions").map((r) => ({
			owner: String(r.owner),
			request_id: String(r.request_id),
			status: String(r.status) as SubmissionRow["status"],
			operation: str(r.operation),
			segment: str(r.segment),
			run: str(r.run),
			request: String(r.request),
			origin: String(r.origin),
			record: str(r.record),
			error: str(r.error),
		})),
		stopIntents: all("SELECT * FROM stop_intents").map((r) => ({
			record: String(r.record),
			stop_request_id: String(r.stop_request_id),
			owner: String(r.owner),
			target: String(r.target),
			control: String(r.control),
			created_at: String(r.created_at),
		})),
		runs: all("SELECT * FROM runs").map((r) => ({
			run: String(r.run),
			decision: str(r.decision),
			segment_request_id: String(r.segment_request_id),
			started: Number(r.started),
			owner: String(r.owner),
			request_id: String(r.request_id),
			revision: Number(r.revision),
			segment: str(r.segment),
			phase: String(r.phase),
			waiting: str(r.waiting),
			outcome: str(r.outcome),
			value: str(r.value),
			error: str(r.error),
			completion_ref: str(r.completion_ref),
			control: String(r.control),
			unknown_effects: String(r.unknown_effects),
			record: String(r.record),
			progress: String(r.progress),
			completion_scope: String(r.completion_scope),
			completion_description: String(r.completion_description),
		})),
		segments: all("SELECT * FROM segments").map((r) => ({
			segment: String(r.segment),
			checkpoint: str(r.checkpoint),
			run: String(r.run),
			revision: Number(r.revision),
			record: String(r.record),
			entry: String(r.entry),
			input: String(r.input),
			environment: str(r.environment),
			value: str(r.value),
			interrupted_children: String(r.interrupted_children),
			evidence: String(r.evidence),
		})),
		calls: all("SELECT * FROM calls").map((r) => ({
			call: String(r.call),
			decision_request: str(r.decision_request),
			run: String(r.run),
			segment: String(r.segment),
			parent: str(r.parent),
			record: String(r.record),
			ref: String(r.ref),
			implementation: String(r.implementation),
			digest: String(r.digest),
			access: String(r.access),
			input: String(r.input),
			execution: String(r.execution),
			outcome: str(r.outcome),
			value: str(r.value),
			closed_by_parent: str(r.closed_by_parent),
			error: str(r.error),
			progress: String(r.progress),
			effects: String(r.effects),
			evidence: String(r.evidence),
			completion: String(r.completion),
		})),
		effects: all("SELECT * FROM effects").map((r) => ({
			effect: String(r.effect),
			owner: str(r.owner),
			operation: String(r.operation),
			record: String(r.record),
			facts: String(r.facts),
			verifications: String(r.verifications),
		})),
		records: all("SELECT * FROM records").map((r) => ({
			record: String(r.record),
			kind: String(r.kind),
			object_ref: String(r.object_ref),
		})),
	};
}

/**
 * 单事务批量提交；返回本批推进到的 writer 实例上界（提交后同一续体发布）。
 * record_log 幂等（§5.3/§5.6）：同 (instance, seq) 必须同载荷，一致幂等跳过
 * （不重复应用物化行），不一致抛冲突（整批回滚、不入库）。
 */
function applyBatch(db: DatabaseSync, items: ApplyItem[]): { instance: string; through: number } | null {
	db.exec("BEGIN");
	try {
		let lastInstance: string | null = null;
		let lastSeq = 0;
		for (const item of items) {
			const payload = JSON.stringify(item.mutation);
			const existing = db
				.prepare("SELECT payload FROM record_log WHERE instance = ? AND seq = ?")
				.get(item.ticket.instance, item.ticket.sequence) as Row | undefined;
			if (existing != null) {
				if (String(existing.payload) !== payload) {
					throw new StorageConflict(`record_log (${item.ticket.instance}, ${item.ticket.sequence}) 已存在且载荷不同`);
				}
				continue;
			}
			db.prepare("INSERT INTO record_log (instance, seq, payload) VALUES (?, ?, ?)").run(
				item.ticket.instance,
				item.ticket.sequence,
				payload,
			);
			if (applyMutation(db, item.mutation) !== false) snapshotMutation(db, item.mutation);
			lastInstance = item.ticket.instance;
			lastSeq = item.ticket.sequence;
		}
		db.exec("COMMIT");
		return lastInstance == null ? null : { instance: lastInstance, through: lastSeq };
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

function applyMutation(db: DatabaseSync, mutation: ApplyItem["mutation"]): false | void {
	switch (mutation.kind) {
		case "owner_state": {
			db.prepare("UPDATE meta SET value=? WHERE key='owner_gates'").run(mutation.gates);
			db.prepare("UPDATE meta SET value=? WHERE key='owner_gate_revision'").run(String(mutation.revision));
			return;
		}
		case "submission": {
			const r = mutation.row;
			// A request stop may arrive after admission committed but before its reply.
			// Preserve the accepted mapping; the stop_intent still stops that segment.
			if (
				r.status === "cancelled" &&
				db
					.prepare("SELECT 1 FROM submissions WHERE owner=? AND request_id=? AND status='accepted'")
					.get(r.owner, r.request_id)
			)
				return;
			db.prepare(
				"INSERT INTO submissions (owner, request_id, status, operation, segment, run, request, origin, record, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner, request_id) DO UPDATE SET status = excluded.status, operation = excluded.operation, segment = excluded.segment, run = excluded.run, request = excluded.request, origin = excluded.origin, record = excluded.record, error = excluded.error",
			).run(r.owner, r.request_id, r.status, r.operation, r.segment, r.run, r.request, r.origin, r.record, r.error);
			return;
		}
		case "stop_intent": {
			const r = mutation.row;
			db.prepare(
				"INSERT INTO stop_intents (record, stop_request_id, owner, target, control, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			).run(r.record, r.stop_request_id, r.owner, r.target, r.control, r.created_at);
			return;
		}
		case "run": {
			const r = mutation.row;
			// A stop already in the writer queue can finish after continue committed.
			// Its old segment must never replace the newly admitted segment projection.
			const latest = db.prepare("SELECT segment FROM runs WHERE run=?").get(r.run);
			if (latest?.segment && latest.segment !== r.segment) {
				const current = db.prepare("SELECT rowid FROM segments WHERE segment=?").get(latest.segment);
				const incoming = db.prepare("SELECT rowid FROM segments WHERE segment=?").get(r.segment);
				if (current && incoming && Number(incoming.rowid) < Number(current.rowid)) return false;
			}
			db.prepare(
				"INSERT INTO runs (run, owner, request_id, revision, segment, phase, waiting, outcome, value, error, completion_ref, control, unknown_effects, record, progress, completion_scope, completion_description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run) DO UPDATE SET revision = excluded.revision, segment = excluded.segment, phase = excluded.phase, waiting = excluded.waiting, outcome = excluded.outcome, value = excluded.value, error = excluded.error, completion_ref = excluded.completion_ref, control = excluded.control, unknown_effects = excluded.unknown_effects, record = excluded.record, progress = excluded.progress, completion_scope = excluded.completion_scope, completion_description = excluded.completion_description",
			).run(
				r.run,
				r.owner,
				r.request_id,
				r.revision,
				r.segment,
				r.phase,
				r.waiting,
				r.outcome,
				r.value,
				r.error,
				r.completion_ref,
				r.control,
				r.unknown_effects,
				r.record,
				r.progress,
				r.completion_scope,
				r.completion_description,
			);
			db.prepare("UPDATE runs SET decision=?,segment_request_id=?,started=? WHERE run=?").run(
				r.decision ?? null,
				r.segment_request_id ?? r.request_id,
				r.started ?? 0,
				r.run,
			);
			return;
		}
		case "segment": {
			const r = mutation.row;
			db.prepare(
				"INSERT INTO segments (segment, run, revision, record, entry, input, environment, value, interrupted_children, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(segment) DO UPDATE SET revision = excluded.revision, record = excluded.record, entry = excluded.entry, input = excluded.input, environment = excluded.environment, value = excluded.value, interrupted_children = excluded.interrupted_children, evidence = excluded.evidence",
			).run(
				r.segment,
				r.run,
				r.revision,
				r.record,
				r.entry,
				r.input,
				r.environment,
				r.value,
				r.interrupted_children,
				r.evidence,
			);
			db.prepare("UPDATE segments SET checkpoint=? WHERE segment=?").run(r.checkpoint ?? null, r.segment);
			return;
		}
		case "call": {
			const r = mutation.row;
			db.prepare(
				"INSERT INTO calls (program, call, run, segment, parent, record, ref, implementation, digest, access, input, execution, outcome, value, closed_by_parent, error, progress, effects, evidence, completion) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(call) DO UPDATE SET program = excluded.program, record = excluded.record, execution = excluded.execution, outcome = excluded.outcome, value = excluded.value, closed_by_parent = excluded.closed_by_parent, error = excluded.error, progress = excluded.progress, effects = excluded.effects, evidence = excluded.evidence, completion = excluded.completion",
			).run(
				r.program ?? null,
				r.call,
				r.run,
				r.segment,
				r.parent,
				r.record,
				r.ref,
				r.implementation,
				r.digest,
				r.access,
				r.input,
				r.execution,
				r.outcome,
				r.value,
				r.closed_by_parent,
				r.error,
				r.progress,
				r.effects,
				r.evidence,
				r.completion,
			);
			db.prepare("UPDATE calls SET decision_request=? WHERE call=?").run(r.decision_request ?? null, r.call);
			return;
		}
		case "effect_fact": {
			const r = mutation.row;
			const fact = mutation.fact;
			// 首条事实固定 owner/operation；record 随新截面更新（§5.4 晚到证据不换绑）
			db.prepare(
				"INSERT OR IGNORE INTO effects (effect, owner, operation, record, facts, verifications) VALUES (?, ?, ?, ?, '[]', '[]')",
			).run(r.effect, r.owner, fact.operation, r.record);
			const row = db
				.prepare("SELECT owner, operation, record, facts FROM effects WHERE effect = ?")
				.get(r.effect) as Row;
			// 同一 effect ref 已属别的 owner/operation：本进程发了与历史记录相同的 ref，
			// 说明发号空间跨启动冲突。静默追加会把两条不同的身体动作混成一条效果记录。
			if (String(row.owner) !== r.owner || String(row.operation) !== r.operation) {
				throw new StorageConflict(
					`effect ${r.effect} 已存在且身份不同：已有 owner=${String(row.owner)} record=${String(row.record)}，本次 owner=${r.owner} record=${r.record}`,
				);
			}
			const facts = JSON.parse(String(row.facts)) as DriverExecutionFact[];
			facts.push(fact);
			db.prepare("UPDATE effects SET facts = ?, record = ? WHERE effect = ?").run(
				JSON.stringify(facts),
				r.record,
				r.effect,
			);
			return;
		}
		case "effect_verification": {
			const r = mutation.row;
			db.prepare(
				"INSERT OR IGNORE INTO effects (effect, owner, operation, record, facts, verifications) VALUES (?, ?, ?, ?, ?, '[]')",
			).run(
				r.effect,
				r.owner,
				(JSON.parse(r.facts) as DriverExecutionFact[])[0]?.operation ?? "unknown",
				r.record,
				r.facts,
			);
			const row = db.prepare("SELECT owner, verifications FROM effects WHERE effect = ?").get(r.effect) as Row;
			if (String(row.owner) !== r.owner) {
				throw new StorageConflict(`effect ${r.effect} 已存在且身份不同：owner=${String(row.owner)} ≠ ${r.owner}`);
			}
			const verifications = JSON.parse(
				String(row.verifications),
			) as import("../contracts/runtime.js").EffectVerification[];
			verifications.push(...r.verifications.slice(verifications.length));
			db.prepare("UPDATE effects SET verifications = ?, record = ? WHERE effect = ?").run(
				JSON.stringify(verifications),
				r.record,
				r.effect,
			);
			return;
		}
	}
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

if (parentPort == null) {
	throw new Error("runtime-db-worker 必须以 worker_threads Worker 启动");
}
const port = parentPort;
let db: DatabaseSync | null = null;
let databasePath = "";

port.on("message", (request: WorkerRequest) => {
	try {
		if (request.type === "open") {
			if (db != null) throw new Error("storage already opened");
			const opened = openDatabase(request.dbPath, request.storageId, request.worldOwner);
			db = opened.db;
			databasePath = request.dbPath;
			port.postMessage({
				type: "opened",
				journalMode: opened.journalMode,
				synchronousMode: opened.synchronousMode,
				writerWatermarks: loadWatermarks(opened.db),
				recovered: loadRecovered(opened.db),
			} satisfies WorkerResponse);
			return;
		}
		if (db == null) throw new Error("storage is not opened");
		if (request.type === "admit") {
			try {
				applyAdmission(db, request.command, (mutation) => {
					if (applyMutation(db!, mutation) !== false) snapshotMutation(db!, mutation);
				});
				port.postMessage({ type: "query_reply", id: request.id, value: null } satisfies WorkerResponse);
			} catch (error) {
				if (db.isTransaction) db.exec("ROLLBACK");
				port.postMessage({
					type: "query_reply",
					id: request.id,
					error: { code: (error as { code?: string }).code ?? "ADMISSION_FAILED", message: messageOf(error) },
				} satisfies WorkerResponse);
			}
			return;
		}
		if (request.type === "query") {
			void queryStorage(db, databasePath, request.query).then(
				(value) => port.postMessage({ type: "query_reply", id: request.id, value } satisfies WorkerResponse),
				(error) =>
					port.postMessage({
						type: "query_reply",
						id: request.id,
						error: { code: error.code ?? "STORE_UNAVAILABLE", message: messageOf(error) },
					} satisfies WorkerResponse),
			);
			return;
		}
		if (request.type === "apply") {
			const ack = applyBatch(db, request.items);
			if (ack != null) {
				port.postMessage({ type: "durable", instance: ack.instance, through: ack.through } satisfies WorkerResponse);
			}
			return;
		}
		db.close();
		db = null;
		port.postMessage({ type: "closed" } satisfies WorkerResponse);
		port.close();
	} catch (err) {
		if (err instanceof StorageConflict) {
			port.postMessage({ type: "conflict", message: messageOf(err) } satisfies WorkerResponse);
		} else {
			port.postMessage({ type: "fatal", message: messageOf(err) } satisfies WorkerResponse);
		}
	}
});
