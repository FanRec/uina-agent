/**
 * Assets 发布核心与读/写视图（assets.md §5/§6/§11.1）。
 *
 * - publish：操作账本重放先于源读取与 CAS（assets.md §6.4）；workspace/import 单次
 *   捕获进本次独占 staging，inputDigest 与 operation 声明不符为 ASSET_SOURCE_CHANGED；
 *   包 Manifest 在捕获后生成，事务内同步安装（§6.3/§7.4）。
 * - publishFromRun：经注入的 ProgramSourcePort 导出冻结段；端口未注入显式失败，
 *   不伪造 Runtime 能力。原生段按 §6.2 生成唯一包装（dependencies/bindings 均空）。
 * - attachEvidence：经注入的可信导出端口路由；来源所有者核验失败不退化成自报事实。
 * - ReadLibrary/WriteLibrary 视图仅委托到本仓库，不复制状态；read/act 不得互相冒充。
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type {
	AssetFailure,
	AssetInspection,
	AssetKind,
	AssetRepository,
	AssetRevisionView,
	AssetSummary,
	AttachEvidenceRequest,
	AuthorManifest,
	EvidenceCopy,
	EvidenceExportPort,
	FormatSchema,
	ImportedFile,
	OperationResult,
	PayloadEntry,
	ProgramSourcePort,
	PublishRequest,
	PublishResult,
	ReadLibrary,
	RepositoryRef,
	RunSegmentRequest,
	WorkspaceManifest,
	WriteLibrary,
} from "../../contracts/assets.js";
import type { ExactRef, JsonValue, Ref } from "../../contracts/values.js";
import {
	canonicalJson,
	type Digest,
	inputDigestOf,
	intentDigestOf,
	isValidAssetName,
	packageDigestOf,
	parseExactRef,
} from "./canonical.js";
import { AssetCatalog, type RevisionRow } from "./catalog.js";
import { AssetFailureError, assetFailure } from "./failure.js";
import { AssetObjectStore, assertSafeRelPath, mediaTypeOfPath } from "./objects.js";
import { declaredPayloadPaths, validateAuthorManifest } from "./validation.js";

const OWNER_HOST = "host";
const PAGE_SIZE = 50;

export interface AssetRepositoryDepsInternal {
	readonly catalog: AssetCatalog;
	readonly store: AssetObjectStore;
	/** 宿主绑定的读取根；workspace 来源 directory 必须留在根内（assets.md §5.2）。 */
	readonly workspaceRoot: string;
	/** 稳定调用者身份（assets.md §5.2 Principal）；缺省 "host"。 */
	readonly ownerId?: string;
	/** Runtime 的可信段导出口；未注入前 publishFromRun 显式失败。 */
	readonly programSource?: ProgramSourcePort;
	/** 可信证据导出口与归属路由；未注入前 attachEvidence 显式失败。 */
	readonly evidencePorts?: {
		resolveOwner(sourceRef: Ref): "runtime" | "world" | null;
		runtime?: EvidenceExportPort;
		world?: EvidenceExportPort;
	};
}

export class AssetRepositoryImpl implements AssetRepository {
	constructor(
		private readonly catalog: AssetCatalog,
		private readonly store: AssetObjectStore,
		private readonly deps: AssetRepositoryDepsInternal,
	) {}

	private get ownerId(): string {
		return this.deps.ownerId ?? OWNER_HOST;
	}

	async close(): Promise<void> {
		this.catalog.close();
	}

	// ---- publish（assets.md §6）----

	async publish(request: PublishRequest, signal?: AbortSignal): Promise<PublishResult> {
		if (signal?.aborted) {
			throw new AssetFailureError("ASSET_INVALID", "发布在开始读取前已取消", undefined, "not_started");
		}
		const shape = this.validateRequestShape(request);
		const sourceIdentity = this.sourceIdentityOf(request);

		// 操作账本重放先于源读取与 CAS：intentDigest 由 operation.inputDigest + 请求字段计算。
		if (request.operation) {
			const replay = this.replayOrConflict(request, sourceIdentity);
			if (replay) return replay;
		}

		const attemptId = this.store.createAttempt();
		try {
			const captured =
				request.source.kind === "workspace"
					? await this.captureWorkspace(attemptId, request.source.directory, request.kind, signal)
					: await this.captureImport(attemptId, request.source, signal);
			// 实际 inputDigest 与 operation 声明核对；不符 ASSET_SOURCE_CHANGED（§6.4）。
			if (request.operation && captured.inputDigest !== request.operation.inputDigest) {
				assetFailure("ASSET_SOURCE_CHANGED", `实际输入身份与 operation.inputDigest 不符：${captured.inputDigest}`);
			}
			this.validateDependencies(request.kind, captured.author);
			const intentDigest = intentDigestOf({
				repositoryId: this.catalog.repositoryId,
				ownerId: this.ownerId,
				method: "publish",
				name: request.name,
				kind: request.kind,
				expectedRef: request.expectedRef,
				intent: shape.intent,
				inputDigest: captured.inputDigest,
				sourceIdentity,
				sourceLinks: request.sourceLinks ?? [],
			});
			return await this.commitPackage(request, shape, captured, attemptId, intentDigest, signal);
		} catch (error) {
			this.store.discardAttempt(attemptId);
			throw error;
		}
	}

