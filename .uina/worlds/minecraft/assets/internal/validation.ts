/**
 * 作者 Manifest 与声明 payload 的结构校验（assets.md §6.1/§8.1/§9.2/§10.1）。
 *
 * 校验只保证声明结构成立，不判断领域语义：
 * - Program：descriptor 形状（不含 ref/implementation）、dependencies/bindings 结构；
 *   语法/可调用性归 Program 适配与 Runtime。
 * - Blueprint：raw 只保存 sourceFile/formatHint；target 携带 schema 身份，
 *   领域验证归 Construction（验证器不可用时不能声称已验证，inspect 如实报告）。
 * - Experience：判断/条件/立场/来源引用结构；不验证判断为真。
 */

import type { AuthorManifest, BlueprintDefinition, ProgramManifest } from "../../contracts/assets.js";
import { parseExactRef } from "./canonical.js";
import { assetFailure } from "./failure.js";

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

function requireExactAssetRef(value: unknown, what: string): string {
	const parsed = parseExactRef(value);
	if (!parsed) invalid(`${what} 必须是本仓库确切引用 name@正整数：${String(value)}`);
	return value as string;
}

function requireStringArray(value: unknown, what: string): string[] {
	if (!Array.isArray(value)) invalid(`${what} 必须是数组`);
	for (const item of value) requireString(item, `${what} 的条目`);
	return value as string[];
}

/** bindings 结构：name 与 refs 一致且非空去重（assets.md §8.1）。 */
function validateBinding(entry: unknown, what: string): void {
	const record = requireObject(entry, what);
	const name = requireString(record.name, `${what}.name`);
	const refs = record.refs;
	if (!Array.isArray(refs) || refs.length === 0) invalid(`${what}.refs 必须是非空数组`);
	const seen = new Set<string>();
	for (const ref of refs) {
		requireExactAssetRef(ref, `${what}.refs 条目`);
		if (!(ref as string).startsWith(`${name}@`)) invalid(`${what} 的 ref ${String(ref)} 与绑定名 ${name} 不一致`);
		if (seen.has(ref as string)) invalid(`${what} 存在重复 ref ${String(ref)}`);
		seen.add(ref as string);
	}
}

function validateFormatSchema(value: unknown, what: string): void {
	const record = requireObject(value, what);
	requireString(record.family, `${what}.family`);
	if (typeof record.version !== "number" || !Number.isInteger(record.version) || record.version < 1) {
		invalid(`${what}.version 必须是正整数`);
	}
}

function validateProgramManifest(value: unknown, what: string): ProgramManifest {
	const record = requireObject(value, what);
	validateFormatSchema(record.format, `${what}.format`);
	const descriptor = requireObject(record.descriptor, `${what}.descriptor`);
	if ("ref" in descriptor || "implementation" in descriptor) {
		invalid(`${what}.descriptor 不得携带 ref/implementation（由调用投影补入）`);
	}
	requireString(descriptor.summary, `${what}.descriptor.summary`);
	requireObject(descriptor.input, `${what}.descriptor.input`);
	requireObject(descriptor.output, `${what}.descriptor.output`);
	if (descriptor.access !== "read" && descriptor.access !== "act") {
		invalid(`${what}.descriptor.access 必须是 read 或 act`);
	}
	const completion = requireObject(descriptor.completion, `${what}.descriptor.completion`);
	if (completion.scope !== "execution" && completion.scope !== "capability" && completion.scope !== "goal") {
		invalid(`${what}.descriptor.completion.scope 不合法`);
	}
	requireString(completion.description, `${what}.descriptor.completion.description`);
	if (completion.verifier !== undefined)
		requireExactAssetRef(completion.verifier, `${what}.descriptor.completion.verifier`);
	if (!Array.isArray(descriptor.errors)) invalid(`${what}.descriptor.errors 必须是数组`);
	for (const entry of descriptor.errors as unknown[]) {
		const error = requireObject(entry, `${what}.descriptor.errors 条目`);
		requireString(error.code, "errors[].code");
		requireString(error.meaning, "errors[].meaning");
	}
	requireStringArray(descriptor.requires, `${what}.descriptor.requires`);
	if (!Array.isArray(descriptor.examples)) invalid(`${what}.descriptor.examples 必须是数组`);
	for (const entry of descriptor.examples as unknown[]) {
		const example = requireObject(entry, `${what}.descriptor.examples 条目`);
		for (const key of ["input", "output"] as const) {
			const v = example[key];
			if (v === undefined || v === null || typeof v === "string" || typeof v === "boolean") continue;
			if (typeof v === "number" && Number.isFinite(v)) continue;
			if (Array.isArray(v) || typeof v === "object") continue;
			invalid(`${what}.descriptor.examples[].${key} 必须是 JSON 值`);
		}
	}
	if (record.sourceFile !== "program.js") invalid(`${what}.sourceFile 必须是 "program.js"`);
	if (record.sourceForm !== "async-function-body") invalid(`${what}.sourceForm 必须是 "async-function-body"`);
	if (!Array.isArray(record.dependencies)) invalid(`${what}.dependencies 必须是数组`);
	for (const ref of record.dependencies as unknown[]) requireExactAssetRef(ref, `${what}.dependencies 条目`);
	if (record.bindings !== undefined) {
		if (!Array.isArray(record.bindings)) invalid(`${what}.bindings 必须是数组`);
		for (const entry of record.bindings as unknown[]) validateBinding(entry, `${what}.bindings 条目`);
	}
	return record as unknown as ProgramManifest;
}

