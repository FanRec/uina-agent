/**
 * 专用 SQLite Worker：持有世界历史数据库连接，脱离 World/Driver 所在事件循环。
 *
 * 职责（World 重构终态）：有序提交（单 Writer）、屏障内的批量 append、
 * 短读事务语义的查询、领域记录 CAS、保留关系、关闭结算。
 *
 * 协议：{ id, op, args } → { id, ok: true, result } | { id, ok: false, error }。
 * 单线程顺序处理消息：每条消息天然是原子边界——append 批量在一个事务内提交，
 * 读取不会看到半个事务；不需要额外读事务封装。
 *
 * 本文件必须是零依赖纯 Node 内置 JS（不进打包/编译管线，Worker 直接按路径加载）。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parentPort } from "node:worker_threads";

const SCHEMA_VERSION = "3";

/** @type {import("node:sqlite").DatabaseSync | null} */
let db = null;

function openDatabase(dataDir, fileName) {
	mkdirSync(dataDir, { recursive: true });
	const database = new DatabaseSync(join(dataDir, fileName));
	database.exec("PRAGMA journal_mode = WAL;");
	// durable ACK 的前提：每次 COMMIT 都把 WAL 刷到盘（不依赖 SQLite 编译默认值）。
	database.exec("PRAGMA synchronous = FULL;");
	// 同文件多连接（误用/工具打开）时避免立即 SQLITE_BUSY：等待而非拒绝。
	database.exec("PRAGMA busy_timeout = 5000;");
	database.exec(`
		CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS evidence (
			ref TEXT PRIMARY KEY,
			stream TEXT NOT NULL,
			seq INTEGER NOT NULL,
			schema TEXT NOT NULL,
			payload TEXT NOT NULL,
			store_seq INTEGER NOT NULL,
			UNIQUE (stream, seq)
		);
		CREATE TABLE IF NOT EXISTS evidence_gaps (
			ref TEXT PRIMARY KEY,
			stream TEXT NOT NULL,
			after INTEGER NOT NULL,
			through INTEGER,
			reason TEXT NOT NULL,
			store_seq INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS records (
			ref TEXT PRIMARY KEY,
			revision INTEGER NOT NULL,
			schema TEXT NOT NULL,
			world TEXT NOT NULL,
			world_revision TEXT NOT NULL,
			value TEXT NOT NULL,
			evidence TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS retention (
			owner TEXT NOT NULL,
			evidence_ref TEXT NOT NULL,
			PRIMARY KEY (owner, evidence_ref)
		);
	`);
	const schemaRow = database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
	if (!schemaRow) {
		database.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
	} else if (schemaRow.value === "2") {
		// 一次性迁移 v2 → v3：删除无消费者的接收序号列（数据行原样保留）。
		database.exec("BEGIN");
		try {
			database.exec("ALTER TABLE evidence DROP COLUMN recv");
			database.exec("ALTER TABLE evidence_gaps DROP COLUMN recv");
			database.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(SCHEMA_VERSION);
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			database.close();
			throw new Error(`schema 迁移 v2 → v3 失败：${String(error)}`);
		}
	} else if (schemaRow.value !== SCHEMA_VERSION) {
		const found = schemaRow.value;
		database.close();
		throw new Error(`存储 schema 版本不兼容：${found} vs ${SCHEMA_VERSION}`);
	}
	return database;
}

let storeVersion = 0;

function loadVersion() {
	const row = db.prepare("SELECT value FROM meta WHERE key = 'store_version'").get();
	storeVersion = row ? Number(row.value) : 0;
}

