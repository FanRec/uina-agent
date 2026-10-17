/**
 * SQLite 目录：仓库身份、名称头、不可变修订、操作账本（LEAD S-A1/S-A3，assets.md §7.1）。
 *
 * - 单 writer 串行提交（node:sqlite 同步 API）；发布走 BEGIN IMMEDIATE，
 *   CAS 为条件 UPDATE（创建 expectedVersion=NULL，修订 expectedVersion=head）。
 * - 操作账本 operations 只保存成功结果；同键同 intentDigest 重放先于 CAS 与源读取。
 * - 数据库只保存目录与索引事实；包内容是 objects/<objectId> 的文件（内容合同）。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssetKind } from "../../contracts/assets.js";

const SCHEMA_VERSION = "1";

export interface RevisionRow {
	name: string;
	version: number;
	kind: AssetKind;
	previousVersion: number | null;
	schema: string;
	digest: string;
	summary: string;
	reason: string | null;
	objectId: string;
	objectsJson: string;
	requiredAssetsJson: string;
	evidenceJson: string;
	sourcesJson: string;
	createdAt: string;
}

export interface OperationRow {
	requestId: string;
	intentDigest: string;
	resultJson: string;
	committedName: string;
	committedVersion: number;
}

export type PublishOutcome =
	| { ok: true; version: number; previousVersion: number | null }
	| { ok: false; reason: "exists" | "conflict" | "not_found" | "kind_mismatch" | "request_conflict" | "store_failed" }
	| { ok: false; reason: "request_committed"; record: string }
	| { ok: false; reason: "commit_unknown"; version: number };

export interface PublishInput {
	requestId: string;
	intentDigest: string;
	name: string;
	kind: AssetKind;
	/** null = 创建（put）；修订为 expectedRef 的版本号。 */
	expectedVersion: number | null;
	schema: string;
	summary: string;
	digest: string;
	objectId: string;
	objectsJson: string;
	requiredAssetsJson: string;
	evidenceJson: string;
	sourcesJson: string;
	reason: string | null;
}

export class AssetCatalog {
	private readonly db: DatabaseSync;
	readonly repositoryId: string;