	private validateRequestShape(request: PublishRequest): {
		name: string;
		expectedVersion: number | null;
		intent: "revise" | "replace_current";
	} {
		if (!isValidAssetName(request.name)) assetFailure("ASSET_INVALID", `资产名称不合法：${String(request.name)}`);
		if (request.kind !== "program" && request.kind !== "blueprint" && request.kind !== "experience") {
			assetFailure("ASSET_INVALID", `kind 不合法：${String(request.kind)}`);
		}
		const intent = request.intent ?? "revise";
		if (intent !== "revise" && intent !== "replace_current") {
			assetFailure("ASSET_INVALID", `intent 不合法：${String(intent)}`);
		}
		let expectedVersion: number | null = null;
		if (request.expectedRef !== null) {
			const parsed = parseExactRef(request.expectedRef);
			if (!parsed || parsed.name !== request.name) {
				assetFailure("ASSET_INVALID", `expectedRef 与 name 不一致：${String(request.expectedRef)}`);
			}
			expectedVersion = parsed.version;
		} else if (intent === "replace_current") {
			assetFailure("ASSET_INVALID", "replace_current 需要当前 head 的 expectedRef CAS");
		}
		if (request.source.kind !== "workspace" && request.source.kind !== "import") {
			assetFailure("ASSET_INVALID", "source 必须是 workspace 或 import");
		}
		return { name: request.name, expectedVersion, intent };
	}

	private sourceIdentityOf(request: PublishRequest): JsonValue {
		// ImportDefinition/文件声明均为 JSON 兼容形状；此处 cast 仅为满足 JsonValue 索引签名。
		if (request.source.kind === "workspace") {
			return { kind: "workspace", directory: this.resolveWorkspaceDir(request.source.directory) };
		}
		if (request.source.kind === "import") {
			return {
				kind: "import",
				definition: request.source.definition,
				files: request.source.files.map((f) => ({ path: f.path, byteLength: f.byteLength, digest: f.digest })),
				label: request.source.label ?? null,
			} as unknown as JsonValue;
		}
		assetFailure("ASSET_INVALID", "source 不合法");
	}

	/** 账本重放：同键同 intentDigest 先于源读取返回原结果；同键不同意图 OPERATION_CONFLICT。 */
	private replayOrConflict(request: PublishRequest, sourceIdentity: JsonValue): PublishResult | null {
		if (!request.operation) return null;
		const intentDigest = intentDigestOf({
			repositoryId: this.catalog.repositoryId,
			ownerId: this.ownerId,
			method: "publish",
			name: request.name,
			kind: request.kind,
			expectedRef: request.expectedRef,
			intent: request.intent ?? "revise",
			inputDigest: request.operation.inputDigest,
			sourceIdentity,
			sourceLinks: request.sourceLinks ?? [],
		});
		const row = this.catalog.operation(this.ownerId, request.operation.id);
		if (!row) return null;
		if (row.intentDigest === intentDigest) {
			return JSON.parse(row.resultJson) as PublishResult;
		}
		assetFailure(
			"OPERATION_CONFLICT",
			`operation ${request.operation.id} 已被不同意图的请求提交（${row.committedName}@${row.committedVersion}）`,
		);
	}

	// ---- workspace 捕获（assets.md §5.2/§5.3）----

	private resolveWorkspaceDir(directory: string): string {
		if (typeof directory !== "string" || directory.length === 0 || directory.includes("..")) {
			assetFailure("ASSET_INVALID", `workspace directory 不合法：${String(directory)}`);
		}
		const root = resolve(this.deps.workspaceRoot);
		const target = resolve(root, directory);
		if (target !== root && !target.startsWith(root + sep)) {
			assetFailure("ASSET_INVALID", `workspace directory 越出宿主绑定读取根：${directory}`);
		}
		return target;
	}

