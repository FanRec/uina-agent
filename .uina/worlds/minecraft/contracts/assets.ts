/**
 * Assets 公共合同（2026-10-17 设计迁移版）。
 *
 * 唯一设计来源：docs/proposals/mc/modules/assets.md（2026-10-17 修订）。
 * 发布合同：工作文件/导入 → 受管 staging → SQLite 目录/CAS + 不可变文件包。
 * Runtime 只经 ProgramSourcePort/EvidenceExportPort 导出有限材料；
 * 旧的 put/revise、RuntimeAssetSourcePort.capture、跨库 owner O/C、资产侧 retain/release 已废弃。
 *
 * 本目录由技术负责人独占修改；变更流程见 ../LEAD.md。
 */

import type { CallableDescriptor } from "./callables.js";
import type { ProgramBinding } from "./program.js";
import type { ExactRef, JsonValue, Ref, Vec3 } from "./values.js";

export type Digest = `sha256:${string}`;
export type AssetKind = "program" | "blueprint" | "experience";
/** 全局 ExactRef 形状沿用 contracts/values.ts；Assets 侧只接受能解析为 name@正整数的值（assets.md §8.1）。 */
export type { ExactRef, JsonValue, Ref, Vec3 };

export interface RepositoryRef {
	repositoryId: string;
	name: string;
	version: number;
}

export interface FormatSchema {
	family: string;
	version: number;
}

// ---- 包与 Manifest（assets.md §4/§6.1）----

export interface PayloadEntry {
	path: string;
	mediaType: string;
	byteLength: number;
	digest: Digest;
}

export interface AuthorMetadata {
	title: string;
	summary: string;
	tags: string[];
}

export interface ProgramManifest {
	format: FormatSchema;
	/** 不含 ref/implementation；投影 Callable 时补入。 */
	descriptor: Omit<CallableDescriptor, "ref" | "implementation">;
	/** 仅已发布 Program 资产依赖（name@正整数）。 */
	dependencies: ExactRef[];
	/** 提供时是唯一、闭合的裸名解析表。 */
	bindings?: ProgramBinding[];
	sourceFile: "program.js";
	sourceForm: "async-function-body";
}

export type BlueprintDefinition =
	| { representation: "raw"; sourceFile: string; formatHint?: string }
	| { representation: "target"; schema: FormatSchema; targetFile: "target.json" };

export interface ExperienceDefinition {
	context: string;
	question: string;
	judgment: string;
	method: string;
	stance: "hypothesis" | "supported" | "disputed" | "withdrawn";
	appliesTo: { assets: ExactRef[]; conditions: string[]; minecraft: string[] };
	support: Ref[];
	counterexamples: Array<{ description: string; evidence: Ref[] }>;
}

export type ImportDefinition =
	| { kind: "program"; metadata: AuthorMetadata; definition: ProgramManifest }
	| { kind: "blueprint"; metadata: AuthorMetadata; definition: BlueprintDefinition }
	| { kind: "experience"; metadata: AuthorMetadata; sourceFile: "experience.json"; notesFile?: "notes.md" };

export type AuthorManifest = ImportDefinition;

/** 工作区 manifest.json 的作者可编辑形状；editing 是来源声明，不是可信历史。 */
export type WorkspaceManifest = AuthorManifest & {
	editing?: { baseRef: RepositoryRef | null };
};

export interface ImportedFile {
	path: string;
	mediaType: string;
	bytes: AsyncIterable<Uint8Array>;
	byteLength: number;
	/** 声明身份必须与接收的实际字节相符。 */
	digest: Digest;
}

export interface ImportSource {
	kind: "import";
	definition: AuthorManifest;
	/** 仅 payload，不能注入已发布 Manifest。 */
	files: ImportedFile[];
	label?: string;
}

export interface WorkspaceSource {
	kind: "workspace";
	/** 相对宿主绑定 workspaceRoot 的普通目录；不是任意系统路径。 */
	directory: string;
}

export type PublishSource = WorkspaceSource | ImportSource;

export interface PublishOperation {
	/** 可信接入生成并在传输重试中复用；模型不填。 */
	id: string;
	/** 本次声明发布文件的不可变输入身份。 */
	inputDigest: Digest;
}

export interface SourceLink {
	owner: "runtime" | "world" | "file" | "external";
	ref: Ref;
	description: string;
}

export interface PublishRequest {
	operation?: PublishOperation;
	name: string;
	kind: AssetKind;
	expectedRef: ExactRef | null;
	/** 默认 revise。回退/替换当前 head 须显式 replace_current，仍对当前 head CAS。 */
	intent?: "revise" | "replace_current";
	source: PublishSource;
	sourceLinks?: SourceLink[];
}

export interface PublishResult {
	ref: ExactRef;
	/** 发布前的 head（线性历史前驱）。 */
	previousRef: ExactRef | null;
	/** WorkspaceManifest.editing.baseRef 的声明投影，不证明实际派生。 */
	derivedFrom: RepositoryRef | null;
	packageDigest: Digest;
	objectId: string;
	packagePath: string;
	head: { ref: ExactRef; changedFrom: ExactRef | null };
}

// ---- 从运行段发布（assets.md §6.2）----

export interface RunSegmentRequest {
	operation?: PublishOperation;
	name: string;
	expectedRef: ExactRef | null;
	run: Ref;
	segment: Ref;
	/** Runtime 的不可变截面；重试不得重新选择"最新段状态"。 */
	record: Ref;
	intent?: "revise" | "replace_current";
	authorMetadata: AuthorMetadata;
}