	constructor(dataDir: string) {
		mkdirSync(dataDir, { recursive: true });
		this.db = new DatabaseSync(join(dataDir, "catalog.sqlite"));
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA busy_timeout = 5000;");
		this.db.exec("PRAGMA foreign_keys = ON;");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS repository (
				repository_id TEXT PRIMARY KEY,
				schema_version INTEGER NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS asset_heads (
				name TEXT PRIMARY KEY,
				kind TEXT NOT NULL CHECK (kind IN ('program','blueprint','experience')),
				head_version INTEGER NULL CHECK (head_version IS NULL OR head_version > 0),
				created_at TEXT NOT NULL,
				UNIQUE (name, kind),
				FOREIGN KEY (name, head_version) REFERENCES asset_revisions(name, version)
			);
			CREATE TABLE IF NOT EXISTS asset_revisions (
				name TEXT NOT NULL,
				version INTEGER NOT NULL CHECK (version > 0),
				kind TEXT NOT NULL CHECK (kind IN ('program','blueprint','experience')),
				previous_version INTEGER NULL,
				schema TEXT NOT NULL,
				digest TEXT NOT NULL,
				summary TEXT NOT NULL,
				reason TEXT,
				object_id TEXT NOT NULL UNIQUE,
				objects_json TEXT NOT NULL,
				required_assets_json TEXT NOT NULL,
				evidence_json TEXT NOT NULL,
				sources_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (name, version),
				FOREIGN KEY (name, previous_version) REFERENCES asset_revisions(name, version)
			);
			CREATE TABLE IF NOT EXISTS operations (
				request_id TEXT PRIMARY KEY,
				intent_digest TEXT NOT NULL,
				result_json TEXT NOT NULL,
				committed_name TEXT NOT NULL,
				committed_version INTEGER NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS asset_revisions_kind_idx ON asset_revisions(kind, name, version);
		`);
		const row = this.db.prepare("SELECT schema_version FROM repository LIMIT 1").get() as
			| { schema_version: number }
			| undefined;
		if (!row) {
			this.repositoryId = `mcassets-${randomUUID()}`;
			this.db
				.prepare("INSERT INTO repository (repository_id, schema_version, created_at) VALUES (?, ?, ?)")
				.run(this.repositoryId, SCHEMA_VERSION, new Date().toISOString());
		} else if (row.schema_version !== Number(SCHEMA_VERSION)) {
			const found = row.schema_version;
			this.db.close();
			throw new Error(`Assets 目录 schema 版本不兼容：${found} vs ${SCHEMA_VERSION}`);
		} else {
			const idRow = this.db.prepare("SELECT repository_id FROM repository LIMIT 1").get() as {
				repository_id: string;
			};
			this.repositoryId = idRow.repository_id;
		}
	}

	headOf(name: string): { kind: AssetKind; headVersion: number | null } | null {
		const row = this.db.prepare("SELECT kind, head_version FROM asset_heads WHERE name = ?").get(name) as
			| { kind: AssetKind; head_version: number | null }
			| undefined;
		if (!row) return null;
		return { kind: row.kind, headVersion: row.head_version };
	}

	revision(name: string, version: number): RevisionRow | null {
		const row = this.db
			.prepare(
				`SELECT name, version, kind, previous_version, schema, digest, summary, reason, object_id,
					objects_json, required_assets_json, evidence_json, sources_json, created_at
				 FROM asset_revisions WHERE name = ? AND version = ?`,
			)
			.get(name, version) as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			name: row.name as string,
			version: row.version as number,
			kind: row.kind as AssetKind,
			previousVersion: (row.previous_version as number | null) ?? null,
			schema: row.schema as string,
			digest: row.digest as string,
			summary: row.summary as string,
			reason: (row.reason as string | null) ?? null,
			objectId: row.object_id as string,
			objectsJson: row.objects_json as string,
			requiredAssetsJson: row.required_assets_json as string,
			evidenceJson: row.evidence_json as string,
			sourcesJson: row.sources_json as string,
			createdAt: row.created_at as string,
		};
	}

	operation(requestId: string): OperationRow | null {
		const row = this.db
			.prepare(
				"SELECT request_id, intent_digest, result_json, committed_name, committed_version FROM operations WHERE request_id = ?",
			)
			.get(requestId) as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			requestId: row.request_id as string,
			intentDigest: row.intent_digest as string,
			resultJson: row.result_json as string,
			committedName: row.committed_name as string,
			committedVersion: row.committed_version as number,
		};
	}

	dependencyExists(ref: { name: string; version: number }): boolean {
		return (
			this.db.prepare("SELECT 1 FROM asset_revisions WHERE name = ? AND version = ?").get(ref.name, ref.version) !==
			undefined
		);
	}

	/**
	 * 发布事务（assets.md §6.3）：账本重查 → head CAS/分配版本 → commitFiles 回调
	 * （同步安装不可变对象 + 构建结果 JSON，assets.md §7.4）→ 插入修订 →
	 * 以原 head 为条件推进 head → 保存操作结果 → COMMIT。
	 * COMMIT 后回执失败时按修订行存在性结算为 commit_unknown，调用方不得删包。
	 */
	publish(
		input: PublishInput,
		commitFiles: (version: number, previousVersion: number | null) => string,
	): PublishOutcome {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.operation(input.requestId);
			if (existing) {
				this.db.exec("ROLLBACK");
				if (existing.intentDigest === input.intentDigest) {
					return { ok: false, reason: "request_committed", record: existing.resultJson };
				}
				return { ok: false, reason: "request_conflict" };
			}
			const head = this.headOf(input.name);
			let version: number;
			let previousVersion: number | null;
			if (input.expectedVersion === null) {
				if (head !== null && head.headVersion !== null) {
					this.db.exec("ROLLBACK");
					return { ok: false, reason: "exists" };
				}
				if (head === null) {
					this.db
						.prepare("INSERT INTO asset_heads (name, kind, head_version, created_at) VALUES (?, ?, NULL, ?)")
						.run(input.name, input.kind, new Date().toISOString());
				} else if (head.kind !== input.kind) {
					this.db.exec("ROLLBACK");
					return { ok: false, reason: "kind_mismatch" };
				}
				version = 1;
				previousVersion = null;
			} else {
				if (head === null || head.headVersion === null) {
					this.db.exec("ROLLBACK");
					return { ok: false, reason: "not_found" };
				}
				if (head.kind !== input.kind) {
					this.db.exec("ROLLBACK");
					return { ok: false, reason: "kind_mismatch" };
				}
				if (head.headVersion !== input.expectedVersion) {
					this.db.exec("ROLLBACK");
					return { ok: false, reason: "conflict" };
				}
				version = input.expectedVersion + 1;
				previousVersion = input.expectedVersion;
			}
			const resultJson = commitFiles(version, previousVersion);
			const now = new Date().toISOString();
			this.db
				.prepare(
					`INSERT INTO asset_revisions
					 (name, version, kind, previous_version, schema, digest, summary, reason, object_id,
						objects_json, required_assets_json, evidence_json, sources_json, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					input.name,
					version,
					input.kind,
					previousVersion,
					input.schema,
					input.digest,
					input.summary,
					input.reason,
					input.objectId,
					input.objectsJson,
					input.requiredAssetsJson,
					input.evidenceJson,
					input.sourcesJson,
					now,
				);
			const updated = this.db
				.prepare("UPDATE asset_heads SET head_version = ? WHERE name = ? AND head_version IS ?")
				.run(version, input.name, input.expectedVersion);
			if (Number(updated.changes) !== 1) {
				this.db.exec("ROLLBACK");
				return { ok: false, reason: "conflict" };
			}
			this.db
				.prepare(
					`INSERT INTO operations (request_id, intent_digest, result_json, committed_name, committed_version, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(input.requestId, input.intentDigest, resultJson, input.name, version, now);
			this.db.exec("COMMIT");
			return { ok: true, version, previousVersion };
		} catch (error) {
			// COMMIT 已执行后失败（或安装抛错）时先尽力回滚，再按真实行存在性结算：
			// 修订行已存在且内容一致 → commit_unknown（调用方报 STORE_UNAVAILABLE + committedRef，不得删包）。
			try {
				this.db.exec("ROLLBACK");
			} catch {
				/* 事务已终结 */
			}
			const candidateVersion = input.expectedVersion === null ? 1 : input.expectedVersion + 1;
			const committed = this.revision(input.name, candidateVersion);
			if (committed && committed.digest === input.digest) {
				return { ok: false, reason: "commit_unknown", version: committed.version };
			}
			console.error("[mc-assets] publish failed:", error);
			return { ok: false, reason: "store_failed" };
		}
	}

	listRevisions(filter: {
		query: string;
		kind: AssetKind | null;
		headsOnly: boolean;
		offset: number;
		limit: number;
	}): RevisionRow[] {
		const pattern = `%${filter.query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
		const rows = this.db
			.prepare(
				`SELECT r.name, r.version, r.kind, r.previous_version, r.schema, r.digest, r.summary, r.reason,
					r.object_id, r.objects_json, r.required_assets_json, r.evidence_json, r.sources_json, r.created_at
				 FROM asset_revisions r
				 ${filter.headsOnly ? "JOIN asset_heads h ON h.name = r.name AND h.head_version = r.version" : ""}
				 WHERE (? = '' OR r.name LIKE ? ESCAPE '\\' OR r.summary LIKE ? ESCAPE '\\')
				   AND (? IS NULL OR r.kind = ?)
				 ORDER BY r.name, r.version
				 LIMIT ? OFFSET ?`,
			)
			.all(filter.query, pattern, pattern, filter.kind, filter.kind, filter.limit, filter.offset) as Record<
			string,
			unknown
		>[];
		return rows.map((row) => ({
			name: row.name as string,
			version: row.version as number,
			kind: row.kind as AssetKind,
			previousVersion: (row.previous_version as number | null) ?? null,
			schema: row.schema as string,
			digest: row.digest as string,
			summary: row.summary as string,
			reason: (row.reason as string | null) ?? null,
			objectId: row.object_id as string,
			objectsJson: row.objects_json as string,
			requiredAssetsJson: row.required_assets_json as string,
			evidenceJson: row.evidence_json as string,
			sourcesJson: row.sources_json as string,
			createdAt: row.created_at as string,
		}));
	}

	close(): void {
		this.db.close();
	}
}
