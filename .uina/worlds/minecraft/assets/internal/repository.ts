/**
 * AssetRepository 业务实现（LEAD S-A1~A3；合同形状见 contracts/assets.ts，
 * 发布顺序与故障语义见 docs/proposals/mc/modules/assets.md §6.3/§6.4/§7.2）。
 *
 * - put/revise 共用发布核心：账本重放先于 CAS 与源读取；evidence 经注入端口
 *   retain，失败 EVIDENCE_UNAVAILABLE，不建立悬空引用；事务失败释放保留，
 *   已确认提交（commit_unknown）则保留随版本存续。
 * - 操作账本键为 requestId（合同无 principal 注入，键作用域退化为 requestId——
 *   已在 LEAD.md §7 登记偏差）；同键不同意图 REQUEST_CONFLICT。
 * - read 核对目录行与包 Manifest 一致性并重算内容摘要；字节级核验在
 *   objects.read 流结束时完成（assets.md §7.2）。
 */

import { randomUUID } from "node:crypto";
import type {
	AssetDraft,
	AssetInspection,
	AssetKind,
	AssetObject,
	AssetObjectPort,
	AssetRecord,
	AssetRepository,
	AssetRevision,
	AssetSearch,
	AssetSummary,
	AssetValue,
} from "../../contracts/assets.js";
import type { WorldEvidencePort } from "../../contracts/world.js";
import type { RuntimeEvidencePort } from "../../contracts/executor.js";
import type { ExactRef, JsonValue, Ref } from "../../contracts/values.js";
import { canonicalJson, contentDigestOf, formatRef, intentDigestOf, parseExactRef, type Digest } from "./canonical.js";
import { AssetCatalog, type RevisionRow } from "./catalog.js";
import { AssetFailureError, assetFailure } from "./failure.js";
import { AssetObjectStore, createObjectPort, type StagedObjectRecord } from "./objects.js";
import { validateDraftRequest, validateRevisionRequest } from "./validation.js";

const SEARCH_PAGE_SIZE = 50;

interface PreparedPublish {
	requestId: Ref;
	name: string;
	kind: AssetKind;
	expectedVersion: number | null;
	schema: ExactRef;
	summary: string;
	digest: Digest;
	intentDigest: Digest;
	reason: string | null;
}

export class AssetRepositoryImpl implements AssetRepository {
	readonly objects: AssetObjectPort;

	constructor(
		private readonly catalog: AssetCatalog,
		private readonly store: AssetObjectStore,
		private readonly worldEvidence?: WorldEvidencePort,
		private readonly runtimeEvidence?: RuntimeEvidencePort,
	) {
		this.objects = createObjectPort(store, {
			lookup: (asset, object) => this.lookupObject(asset, object),
		});
	}

	async close(): Promise<void> {
		this.catalog.close();
	}

	private lookupObject(asset: string, object: string): { objectId: string; digest: Digest; byteLength: number } | null {
		const parsed = parseExactRef(asset);
		if (!parsed) assetFailure("ASSET_INVALID", `objects.read 的 asset 不是合法确切引用：${asset}`);
		const row = this.catalog.revision(parsed.name, parsed.version);
		if (!row) assetFailure("ASSET_NOT_FOUND", `资产不存在：${asset}`);
		const objects = JSON.parse(row.objectsJson) as Record<string, AssetObject>;
		const entry = objects[object];
		if (!entry) return null;
		return { objectId: entry.ref, digest: entry.digest as Digest, byteLength: entry.byteLength };
	}

	async put(request: AssetDraft): Promise<AssetRecord> {
		validateDraftRequest(request);
		const prepared = this.prepare(request, request.name, null, null);
		return this.publish(prepared, request);
	}

	async revise(request: AssetRevision): Promise<AssetRecord> {
		validateRevisionRequest(request);
		const parsed = parseExactRef(request.expectedRef);
		if (!parsed) assetFailure("ASSET_INVALID", `expectedRef 不是合法确切引用：${String(request.expectedRef)}`);
		// 合同 AssetRevision 无 name：修订目标名即 expectedRef 的 name 部分。
		const prepared = this.prepare(request, parsed.name, parsed.version, request.reason);
		return this.publish(prepared, request);
	}