	private async captureWorkspace(
		attemptId: string,
		directory: string,
		kind: AssetKind,
		signal?: AbortSignal,
	): Promise<CapturedBundle> {
		const dir = this.resolveWorkspaceDir(directory);
		// symlink/reparse point 拒绝：realpath 归一后仍须留在读取根内（assets.md §5.2）。
		const realRoot = await realpath(this.deps.workspaceRoot);
		const realDir = await realpath(dir).catch(() => dir);
		if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
			assetFailure("ASSET_INVALID", `workspace directory 越出读取根（symlink/reparse 拒绝）：${directory}`);
		}
		let manifestText: string;
		try {
			// Manifest 读取一次并固定；此后只解析此副本（assets.md §5.3 步骤 1）。
			manifestText = await readFile(join(dir, "manifest.json"), "utf8");
		} catch {
			assetFailure("ASSET_SOURCE_UNAVAILABLE", `工作目录缺少 manifest.json：${directory}`);
		}
		let manifest: WorkspaceManifest;
		try {
			manifest = JSON.parse(manifestText) as WorkspaceManifest;
		} catch {
			assetFailure("ASSET_INVALID", `manifest.json 不可解析：${directory}`);
		}
		if (manifest.kind !== kind) {
			assetFailure("ASSET_KIND_MISMATCH", `manifest.kind=${manifest.kind}，请求 kind=${kind}`);
		}
		validateAuthorManifest(manifest);
		// author 为去除工作区 editing 的规范值；editing 只进来源声明（assets.md §4）。
		const { editing, ...author } = manifest;
		const declaredPaths = declaredPayloadPaths(manifest);
		const payloads: PayloadEntry[] = [];
		for (const relPath of declaredPaths) {
			if (signal?.aborted) {
				throw new AssetFailureError("ASSET_INVALID", "发布在捕获期间被取消", undefined, "cancelled");
			}
			assertSafeRelPath(relPath);
			const bytes = await readFile(join(dir, ...relPath.split("/"))).catch(() =>
				assetFailure("ASSET_SOURCE_UNAVAILABLE", `声明 payload 缺失或不可读：${relPath}`),
			);
			const digest: Digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
			const captured = this.store.writeCapturedBytes(attemptId, relPath, bytes);
			this.store.recordCaptured(attemptId, captured);
			// mediaType 按固定扩展名规则推导；工作文件不自带声明（assets.md §5.2）。
			payloads.push({ path: relPath, mediaType: mediaTypeOfPath(relPath), byteLength: bytes.byteLength, digest });
		}
		const inputDigest = inputDigestOf({ author, payloads });
		return { author, payloads, inputDigest, editingBaseRef: editing?.baseRef ?? null };
	}

	// ---- import 捕获（assets.md §6.1）----

	private async captureImport(
		attemptId: string,
		source: { definition: AuthorManifest; files: ImportedFile[] },
		signal?: AbortSignal,
	): Promise<CapturedBundle> {
		const manifest = source.definition;
		validateAuthorManifest(manifest);
		const declaredPaths = declaredPayloadPaths(manifest);
		const declaredFiles = new Map(source.files.map((f) => [f.path, f]));
		// 声明集合必须一致：缺项、多项均拒绝；不得因缺项改选别的文件（assets.md §6.1）。
		for (const path of declaredPaths) {
			if (!declaredFiles.has(path)) assetFailure("ASSET_INVALID", `import 缺少声明 payload：${path}`);
		}
		if (declaredFiles.size !== declaredPaths.length) {
			assetFailure("ASSET_INVALID", "import 存在未声明的多余 payload 文件");
		}
		const payloads: PayloadEntry[] = [];
		for (const relPath of declaredPaths) {
			if (signal?.aborted) {
				throw new AssetFailureError("ASSET_INVALID", "发布在捕获期间被取消", undefined, "cancelled");
			}
			const declared = declaredFiles.get(relPath)!;
			// 导入声明匹配同一 mediaType 推导规则（assets.md §5.2）。
			if (declared.mediaType !== mediaTypeOfPath(relPath)) {
				assetFailure("ASSET_INVALID", `payload "${relPath}" 的 mediaType 与扩展名推导规则不符`);
			}
			const captured = await this.store.captureFile(attemptId, relPath, declared.bytes);
			this.store.recordCaptured(attemptId, captured);
			if (captured.digest !== declared.digest || captured.byteLength !== declared.byteLength) {
				assetFailure("ASSET_INVALID", `payload "${relPath}" 实际字节与声明长度/摘要不符`);
			}
			payloads.push({
				path: relPath,
				mediaType: declared.mediaType,
				byteLength: captured.byteLength,
				digest: captured.digest,
			});
		}
		const author = manifest;
		const inputDigest = inputDigestOf({ author, payloads });
		return { author, payloads, inputDigest, editingBaseRef: null };
	}

	// ---- 依赖与提交（assets.md §6.1/§6.3）----

	private validateDependencies(kind: AssetKind, author: AuthorManifest): void {
		if (kind !== "program" || author.kind !== "program") return;
		for (const ref of author.definition.dependencies) {
			const parsed = parseExactRef(ref);
			if (!parsed) assetFailure("ASSET_INVALID", `dependencies 条目不是本仓库确切引用：${ref}`);
			if (!this.catalog.dependencyExists(parsed)) {
				assetFailure("ASSET_DEPENDENCY_UNAVAILABLE", `必需资产在本仓库不存在：${ref}`);
			}
		}
	}

	private async commitPackage(
		request: PublishRequest,
		shape: { name: string; expectedVersion: number | null; intent: "revise" | "replace_current" },
		captured: CapturedBundle,
		attemptId: string,
		intentDigest: Digest,
		signal?: AbortSignal,
	): Promise<PublishResult> {
		// revise 的作者基准声明检查：baseRef 必须与 expectedRef 一致；缺失/不符 REVISION_CONFLICT
		// （只防未修改的旧来源声明被忽略，不证明实际派生——assets.md §6.1）。
		const derivedFrom = captured.editingBaseRef;
		if (shape.intent === "revise" && shape.expectedVersion !== null) {
			const declared =
				derivedFrom !== null &&
				derivedFrom.repositoryId === this.catalog.repositoryId &&
				derivedFrom.name === shape.name &&
				derivedFrom.version === shape.expectedVersion;
			if (!declared) {
				assetFailure(
					"REVISION_CONFLICT",
					derivedFrom === null
						? `修订缺少 editing.baseRef 声明（期望基于 @${shape.expectedVersion}）`
						: `editing.baseRef ${derivedFrom.name}@${derivedFrom.version} 与 expectedRef @${shape.expectedVersion} 不符`,
				);
			}
		}
		if (signal?.aborted) {
			throw new AssetFailureError("ASSET_INVALID", "发布在安装前被取消", undefined, "cancelled");
		}
		// 包 Manifest（assets.md §4）：J 编码实际字节 → manifestDigest → packageDigest。
		const manifestValue = {
			packageSchema: 1,
			author: captured.author,
			payloads: [...captured.payloads].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
		};
		const manifestText = canonicalJson(manifestValue);
		const manifestDigest: Digest = `sha256:${createHash("sha256").update(manifestText, "utf8").digest("hex")}`;
		const packageDigest = packageDigestOf(manifestDigest);
		const objectId = `pkg-${randomUUID()}`;
		const format = formatOf(request.kind, captured.author);
		const sources: { ownerKind: "runtime" | "world" | "file" | "external"; sourceRef: string; description: string }[] =
			[];
		if (derivedFrom !== null) {
			sources.push({
				ownerKind: "file",
				sourceRef: `${derivedFrom.repositoryId}/${derivedFrom.name}@${derivedFrom.version}`,
				description: "derivedFrom：作者编辑基准声明，不证明实际派生",
			});
		}
		for (const link of request.sourceLinks ?? []) {
			sources.push({ ownerKind: link.owner, sourceRef: link.ref, description: link.description });
		}
		const dependencies =
			request.kind === "program" && captured.author.kind === "program"
				? captured.author.definition.dependencies.flatMap((ref) => {
						const dep = parseExactRef(ref);
						return dep ? [{ depName: dep.name, depVersion: dep.version }] : [];
					})
				: [];
		const operationId = request.operation?.id ?? `op-${randomUUID()}`;
		const outcome = this.catalog.publish(
			{
				ownerId: this.ownerId,
				operationId,
				intentDigest,
				name: shape.name,
				kind: request.kind,
				expectedVersion: shape.expectedVersion,
				formatFamily: format.family,
				formatVersion: format.version,
				title: captured.author.metadata.title,
				summary: captured.author.metadata.summary,
				tagsJson: canonicalJson([...captured.author.metadata.tags]),
				packageDigest,
				objectId,
				dependencies,
				sources,
			},
			(version) => {
				// 提交临界区（assets.md §7.4）：同步安装整包，禁止覆盖。
				this.store.installPackage(attemptId, objectId, manifestText);
				// 账本保存完整结果：重放必须与首次返回逐字段一致（含 derivedFrom/head）。
				return canonicalJson({
					ref: `${shape.name}@${version}`,
					previousRef: shape.expectedVersion === null ? null : `${shape.name}@${shape.expectedVersion}`,
					derivedFrom,
					packageDigest,
					objectId,
					packagePath: `objects/${objectId}`,
					head: {
						ref: `${shape.name}@${version}`,
						changedFrom: shape.expectedVersion === null ? null : `${shape.name}@${shape.expectedVersion}`,
					},
				} satisfies PublishResult);
			},
		);
		if (outcome.ok) {
			const ref = `${shape.name}@${outcome.version}` as ExactRef;
			return {
				ref,
				previousRef: outcome.previousVersion === null ? null : (`${shape.name}@${outcome.previousVersion}` as ExactRef),
				derivedFrom,
				packageDigest,
				objectId,
				packagePath: `objects/${objectId}`,
				head: {
					ref,
					changedFrom: shape.expectedVersion === null ? null : (`${shape.name}@${shape.expectedVersion}` as ExactRef),
				},
			};
		}
		switch (outcome.reason) {
			case "operation_committed":
				return JSON.parse(outcome.resultJson) as PublishResult;
			case "operation_conflict":
				assetFailure("OPERATION_CONFLICT", "operation 已被不同意图的并发请求提交");
			case "exists":
				assetFailure("ASSET_INVALID", `资产 ${shape.name} 已存在（创建须 expectedRef=null 且 head 为空）`);
			case "not_found":
				assetFailure("ASSET_NOT_FOUND", `资产 ${shape.name} 不存在，无法修订`);
			case "kind_mismatch":
				assetFailure("ASSET_KIND_MISMATCH", `资产 ${shape.name} 的 kind 与请求不符`);
			case "conflict":
				assetFailure(
					"REVISION_CONFLICT",
					shape.expectedVersion === null
						? `并发创建冲突：${shape.name} 的 head 已存在`
						: `CAS 冲突：head 已不是 @${shape.expectedVersion}`,
				);
			case "commit_unknown": {
				const committedRef = `${shape.name}@${outcome.version}` as ExactRef;
				throw new AssetFailureError(
					"ASSET_STORE_UNAVAILABLE",
					`提交事实无法确认，但 ${committedRef} 已确认发布；不能当"未保存"重新创建`,
					committedRef,
					"unknown",
				);
			}
			case "store_failed":
				assetFailure("ASSET_STORE_UNAVAILABLE", "发布事务失败（数据库错误，详见日志）");
		}
	}

	// ---- publishFromRun（assets.md §6.2）----

	async publishFromRun(request: RunSegmentRequest, signal?: AbortSignal): Promise<PublishResult> {
		if (!this.deps.programSource) {
			assetFailure(
				"ASSET_SOURCE_UNAVAILABLE",
				"ProgramSourcePort 未注入（Runtime 切片未接线）；不能从运行段发布，不伪造导出",
			);
		}
		if (!isValidAssetName(request.name)) assetFailure("ASSET_INVALID", `资产名称不合法：${String(request.name)}`);
		let expectedVersion: number | null = null;
		if (request.expectedRef !== null) {
			const parsed = parseExactRef(request.expectedRef);
			if (!parsed || parsed.name !== request.name) {
				assetFailure("ASSET_INVALID", `expectedRef 与 name 不一致：${String(request.expectedRef)}`);
			}
			expectedVersion = parsed.version;
		}
		const export_ = await this.deps.programSource.exportSegment(
			{ run: request.run, segment: request.segment, record: request.record },
			signal,
		);
		const attemptId = this.store.createAttempt();
		try {
			const sourceBytes = await readAll(
				export_.implementation === "program" ? export_.sourceBytes : wrapperSourceBytes(export_.descriptor.ref),
			);
			const capturedSource = this.store.writeCapturedBytes(attemptId, "program.js", sourceBytes);
			this.store.recordCaptured(attemptId, capturedSource);
			let author: AuthorManifest;
			if (export_.implementation === "program") {
				const manifestBytes = await readAll(export_.manifestBytes);
				const manifest = JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
				) as import("../../contracts/assets.js").ProgramManifest;
				// effectiveBindings 转为唯一 bindings 字段（assets.md §6.2）。
				manifest.bindings = export_.effectiveBindings;
				author = { kind: "program", metadata: request.authorMetadata, definition: manifest };
			} else {
				// 原生段唯一包装：dependencies/bindings 均空；确切 ref 只在源码字面量与可信来源。
				const { ref: _ref, implementation: _impl, ...descriptor } = export_.descriptor;
				void _ref;
				void _impl;
				author = {
					kind: "program",
					metadata: request.authorMetadata,
					definition: {
						format: { family: "assets.program", version: 1 },
						descriptor,
						dependencies: [],
						bindings: [],
						sourceFile: "program.js",
						sourceForm: "async-function-body",
					},
				};
			}
			validateAuthorManifest(author);
			this.validateDependencies("program", author);
			const sourceEntry = this.store.stagedFile(attemptId, "program.js");
			if (!sourceEntry) assetFailure("ASSET_SOURCE_UNAVAILABLE", "包装源码暂存记录缺失");
			const payloads: PayloadEntry[] = [
				{
					path: "program.js",
					mediaType: mediaTypeOfPath("program.js"),
					byteLength: sourceEntry.byteLength,
					digest: sourceEntry.digest,
				},
			];
			const inputDigest = inputDigestOf({ author, payloads });
			if (request.operation && request.operation.inputDigest !== inputDigest) {
				assetFailure("ASSET_SOURCE_CHANGED", `实际输入身份与 operation.inputDigest 不符：${inputDigest}`);
			}
			const intentDigest = intentDigestOf({
				repositoryId: this.catalog.repositoryId,
				ownerId: this.ownerId,
				method: "publish_from_run",
				name: request.name,
				kind: "program",
				expectedRef: request.expectedRef,
				intent: request.intent ?? "revise",
				inputDigest,
				sourceIdentity: {
					run: request.run,
					segment: request.segment,
					record: request.record,
					authorMetadata: request.authorMetadata,
				},
				sourceLinks: [],
			});
			const format = formatOf("program", author);
			const manifestValue = { packageSchema: 1, author, payloads: [...payloads] };
			const manifestText = canonicalJson(manifestValue);
			const manifestDigest: Digest = `sha256:${createHash("sha256").update(manifestText, "utf8").digest("hex")}`;
			const packageDigest = packageDigestOf(manifestDigest);
			const objectId = `pkg-${randomUUID()}`;
			const dependencies = author.definition.dependencies.flatMap((ref) => {
				const dep = parseExactRef(ref);
				return dep ? [{ depName: dep.name, depVersion: dep.version }] : [];
			});
			const outcome = this.catalog.publish(
				{
					ownerId: this.ownerId,
					operationId: request.operation?.id ?? `op-${randomUUID()}`,
					intentDigest,
					name: request.name,
					kind: "program",
					expectedVersion,
					formatFamily: format.family,
					formatVersion: format.version,
					title: request.authorMetadata.title,
					summary: request.authorMetadata.summary,
					tagsJson: canonicalJson([...request.authorMetadata.tags]),
					packageDigest,
					objectId,
					dependencies,
					sources: [
						{
							ownerKind: "runtime",
							sourceRef: `${request.run}/${request.segment}/${request.record}`,
							description: "run segment 冻结导出：Run/Segment/Record 截面",
						},
					],
				},
				(version) => {
					this.store.installPackage(attemptId, objectId, manifestText);
					return canonicalJson({ ref: `${request.name}@${version}`, packageDigest, objectId });
				},
			);
			if (outcome.ok) {
				const ref = `${request.name}@${outcome.version}` as ExactRef;
				return {
					ref,
					previousRef:
						outcome.previousVersion === null ? null : (`${request.name}@${outcome.previousVersion}` as ExactRef),
					derivedFrom: null,
					packageDigest,
					objectId,
					packagePath: `objects/${objectId}`,
					head: { ref, changedFrom: request.expectedRef },
				};
			}
			if (outcome.reason === "operation_committed") return JSON.parse(outcome.resultJson) as PublishResult;
			if (outcome.reason === "commit_unknown") {
				const committedRef = `${request.name}@${outcome.version}` as ExactRef;
				throw new AssetFailureError(
					"ASSET_STORE_UNAVAILABLE",
					`提交事实无法确认，但 ${committedRef} 已确认发布`,
					committedRef,
					"unknown",
				);
			}
			assetFailure(
				outcome.reason === "exists"
					? "ASSET_INVALID"
					: outcome.reason === "not_found"
						? "ASSET_NOT_FOUND"
						: outcome.reason === "kind_mismatch"
							? "ASSET_KIND_MISMATCH"
							: outcome.reason === "operation_conflict"
								? "OPERATION_CONFLICT"
								: "REVISION_CONFLICT",
				"publishFromRun 事务失败",
			);
		} catch (error) {
			this.store.discardAttempt(attemptId);
			throw error;
		}
	}

	// ---- attachEvidence（assets.md §10.2）----

	async attachEvidence(request: AttachEvidenceRequest, signal?: AbortSignal): Promise<EvidenceCopy> {
		const parsed = parseExactRef(request.ref);
		if (!parsed) assetFailure("ASSET_INVALID", `ref 不是合法确切引用：${String(request.ref)}`);
		const revision = this.catalog.revision(parsed.name, parsed.version);
		if (!revision) assetFailure("ASSET_NOT_FOUND", `资产不存在：${request.ref}`);
		const routing = this.deps.evidencePorts;
		if (!routing) {
			assetFailure("ASSET_SOURCE_UNAVAILABLE", "EvidenceExportPort 未注入；不能建立可信证据关联");
		}
		const owner = routing.resolveOwner(request.sourceRef);
		if (owner === null) assetFailure("ASSET_SOURCE_UNAVAILABLE", `sourceRef 归属无法核验：${request.sourceRef}`);
		const port: EvidenceExportPort | undefined = owner === "runtime" ? routing.runtime : routing.world;
		if (!port) assetFailure("ASSET_SOURCE_UNAVAILABLE", `${owner} 的可信导出端口未注入`);
		const export_ = await port.exportEvidence(
			{ sourceRef: request.sourceRef, persistence: request.persistence },
			signal,
		);
		const copy: EvidenceCopy = {
			evidenceId: 0,
			owner,
			originalRef: export_.originalRef,
			schema: export_.schema,
			completeness: export_.completeness,
			capturedAt: new Date().toISOString(),
			observedAt: export_.observedAt,
			unknowns: [...export_.unknowns],
			metadata: export_.metadata,
		};
		if (export_.payload !== undefined && request.persistence === "copy") {
			const attemptId = this.store.createAttempt();
			try {
				const copyId = `ev-${randomUUID()}`;
				const captured = await this.store.captureFile(attemptId, `${copyId}/payload`, export_.payload);
				const manifestText = canonicalJson({
					evidenceSchema: 1,
					owner,
					originalRef: export_.originalRef,
					payload: captured,
				});
				this.store.installPackage(attemptId, copyId, manifestText);
				copy.payloadPath = `${copyId}/payload`;
				copy.payloadDigest = captured.digest;
			} catch (error) {
				this.store.discardAttempt(attemptId);
				throw error;
			}
		}
		return { ...copy, evidenceId: this.catalog.insertEvidence(parsed.name, parsed.version, copy) };
	}

	// ---- ReadLibrary（assets.md §11.1/§7.2）----

	async resolve(name: string): Promise<{ name: string; kind: AssetKind; ref: ExactRef | null }> {
		if (!isValidAssetName(name)) assetFailure("ASSET_INVALID", `资产名称不合法：${String(name)}`);
		const head = this.catalog.headOf(name);
		if (!head || head.headVersion === null) {
			assetFailure("ASSET_NOT_FOUND", `资产不存在：${name}`);
		}
		return { name, kind: head.kind, ref: `${name}@${head.headVersion}` as ExactRef };
	}

	async read(ref: ExactRef): Promise<AssetRevisionView> {
		const row = this.loadRevisionRow(ref);
		const manifest = this.loadPackageManifest(row);
		return {
			ref: `${row.name}@${row.version}` as ExactRef,
			name: row.name,
			kind: row.kind,
			title: row.title,
			summary: row.summary,
			tags: JSON.parse(row.tagsJson) as string[],
			previousRef: row.previousVersion === null ? null : (`${row.name}@${row.previousVersion}` as ExactRef),
			derivedFrom: this.derivedFromOf(row),
			format: { family: row.formatFamily, version: row.formatVersion },
			packageDigest: row.packageDigest,
			requires: this.catalog
				.dependenciesOf(row.name, row.version)
				.map((d) => `${d.depName}@${d.depVersion}` as ExactRef),
			sources: this.catalog.sourcesOf(row.name, row.version),
			evidence: this.catalog.evidenceOf(row.name, row.version),
			files: [...manifest.payloads],
		};
	}

	async readPayload(ref: ExactRef, path: string): Promise<AsyncIterable<Uint8Array>> {
		const row = this.loadRevisionRow(ref);
		if (path === "manifest.json") {
			const text = this.store.readManifest(row.objectId);
			return bytesToAsyncIterable(new TextEncoder().encode(text));
		}
		const manifest = this.loadPackageManifest(row);
		const declared = manifest.payloads.find((p) => p.path === path);
		if (!declared) assetFailure("ASSET_INVALID", `路径 "${path}" 不在包 Manifest 的 payload 表中`);
		assertSafeRelPath(path);
		return this.store.readObject(row.objectId, path, { digest: declared.digest, byteLength: declared.byteLength });
	}

	async inspect(ref: ExactRef): Promise<AssetInspection> {
		const row = this.loadRevisionRow(ref);
		const format: FormatSchema = { family: row.formatFamily, version: row.formatVersion };
		try {
			const manifest = this.loadPackageManifest(row);
			// 完整性：包 Manifest 的每个 payload 逐项流式核对（§7.2：读完整才算成功）。
			for (const payload of manifest.payloads) {
				const stream = this.store.readObject(row.objectId, payload.path, {
					digest: payload.digest,
					byteLength: payload.byteLength,
				});
				for await (const chunk of stream) {
					void chunk;
				}
			}
			return { ref, format, integrity: "verified", formatSupport: "unknown", diagnostics: [] };
		} catch (error) {
			const failure = error as AssetFailure;
			if (failure.code === "ASSET_CORRUPT" || failure.code === "OBJECT_UNAVAILABLE") {
				return {
					ref,
					format,
					integrity: "corrupt",
					formatSupport: "unknown",
					diagnostics: [{ code: failure.code, message: failure.message }],
				};
			}
			return {
				ref,
				format,
				integrity: "unknown",
				formatSupport: "unknown",
				diagnostics: [{ code: "ASSET_STORE_UNAVAILABLE", message: String(error) }],
			};
		}
	}

	async search(query: { text?: string; kind?: AssetKind; tags?: string[]; limit?: number }): Promise<AssetSummary[]> {
		const rows = this.catalog.listRevisions({
			query: query.text ?? "",
			kind: query.kind ?? null,
			headsOnly: true,
			offset: 0,
			limit: Math.min(query.limit ?? PAGE_SIZE, 500),
		});
		const requestedTags = query.tags ?? [];
		return rows
			.map((row) => ({
				ref: `${row.name}@${row.version}` as ExactRef,
				name: row.name,
				kind: row.kind,
				title: row.title,
				summary: row.summary,
				tags: JSON.parse(row.tagsJson) as string[],
			}))
			.filter((item) => requestedTags.every((tag) => item.tags.includes(tag)));
	}

	async listVersions(name: string, afterVersion?: number): Promise<AssetSummary[]> {
		if (!isValidAssetName(name)) assetFailure("ASSET_INVALID", `资产名称不合法：${String(name)}`);
		const after = afterVersion ?? 0;
		return this.catalog
			.listRevisions({ query: name, kind: null, headsOnly: false, offset: 0, limit: 10_000 })
			.filter((row) => row.name === name && row.version > after)
			.map((row) => ({
				ref: `${row.name}@${row.version}` as ExactRef,
				name: row.name,
				kind: row.kind,
				title: row.title,
				summary: row.summary,
				tags: JSON.parse(row.tagsJson) as string[],
			}));
	}

	async getOperation(operationId: string): Promise<OperationResult> {
		try {
			const row = this.catalog.operation(this.ownerId, operationId);
			if (!row) return { operationId, state: "absent" };
			return { operationId, state: "committed", result: JSON.parse(row.resultJson) as PublishResult };
		} catch (error) {
			return { operationId, state: "unknown", reason: String(error) };
		}
	}

	// ---- 内部 ----

	private loadRevisionRow(ref: ExactRef): RevisionRow {
		const parsed = parseExactRef(ref);
		if (!parsed) assetFailure("ASSET_INVALID", `不是合法确切引用：${String(ref)}`);
		const row = this.catalog.revision(parsed.name, parsed.version);
		if (!row) assetFailure("ASSET_NOT_FOUND", `资产不存在：${ref}`);
		return row;
	}

	private loadPackageManifest(row: RevisionRow): {
		packageSchema: number;
		author: AuthorManifest;
		payloads: PayloadEntry[];
	} {
		let manifest: unknown;
		try {
			manifest = JSON.parse(this.store.readManifest(row.objectId));
		} catch (error) {
			assetFailure("ASSET_CORRUPT", `包 Manifest 不可解析（objectId=${row.objectId}）：${String(error)}`);
		}
		const record = manifest as { packageSchema?: number; author?: AuthorManifest; payloads?: PayloadEntry[] };
		if (record.packageSchema !== 1 || !record.author || !Array.isArray(record.payloads)) {
			assetFailure("ASSET_CORRUPT", `包 Manifest 形状不合法（objectId=${row.objectId}）`);
		}
		return record as { packageSchema: 1; author: AuthorManifest; payloads: PayloadEntry[] };
	}

	private derivedFromOf(row: RevisionRow): RepositoryRef | null {
		for (const source of this.catalog.sourcesOf(row.name, row.version)) {
			if (source.owner === "file" && source.description.startsWith("derivedFrom")) {
				const match = /^(.+)\/([^/]+)@(\d+)$/.exec(source.ref);
				if (match) return { repositoryId: match[1], name: match[2], version: Number(match[3]) };
			}
		}
		return null;
	}
}

