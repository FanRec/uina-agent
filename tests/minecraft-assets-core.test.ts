/**
 * Assets 仓库核心（S-A1 新合同版）：publish CAS、名称头、kind、依赖、读视图。
 */

import { describe, expect, it } from "vitest";
import {
	authorMetadata,
	createRepo,
	createWorkspace,
	expectAssetFailure,
	PROGRAM_SOURCE,
	programManifest,
} from "./minecraft-assets-helpers.js";

function workspaceProgram(ws: ReturnType<typeof createWorkspace>, name: string, source = PROGRAM_SOURCE): string {
	return ws.createDir(name, {
		"manifest.json": JSON.stringify({
			kind: "program",
			metadata: authorMetadata(name),
			definition: programManifest(name),
		}),
		"program.js": source,
	});
}

describe("minecraft assets core (publish/read)", () => {
	it("workspace 创建得到 name@1；重复创建 CAS 拒绝", async () => {
		const ws = createWorkspace();
		const { repo, dispose } = createRepo({ workspaceRoot: ws.root });
		try {
			const dir = workspaceProgram(ws, "gather.wood");
			const result = await repo.write.publish({
				name: "gather.wood",
				kind: "program",
				expectedRef: null,
				source: { kind: "workspace", directory: dir },
			});
			expect(result.ref).toBe("gather.wood@1");
			expect(result.previousRef).toBeNull();
			expect(result.head.ref).toBe("gather.wood@1");

			// 已存在：expectedRef=null 的创建再次失败（head CAS）。
			await expect(
				repo.write.publish({
					name: "gather.wood",
					kind: "program",
					expectedRef: null,
					source: { kind: "workspace", directory: dir },
				}),
			).rejects.toMatchObject(expectAssetFailure("ASSET_INVALID"));
		} finally {
			ws.dispose();
			dispose();
		}
	});

	it("revise：editing.baseRef 必须与 expectedRef 一致；CAS 成功得 @2；冲突 REVISION_CONFLICT", async () => {
		const ws = createWorkspace();
		const { repo, dispose } = createRepo({ workspaceRoot: ws.root });
		try {
			const manifest = {
				kind: "program",
				metadata: authorMetadata("collect"),
				definition: programManifest("collect"),
			};
			const dir = ws.createDir("collect", {
				"manifest.json": JSON.stringify(manifest),
				"program.js": PROGRAM_SOURCE,
			});
			const first = await repo.write.publish({
				name: "collect",
				kind: "program",
				expectedRef: null,
				source: { kind: "workspace", directory: dir },
			});
			expect(first.ref).toBe("collect@1");

			// 缺少 editing.baseRef 声明的修订 → REVISION_CONFLICT。
			await expect(
				repo.write.publish({
					name: "collect",
					kind: "program",
					expectedRef: "collect@1",
					source: { kind: "workspace", directory: dir },
				}),
			).rejects.toMatchObject(expectAssetFailure("REVISION_CONFLICT"));

			// 修订：作者更新 baseRef 声明 + 源码。
			ws.createDir("collect", {
				"manifest.json": JSON.stringify({
					...manifest,
					editing: { baseRef: { repositoryId: repo.catalog.repositoryId, name: "collect", version: 1 } },
				}),
				"program.js": PROGRAM_SOURCE + "// v2\n",
			});
			const second = await repo.write.publish({
				name: "collect",
				kind: "program",
				expectedRef: "collect@1",
				source: { kind: "workspace", directory: dir },
			});
			expect(second.ref).toBe("collect@2");
			expect(second.previousRef).toBe("collect@1");
			expect(second.derivedFrom).toMatchObject({ name: "collect", version: 1 });

			// 对旧 head 的并发 CAS 冲突。
			await expect(
				repo.write.publish({
					name: "collect",
					kind: "program",
					expectedRef: "collect@1",
					source: { kind: "workspace", directory: dir },
				}),
			).rejects.toMatchObject(expectAssetFailure("REVISION_CONFLICT"));
		} finally {
			ws.dispose();
			dispose();
		}
	});

	it("replace_current：显式意图跳过 baseRef 声明检查，仍执行 head CAS", async () => {
		const ws = createWorkspace();
		const { repo, dispose } = createRepo({ workspaceRoot: ws.root });
		try {
			const manifest = {
				kind: "program",
				metadata: authorMetadata("rollback.me"),
				definition: programManifest("rollback.me"),
			};
			const dir = ws.createDir("rollback.me", {
				"manifest.json": JSON.stringify(manifest),
				"program.js": PROGRAM_SOURCE,
			});
			await repo.write.publish({
				name: "rollback.me",
				kind: "program",
				expectedRef: null,
				source: { kind: "workspace", directory: dir },
			});
			const second = await repo.write.publish({
				name: "rollback.me",
				kind: "program",
				expectedRef: "rollback.me@1",
				intent: "replace_current",
				source: { kind: "workspace", directory: dir },
			});
			expect(second.ref).toBe("rollback.me@2");
			// 回退：从 @1 内容产生 @3（不移动 head 之外的任何东西）。
			const third = await repo.write.publish({
				name: "rollback.me",
				kind: "program",
				expectedRef: "rollback.me@2",
				intent: "replace_current",
				source: { kind: "workspace", directory: dir },
			});
			expect(third.ref).toBe("rollback.me@3");
			expect(third.previousRef).toBe("rollback.me@2");
		} finally {
			ws.dispose();
			dispose();
		}
	});

	it("kind 首次占用后不可变更；跨 kind 同名拒绝", async () => {
		const ws = createWorkspace();
		const { repo, dispose } = createRepo({ workspaceRoot: ws.root });
		try {
			const dir = workspaceProgram(ws, "shared.name");
			await repo.write.publish({
				name: "shared.name",
				kind: "program",
				expectedRef: null,
				source: { kind: "workspace", directory: dir },
			});
			const blueprintDir = ws.createDir("shared.name.bp", {
				"manifest.json": JSON.stringify({
					kind: "blueprint",
					metadata: authorMetadata("bp"),
					definition: { representation: "raw", sourceFile: "source.schem" },
				}),
				"source.schem": "binary-bytes",
			});
			await expect(
				repo.write.publish({
					name: "shared.name",
					kind: "blueprint",
					expectedRef: null,
					source: { kind: "workspace", directory: blueprintDir },
				}),
			).rejects.toMatchObject(expectAssetFailure("ASSET_KIND_MISMATCH"));
		} finally {
			ws.dispose();
			dispose();
		}
	});

	it("program 依赖必须存在（ASSET_DEPENDENCY_UNAVAILABLE）；存在后通过", async () => {
		const ws = createWorkspace();
		const { repo, dispose } = createRepo({ workspaceRoot: ws.root });
		try {
			const depDir = workspaceProgram(ws, "dep.base");
			await repo.write.publish({
				name: "dep.base",
				kind: "program",
				expectedRef: null,
				source: { kind: "workspace", directory: depDir },
			});

			const missing = ws.createDir("dep.user", {
				"manifest.json": JSON.stringify({
					kind: "program",
					metadata: authorMetadata("dep.user"),
					definition: programManifest("dep.user", ["dep.missing@1"]),
				}),
				"program.js": PROGRAM_SOURCE,
			});
			await expect(
				repo.write.publish({
					name: "dep.user",
					kind: "program",
					expectedRef: null,
					source: { kind: "workspace", directory: missing },
				}),
			).rejects.toMatchObject(expectAssetFailure("ASSET_DEPENDENCY_UNAVAILABLE"));

			const ok = ws.createDir("dep.user2", {
				"manifest.json": JSON.stringify({
					kind: "program",
					metadata: authorMetadata("dep.user2"),
					definition: programManifest("dep.user2", ["dep.base@1"]),
				}),
				"program.js": PROGRAM_SOURCE,
			});
			const result = await repo.write.publish({
				name: "dep.user2",
				kind: "program",
				expectedRef: null,
				source: { kind: "workspace", directory: ok },
			});
			expect(result.ref).toBe("dep.user2@1");
			const view = await repo.read.read("dep.user2@1");
			expect(view.requires).toEqual(["dep.base@1"]);
		} finally {
			ws.dispose();
			dispose();
		}
	});

	it("读视图：resolve/read/readPayload/inspect/listVersions；payload 流末尾核验", async () => {
		const ws = createWorkspace();
		const { repo, dispose } = createRepo({ workspaceRoot: ws.root });
		try {
			const dir = workspaceProgram(ws, "read.me");
			const published = await repo.write.publish({
				name: "read.me",
				kind: "program",
				expectedRef: null,
				source: { kind: "workspace", directory: dir },
			});

			const resolved = await repo.read.resolve("read.me");
			expect(resolved).toMatchObject({ name: "read.me", kind: "program", ref: "read.me@1" });

			const view = await repo.read.read("read.me@1");
			expect(view.kind).toBe("program");
			expect(view.files.map((f) => f.path)).toEqual(["program.js"]);

			// 源码逐字节往返。
			const stream = await repo.read.readPayload("read.me@1", "program.js");
			const chunks: Uint8Array[] = [];
			for await (const chunk of stream) chunks.push(chunk);
			const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
			expect(text).toBe(PROGRAM_SOURCE);

			const inspection = await repo.read.inspect("read.me@1");
			expect(inspection.integrity).toBe("verified");

			// 不在 Manifest 表中的路径拒绝。
			await expect(repo.read.readPayload("read.me@1", "not-declared.js")).rejects.toMatchObject(
				expectAssetFailure("ASSET_INVALID"),
			);
			void published;
		} finally {
			ws.dispose();
			dispose();
		}
	});

	it("search/listVersions：head 查询与版本列表", async () => {
		const ws = createWorkspace();
		const { repo, dispose } = createRepo({ workspaceRoot: ws.root });
		try {
			const manifest = {
				kind: "program",
				metadata: authorMetadata("search.target"),
				definition: programManifest("search.target"),
			};
			ws.createDir("search.target", { "manifest.json": JSON.stringify(manifest), "program.js": PROGRAM_SOURCE });
			await repo.write.publish({
				name: "search.target",
				kind: "program",
				expectedRef: null,
				source: { kind: "workspace", directory: "search.target" },
			});
			ws.createDir("search.target", {
				"manifest.json": JSON.stringify({
					...manifest,
					editing: { baseRef: { repositoryId: repo.catalog.repositoryId, name: "search.target", version: 1 } },
				}),
				"program.js": PROGRAM_SOURCE + "// v2\n",
			});
			await repo.write.publish({
				name: "search.target",
				kind: "program",
				expectedRef: "search.target@1",
				source: { kind: "workspace", directory: "search.target" },
			});
			const heads = await repo.read.search({ text: "search.target" });
			expect(heads).toHaveLength(1);
			expect(heads[0].ref).toBe("search.target@2");
			const versions = await repo.read.listVersions("search.target");
			expect(versions.map((v) => v.ref)).toEqual(["search.target@1", "search.target@2"]);
		} finally {
			ws.dispose();
			dispose();
		}
	});

	it("名称规范与路径安全：非法名称/路径穿越/保留路径拒绝", async () => {
		const ws = createWorkspace();
		const { repo, dispose } = createRepo({ workspaceRoot: ws.root });
		try {
			await expect(
				repo.write.publish({
					name: "Bad.Name",
					kind: "program",
					expectedRef: null,
					source: { kind: "workspace", directory: "x" },
				}),
			).rejects.toMatchObject(expectAssetFailure("ASSET_INVALID"));

			// 声明保留路径 manifest.json 作为 payload → 拒绝。
			ws.createDir("reserved", {
				"manifest.json": JSON.stringify({
					kind: "program",
					metadata: authorMetadata("reserved"),
					definition: { ...programManifest("reserved"), sourceFile: "manifest.json" },
				}),
			});
			await expect(
				repo.write.publish({
					name: "reserved",
					kind: "program",
					expectedRef: null,
					source: { kind: "workspace", directory: "reserved" },
				}),
			).rejects.toMatchObject(expectAssetFailure("ASSET_INVALID"));

			// workspace 目录越出读取根。
			await expect(
				repo.write.publish({
					name: "escape",
					kind: "program",
					expectedRef: null,
					source: { kind: "workspace", directory: "../outside" },
				}),
			).rejects.toMatchObject(expectAssetFailure("ASSET_INVALID"));
		} finally {
			ws.dispose();
			dispose();
		}
	});
});