function validateBlueprintDefinition(value: unknown, what: string): BlueprintDefinition {
	const record = requireObject(value, what);
	if (record.representation === "raw") {
		requireString(record.sourceFile, `${what}.sourceFile`);
		if (record.formatHint !== undefined) {
			requireString(record.formatHint, `${what}.formatHint`);
		}
		return record as unknown as BlueprintDefinition;
	}
	if (record.representation === "target") {
		validateFormatSchema(record.schema, `${what}.schema`);
		if (record.targetFile !== "target.json") {
			invalid(`${what}.targetFile 必须是 "target.json"`);
		}
		return record as unknown as BlueprintDefinition;
	}
	invalid(`${what}.representation 必须是 "raw" 或 "target"`);
}

function validateAuthorMetadata(value: unknown, what: string): void {
	const record = requireObject(value, what);
	requireString(record.title, `${what}.title`);
	requireString(record.summary, `${what}.summary`);
	requireStringArray(record.tags, `${what}.tags`);
}

/** 作者 Manifest 整体校验：kind 与领域定义一致、payload 声明路径安全（assets.md §6.1）。 */
export function validateAuthorManifest(manifest: AuthorManifest): void {
	const record = requireObject(manifest, "manifest");
	validateAuthorMetadata(record.metadata, "manifest.metadata");
	if (manifest.kind === "program") {
		validateProgramManifest(record.definition, "manifest.definition");
	} else if (manifest.kind === "blueprint") {
		validateBlueprintDefinition(record.definition, "manifest.definition");
	} else if (manifest.kind === "experience") {
		if (record.sourceFile !== "experience.json") invalid("manifest.sourceFile 必须是 experience.json");
		if (record.notesFile !== undefined && record.notesFile !== "notes.md") {
			invalid("manifest.notesFile 只能是 notes.md");
		}
	} else {
		// 穷尽分支后 manifest 收窄为 never；经 unknown 读取原始 kind 值用于报错。
		invalid(`manifest.kind 不合法：${String((manifest as unknown as { kind?: unknown }).kind)}`);
	}
	const paths = declaredPayloadPaths(manifest);
	if (paths.includes("manifest.json")) invalid("manifest.json 是保留路径，不能作为 payload");
}

/** 交付的 payload 声明集（assets.md §6.1 领域定义引用的集合）。 */
export function declaredPayloadPaths(manifest: AuthorManifest): string[] {
	if (manifest.kind === "program") return [manifest.definition.sourceFile];
	if (manifest.kind === "blueprint") {
		// TS7 属性判别不收窄父对象：用 Extract 谓词分支访问。
		const raw = manifest.definition as Extract<BlueprintDefinition, { representation: "raw" }>;
		const target = manifest.definition as Extract<BlueprintDefinition, { representation: "target" }>;
		return manifest.definition.representation === "raw" ? [raw.sourceFile] : [target.targetFile];
	}
	return manifest.notesFile ? [manifest.sourceFile, manifest.notesFile] : [manifest.sourceFile];
}
