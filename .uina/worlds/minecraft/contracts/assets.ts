/**
 * 资产仓库（AssetRepository）合同（lead 固定合同）。
 * 唯一设计来源：docs/proposals/mc/public-api.md §6.3。
 */

import type { ProgramDefinition } from "./program.js";
import type { ExactRef, JsonValue, Ref, Vec3 } from "./values.js";

export type CellTarget =
	| { kind: "set"; block: string; state: Record<string, string | number | boolean>; data?: JsonValue }
	| { kind: "clear" | "preserve" | "unknown" };

export interface BlueprintTarget {
	gameDataVersion: string;
	/** 局部整数格，min 包含、max 不包含。 */
	bounds: { min: Vec3; max: Vec3 };
	defaultCell: "preserve";
	cells: { at: Vec3; target: CellTarget }[];
}

export interface BlueprintDefinition {
	summary: string;
	representation:
		| { kind: "source"; object: string; formatHint?: string }
		| {
				kind: "target";
				target: { kind: "inline"; value: BlueprintTarget } | { kind: "object"; object: string; schema: ExactRef };
		  };
}

export interface BlueprintInterpretation {
	source: ExactRef;
	decoder: ExactRef;
	policy: { ref: ExactRef; input: JsonValue };
}

export interface ExperienceDefinition {
	context: string;
	judgment: string;
	method: string;
	appliesTo: { assets: ExactRef[]; conditions: string[] };
	support: Ref[];
	counterexamples: { description: string; evidence: Ref[] }[];
}

export interface AssetContentMap {
	program: ProgramDefinition;
	blueprint: BlueprintDefinition;
	experience: ExperienceDefinition;
}

export type AssetKind = keyof AssetContentMap;

export interface AssetEvidence {
	owner: "world" | "runtime";
	ref: Ref;
}

export type AssetSource =
	| { kind: "run"; run: Ref; segment: Ref; record: Ref; revision: number; sourceDigest: string }
	| { kind: "asset"; ref: ExactRef }
	| { kind: "import"; name: string; location?: string };

export interface AssetObject {
	ref: Ref;
	digest: string;
	byteLength: number;
	mediaType?: string;
	fileName?: string;
}

export interface AssetWriteMetadata {
	schema: ExactRef;
	objects: Record<string, AssetObject>;
	requiredAssets: ExactRef[];
	evidence: AssetEvidence[];
	sources: AssetSource[];
}

export interface AssetEnvelope extends AssetWriteMetadata {
	ref: ExactRef;
	digest: string;
	summary: string;
	basedOn?: ExactRef;
	reason?: string;
}

export type AssetRecord<K extends AssetKind = AssetKind> = {
	[P in K]: AssetEnvelope & { kind: P; content: AssetContentMap[P] };
}[K];

export type AssetValue = {
	[K in AssetKind]: AssetWriteMetadata & { kind: K; content: AssetContentMap[K] };
}[AssetKind];

export type AssetDraft = AssetValue & { requestId: Ref; name: string };
export type AssetRevision = AssetValue & { requestId: Ref; expectedRef: ExactRef; reason: string };

export interface AssetSummary {
	kind: AssetKind;
	ref: ExactRef;
	schema: ExactRef;
	digest: string;
	summary: string;
}

export interface AssetSearch {
	query: string;
	kind?: AssetKind;
	versions?: "heads" | "all";
	cursor?: string;
}

export interface AssetInspection extends AssetEnvelope {
	kind: AssetKind;
	content: JsonValue;
	schemaAvailability: { state: "available" | "unavailable" | "unknown"; reasons: string[] };
}

export type AssetErrorCode =
	| "ASSET_EXISTS"
	| "ASSET_NOT_FOUND"
	| "ASSET_KIND_MISMATCH"
	| "SCHEMA_UNAVAILABLE"
	| "ASSET_INVALID"
	| "ASSET_CORRUPT"
	| "OBJECT_UNAVAILABLE"
	| "EVIDENCE_UNAVAILABLE"
	| "ASSET_DEPENDENCY_UNAVAILABLE"
	| "REVISION_CONFLICT"
	| "REQUEST_CONFLICT"
	| "STORE_UNAVAILABLE";

export interface AssetFailure extends Error {
	code: AssetErrorCode;
	/** 该确切版本已确认发布但后续步骤失败；不能当"未保存"重新创建。 */
	committedRef?: ExactRef;
}

export interface AssetReadRepository {
	read<K extends AssetKind>(kind: K, ref: ExactRef): Promise<AssetRecord<K>>;
	search(request: AssetSearch): Promise<{ items: AssetSummary[]; next?: string }>;
	inspect(ref: ExactRef): Promise<AssetInspection>;
}

export interface AssetRepository extends AssetReadRepository {
	put(request: AssetDraft): Promise<AssetRecord>;
	revise(request: AssetRevision): Promise<AssetRecord>;
}

export interface ScriptAssetRepository extends AssetReadRepository {
	put(request: Omit<AssetDraft, "requestId">): Promise<AssetRecord>;
	revise(request: Omit<AssetRevision, "requestId">): Promise<AssetRecord>;
}

/** 仅注入可信的持久发布/导入导出所有者；脚本不获得 stage/read 流代理。 */
export interface AssetObjectPort {
	stage(
		request: { requestId: Ref; key: string; mediaType?: string; fileName?: string },
		bytes: AsyncIterable<Uint8Array>,
	): Promise<AssetObject>;
	read(request: {
		asset: ExactRef;
		object: string;
		range?: { offset: number; length: number };
	}): Promise<AsyncIterable<Uint8Array>>;
}

export type ProgramRecord = AssetRecord<"program">;

export interface ProgramSaveRequest {
	requestId: Ref;
	name: string;
	definition: ProgramDefinition;
	evidence: AssetEvidence[];
	sources?: AssetSource[];
	requiredAssets?: ExactRef[];
}

export interface ProgramSaveFromRunRequest {
	requestId: Ref;
	name: string;
	run: Ref;
	segment: Ref;
	evidence?: AssetEvidence[];
}

export interface ProgramReviseRequest {
	requestId: Ref;
	expectedRef: ExactRef;
	definition: ProgramDefinition;
	reason: string;
	evidence: AssetEvidence[];
	sources?: AssetSource[];
	requiredAssets?: ExactRef[];
}

export interface ProgramAssets {
	save(request: ProgramSaveRequest): Promise<ProgramRecord>;
	saveFromRun(request: ProgramSaveFromRunRequest): Promise<ProgramRecord>;
	read(ref: ExactRef): Promise<ProgramRecord>;
	revise(request: ProgramReviseRequest): Promise<ProgramRecord>;
}

/** 脚本侧便利门面：requestId 由运行管理生成，脚本不填。 */
export interface ScriptAssets {
	readonly repository: ScriptAssetRepository;
	save(request: Omit<ProgramSaveRequest, "requestId">): Promise<ProgramRecord>;
	saveFromRun(request: Omit<ProgramSaveFromRunRequest, "requestId">): Promise<ProgramRecord>;
	read(ref: ExactRef): Promise<ProgramRecord>;
	revise(request: Omit<ProgramReviseRequest, "requestId">): Promise<ProgramRecord>;
}

export type ReadAssets = Pick<ScriptAssets, "read"> & {
	readonly repository: Pick<ScriptAssetRepository, "read" | "search" | "inspect">;
};