// ---- 冻结视图（assets.md §11.1：read/act 不得互相冒充）----

class FrozenReadLibrary implements ReadLibrary {
	constructor(protected readonly repo: AssetRepositoryImpl) {}
	resolve(name: string): Promise<{ name: string; kind: AssetKind; ref: ExactRef | null }> {
		return this.repo.resolve(name);
	}
	read(ref: ExactRef): Promise<AssetRevisionView> {
		return this.repo.read(ref);
	}
	readPayload(ref: ExactRef, path: string): Promise<AsyncIterable<Uint8Array>> {
		return this.repo.readPayload(ref, path);
	}
	inspect(ref: ExactRef): Promise<AssetInspection> {
		return this.repo.inspect(ref);
	}
	search(query: { text?: string; kind?: AssetKind; tags?: string[]; limit?: number }): Promise<AssetSummary[]> {
		return this.repo.search(query);
	}
	listVersions(name: string, afterVersion?: number): Promise<AssetSummary[]> {
		return this.repo.listVersions(name, afterVersion);
	}
}

class FrozenWriteLibrary extends FrozenReadLibrary implements WriteLibrary {
	publish(request: PublishRequest, signal?: AbortSignal): Promise<PublishResult> {
		return this.repo.publish(request, signal);
	}
	publishFromRun(request: RunSegmentRequest, signal?: AbortSignal): Promise<PublishResult> {
		return this.repo.publishFromRun(request, signal);
	}
	getOperation(operationId: string): Promise<OperationResult> {
		return this.repo.getOperation(operationId);
	}
	attachEvidence(request: AttachEvidenceRequest, signal?: AbortSignal): Promise<EvidenceCopy> {
		return this.repo.attachEvidence(request, signal);
	}
}