function bumpVersion() {
	storeVersion += 1;
	db.prepare(
		"INSERT INTO meta (key, value) VALUES ('store_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(String(storeVersion));
}

/** 分配全局单调 store_seq（跨 evidence/evidence_gaps 共享；仅限已开启事务内调用）。 */
function nextStoreSeq() {
	const row = db.prepare("SELECT value FROM meta WHERE key = 'store_seq_counter'").get();
	const next = (row ? Number(row.value) : 0) + 1;
	db.prepare(
		"INSERT INTO meta (key, value) VALUES ('store_seq_counter', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(String(next));
	return next;
}

function appendEvidence(entries) {
	const insertFact = db.prepare(
		"INSERT OR IGNORE INTO evidence (ref, stream, seq, schema, payload, store_seq) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const insertGap = db.prepare(
		"INSERT OR IGNORE INTO evidence_gaps (ref, stream, after, through, reason, store_seq) VALUES (?, ?, ?, ?, ?, ?)",
	);
	// 身份核验（§5.3）：崩溃恢复后的重放不靠 INSERT OR IGNORE 静默吞——
	// 同 (stream,seq) 必须同 ref、同 gap ref 必须同区间，否则报告冲突而不是装作幂等。
	const factByIdentity = db.prepare("SELECT ref FROM evidence WHERE stream = ? AND seq = ?");
	const factByRef = db.prepare("SELECT stream, seq FROM evidence WHERE ref = ?");
	const gapByRef = db.prepare("SELECT after, through FROM evidence_gaps WHERE ref = ?");
	db.exec("BEGIN");
	const conflicts = [];
	try {
		let inserted = 0;
		for (const entry of entries) {
			if (entry.kind === "fact") {
				const { ref, stream, seq } = {
					ref: entry.record.ref,
					stream: entry.record.mark.stream,
					seq: entry.record.mark.sequence,
				};
				const byIdentity = factByIdentity.get(stream, seq);
				const byRef = factByRef.get(ref);
				if (byIdentity || byRef) {
					if (byIdentity && byRef && byIdentity.ref === ref && byRef.stream === stream && byRef.seq === seq) {
						continue; // 同身份同载荷重放：幂等，不重复入库
					}
					conflicts.push({
						kind: "fact",
						ref,
						detail: `同身份不同载荷：stream=${stream} seq=${seq} 已持久 ref=${byIdentity ? byIdentity.ref : "(无)"} vs ${ref}`,
					});
					continue;
				}
				inserted += Number(
					insertFact.run(ref, stream, seq, entry.record.schema, JSON.stringify(entry.record), nextStoreSeq()).changes,
				);
			} else {
				const gap = entry.gap;
				const existing = gapByRef.get(gap.ref);
				if (existing) {
					if (existing.after === gap.after && (existing.through ?? null) === gap.through) {
						continue; // 同身份同区间重放：幂等
					}
					conflicts.push({
						kind: "gap",
						ref: gap.ref,
						detail: `同 gap ref 区间变化：ref=${gap.ref} 已持久 (${existing.after},${existing.through ?? "null"}] vs (${gap.after},${gap.through ?? "null"}]`,
					});
					continue;
				}
				inserted += Number(
					insertGap.run(gap.ref, gap.stream, gap.after, gap.through, gap.reason, nextStoreSeq()).changes,
				);
			}
		}
		// 全部按身份重放（无新行、无冲突）：没有新数据就不推进提交版本，
		// 否则会给历史 watcher 制造"版本变了但数据没变"的无效唤醒。
		if (inserted > 0) bumpVersion();
		db.exec("COMMIT");
		return { ok: true, version: storeVersion, conflicts };
	} catch (error) {
		db.exec("ROLLBACK");
		console.error("[mc-world-worker] appendEvidence failed:", error);
		return { ok: false, conflicts: [] };
	}
}

function listEvidence(filter) {
	// store_seq 是跨两表共享的全局单调分配键（append 时分配，永不复用）；
	// 合并排序保证真实插入顺序，分页无重复/遗漏。
	const factRows = db
		.prepare(
			`SELECT store_seq, payload FROM evidence
			 WHERE (? IS NULL OR stream = ?) AND (? IS NULL OR schema = ?) AND (? IS NULL OR store_seq > ?)
			 ORDER BY store_seq LIMIT ?`,
		)
		.all(
			filter.stream ?? null,
			filter.stream ?? null,
			filter.schema ?? null,
			filter.schema ?? null,
			filter.afterStoreSeq ?? null,
			filter.afterStoreSeq ?? null,
			filter.limit,
		);
	const gapRows =
		filter.schema && filter.schema.length > 0
			? [] // schema 过滤只匹配事实
			: db
					.prepare(
						`SELECT store_seq, ref, stream, after, through, reason FROM evidence_gaps
						 WHERE (? IS NULL OR stream = ?) AND (? IS NULL OR store_seq > ?)
						 ORDER BY store_seq LIMIT ?`,
					)
					.all(
						filter.stream ?? null,
						filter.stream ?? null,
						filter.afterStoreSeq ?? null,
						filter.afterStoreSeq ?? null,
						filter.limit,
					);
	const items = [
		...factRows.map((row) => ({
			storeSeq: row.store_seq,
			entry: { kind: "fact", record: JSON.parse(row.payload) },
		})),
		...gapRows.map((row) => ({
			storeSeq: row.store_seq,
			entry: {
				kind: "gap",
				gap: { ref: row.ref, stream: row.stream, after: row.after, through: row.through, reason: row.reason },
			},
		})),
	]
		.sort((a, b) => a.storeSeq - b.storeSeq)
		.slice(0, filter.limit);
	const last = items.at(-1);
	return {
		version: storeVersion,
		items,
		nextStoreSeq: items.length === filter.limit && last ? last.storeSeq : null,
	};
}

function hasEvidence(ref) {
	const row = db.prepare("SELECT 1 FROM evidence WHERE ref = ?").get(ref);
	if (row) return true;
	return db.prepare("SELECT 1 FROM evidence_gaps WHERE ref = ?").get(ref) !== undefined;
}

function recoverySnapshot() {
	const factRows = db.prepare("SELECT stream, seq FROM evidence").all();
	const gapRows = db.prepare("SELECT DISTINCT stream, ref FROM evidence_gaps").all();
	const byStream = new Map();
	const ensure = (stream) => {
		let entry = byStream.get(stream);
		if (!entry) {
			entry = { stream, persistedFactSeqs: [], persistedGapRefs: [] };
			byStream.set(stream, entry);
		}
		return entry;
	};
	for (const row of factRows) ensure(row.stream).persistedFactSeqs.push(row.seq);
	for (const row of gapRows) ensure(row.stream).persistedGapRefs.push(row.ref);
	return [...byStream.values()];
}

function writeRecord(change) {
	const existingRow = db
		.prepare("SELECT revision, schema, world, world_revision, created_at FROM records WHERE ref = ?")
		.get(change.ref);
	db.exec("BEGIN");
	try {
		if (change.expectedRevision === null) {
			if (existingRow) {
				db.exec("ROLLBACK");
				return { ok: false, reason: "conflict" };
			}
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO records (ref, revision, schema, world, world_revision, value, evidence, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
			).run(
				change.ref,
				change.schema,
				change.world,
				change.worldRevision,
				JSON.stringify(change.value),
				JSON.stringify(change.evidence),
				now,
			);
			bumpVersion();
			db.exec("COMMIT");
			return {
				ok: true,
				version: storeVersion,
				record: {
					ref: change.ref,
					revision: 1,
					schema: change.schema,
					world: change.world,
					worldRevision: change.worldRevision,
					value: change.value,
					evidence: [...change.evidence],
					createdAt: now,
				},
			};
		}
		if (!existingRow) {
			db.exec("ROLLBACK");
			return { ok: false, reason: "not_found" };
		}
		if (existingRow.revision !== change.expectedRevision) {
			db.exec("ROLLBACK");
			return { ok: false, reason: "conflict" };
		}
		if (
			existingRow.schema !== change.schema ||
			existingRow.world !== change.world ||
			existingRow.world_revision !== change.worldRevision
		) {
			db.exec("ROLLBACK");
			return { ok: false, reason: "immutable_fields" };
		}
		db.prepare("UPDATE records SET revision = revision + 1, value = ?, evidence = ? WHERE ref = ?").run(
			JSON.stringify(change.value),
			JSON.stringify(change.evidence),
			change.ref,
		);
		bumpVersion();
		db.exec("COMMIT");
		const row = db.prepare("SELECT revision, created_at FROM records WHERE ref = ?").get(change.ref);
		return {
			ok: true,
			version: storeVersion,
			record: {
				ref: change.ref,
				revision: row.revision,
				schema: change.schema,
				world: change.world,
				worldRevision: change.worldRevision,
				value: change.value,
				evidence: [...change.evidence],
				createdAt: row.created_at,
			},
		};
	} catch (error) {
		db.exec("ROLLBACK");
		console.error("[mc-world-worker] writeRecord failed:", error);
		return { ok: false, reason: "store_failed" };
	}
}

function readRecord(ref) {
	const row = db.prepare("SELECT * FROM records WHERE ref = ?").get(ref);
	if (!row) return null;
	return {
		ref: row.ref,
		revision: row.revision,
		schema: row.schema,
		world: row.world,
		worldRevision: row.world_revision,
		value: JSON.parse(row.value),
		evidence: JSON.parse(row.evidence),
		createdAt: row.created_at,
	};
}

function retain(owner, evidence) {
	const insert = db.prepare("INSERT OR IGNORE INTO retention (owner, evidence_ref) VALUES (?, ?)");
	db.exec("BEGIN");
	try {
		for (const ref of evidence) insert.run(owner, ref);
		// 保留关系不改变查询可观察状态：不推进提交版本（分页 token 与历史 watcher 不受影响）。
		db.exec("COMMIT");
		return true;
	} catch (error) {
		db.exec("ROLLBACK");
		console.error("[mc-world-worker] retain failed:", error);
		return false;
	}
}

function release(owner) {
	const result = db.prepare("DELETE FROM retention WHERE owner = ?").run(owner);
	return Number(result.changes) > 0;
}

function durabilityPragmas() {
	const journal = db.prepare("PRAGMA journal_mode").get();
	const sync = db.prepare("PRAGMA synchronous").get();
	return {
		journalMode: String(journal ? Object.values(journal)[0] : "unknown"),
		synchronous: Number(sync ? Object.values(sync)[0] : -1),
	};
}

const handlers = {
	open({ dataDir, fileName }) {
		db = openDatabase(dataDir, fileName);
		loadVersion();
		// 如实报告实际生效的持久性配置，供上层核验 durableThrough 的承诺。
		return { description: "SQLite 持久存储（专用 Worker，WAL）", durability: durabilityPragmas() };
	},
	append({ entries }) {
		return appendEvidence(entries);
	},
	list({ filter }) {
		return { page: listEvidence(filter) };
	},
	has({ ref }) {
		return { exists: hasEvidence(ref) };
	},
	recovery() {
		return { streams: recoverySnapshot() };
	},
	record_write({ change }) {
		return { outcome: writeRecord(change) };
	},
	record_read({ ref }) {
		return { row: readRecord(ref) };
	},
	retain({ owner, evidence }) {
		return { ok: retain(owner, evidence) };
	},
	release({ owner }) {
		return { ok: release(owner) };
	},
	close() {
		if (db) {
			db.close();
			db = null;
		}
		return {};
	},
};

parentPort.on("message", (msg) => {
	let response;
	try {
		const handler = handlers[msg.op];
		if (!handler) throw new Error(`未知存储操作：${msg.op}`);
		response = { id: msg.id, ok: true, result: handler(msg.args ?? {}) };
	} catch (error) {
		response = { id: msg.id, ok: false, error: String((error && error.stack) || error) };
	}
	parentPort.postMessage(response);
	if (msg.op === "close") parentPort.close();
});
