/**
 * 三 kind 内容与写元数据的结构校验（LEAD S-A1）。
 *
 * 校验只保证声明结构成立，不判断领域语义：
 * - Program：descriptor 形状（不含 ref/implementation，投影时补入）、源码非空、
 *   dependencies/bindings 结构；语法/可调用性归 Program 适配与 Runtime（assets.md §8.1）。
 * - Blueprint：source 表示必须引用本次声明的对象；target inline 校验 CellTarget 四态
 *   （set/clear/preserve/unknown，contracts/assets.ts）；领域解释归 Construction（assets.md §9）。
 * - Experience：判断/条件/来源引用结构；不验证判断为真（assets.md §10.1）。
 */

import type {
	AssetDraft,
	AssetKind,
	AssetRevision,
	AssetValue,
	BlueprintDefinition,
	BlueprintTarget,
	ExperienceDefinition,
} from "../../contracts/assets.js";
import type { ProgramDefinition } from "../../contracts/program.js";
import { isExactRef, type ExactRef, type JsonValue } from "../../contracts/values.js";
import { assetFailure } from "./failure.js";
import { isDigestFormat, isValidAssetName, parseExactRef } from "./canonical.js";

function invalid(message: string): never {
	return assetFailure("ASSET_INVALID", message);
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${what} 必须是对象`);
	return value as Record<string, unknown>;
}

function requireString(value: unknown, what: string): string {
	if (typeof value !== "string" || value.length === 0) invalid(`${what} 必须是非空字符串`);
	return value;
}

function requireExactRef(value: unknown, what: string): ExactRef {
	if (!isExactRef(value)) invalid(`${what} 必须是确切引用 name@version`);
	const parsed = parseExactRef(value);
	if (!parsed) invalid(`${what} 不是合法的本仓库引用：${String(value)}`);
	return value;
}

function requireStringArray(value: unknown, what: string): string[] {
	if (!Array.isArray(value)) invalid(`${what} 必须是数组`);
	for (const item of value) requireString(item, `${what} 的条目`);
	return value as string[];
}

/** 名称部分与 ExactRef 一致且非空去重（assets.md §8.1 bindings 结构）。 */
function validateBinding(entry: unknown, what: string): void {
	const record = requireObject(entry, what);
	const name = requireString(record.name, `${what}.name`);
	const refs = record.refs;
	if (!Array.isArray(refs) || refs.length === 0) invalid(`${what}.refs 必须是非空数组`);
	const seen = new Set<string>();
	for (const ref of refs) {
		requireExactRef(ref, `${what}.refs 条目`);
		if (!(ref as string).startsWith(`${name}@`)) invalid(`${what} 的 ref ${String(ref)} 与绑定名 ${name} 不一致`);
		if (seen.has(ref as string)) invalid(`${what} 存在重复 ref ${String(ref)}`);
		seen.add(ref as string);
	}
}

export function validateProgramDefinition(value: unknown): ProgramDefinition {
	const record = requireObject(value, "program.content");
	const descriptor = requireObject(record.descriptor, "program.descriptor");
	if ("ref" in descriptor || "implementation" in descriptor) {
		invalid("program.descriptor 不得携带 ref/implementation（由调用投影补入）");
	}
	requireString(descriptor.summary, "program.descriptor.summary");
	requireObject(descriptor.input, "program.descriptor.input");
	requireObject(descriptor.output, "program.descriptor.output");
	if (descriptor.access !== "read" && descriptor.access !== "act") {
		invalid("program.descriptor.access 必须是 read 或 act");
	}
	const completion = requireObject(descriptor.completion, "program.descriptor.completion");
	if (completion.scope !== "execution" && completion.scope !== "capability" && completion.scope !== "goal") {
		invalid("program.descriptor.completion.scope 不合法");
	}
	requireString(completion.description, "program.descriptor.completion.description");
	if (!Array.isArray(descriptor.errors)) invalid("program.descriptor.errors 必须是数组");
	for (const entry of descriptor.errors as unknown[]) {
		const error = requireObject(entry, "program.descriptor.errors 条目");
		requireString(error.code, "errors[].code");
		requireString(error.meaning, "errors[].meaning");
	}
	requireStringArray(descriptor.requires, "program.descriptor.requires");
	if (!Array.isArray(descriptor.examples)) invalid("program.descriptor.examples 必须是数组");
	for (const entry of descriptor.examples as unknown[]) {
		const example = requireObject(entry, "program.descriptor.examples 条目");
		if (!isJsonValue(example.input)) invalid("examples[].input 必须是 JSON 值");
		if (!isJsonValue(example.output)) invalid("examples[].output 必须是 JSON 值");
	}
	requireString(record.source, "program.source");
	if (record.bindings !== undefined) {
		if (!Array.isArray(record.bindings)) invalid("program.bindings 必须是数组");
		for (const entry of record.bindings as unknown[]) validateBinding(entry, "program.bindings 条目");
	}
	if (!Array.isArray(record.dependencies)) invalid("program.dependencies 必须是数组");
	for (const ref of record.dependencies as unknown[]) requireExactRef(ref, "program.dependencies 条目");
	return record as unknown as ProgramDefinition;
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value === "object" && value !== null) {
		return Object.values(value).every(isJsonValue);
	}
	return false;
}

function validateVec3(value: unknown, what: string): void {
	const record = requireObject(value, what);
	for (const axis of ["x", "y", "z"] as const) {
		const coordinate = record[axis];
		if (typeof coordinate !== "number" || !Number.isInteger(coordinate)) {
			invalid(`${what}.${axis} 必须是整数`);
		}
	}
}

function validateCellTarget(value: unknown, what: string): void {
	const record = requireObject(value, what);
	if (record.kind === "set") {
		requireString(record.block, `${what}.block`);
		const state = requireObject(record.state, `${what}.state`);
		for (const entry of Object.values(state)) {
			if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
				invalid(`${what}.state 的值必须是 string|number|boolean`);
			}
		}
		if (record.data !== undefined && !isJsonValue(record.data)) invalid(`${what}.data 必须是 JSON 值`);
		return;
	}
	if (record.kind === "clear" || record.kind === "preserve" || record.kind === "unknown") return;
	invalid(`${what}.kind 必须是 set|clear|preserve|unknown`);
}

function validateBlueprintTarget(value: unknown, what: string): BlueprintTarget {
	const record = requireObject(value, what);
	requireString(record.gameDataVersion, `${what}.gameDataVersion`);
	const bounds = requireObject(record.bounds, `${what}.bounds`);
	validateVec3(bounds.min, `${what}.bounds.min`);
	validateVec3(bounds.max, `${what}.bounds.max`);
	const min = bounds.min as BlueprintTarget["bounds"]["min"];
	const max = bounds.max as BlueprintTarget["bounds"]["max"];
	for (const axis of ["x", "y", "z"] as const) {
		if ((min[axis] as number) >= (max[axis] as number)) {
			invalid(`${what}.bounds.${axis} 要求 min < max（min 包含、max 不包含）`);
		}
	}
	if (record.defaultCell !== "preserve") invalid(`${what}.defaultCell 必须是 preserve`);
	if (!Array.isArray(record.cells)) invalid(`${what}.cells 必须是数组`);
	for (const entry of record.cells as unknown[]) {
		const cell = requireObject(entry, `${what}.cells 条目`);
		validateVec3(cell.at, `${what}.cells[].at`);
		validateCellTarget(cell.target, `${what}.cells[].target`);
	}
	return record as unknown as BlueprintTarget;
}

export function validateBlueprintDefinition(value: unknown, declaredObjects: ReadonlySet<string>): BlueprintDefinition {
	const record = requireObject(value, "blueprint.content");
	requireString(record.summary, "blueprint.summary");
	const representation = requireObject(record.representation, "blueprint.representation");
	if (representation.kind === "source") {
		const objectKey = requireString(representation.object, "blueprint.representation.object");
		if (!declaredObjects.has(objectKey)) {
			invalid(`blueprint.representation.object "${objectKey}" 未在本次声明的 objects 中`);
		}
		if (representation.formatHint !== undefined) {
			requireString(representation.formatHint, "blueprint.representation.formatHint");
		}
		return record as unknown as BlueprintDefinition;
	}
	if (representation.kind === "target") {
		const target = requireObject(representation.target, "blueprint.representation.target");
		if (target.kind === "inline") {
			validateBlueprintTarget(target.value, "blueprint.target.value");
		} else if (target.kind === "object") {
			const objectKey = requireString(target.object, "blueprint.target.object");
			if (!declaredObjects.has(objectKey)) {
				invalid(`blueprint.target.object "${objectKey}" 未在本次声明的 objects 中`);
			}
			requireExactRef(target.schema, "blueprint.target.schema");
		} else {
			invalid("blueprint.representation.target.kind 必须是 inline 或 object");
		}
		return record as unknown as BlueprintDefinition;
	}
	invalid("blueprint.representation.kind 必须是 source 或 target");
}

export function validateExperienceDefinition(value: unknown): ExperienceDefinition {
	const record = requireObject(value, "experience.content");
	requireString(record.context, "experience.context");
	requireString(record.judgment, "experience.judgment");
	requireString(record.method, "experience.method");
	const appliesTo = requireObject(record.appliesTo, "experience.appliesTo");
	if (!Array.isArray(appliesTo.assets)) invalid("experience.appliesTo.assets 必须是数组");
	for (const ref of appliesTo.assets as unknown[]) requireExactRef(ref, "experience.appliesTo.assets 条目");
	requireStringArray(appliesTo.conditions, "experience.appliesTo.conditions");
	if (!Array.isArray(record.support)) invalid("experience.support 必须是数组");
	for (const ref of record.support as unknown[]) requireString(ref, "experience.support 条目");
	if (!Array.isArray(record.counterexamples)) invalid("experience.counterexamples 必须是数组");
	for (const entry of record.counterexamples as unknown[]) {
		const counterexample = requireObject(entry, "experience.counterexamples 条目");
		requireString(counterexample.description, "counterexamples[].description");
		if (!Array.isArray(counterexample.evidence)) invalid("counterexamples[].evidence 必须是数组");
		for (const ref of counterexample.evidence as unknown[]) requireString(ref, "counterexamples[].evidence 条目");
	}
	return record as unknown as ExperienceDefinition;
}

export function validateKindContent(kind: AssetKind, content: unknown, declaredObjects: ReadonlySet<string>): void {
	if (kind === "program") validateProgramDefinition(content);
	else if (kind === "blueprint") validateBlueprintDefinition(content, declaredObjects);
	else validateExperienceDefinition(content);
}

function validateAssetObject(value: unknown, what: string): void {
	const record = requireObject(value, what);
	requireString(record.ref, `${what}.ref`);
	if (!isDigestFormat(record.digest)) invalid(`${what}.digest 必须是 sha256:<64 位十六进制>`);
	const byteLength = record.byteLength;
	if (typeof byteLength !== "number" || !Number.isInteger(byteLength) || byteLength < 0) {
		invalid(`${what}.byteLength 必须是非负整数`);
	}
	if (record.mediaType !== undefined) requireString(record.mediaType, `${what}.mediaType`);
	if (record.fileName !== undefined) requireString(record.fileName, `${what}.fileName`);
}

/** 写元数据结构校验；objects 与暂存的一致性由 repository 对照 stage 记录核验。 */
export function validateWriteMetadata(value: AssetValue): void {
	requireExactRef(value.schema, "schema");
	const objects = requireObject(value.objects, "objects");
	const declared = new Set<string>();
	for (const [key, entry] of Object.entries(objects)) {
		if (key.length === 0) invalid("objects 的键不能为空");
		if (declared.has(key)) invalid(`objects 存在重复键 "${key}"`);
		declared.add(key);
		validateAssetObject(entry, `objects["${key}"]`);
	}
	if (!Array.isArray(value.requiredAssets)) invalid("requiredAssets 必须是数组");
	for (const ref of value.requiredAssets as unknown[]) requireExactRef(ref, "requiredAssets 条目");
	if (!Array.isArray(value.evidence)) invalid("evidence 必须是数组");
	for (const entry of value.evidence as unknown[]) {
		const evidence = requireObject(entry, "evidence 条目");
		if (evidence.owner !== "world" && evidence.owner !== "runtime") {
			invalid("evidence.owner 必须是 world 或 runtime");
		}
		requireString(evidence.ref, "evidence.ref");
	}
	if (!Array.isArray(value.sources)) invalid("sources 必须是数组");
	for (const entry of value.sources as unknown[]) {
		const source = requireObject(entry, "sources 条目");
		if (source.kind === "run") {
			requireString(source.run, "sources[].run");
			requireString(source.segment, "sources[].segment");
			requireString(source.record, "sources[].record");
			if (typeof source.revision !== "number" || !Number.isInteger(source.revision) || source.revision < 0) {
				invalid("sources[].revision 必须是非负整数");
			}
			if (!isDigestFormat(source.sourceDigest)) invalid("sources[].sourceDigest 必须是 sha256 摘要");
		} else if (source.kind === "asset") {
			requireExactRef(source.ref, "sources[].ref");
		} else if (source.kind === "import") {
			requireString(source.name, "sources[].name");
			if (source.location !== undefined) requireString(source.location, "sources[].location");
		} else {
			invalid("sources[].kind 必须是 run|asset|import");
		}
	}
	validateKindContent(value.kind, value.content, declared);
}

/** put 请求整体校验（修订目标名取自 expectedRef，见 validateRevisionRequest）。 */
export function validateDraftRequest(request: AssetDraft): void {
	if (typeof request.requestId !== "string" || request.requestId.length === 0) {
		invalid("requestId 必须是非空字符串");
	}
	if (!isValidAssetName(request.name)) invalid(`资产名称不合法：${String(request.name)}`);
	validateWriteMetadata(request);
}

/**
 * revise 请求校验。合同中 AssetRevision 不携带 name：修订目标即 expectedRef
 * 的 name 部分（对当前 head 的 CAS 修订），这是唯一自洽读法——已登记 LEAD.md §7。
 */
export function validateRevisionRequest(request: AssetRevision): void {
	if (typeof request.requestId !== "string" || request.requestId.length === 0) {
		invalid("requestId 必须是非空字符串");
	}
	const parsed = parseExactRef(request.expectedRef);
	if (!parsed) invalid(`expectedRef 必须是确切引用，实际：${String(request.expectedRef)}`);
	requireString(request.reason, "reason");
	validateWriteMetadata(request);
}
