/**
 * SQLite 目录：仓库身份、名称头、不可变修订、依赖/来源/证据索引、操作账本
 * （assets.md §7.1 最小 Schema）。
 *
 * - 单 writer 串行提交（node:sqlite 同步 API）；发布走 BEGIN IMMEDIATE，
 *   CAS 为条件 UPDATE（创建 expectedVersion=NULL，修订 expectedVersion=head）。
 * - derivedFrom 不是列：作者 editing.baseRef 声明写入来源索引（owner_kind='file'），
 *   读取时投影，不构成可信派生外键（assets.md §6.1）。
 * - 操作账本 operations 只保存成功结果，键为 (ownerId, operationId)（assets.md §6.4）；
 *   同键同 intentDigest 重放先于 CAS 与源读取。
 * - 数据库只保存目录与索引事实；包内容是 objects/<objectId> 的文件（内容合同）。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssetKind, Digest, EvidenceCopy, SourceLink } from "../../contracts/assets.js";

const SCHEMA_VERSION = 2;

export interface RevisionRow {
	name: string;
	version: number;
	kind: AssetKind;
	previousVersion: number | null;
	formatFamily: string;
	formatVersion: number;
	title: string;
	summary: string;
	tagsJson: string;
	objectId: string;
	packageDigest: Digest;
	createdAt: string;
}

export interface OperationRow {
	ownerId: string;
	operationId: string;
	intentDigest: string;
	resultJson: string;
	committedName: string;
	committedVersion: number;
}

export type PublishOutcome =
	| { ok: true; version: number; previousVersion: number | null }
	| { ok: false; reason: "exists" | "conflict" | "not_found" | "kind_mismatch" | "operation_conflict" | "store_failed" }
	| { ok: false; reason: "operation_committed"; resultJson: string }
	| { ok: false; reason: "commit_unknown"; version: number };

export interface PublishInput {
	ownerId: string;
	operationId: string;
	intentDigest: string;
	name: string;
	kind: AssetKind;
	/** null = 创建；修订为 expectedRef 的版本号。 */
	expectedVersion: number | null;
	formatFamily: string;
	formatVersion: number;
	title: string;
	summary: string;
	tagsJson: string;
	packageDigest: string;
	objectId: string;
	/** 确定属于本仓库的 Program 依赖投影（dep_name, dep_version）。 */
	dependencies: { depName: string; depVersion: number }[];
	/** 作者声明来源（含 derivedFrom 投影）与 sourceLinks。 */
	sources: { ownerKind: "runtime" | "world" | "file" | "external"; sourceRef: string; description: string }[];
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
				format_family TEXT NOT NULL,
				format_version INTEGER NOT NULL,
				title TEXT NOT NULL,
				summary TEXT NOT NULL,
				tags_json TEXT NOT NULL,
				object_id TEXT NOT NULL UNIQUE,
				package_digest TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (name, version),
				FOREIGN KEY (name, kind) REFERENCES asset_heads(name, kind),
				FOREIGN KEY (name, previous_version) REFERENCES asset_revisions(name, version)
			);
			CREATE TABLE IF NOT EXISTS asset_dependencies (
				name TEXT NOT NULL,
				version INTEGER NOT NULL,
				dep_name TEXT NOT NULL,
				dep_version INTEGER NOT NULL,
				PRIMARY KEY (name, version, dep_name, dep_version),
				FOREIGN KEY (name, version) REFERENCES asset_revisions(name, version),
				FOREIGN KEY (dep_name, dep_version) REFERENCES asset_revisions(name, version)
			);
			CREATE TABLE IF NOT EXISTS asset_sources (
				source_id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				version INTEGER NOT NULL,
				owner_kind TEXT NOT NULL CHECK (owner_kind IN ('runtime','world','file','external')),
				source_ref TEXT NOT NULL,
				description TEXT NOT NULL,
				FOREIGN KEY (name, version) REFERENCES asset_revisions(name, version)
			);
			CREATE TABLE IF NOT EXISTS asset_evidence (
				evidence_id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				version INTEGER NOT NULL,
				owner_kind TEXT NOT NULL CHECK (owner_kind IN ('runtime','world')),
				source_ref TEXT NOT NULL,
				schema_family TEXT NOT NULL,
				schema_version INTEGER NOT NULL,
				payload_relpath TEXT,
				payload_digest TEXT,
				payload_byte_length INTEGER,
				completeness TEXT NOT NULL CHECK (completeness IN ('self_contained','partial','link_only')),
				metadata_json TEXT NOT NULL,
				captured_at TEXT NOT NULL,
				FOREIGN KEY (name, version) REFERENCES asset_revisions(name, version)
			);
			CREATE TABLE IF NOT EXISTS operations (
				owner_id TEXT NOT NULL,
				operation_id TEXT NOT NULL,
				operation_kind TEXT NOT NULL,
				intent_digest TEXT NOT NULL,
				result_json TEXT NOT NULL,
				committed_name TEXT NOT NULL,
				committed_version INTEGER NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (owner_id, operation_id),
				FOREIGN KEY (committed_name, committed_version) REFERENCES asset_revisions(name, version)
			);
			CREATE INDEX IF NOT EXISTS asset_revisions_kind_idx ON asset_revisions(kind, name, version);
			CREATE INDEX IF NOT EXISTS asset_revisions_text_idx ON asset_revisions(name, title);
			CREATE INDEX IF NOT EXISTS asset_dependencies_dep_idx ON asset_dependencies(dep_name, dep_version);
		`);
		const row = this.db.prepare("SELECT schema_version FROM repository LIMIT 1").get() as
			| { schema_version: number }
			| undefined;
		if (!row) {
			this.repositoryId = `mcassets-${randomUUID()}`;
			this.db
				.prepare("INSERT INTO repository (repository_id, schema_version, created_at) VALUES (?, ?, ?)")
				.run(this.repositoryId, SCHEMA_VERSION, new Date().toISOString());
		} else if (row.schema_version !== SCHEMA_VERSION) {
			const found = row.schema_version;
			this.db.close();
			throw new Error(`Assets 目录 schema 版本不兼容：${found} vs ${SCHEMA_VERSION}`);
		} else {
			const idRow = this.db.prepare("SELECT repository_id FROM repository LIMIT 1").get() as {
				repository_id: string;
			};
			this.repositoryId = idRow.repository_id as string;
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
				`SELECT name, version, kind, previous_version, format_family, format_version, title, summary,
					tags_json, object_id, package_digest, created_at
				 FROM asset_revisions WHERE name = ? AND version = ?`,
			)
			.get(name, version) as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			name: row.name as string,
			version: row.version as number,
			kind: row.kind as AssetKind,
			previousVersion: (row.previous_version as number | null) ?? null,
			formatFamily: row.format_family as string,
			formatVersion: row.format_version as number,
			title: row.title as string,
			summary: row.summary as string,
			tagsJson: row.tags_json as string,
			objectId: row.object_id as string,
			packageDigest: row.package_digest as Digest,
			createdAt: row.created_at as string,
		};
	}

	dependenciesOf(name: string, version: number): { depName: string; depVersion: number }[] {
		const rows = this.db
			.prepare("SELECT dep_name, dep_version FROM asset_dependencies WHERE name = ? AND version = ? ORDER BY dep_name")
			.all(name, version) as Record<string, unknown>[];
		return rows.map((row) => ({ depName: row.dep_name as string, depVersion: row.dep_version as number }));
	}

	sourcesOf(name: string, version: number): SourceLink[] {
		const rows = this.db
			.prepare("SELECT owner_kind, source_ref, description FROM asset_sources WHERE name = ? AND version = ?")
			.all(name, version) as Record<string, unknown>[];
		return rows.map((row) => ({
			owner: row.owner_kind as SourceLink["owner"],
			ref: row.source_ref as string,
			description: row.description as string,
		}));
	}

	evidenceOf(name: string, version: number): EvidenceCopy[] {
		const rows = this.db
			.prepare(
				`SELECT evidence_id, owner_kind, source_ref, schema_family, schema_version, payload_relpath,
					payload_digest, payload_byte_length, completeness, metadata_json, captured_at
				 FROM asset_evidence WHERE name = ? AND version = ? ORDER BY evidence_id`,
			)
			.all(name, version) as Record<string, unknown>[];
		return rows.map((row) => ({
			evidenceId: row.evidence_id as number,
			owner: row.owner_kind as "runtime" | "world",
			originalRef: row.source_ref as string,
			schema: { family: row.schema_family as string, version: row.schema_version as number },
			payloadPath: (row.payload_relpath as string | null) ?? undefined,
			payloadDigest: (row.payload_digest as Digest | null) ?? undefined,
			completeness: row.completeness as EvidenceCopy["completeness"],
			capturedAt: row.captured_at as string,
			unknowns: [],
			metadata: JSON.parse(row.metadata_json as string),
		}));
	}

	operation(ownerId: string, operationId: string): OperationRow | null {
		const row = this.db
			.prepare(
				"SELECT owner_id, operation_id, intent_digest, result_json, committed_name, committed_version FROM operations WHERE owner_id = ? AND operation_id = ?",
			)
			.get(ownerId, operationId) as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			ownerId: row.owner_id as string,
			operationId: row.operation_id as string,
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
	 * 发布事务（assets.md §6.3）：操作账本重查 → head CAS/分配版本 → commitFiles 回调
	 * （同步安装不可变包，assets.md §7.4）→ 插入修订/依赖/来源 → 以原 head 为条件推进
	 * head → 保存操作结果 → COMMIT。COMMIT 后回执失败按修订行存在性结算 commit_unknown。
	 */
	publish(
		input: PublishInput,
		commitFiles: (version: number, previousVersion: number | null) => string,
	): PublishOutcome {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.operation(input.ownerId, input.operationId);
			if (existing) {
				this.db.exec("ROLLBACK");
				if (existing.intentDigest === input.intentDigest) {
					return { ok: false, reason: "operation_committed", resultJson: existing.resultJson };
				}
				return { ok: false, reason: "operation_conflict" };
			}
			const head = this.headOf(input.name);
			let version: number;
			let previousVersion: number | null;
			if (input.expectedVersion === null) {
				if (head !== null && head.headVersion !== null) {
					this.db.exec("ROLLBACK");
					// 名称已被占用：kind 不一致优先报 kind_mismatch（比 exists 更准确）。
					if (head.kind !== input.kind) return { ok: false, reason: "kind_mismatch" };
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
					 (name, version, kind, previous_version, format_family, format_version, title, summary,
						tags_json, object_id, package_digest, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					input.name,
					version,
					input.kind,
					previousVersion,
					input.formatFamily,
					input.formatVersion,
					input.title,
					input.summary,
					input.tagsJson,
					input.objectId,
					input.packageDigest,
					now,
				);
			const insertDep = this.db.prepare(
				"INSERT INTO asset_dependencies (name, version, dep_name, dep_version) VALUES (?, ?, ?, ?)",
			);
			for (const dep of input.dependencies) {
				insertDep.run(input.name, version, dep.depName, dep.depVersion);
			}
			const insertSource = this.db.prepare(
				"INSERT INTO asset_sources (name, version, owner_kind, source_ref, description) VALUES (?, ?, ?, ?, ?)",
			);
			for (const source of input.sources) {
				insertSource.run(input.name, version, source.ownerKind, source.sourceRef, source.description);
			}
			const updated = this.db
				.prepare("UPDATE asset_heads SET head_version = ? WHERE name = ? AND head_version IS ?")
				.run(version, input.name, input.expectedVersion);
			if (Number(updated.changes) !== 1) {
				this.db.exec("ROLLBACK");
				return { ok: false, reason: "conflict" };
			}
			this.db
				.prepare(
					`INSERT INTO operations (owner_id, operation_id, operation_kind, intent_digest, result_json, committed_name, committed_version, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(input.ownerId, input.operationId, "publish", input.intentDigest, resultJson, input.name, version, now);
			this.db.exec("COMMIT");
			return { ok: true, version, previousVersion };
		} catch (error) {
			// COMMIT 已执行后失败（或安装抛错）时先尽力回滚，再按真实行存在性结算：
			// 修订行已存在且包一致 → commit_unknown（调用方报 ASSET_STORE_UNAVAILABLE + committedRef，不得删包）。
			try {
				this.db.exec("ROLLBACK");
			} catch {
				/* 事务已终结 */
			}
			const candidateVersion = input.expectedVersion === null ? 1 : input.expectedVersion + 1;
			const committed = this.revision(input.name, candidateVersion);
			if (committed && committed.packageDigest === input.packageDigest) {
				return { ok: false, reason: "commit_unknown", version: committed.version };
			}
			console.error("[mc-assets] publish failed:", error);
			return { ok: false, reason: "store_failed" };
		}
	}

	insertEvidence(name: string, version: number, copy: EvidenceCopy): number {
		const result = this.db
			.prepare(
				`INSERT INTO asset_evidence (name, version, owner_kind, source_ref, schema_family, schema_version,
					payload_relpath, payload_digest, payload_byte_length, completeness, metadata_json, captured_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				name,
				version,
				copy.owner,
				copy.originalRef,
				copy.schema.family,
				copy.schema.version,
				copy.payloadPath ?? null,
				copy.payloadDigest ?? null,
				copy.payloadPath !== undefined && copy.payloadDigest !== undefined ? 1 : null,
				copy.completeness,
				JSON.stringify(copy.metadata),
				copy.capturedAt,
			);
		return Number(result.lastInsertRowid);
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
				`SELECT r.name, r.version, r.kind, r.previous_version, r.format_family, r.format_version,
					r.title, r.summary, r.tags_json, r.object_id, r.package_digest, r.created_at
				 FROM asset_revisions r
				 ${filter.headsOnly ? "JOIN asset_heads h ON h.name = r.name AND h.head_version = r.version" : ""}
				 WHERE (? = '' OR r.name LIKE ? ESCAPE '\\' OR r.title LIKE ? ESCAPE '\\' OR r.summary LIKE ? ESCAPE '\\')
				   AND (? IS NULL OR r.kind = ?)
				 ORDER BY r.name, r.version
				 LIMIT ? OFFSET ?`,
			)
			.all(filter.query, pattern, pattern, pattern, filter.kind, filter.kind, filter.limit, filter.offset) as Record<
			string,
			unknown
		>[];
		return rows.map((row) => ({
			name: row.name as string,
			version: row.version as number,
			kind: row.kind as AssetKind,
			previousVersion: (row.previous_version as number | null) ?? null,
			formatFamily: row.format_family as string,
			formatVersion: row.format_version as number,
			title: row.title as string,
			summary: row.summary as string,
			tagsJson: row.tags_json as string,
			objectId: row.object_id as string,
			packageDigest: row.package_digest as Digest,
			createdAt: row.created_at as string,
		}));
	}

	close(): void {
		this.db.close();
	}
}