	/** 固定内容身份与意图指纹；对象暂存一致性与依赖存在性在此核验。 */
	private prepare(
		request: AssetDraft | AssetRevision,
		name: string,
		expectedVersion: number | null,
		reason: string | null,
	): PreparedPublish {
		// 对象声明必须与本次 stage 记录一致（暂存独占于 requestId，assets.md §5.3）。
		for (const [key, declared] of Object.entries(request.objects)) {
			const staged: StagedObjectRecord | undefined = this.store.stagedRecord(request.requestId, key);
			if (!staged) {
				assetFailure("ASSET_INVALID", `对象 "${key}" 未通过 objects.stage 暂存（requestId=${request.requestId}）`);
			}
			if (
				declared.ref !== staged.objectId ||
				declared.digest !== staged.digest ||
				declared.byteLength !== staged.byteLength ||
				declared.mediaType !== staged.mediaType ||
				declared.fileName !== staged.fileName
			) {
				assetFailure("ASSET_INVALID", `对象 "${key}" 的声明与暂存记录不符`);
			}
		}
		for (const ref of request.requiredAssets) {
			const parsed = parseExactRef(ref);
			if (!parsed || !this.catalog.dependencyExists(parsed)) {
				assetFailure("ASSET_DEPENDENCY_UNAVAILABLE", `必需资产在本仓库不存在：${ref}`);
			}
		}
		const digest = contentDigestOf({
			kind: request.kind,
			schema: request.schema,
			content: request.content,
			objects: request.objects,
			requiredAssets: request.requiredAssets,
		});
		const intentDigest = intentDigestOf({
			method: expectedVersion === null ? "put" : "revise",
			name,
			kind: request.kind,
			expectedRef: expectedVersion === null ? null : formatRef(name, expectedVersion),
			reason,
			schema: request.schema,
			content: request.content,
			objects: request.objects,
			requiredAssets: request.requiredAssets,
			evidence: request.evidence,
			sources: request.sources,
		});
		return {
			requestId: request.requestId,
			name,
			kind: request.kind,
			expectedVersion,
			schema: request.schema,
			summary: deriveSummary(request),
			digest,
			intentDigest,
			reason,
		};
	}

	/** 快速 head 预检（advisory；权威判定在事务内）：避免无谓的证据保留与暂存消耗。 */
	private precheckHead(prepared: PreparedPublish): void {
		const head = this.catalog.headOf(prepared.name);
		if (prepared.expectedVersion === null) {
			if (head !== null && head.headVersion !== null) {
				assetFailure(
					"ASSET_EXISTS",
					`资产 ${prepared.name} 已存在（当前 ${formatRef(prepared.name, head.headVersion)}）`,
				);
			}
			if (head !== null && head.kind !== prepared.kind) {
				assetFailure("ASSET_KIND_MISMATCH", `名称 ${prepared.name} 已被 kind=${head.kind} 占用`);
			}
			return;
		}
		if (head === null || head.headVersion === null) {
			assetFailure("ASSET_NOT_FOUND", `资产 ${prepared.name} 不存在，无法修订`);
		}
		if (head.kind !== prepared.kind) {
			assetFailure("ASSET_KIND_MISMATCH", `资产 ${prepared.name} 是 ${head.kind}，请求 kind=${prepared.kind}`);
		}
		if (head.headVersion !== prepared.expectedVersion) {
			assetFailure(
				"REVISION_CONFLICT",
				`head 已前进到 ${formatRef(prepared.name, head.headVersion)}，请求基于 @${prepared.expectedVersion}`,
			);
		}
	}

	/** 保留声明证据；任一侧失败时释放已成功一侧——不留下无提交对应的悬挂保留。 */
	private async retainEvidence(request: AssetDraft | AssetRevision): Promise<boolean> {
		const worldRefs = request.evidence.filter((entry) => entry.owner === "world").map((entry) => entry.ref);
		const runtimeRefs = request.evidence.filter((entry) => entry.owner === "runtime").map((entry) => entry.ref);
		if (worldRefs.length > 0) {
			if (!this.worldEvidence) {
				assetFailure("EVIDENCE_UNAVAILABLE", "声明了 world 证据但未注入 WorldEvidencePort，不能建立悬空引用");
			}
			try {
				await this.worldEvidence.retain(request.requestId, worldRefs);
			} catch (error) {
				throw new AssetFailureError("EVIDENCE_UNAVAILABLE", `world 证据保留失败：${String(error)}`);
			}
		}
		if (runtimeRefs.length > 0) {
			if (!this.runtimeEvidence) {
				await this.releaseEvidence(request.requestId);
				assetFailure("EVIDENCE_UNAVAILABLE", "声明了 runtime 证据但未注入 RuntimeEvidencePort，不能建立悬空引用");
			}
			try {
				await this.runtimeEvidence.retain(request.requestId, runtimeRefs);
			} catch (error) {
				await this.releaseEvidence(request.requestId);
				throw new AssetFailureError("EVIDENCE_UNAVAILABLE", `runtime 证据保留失败：${String(error)}`);
			}
		}
		return worldRefs.length + runtimeRefs.length > 0;
	}

