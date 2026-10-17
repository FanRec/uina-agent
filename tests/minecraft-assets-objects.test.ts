/**
 * Assets 字节对象与完整性（S-A2 新合同版）：包安装禁止覆盖、流末尾核验、损坏检测。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

describe("minecraft assets objects (integrity)", () => {
	it("发布后篡改包内 payload → readPayload 流结束 ASSET_CORRUPT；inspect 报 corrupt", async () => {
		const ws = createWorkspace();
		const { repo, dataDir, dispose } = createRepo({ workspaceRoot: ws.root });
		try {
			const dir = workspaceProgram(ws, "tamper.me");
			await repo.write.publish({
				name: "tamper.me",
				kind: "program",
				expectedRef: null,
				source: { kind: "workspace", directory: dir },
			});
			// 篡改：找到唯一的对象目录（只发布过一个修订），物理改写包内 payload。
			const { readdirSync } = await import("node:fs");
			const objectsRoot = join(dataDir, "objects");
			const [objectId] = readdirSync(objectsRoot);
			writeFileSync(join(objectsRoot, objectId, "program.js"), "TAMPERED", "utf8");

			// readPayload 返回惰性流：错误在消费（读完整）时抛出。
			const stream = await repo.read.readPayload("tamper.me@1", "program.js");
			await expect(async () => {
				for await (const chunk of stream) void chunk;
			}).rejects.toMatchObject(expectAssetFailure("ASSET_CORRUPT"));
			const inspection = await repo.read.inspect("tamper.me@1");
			expect(inspection.integrity).toBe("corrupt");
		} finally {
			ws.dispose();
			dispose();
		}
	});

	it("import 来源：声明摘要不符 ASSET_INVALID；mediaType 不符拒绝；一致则发布", async () => {
		const ws = createWorkspace();
		const { repo, dispose } = createRepo({ workspaceRoot: ws.root });
		try {
			const definition = programManifest("imported");
			const good = {
				path: "program.js",
				mediaType: "text/javascript",
				bytes: (async function* () {
					yield new TextEncoder().encode(PROGRAM_SOURCE);
				})(),
				byteLength: Buffer.byteLength(PROGRAM_SOURCE),
				digest:
					`sha256:${(await import("node:crypto")).createHash("sha256").update(PROGRAM_SOURCE).digest("hex")}` as const,
			};
			const result = await repo.write.publish({
				name: "imported",
				kind: "program",
				expectedRef: null,
				source: {
					kind: "import",
					definition: { kind: "program", metadata: authorMetadata("imported"), definition },
					files: [good],
				},
			});
			expect(result.ref).toBe("imported@1");

			// mediaType 与推导规则不符。
			const badMedia = {
				...good,
				bytes: (async function* () {
					yield new TextEncoder().encode(PROGRAM_SOURCE);
				})(),
				mediaType: "text/plain",
			};
			await expect(
				repo.write.publish({
					name: "imported2",
					kind: "program",
					expectedRef: null,
					source: {
						kind: "import",
						definition: { kind: "program", metadata: authorMetadata("imported2"), definition },
						files: [badMedia],
					},
				}),
			).rejects.toMatchObject(expectAssetFailure("ASSET_INVALID"));

			// 声明摘要与实际字节不符。
			const badDigest = {
				...good,
				bytes: (async function* () {
					yield new TextEncoder().encode("other bytes");
				})(),
				mediaType: "text/javascript",
			};
			await expect(
				repo.write.publish({
					name: "imported3",
					kind: "program",
					expectedRef: null,
					source: {
						kind: "import",
						definition: { kind: "program", metadata: authorMetadata("imported3"), definition },
						files: [badDigest],
					},
				}),
			).rejects.toMatchObject(expectAssetFailure("ASSET_INVALID"));
		} finally {
			ws.dispose();
			dispose();
		}
	});

	it("发布成功不回写工作文件；工作目录被删除不影响已发布读取", async () => {
		const ws = createWorkspace();
		const { repo, dispose } = createRepo({ workspaceRoot: ws.root });
		try {
			const manifest = { kind: "program", metadata: authorMetadata("durable"), definition: programManifest("durable") };
			const dir = ws.createDir("durable", { "manifest.json": JSON.stringify(manifest), "program.js": PROGRAM_SOURCE });
			await repo.write.publish({
				name: "durable",
				kind: "program",
				expectedRef: null,
				source: { kind: "workspace", directory: dir },
			});
			// 捕获后删除工作目录：已发布内容不受影响（assets.md §5.3）。
			ws.dispose();
			const text = await (async () => {
				const stream = await repo.read.readPayload("durable@1", "program.js");
				const chunks: Uint8Array[] = [];
				for await (const chunk of stream) chunks.push(chunk);
				return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
			})();
			expect(text).toBe(PROGRAM_SOURCE);
		} finally {
			dispose();
		}
	});
});
