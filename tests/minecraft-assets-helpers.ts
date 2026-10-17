/**
 * Assets 测试公共替身与构造器（LEAD.md 所有权前缀 minecraft-assets-*）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { createAssetRepository, type AssetRepositoryHandle } from "../.uina/worlds/minecraft/assets/index.js";
import type {
	AssetFailure,
	AssetWriteMetadata,
	BlueprintDefinition,
	ExperienceDefinition,
} from "../.uina/worlds/minecraft/contracts/assets.js";
import type { ProgramDefinition } from "../.uina/worlds/minecraft/contracts/program.js";
import type { ExactRef, Ref } from "../.uina/worlds/minecraft/contracts/values.js";

/** 窄化的相关联成员类型：spread 后仍保持 kind/content 对应（AssetDraft 是相关联联合）。 */
export type ProgramAssetDraft = AssetWriteMetadata & {
	kind: "program";
	content: ProgramDefinition;
	requestId: Ref;
	name: string;
};
export type ExperienceAssetDraft = AssetWriteMetadata & {
	kind: "experience";
	content: ExperienceDefinition;
	requestId: Ref;
	name: string;
};
export type ProgramAssetRevision = Omit<ProgramAssetDraft, "name"> & { expectedRef: ExactRef; reason: string };
import type { WorldEvidencePort } from "../.uina/worlds/minecraft/contracts/world.js";
import type { RuntimeEvidencePort } from "../.uina/worlds/minecraft/contracts/executor.js";

export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function createRepo(dir: string): AssetRepositoryHandle {
	return createAssetRepository({ dataDir: dir });
}

export function programContent(source = "return input.x;", summary = "测试程序"): ProgramDefinition {
	return {
		descriptor: {
			summary,
			input: { type: "object" },
			output: { type: "object" },
			access: "act",
			completion: { scope: "execution", description: "执行完成" },
			errors: [],
			requires: [],
			examples: [],
		},
		source,
		dependencies: [],
	};
}

export function programDraft(
	requestId: string,
	name: string,
	content: ProgramDefinition = programContent(),
): ProgramAssetDraft {
	return {
		requestId,
		name,
		kind: "program",
		content,
		schema: "assets.program@1",
		objects: {},
		requiredAssets: [],
		evidence: [],
		sources: [],
	};
}

export function blueprintContent(objectKey: string, summary = "测试蓝图"): BlueprintDefinition {
	return { summary, representation: { kind: "source", object: objectKey, formatHint: "schem" } };
}

export function experienceContent(judgment = "白天挖矿更安全。"): ExperienceDefinition {
	return {
		context: "露天采矿",
		judgment,
		method: "对比昼夜受伤记录",
		appliesTo: { assets: [], conditions: ["difficulty=normal"] },
		support: [],
		counterexamples: [],
	};
}

export function experienceDraft(requestId: string, name: string, content = experienceContent()): ExperienceAssetDraft {
	return {
		requestId,
		name,
		kind: "experience",
		content,
		schema: "assets.experience@1",
		objects: {},
		requiredAssets: [],
		evidence: [],
		sources: [],
	};
}

export function programRevision(
	requestId: string,
	expectedRef: ExactRef,
	reason: string,
	content: ProgramDefinition = programContent(),
): ProgramAssetRevision {
	return {
		requestId,
		expectedRef,
		reason,
		kind: "program",
		content,
		schema: "assets.program@1",
		objects: {},
		requiredAssets: [],
		evidence: [],
		sources: [],
	};
}

export interface FakeEvidence {
	port: WorldEvidencePort & RuntimeEvidencePort;
	retained: { owner: string; refs: string[] }[];
	released: string[];
}

export function fakeEvidence(options?: { failRetain?: boolean }): FakeEvidence {
	const retained: { owner: string; refs: string[] }[] = [];
	const released: string[] = [];
	const port = {
		async retain(owner: string, refs: string[]): Promise<void> {
			if (options?.failRetain) throw new Error("retain failed（替身）");
			retained.push({ owner, refs: [...refs] });
		},
		async release(owner: string): Promise<void> {
			released.push(owner);
		},
	};
	return { port, retained, released };
}

export function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** 合同要求 stage 的 bytes 是 AsyncIterable<Uint8Array>；测试用单块流。 */
export async function* byteStream(text: string): AsyncGenerator<Uint8Array> {
	yield bytes(text);
}

export async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of iterable) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

/** 断言 Promise 以指定 AssetErrorCode 失败。 */
export async function expectAssetFailure(
	run: () => Promise<unknown>,
	code: AssetFailure["code"],
): Promise<AssetFailure> {
	try {
		await run();
	} catch (error) {
		expect((error as AssetFailure).name).toBe("AssetFailure");
		expect((error as AssetFailure).code).toBe(code);
		return error as AssetFailure;
	}
	throw new Error(`预期失败 ${code} 未发生`);
}