	private async releaseEvidence(requestId: Ref): Promise<void> {
		await this.worldEvidence?.release(requestId).catch(() => undefined);
		await this.runtimeEvidence?.release(requestId).catch(() => undefined);
	}

	private async publish(prepared: PreparedPublish, request: AssetDraft | AssetRevision): Promise<AssetRecord> {
		// 账本重放先于一切源读取与 CAS（assets.md §6.4）。
		const operation = this.catalog.operation(prepared.requestId);
		if (operation) {
			if (operation.intentDigest === prepared.intentDigest) {
				return JSON.parse(operation.resultJson) as AssetRecord;
			}
			assetFailure(
				"REQUEST_CONFLICT",
				`requestId ${prepared.requestId} 已被不同意图的请求提交（committed ${operation.committedName}@${operation.committedVersion}）`,
			);
		}
		this.precheckHead(prepared);
		const retainedEvidence = await this.retainEvidence(request);
		let committedRef: ExactRef | null = null;
		try {
			const manifestAttemptId = this.store.createManifestAttempt();
			const packageObjectId = `pkg-${randomUUID()}`;
			const outcome = this.catalog.publish(
				{
					requestId: prepared.requestId,
					intentDigest: prepared.intentDigest,
					name: prepared.name,
					kind: prepared.kind,
					expectedVersion: prepared.expectedVersion,
					schema: prepared.schema,
					summary: prepared.summary,
					digest: prepared.digest,
					objectId: packageObjectId,
					objectsJson: canonicalJson(request.objects),
					requiredAssetsJson: canonicalJson(request.requiredAssets),
					evidenceJson: canonicalJson(request.evidence),
					sourcesJson: canonicalJson(request.sources),
					reason: prepared.reason,
				},
				(version) => {
					// 提交临界区（assets.md §7.4）：同步安装全部不可变对象与修订包，禁止覆盖。
					const ref = formatRef(prepared.name, version);
					const record = buildRecord(prepared, request, ref);
					for (const staged of Object.keys(request.objects).map(
						(key) => this.store.stagedRecord(request.requestId, key)!,
					)) {
						this.store.installSync(staged);
					}
					this.store.installManifestSync(
						manifestAttemptId,
						packageObjectId,
						canonicalJson({ packageSchema: 1, record }),
					);
					return canonicalJson(record);
				},
			);
			if (outcome.ok) {
				this.store.releaseStaged(request.requestId);
				return buildRecord(prepared, request, formatRef(prepared.name, outcome.version));
			}
			if (outcome.reason === "request_committed") {
				// 并发同 requestId 已提交：本侧保留（同 owner/refs，幂等）随已提交版本存续。
				const replayed = JSON.parse(outcome.record) as AssetRecord;
				committedRef = replayed.ref;
				return replayed;
			}
			if (outcome.reason === "commit_unknown") {
				committedRef = formatRef(prepared.name, outcome.version);
				throw new AssetFailureError(
					"STORE_UNAVAILABLE",
					`提交事实无法确认，但 ${committedRef} 已确认发布；不能当"未保存"重新创建`,
					committedRef,
				);
			}
			switch (outcome.reason) {
				case "exists":
					assetFailure("ASSET_EXISTS", `资产 ${prepared.name} 已存在`);
				case "not_found":
					assetFailure("ASSET_NOT_FOUND", `资产 ${prepared.name} 不存在，无法修订`);
				case "kind_mismatch":
					assetFailure("ASSET_KIND_MISMATCH", `资产 ${prepared.name} 的 kind 与请求不符`);
				case "conflict":
					assetFailure(
						"REVISION_CONFLICT",
						prepared.expectedVersion === null
							? `并发创建冲突：${prepared.name} 的 head 已存在`
							: `CAS 冲突：head 已不是 @${prepared.expectedVersion}`,
					);
				case "request_conflict":
					assetFailure("REQUEST_CONFLICT", `requestId ${prepared.requestId} 已被不同意图的并发请求提交`);
				case "store_failed":
					assetFailure("STORE_UNAVAILABLE", "发布事务失败（数据库错误，详见日志）");
			}
		} catch (error) {
			// 未提交失败的路径释放证据保留；已确认提交（committedRef 非空）则保留随版本存续。
			if (retainedEvidence && committedRef === null) await this.releaseEvidence(request.requestId);
			throw error;
		}
	}

	async read<K extends AssetKind>(kind: K, ref: ExactRef): Promise<AssetRecord<K>> {
		const record = this.readRecord(ref);
		if (record.kind !== kind) {
			assetFailure("ASSET_KIND_MISMATCH", `资产 ${ref} 是 ${record.kind}，请求 kind=${kind}`);
		}
		return record as AssetRecord<K>;
	}