export interface ProgramSegmentExport {
	implementation: "program";
	sourceBytes: Uint8Array | AsyncIterable<Uint8Array>;
	manifestBytes: Uint8Array | AsyncIterable<Uint8Array>;
	effectiveBindings: ProgramBinding[];
	nativeEnvironment: Ref;
	record: Ref;
	sourceDigest: Digest;
	sourceRef: Ref;
}

export interface NativeSegmentExport {
	implementation: "native";
	/** 执行时冻结的完整 descriptor，含确切 ref。 */
	descriptor: CallableDescriptor;
	nativeEnvironment: Ref;
	record: Ref;
	/** Runtime 当时使用的实现身份，不是包装源码摘要。 */
	implementationDigest: Digest;
}

export type ProgramExport = ProgramSegmentExport | NativeSegmentExport;

/** Runtime 的可信最小导出口；组合根注入，脚本不可伪造。 */
export interface ProgramSourcePort {
	exportSegment(request: { run: Ref; segment: Ref; record: Ref }, signal?: AbortSignal): Promise<ProgramExport>;
}

// ---- Evidence（assets.md §10.2）----

export interface AttachEvidenceRequest {
	ref: ExactRef;
	/** 精确记录/观察引用；只表达选择，不证明归属或内容。 */
	sourceRef: Ref;
	persistence: "link" | "copy";
}

/** 仅宿主进程内返回类型；绝不接受模型 JSON 反序列化为该对象。 */
export interface TrustedEvidenceExport {
	owner: "runtime" | "world";
	originalRef: Ref;
	schema: FormatSchema;
	completeness: "self_contained" | "partial" | "link_only";
	observedAt?: string;
	unknowns: string[];
	metadata: JsonValue;
	payload?: AsyncIterable<Uint8Array>;
}

export interface EvidenceExportPort {
	exportEvidence(
		request: { sourceRef: Ref; persistence: "link" | "copy" },
		signal?: AbortSignal,
	): Promise<TrustedEvidenceExport>;
}

export interface EvidenceCopy {
	evidenceId: number;
	owner: "runtime" | "world";
	originalRef: Ref;
	schema: FormatSchema;
	payloadPath?: string;
	payloadDigest?: Digest;
	completeness: "self_contained" | "partial" | "link_only";
	capturedAt: string;
	observedAt?: string;
	unknowns: string[];
	metadata: JsonValue;
}

// ---- 读视图与写视图（assets.md §11.1）----

export interface AssetSummary {
	ref: ExactRef;
	name: string;
	kind: AssetKind;
	title: string;
	summary: string;
	tags: string[];
}

export interface AssetRevisionView extends AssetSummary {
	previousRef: ExactRef | null;
	derivedFrom: RepositoryRef | null;
	format: FormatSchema;
	packageDigest: Digest;
	requires: ExactRef[];
	sources: SourceLink[];
	evidence: EvidenceCopy[];
	files: PayloadEntry[];
}

export interface AssetInspection {
	ref: ExactRef;
	format: FormatSchema;
	integrity: "verified" | "corrupt" | "unknown";
	formatSupport: "available" | "unavailable" | "unknown";
	diagnostics: { code: string; message: string; path?: string }[];
}

export type OperationResult =
	| { operationId: string; state: "committed"; result: PublishResult }
	| { operationId: string; state: "absent" | "unknown"; reason?: string };

/** 基础可读合同；read Callable 收到的是只含这些方法的独立冻结包装。 */
export interface ReadLibrary {
	resolve(name: string): Promise<{ name: string; kind: AssetKind; ref: ExactRef | null }>;
	read(ref: ExactRef): Promise<AssetRevisionView>;
	readPayload(ref: ExactRef, path: string): Promise<AsyncIterable<Uint8Array>>;
	inspect(ref: ExactRef): Promise<AssetInspection>;
	search(query: { text?: string; kind?: AssetKind; tags?: string[]; limit?: number }): Promise<AssetSummary[]>;
	listVersions(name: string, afterVersion?: number): Promise<AssetSummary[]>;
}

/** act Callable 才可取得；写入口每次准入和提交再次检查真实 scope。 */
export interface WriteLibrary extends ReadLibrary {
	publish(request: PublishRequest, signal?: AbortSignal): Promise<PublishResult>;
	publishFromRun(request: RunSegmentRequest, signal?: AbortSignal): Promise<PublishResult>;
	getOperation(operationId: string): Promise<OperationResult>;
	attachEvidence(request: AttachEvidenceRequest, signal?: AbortSignal): Promise<EvidenceCopy>;
}

/** 唯一业务实现；ReadLibrary/WriteLibrary 视图仅委托到它，不复制状态。 */
export interface AssetRepository extends WriteLibrary {}

export type AssetErrorCode =
	| "ASSET_INVALID"
	| "ASSET_NOT_FOUND"
	| "ASSET_KIND_MISMATCH"
	| "REVISION_CONFLICT"
	| "ASSET_SOURCE_CHANGED"
	| "ASSET_SOURCE_UNAVAILABLE"
	| "ASSET_DEPENDENCY_UNAVAILABLE"
	| "AIR_POLICY_REQUIRED"
	| "SCHEMA_UNAVAILABLE"
	| "ASSET_CORRUPT"
	| "OBJECT_UNAVAILABLE"
	| "OPERATION_CONFLICT"
	| "ASSET_STORE_UNAVAILABLE"
	| "ASSET_RESOURCE_EXHAUSTED";

export interface AssetFailure extends Error {
	code: AssetErrorCode;
	/** 该确切版本已确认发布但后续步骤失败；不能当"未保存"重新创建。 */
	committedRef?: ExactRef;
	/** 五态边界（assets.md §6.4 取消时点表）；缺省按 failed 解释。 */
	status?: "failed" | "cancelled" | "unknown" | "not_started";
}
