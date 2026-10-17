/**
 * Minecraft Assets S-A3：请求账本——requestId 幂等重放、REQUEST_CONFLICT、
 * 跨重启恢复与并发 CAS（LEAD.md §3 Assets 切片 3 的可测部分）。
 */

import { describe, expect, it } from "vitest";
import {
	createRepo,
	expectAssetFailure,
	experienceDraft,
	fakeEvidence,
	programContent,
	programDraft,
	tempDir,
} from "./minecraft-assets-helpers.js";
import { createAssetRepository } from "../.uina/worlds/minecraft/assets/index.js";
import type { AssetRevision } from "../.uina/worlds/minecraft/contracts/assets.js";
import type { ExactRef } from "../.uina/worlds/minecraft/contracts/values.js";

describe("minecraft assets 请求账本（S-A3）", () => {
	it("同 requestId 同意图重放：返回原结果，不产生新版本", async () => {
		const { dir, cleanup } = tempDir("mcw-a3-");
		try {
			const repo = createRepo(dir);
			const draft = programDraft("req-1", "user.p", programContent("return 1;"));
			const first = await repo.put(draft);
			const replay = await repo.put({ ...draft, requestId: "req-1" });
			expect(replay).toEqual(first);
			const all = await repo.search({ query: "user.p", versions: "all" });
			expect(all.items).toHaveLength(1);

			const revised = await repo.revise({
				requestId: "req-2",
				expectedRef: "user.p@1",
				reason: "v2",
				kind: "program",
				content: programContent("return 2;"),
				schema: "assets.program@1",
				objects: {},
				requiredAssets: [],
				evidence: [],
				sources: [],
			});
			const revisedReplay = await repo.revise({
				requestId: "req-2",
				expectedRef: "user.p@1",
				reason: "v2",
				kind: "program",
				content: programContent("return 2;"),
				schema: "assets.program@1",
				objects: {},
				requiredAssets: [],
				evidence: [],
				sources: [],
			});
			expect(revisedReplay).toEqual(revised);
			expect((await repo.search({ query: "user.p", versions: "all" })).items).toHaveLength(2);
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("同 requestId 不同意图：REQUEST_CONFLICT；跨方法复用（put→revise）同样冲突", async () => {
		const { dir, cleanup } = tempDir("mcw-a3-");
		try {
			const repo = createRepo(dir);
			const draft = programDraft("req-1", "user.p", programContent("return 1;"));
			await repo.put(draft);
			await expectAssetFailure(
				() => repo.put({ ...draft, requestId: "req-1", content: programContent("return 999;") }),
				"REQUEST_CONFLICT",
			);
			await expectAssetFailure(
				() =>
					repo.revise({
						requestId: "req-1",
						expectedRef: "user.p@1",
						reason: "换意图",
						kind: "program",
						content: programContent("return 2;"),
						schema: "assets.program@1",
						objects: {},
						requiredAssets: [],
						evidence: [],
						sources: [],
					}),
				"REQUEST_CONFLICT",
			);
			// 冲突重放不改变 head。
			expect((await repo.search({ query: "user.p" })).items[0]?.ref).toBe("user.p@1");
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("revise 重放要求 expectedRef 也一致：意图指纹覆盖基准引用", async () => {
		const { dir, cleanup } = tempDir("mcw-a3-");
		try {
			const repo = createRepo(dir);
			await repo.put(programDraft("r0", "user.p"));
			await repo.revise(reviseRequest("r1", "user.p@1", "return 2;"));
			await repo.revise(reviseRequest("r2", "user.p@2", "return 3;"));
			// 用已消费的 r1 重放：同 token 同意图 → 先于 CAS 返回原结果（head 前进不影响重放）。
			const replayR1 = await repo.revise(reviseRequest("r1", "user.p@1", "return 2;"));
			expect(replayR1.ref).toBe("user.p@2");
			// 完整一致的 r2 重放成功。
			const replay = await repo.revise(reviseRequest("r2", "user.p@2", "return 3;"));
			expect(replay.ref).toBe("user.p@3");
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("账本与目录持久化：close 后重开，重放返回原结果；head/版本完整恢复", async () => {
		const { dir, cleanup } = tempDir("mcw-a3-");
		try {
			const evidence = fakeEvidence();
			const repo = createAssetRepository({ dataDir: dir, worldEvidence: evidence.port });
			const draft = {
				...programDraft("req-1", "user.p", programContent("return 42;")),
				evidence: [{ owner: "world" as const, ref: "mcw:ev:1" }],
			};
			const first = await repo.put(draft);
			await repo.close();

			const reopened = createAssetRepository({ dataDir: dir, worldEvidence: evidence.port });
			const replay = await reopened.put({ ...draft, requestId: "req-1" });
			expect(replay).toEqual(first);
			const read = await reopened.read("program", "user.p@1");
			expect(read.content.source).toBe("return 42;");
			expect(read.evidence).toEqual([{ owner: "world", ref: "mcw:ev:1" }]);
			// 证据保留关系也持久在 World 侧替身的账本之外——这里只断言重放不再 retain 新条目。
			expect(evidence.retained).toHaveLength(1);
			await reopened.close();
		} finally {
			cleanup();
		}
	});

	it("并发 revise 同一 expectedRef：恰好一个成功，另一个 REVISION_CONFLICT", async () => {
		const { dir, cleanup } = tempDir("mcw-a3-");
		try {
			const repo = createRepo(dir);
			await repo.put(programDraft("r0", "user.p"));
			const results = await Promise.allSettled([
				repo.revise(reviseRequest("c1", "user.p@1", "return 'a';")),
				repo.revise(reviseRequest("c2", "user.p@1", "return 'b';")),
			]);
			const fulfilled = results.filter((r) => r.status === "fulfilled");
			const rejected = results.filter((r) => r.status === "rejected");
			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(1);
			expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "REVISION_CONFLICT" });
			expect((fulfilled[0] as PromiseFulfilledResult<{ ref: string }>).value.ref).toBe("user.p@2");
			// head 一致且账本只有一条成功记录。
			const heads = await repo.search({ query: "user.p" });
			expect(heads.items.map((item) => item.ref)).toEqual(["user.p@2"]);
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("发布失败（依赖缺失）不留下成功操作记录：修复后同 requestId 可重新提交", async () => {
		const { dir, cleanup } = tempDir("mcw-a3-");
		try {
			const repo = createRepo(dir);
			const draft = { ...programDraft("req-1", "user.app"), requiredAssets: ["lib@1" as ExactRef] };
			await expectAssetFailure(() => repo.put(draft), "ASSET_DEPENDENCY_UNAVAILABLE");
			await repo.put(programDraft("req-2", "lib"));
			const record = await repo.put(draft); // 同 requestId，依赖已就绪
			expect(record.ref).toBe("user.app@1");
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("experience 的 requestId 与 program 的互不串扰：不同资产类型同键按意图指纹判定", async () => {
		const { dir, cleanup } = tempDir("mcw-a3-");
		try {
			const repo = createRepo(dir);
			await repo.put(programDraft("req-1", "user.p"));
			// 同 requestId、不同 kind/内容 → intentDigest 不同 → 冲突。
			await expectAssetFailure(() => repo.put({ ...experienceDraft("req-1", "user.e") }), "REQUEST_CONFLICT");
			// 新 requestId 正常创建。
			const experience = await repo.put(experienceDraft("req-2", "user.e"));
			expect(experience.ref).toBe("user.e@1");
			await repo.close();
		} finally {
			cleanup();
		}
	});
});

function reviseRequest(requestId: string, expectedRef: ExactRef, source: string): AssetRevision {
	return {
		requestId,
		expectedRef,
		reason: `修订 ${requestId}`,
		kind: "program" as const,
		content: programContent(source),
		schema: "assets.program@1",
		objects: {},
		requiredAssets: [],
		evidence: [],
		sources: [],
	};
}
