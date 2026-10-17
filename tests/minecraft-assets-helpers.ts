/**
 * Assets 测试公共构造器（lead；新发布合同 2026-10-17）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { type AssetRepositoryHandle, createAssetRepository } from "../.uina/worlds/minecraft/assets/index.js";
import type { AuthorMetadata, ProgramManifest } from "../.uina/worlds/minecraft/contracts/assets.js";

export interface Workspace {
	root: string;
	dispose(): void;
	/** 在 root 下创建一个工作目录并写入文件，返回相对目录名。 */
	createDir(name: string, files: Record<string, string>): string;
}

export function createWorkspace(): Workspace {
	const root = mkdtempSync(join(tmpdir(), "mc-assets-ws-"));
	return {
		root,
		dispose: () => rmSync(root, { recursive: true, force: true }),
		createDir(name, files) {
			const dir = join(root, name);
			mkdirSync(dir, { recursive: true });
			for (const [path, content] of Object.entries(files)) {
				writeFileSync(join(dir, path), content, "utf8");
			}
			return name;
		},
	};
}

export interface TestRepo {
	repo: AssetRepositoryHandle;
	dataDir: string;
	dispose(): void;
}

export function createRepo(options?: {
	ownerId?: string;
	workspaceRoot?: string;
	programSource?: import("../.uina/worlds/minecraft/contracts/assets.js").ProgramSourcePort;
}): TestRepo {
	const dataDir = mkdtempSync(join(tmpdir(), "mc-assets-db-"));
	const workspaceRoot = options?.workspaceRoot ?? mkdtempSync(join(tmpdir(), "mc-assets-ws-"));
	const repo = createAssetRepository({
		dataDir,
		workspaceRoot,
		ownerId: options?.ownerId,
		programSource: options?.programSource,
	});
	return {
		repo,
		dataDir,
		dispose: () => {
			void repo.close();
			rmSync(dataDir, { recursive: true, force: true });
		},
	};
}

export function authorMetadata(title: string): AuthorMetadata {
	return { title, summary: `${title} 摘要`, tags: ["test"] };
}

export function programManifest(summary: string, dependencies: readonly string[] = []): ProgramManifest {
	return {
		format: { family: "assets.program.test", version: 1 },
		descriptor: {
			summary,
			input: { type: "object" },
			output: { type: "object" },
			access: "act",
			completion: { scope: "execution", description: "测试程序完成" },
			errors: [{ code: "TARGET_NOT_MET", meaning: "目标不足" }],
			requires: [],
			examples: [],
		},
		dependencies: dependencies as ProgramManifest["dependencies"],
		sourceFile: "program.js",
		sourceForm: "async-function-body",
	};
}

export const PROGRAM_SOURCE = "return { done: true };\n";

export function expectAssetFailure(code: string): { code: string } {
	return { code };
}

export { expect };