export function readLibraryView(repo: AssetRepositoryImpl): ReadLibrary {
	return Object.freeze(new FrozenReadLibrary(repo));
}

export function writeLibraryView(repo: AssetRepositoryImpl): WriteLibrary {
	return Object.freeze(new FrozenWriteLibrary(repo));
}

// ---- 辅助 ----

interface CapturedBundle {
	author: AuthorManifest;
	payloads: PayloadEntry[];
	inputDigest: Digest;
	editingBaseRef: RepositoryRef | null;
}

type RawBlueprint = Extract<import("../../contracts/assets.js").BlueprintDefinition, { representation: "raw" }>;

function isRawBlueprint(d: import("../../contracts/assets.js").BlueprintDefinition): d is RawBlueprint {
	return d.representation === "raw";
}

function formatOf(kind: AssetKind, author: AuthorManifest): FormatSchema {
	if (kind === "program" && author.kind === "program") return author.definition.format;
	if (kind === "blueprint" && author.kind === "blueprint") {
		return isRawBlueprint(author.definition)
			? { family: "assets.blueprint.raw", version: 1 }
			: author.definition.schema;
	}
	return { family: "assets.experience", version: 1 };
}

function wrapperSourceBytes(nativeRef: string): Uint8Array {
	// 原生段唯一包装（assets.md §6.2）：严格 UTF-8、固定换行；确切 ref 只在 mc.call 字面量。
	const jsonRef = JSON.stringify(nativeRef);
	return new TextEncoder().encode(`return await mc.call(${jsonRef}, input);\n`);
}

async function readAll(bytes: Uint8Array | AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	if (!(Symbol.asyncIterator in bytes)) return bytes as Uint8Array;
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of bytes) {
		chunks.push(chunk);
		length += chunk.byteLength;
	}
	const out = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function bytesToAsyncIterable(bytes: Uint8Array): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			yield bytes;
		},
	};
}