	async inspect(ref: ExactRef): Promise<AssetInspection> {
		const row = this.loadRevisionRow(ref);
		const record = this.readRecord(ref);
		return {
			ref: record.ref,
			digest: record.digest,
			summary: record.summary,
			basedOn: record.basedOn,
			reason: record.reason,
			kind: row.kind,
			content: record.content as unknown as JsonValue,
			schema: record.schema,
			objects: record.objects,
			requiredAssets: record.requiredAssets,
			evidence: record.evidence,
			sources: record.sources,
			schemaAvailability: {
				state: "unknown",
				reasons: ["本仓库未注入格式 Schema 注册表；已核验的只有包目录级完整性"],
			},
		};
	}

	async search(request: AssetSearch): Promise<{ items: AssetSummary[]; next?: string }> {
		const query = typeof request.query === "string" ? request.query : "";
		const offset = parseCursor(request.cursor);
		const rows = this.catalog.listRevisions({
			query,
			kind: request.kind ?? null,
			headsOnly: request.versions !== "all",
			offset,
			limit: SEARCH_PAGE_SIZE,
		});
		const items: AssetSummary[] = rows.map((row) => ({
			kind: row.kind,
			ref: formatRef(row.name, row.version),
			schema: row.schema as ExactRef,
			digest: row.digest,
			summary: row.summary,
		}));
		if (rows.length === SEARCH_PAGE_SIZE) return { items, next: String(offset + SEARCH_PAGE_SIZE) };
		return { items };
	}

	private loadRevisionRow(ref: ExactRef): RevisionRow {
		const parsed = parseExactRef(ref);
		if (!parsed) assetFailure("ASSET_INVALID", `不是合法确切引用：${String(ref)}`);
		const row = this.catalog.revision(parsed.name, parsed.version);
		if (!row) assetFailure("ASSET_NOT_FOUND", `资产不存在：${ref}`);
		return row;
	}

	/** 读取并核对包 Manifest 与目录行的一致性（assets.md §7.2）。 */
	private readRecord(ref: ExactRef): AssetRecord {
		const row = this.loadRevisionRow(ref);
		let manifestText: string;
		try {
			manifestText = this.store.readManifest(row.objectId);
		} catch {
			assetFailure("ASSET_CORRUPT", `修订包缺失或不可读：${ref}（objectId=${row.objectId}）`);
		}
		let manifest: { packageSchema: number; record: AssetRecord };
		try {
			manifest = JSON.parse(manifestText);
		} catch {
			assetFailure("ASSET_CORRUPT", `包 Manifest 不可解析：${ref}`);
		}
		const record = manifest.record;
		if (
			manifest.packageSchema !== 1 ||
			record.ref !== ref ||
			record.kind !== row.kind ||
			record.digest !== row.digest ||
			record.summary !== row.summary ||
			record.schema !== row.schema
		) {
			assetFailure("ASSET_CORRUPT", `包 Manifest 与目录行不一致：${ref}`);
		}
		const recomputed = contentDigestOf({
			kind: row.kind,
			schema: row.schema as ExactRef,
			content: record.content as unknown as JsonValue,
			objects: record.objects,
			requiredAssets: record.requiredAssets,
		});
		if (recomputed !== row.digest) {
			assetFailure("ASSET_CORRUPT", `内容摘要不符（包内容被改动）：${ref}`);
		}
		for (const declared of Object.values(record.objects)) {
			this.store.verifyInstalledDeclaration(declared.ref, declared);
		}
		return record;
	}
}

function parseCursor(cursor: string | undefined): number {
	if (cursor === undefined) return 0;
	const value = Number(cursor);
	if (!Number.isInteger(value) || value < 0) assetFailure("ASSET_INVALID", `search cursor 不合法：${String(cursor)}`);
	return value;
}

/** 合同强制包封有 summary；program/blueprint 自带，experience 从 judgment 首行派生。 */
function deriveSummary(request: AssetValue): string {
	if (request.kind === "program")
		return String((request.content as { descriptor: { summary: string } }).descriptor.summary);
	if (request.kind === "blueprint") return String((request.content as { summary: string }).summary);
	const judgment = String((request.content as { judgment: string }).judgment);
	const firstLine = judgment.split("\n", 1)[0] ?? judgment;
	return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
}

function buildRecord(prepared: PreparedPublish, request: AssetDraft | AssetRevision, ref: ExactRef): AssetRecord {
	return {
		kind: prepared.kind,
		ref,
		digest: prepared.digest,
		summary: prepared.summary,
		reason: prepared.reason ?? undefined,
		schema: request.schema,
		objects: request.objects,
		requiredAssets: request.requiredAssets,
		evidence: request.evidence,
		sources: request.sources,
		content: request.content,
	} as unknown as AssetRecord;
}
