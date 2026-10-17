/**
 * Minecraft Assets S-A2：受管不可变字节对象——stage/read、流末尾摘要核验、
 * 唯一物理对象、发布可见性、版本间隔离（LEAD.md §3 Assets 切片 2）。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	collect,
	createRepo,
	expectAssetFailure,
	blueprintContent,
	byteStream,
	tempDir,
} from "./minecraft-assets-helpers.js";

async function putBlueprintWithObject(
	repo: ReturnType<typeof createRepo>,
	requestId: string,
	name: string,
	payload: string,
	key = "source",
) {
	const object = await repo.objects.stage(
		{ requestId, key, mediaType: "application/octet-stream", fileName: `${name}.schem` },
		byteStream(payload),
	);
	const record = await repo.put({
		requestId,
		name,
		kind: "blueprint",
		content: blueprintContent(key),
		schema: "assets.blueprint@1",
		objects: { [key]: object },
		requiredAssets: [],
		evidence: [],
		sources: [],
	});
	return { object, record };
}

describe("minecraft assets 字节对象（S-A2）", () => {
	it("stage 计算摘要与长度；发布后 objects.read 全量流读出并核验", async () => {
		const { dir, cleanup } = tempDir("mcw-a2-");
		try {
			const repo = createRepo(dir);
			const payload = "SCHEM-RAW-BYTES-\u00e9\u4e2d\u6587";
			const { object, record } = await putBlueprintWithObject(repo, "req-1", "castle", payload);
			expect(object.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(object.byteLength).toBe(new TextEncoder().encode(payload).byteLength);
			expect(object.mediaType).toBe("application/octet-stream");

			const stream = await repo.objects.read({ asset: record.ref, object: "source" });
			const received = await collect(stream);
			expect(received.toString("utf8")).toBe(payload);
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("range 读取返回指定区间；未知对象键报 OBJECT_UNAVAILABLE", async () => {
		const { dir, cleanup } = tempDir("mcw-a2-");
		try {
			const repo = createRepo(dir);
			const { record } = await putBlueprintWithObject(repo, "req-1", "castle", "0123456789");
			const middle = await collect(
				await repo.objects.read({ asset: record.ref, object: "source", range: { offset: 2, length: 4 } }),
			);
			expect(middle.toString("utf8")).toBe("2345");
			const tail = await collect(
				await repo.objects.read({ asset: record.ref, object: "source", range: { offset: 8, length: 100 } }),
			);
			expect(tail.toString("utf8")).toBe("89");
			await expectAssetFailure(() => repo.objects.read({ asset: record.ref, object: "ghost" }), "OBJECT_UNAVAILABLE");
			await expectAssetFailure(() => repo.objects.read({ asset: "missing@1", object: "source" }), "ASSET_NOT_FOUND");
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("payload 被外部篡改：objects.read 在流结束时报 ASSET_CORRUPT（先产出部分 chunk）", async () => {
		const { dir, cleanup } = tempDir("mcw-a2-");
		try {
			const repo = createRepo(dir);
			const { record } = await putBlueprintWithObject(repo, "req-1", "castle", "AAAABBBB");
			const objectsDir = join(dir, "objects");
			await repo.close();

			// 重新打开并定位：目录里只有一个 payload 文件。
			const repo2 = createRepo(dir);
			const { readdirSync } = await import("node:fs");
			const [objectIdDir] = readdirSync(objectsDir).filter((entry) => {
				try {
					return readFileSync(join(objectsDir, entry, "payload")).toString("utf8") === "AAAABBBB";
				} catch {
					return false;
				}
			});
			expect(objectIdDir).toBeDefined();
			writeFileSync(join(objectsDir, objectIdDir, "payload"), "AAAACCCC");

			const stream = await repo2.objects.read({ asset: record.ref, object: "source" });
			let chunks = 0;
			await expect(async () => {
				for await (const _chunk of stream) chunks += 1;
			}).rejects.toMatchObject({ code: "ASSET_CORRUPT" });
			expect(chunks).toBeGreaterThan(0); // 错误在流结束时报告，不否定已产出部分
			await repo2.close();
		} finally {
			cleanup();
		}
	});

	it("meta.json 与目录声明不符：repository.read 报 ASSET_CORRUPT；包丢失报 ASSET_CORRUPT", async () => {
		const { dir, cleanup } = tempDir("mcw-a2-");
		try {
			const repo = createRepo(dir);
			const { record } = await putBlueprintWithObject(repo, "req-1", "castle", "BYTES");
			const objectsDir = join(dir, "objects");
			await repo.close();

			// 篡改 meta.json 的 digest。
			const repo2 = createRepo(dir);
			const { readdirSync } = await import("node:fs");
			const target = readdirSync(objectsDir).find((entry) => {
				try {
					return readFileSync(join(objectsDir, entry, "payload")).toString("utf8") === "BYTES";
				} catch {
					return false;
				}
			})!;
			const metaPath = join(objectsDir, target, "meta.json");
			const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { digest: string };
			writeFileSync(metaPath, JSON.stringify({ ...meta, digest: "sha256:" + "f".repeat(64) }));
			await expectAssetFailure(() => repo2.read("blueprint", record.ref), "ASSET_CORRUPT");
			await repo2.close();

			// 包目录整体缺失。
			const { rmSync } = await import("node:fs");
			rmSync(join(objectsDir, target), { recursive: true, force: true });
			const repo3 = createRepo(dir);
			await expectAssetFailure(() => repo3.read("blueprint", record.ref), "ASSET_CORRUPT");
			await repo3.close();
		} finally {
			cleanup();
		}
	});

	it("同 key 重复 stage：新 attempt 后写者胜；发布后修订间对象隔离，v1 字节不变", async () => {
		const { dir, cleanup } = tempDir("mcw-a2-");
		try {
			const repo = createRepo(dir);
			const first = await repo.objects.stage({ requestId: "req-1", key: "source" }, byteStream("V1"));
			const replaced = await repo.objects.stage({ requestId: "req-1", key: "source" }, byteStream("V2-LONGER"));
			expect(replaced.ref).not.toBe(first.ref);
			expect(replaced.digest).not.toBe(first.digest);

			const v1 = await repo.put({
				requestId: "req-1",
				name: "tower",
				kind: "blueprint",
				content: blueprintContent("source"),
				schema: "assets.blueprint@1",
				objects: { source: replaced },
				requiredAssets: [],
				evidence: [],
				sources: [],
			});
			expect((await collect(await repo.objects.read({ asset: v1.ref, object: "source" }))).toString("utf8")).toBe(
				"V2-LONGER",
			);

			// 修订换新对象：v2 读新字节，v1 仍读旧字节（不可变、不复用）。
			const object2 = await repo.objects.stage({ requestId: "req-2", key: "source" }, byteStream("V3"));
			const v2 = await repo.revise({
				requestId: "req-2",
				expectedRef: v1.ref,
				reason: "换对象",
				kind: "blueprint",
				content: blueprintContent("source"),
				schema: "assets.blueprint@1",
				objects: { source: object2 },
				requiredAssets: [],
				evidence: [],
				sources: [],
			});
			expect((await collect(await repo.objects.read({ asset: v1.ref, object: "source" }))).toString("utf8")).toBe(
				"V2-LONGER",
			);
			expect((await collect(await repo.objects.read({ asset: v2.ref, object: "source" }))).toString("utf8")).toBe("V3");
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("零字节对象可暂存与发布；暂存目录独占（payload 命名固定，不依赖 key 的路径安全性）", async () => {
		const { dir, cleanup } = tempDir("mcw-a2-");
		try {
			const repo = createRepo(dir);
			const object = await repo.objects.stage({ requestId: "req-1", key: "../escape" }, byteStream(""));
			expect(object.byteLength).toBe(0);
			const record = await repo.put({
				requestId: "req-1",
				name: "empty",
				kind: "blueprint",
				content: blueprintContent("../escape"),
				schema: "assets.blueprint@1",
				objects: { "../escape": object },
				requiredAssets: [],
				evidence: [],
				sources: [],
			});
			const received = await collect(await repo.objects.read({ asset: record.ref, object: "../escape" }));
			expect(received.byteLength).toBe(0);
			await repo.close();
		} finally {
			cleanup();
		}
	});
});
