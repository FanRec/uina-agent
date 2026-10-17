/**
 * Minecraft Assets S-A1：仓库核心——put/revise CAS、名称头、摘要规范化、
 * 三 kind 校验、依赖存在性、证据保留与检索（LEAD.md §3 Assets 切片 1）。
 */

import { describe, expect, it } from "vitest";
import { createAssetRepository } from "../.uina/worlds/minecraft/assets/index.js";
import type { AssetDraft } from "../.uina/worlds/minecraft/contracts/assets.js";
import type { ProgramDefinition } from "../.uina/worlds/minecraft/contracts/program.js";
import type { CellTarget } from "../.uina/worlds/minecraft/contracts/assets.js";
import type { ExactRef } from "../.uina/worlds/minecraft/contracts/values.js";
import {
	blueprintContent,
	byteStream,
	createRepo,
	expectAssetFailure,
	experienceContent,
	experienceDraft,
	fakeEvidence,
	programContent,
	programDraft,
	programRevision,
	tempDir,
} from "./minecraft-assets-helpers.js";

describe("minecraft assets 仓库核心（S-A1）", () => {
	it("put 创建 @1 并可读回；digest 稳定；read kind 不符报 ASSET_KIND_MISMATCH", async () => {
		const { dir, cleanup } = tempDir("mcw-a1-");
		try {
			const repo = createRepo(dir);
			const draft = programDraft("req-1", "user.parkour");
			const record = await repo.put(draft);
			expect(record.ref).toBe("user.parkour@1");
			expect(record.summary).toBe("测试程序");
			expect(record.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(record.reason).toBeUndefined();

			const read = await repo.read("program", "user.parkour@1");
			expect(read.content.source).toBe("return input.x;");
			expect(read.digest).toBe(record.digest);
			await expectAssetFailure(() => repo.read("blueprint", "user.parkour@1"), "ASSET_KIND_MISMATCH");
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("重复创建报 ASSET_EXISTS；revise CAS 成功得 @2、reason 入包；错误 expectedRef 报冲突", async () => {
		const { dir, cleanup } = tempDir("mcw-a1-");
		try {
			const repo = createRepo(dir);
			await repo.put(programDraft("req-1", "user.parkour"));
			await expectAssetFailure(() => repo.put(programDraft("req-2", "user.parkour")), "ASSET_EXISTS");

			const revised = await repo.revise({
				requestId: "req-3",
				expectedRef: "user.parkour@1",
				reason: "修正起跳判定",
				kind: "program",
				content: programContent("return input.y;"),
				schema: "assets.program@1",
				objects: {},
				requiredAssets: [],
				evidence: [],
				sources: [],
			});
			expect(revised.ref).toBe("user.parkour@2");
			expect(revised.reason).toBe("修正起跳判定");
			expect(revised.digest).not.toBe((await repo.read("program", "user.parkour@1")).digest);

			await expectAssetFailure(
				() => repo.revise({ ...programDraft("req-4", "ignored"), expectedRef: "user.parkour@1", reason: "过期基准" }),
				"REVISION_CONFLICT",
			);
			await expectAssetFailure(
				() => repo.revise({ ...programDraft("req-5", "ignored"), expectedRef: "ghost@1", reason: "不存在" }),
				"ASSET_NOT_FOUND",
			);
			// 旧版本仍可读（不可变版本历史）。
			expect((await repo.read("program", "user.parkour@1")).content.source).toBe("return input.x;");
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("名称校验：大写、斜杠、@、空串、保留设备名、首字符点均拒绝", async () => {
		const { dir, cleanup } = tempDir("mcw-a1-");
		try {
			const repo = createRepo(dir);
			for (const name of ["User.parkour", "a/b", "a@1", "", "con", "Con.txt", "com1", "..", ".hidden", "a b"]) {
				await expectAssetFailure(() => repo.put(programDraft(`req-${name}`, name)), "ASSET_INVALID");
			}
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("内容摘要规范化：同内容不同键序跨资产得到相同 digest；evidence/sources 不改变内容摘要", async () => {
		const { dir, cleanup } = tempDir("mcw-a1-");
		try {
			const repo = createRepo(dir);
			// 两个程序内容语义相同但 descriptor 键插入顺序不同。
			const a: AssetDraft = programDraft("req-a", "alpha", programContent("return 1;", "同内容"));
			const bContent = {
				descriptor: {
					errors: [],
					requires: [],
					examples: [],
					completion: { description: "执行完成", scope: "execution" as const },
					access: "act" as const,
					output: { type: "object" },
					input: { type: "object" },
					summary: "同内容",
				},
				source: "return 1;",
				dependencies: [],
			};
			const b = programDraft("req-b", "beta", bContent);
			const recordA = await repo.put(a);
			const recordB = await repo.put(b);
			expect(recordA.digest).toBe(recordB.digest);

			// evidence/sources 属于出处，不参与内容摘要。
			const withSources = {
				...experienceDraft("req-c", "gamma"),
				sources: [{ kind: "asset" as const, ref: "alpha@1" as ExactRef }],
			};
			const recordC = await repo.put(withSources);
			const plain = experienceContent();
			const recordD = await repo.put(experienceDraft("req-d", "delta", plain));
			expect(recordC.digest).toBe(recordD.digest);
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("三 kind 结构校验：program 缺 source、blueprint 引用未暂存对象、非法 CellTarget、experience 缺 judgment 均拒绝", async () => {
		const { dir, cleanup } = tempDir("mcw-a1-");
		try {
			const repo = createRepo(dir);
			// program 缺 source。
			const broken = programDraft("req-1", "p1");
			const { source: _source, ...noSource } = broken.content as ProgramDefinition & { source: string };
			await expectAssetFailure(
				() => repo.put({ ...broken, content: noSource as unknown as typeof broken.content }),
				"ASSET_INVALID",
			);

			// descriptor 携带 ref/implementation 拒绝（投影时才补入）。
			const withRef = programContent();
			const withRefDraft = programDraft("req-2", "p2", {
				...withRef,
				descriptor: { ...withRef.descriptor, ref: "p2@1", implementation: "program" } as typeof withRef.descriptor,
			});
			await expectAssetFailure(() => repo.put(withRefDraft), "ASSET_INVALID");

			// blueprint source 引用未暂存对象。
			await expectAssetFailure(
				() =>
					repo.put({
						...programDraft("req-3", "b1"),
						kind: "blueprint",
						content: { summary: "s", representation: { kind: "source", object: "missing" } },
					}),
				"ASSET_INVALID",
			);

			// blueprint target inline：合法四态通过；非法 kind 拒绝。
			const targetBase = {
				gameDataVersion: "1.21",
				bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 2 } },
				defaultCell: "preserve" as const,
			};
			const goodTarget = {
				...targetBase,
				cells: [
					{ at: { x: 0, y: 0, z: 0 }, target: { kind: "set" as const, block: "stone", state: {} } },
					{ at: { x: 1, y: 0, z: 1 }, target: { kind: "clear" as const } },
					{ at: { x: 1, y: 0, z: 0 }, target: { kind: "preserve" as const } },
					{ at: { x: 0, y: 0, z: 1 }, target: { kind: "unknown" as const } },
				],
			};
			const okTarget = await repo.put({
				...programDraft("req-4", "b2"),
				kind: "blueprint",
				content: { summary: "四态", representation: { kind: "target", target: { kind: "inline", value: goodTarget } } },
			});
			expect(okTarget.ref).toBe("b2@1");
			await expectAssetFailure(
				() =>
					repo.put({
						...programDraft("req-5", "b3"),
						kind: "blueprint",
						content: {
							summary: "坏",
							representation: {
								kind: "target",
								target: {
									kind: "inline",
									value: {
										...targetBase,
										cells: [{ at: { x: 0, y: 0, z: 0 }, target: { kind: "demolish" } as unknown as CellTarget }],
									},
								},
							},
						},
					}),
				"ASSET_INVALID",
			);

			// experience 缺 judgment。
			const noJudgment = experienceContent();
			const { judgment: _j, ...rest } = noJudgment;
			await expectAssetFailure(
				() => repo.put(experienceDraft("req-6", "e1", rest as typeof noJudgment)),
				"ASSET_INVALID",
			);
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("requiredAssets 必须是本仓库已发布版本；缺失报 ASSET_DEPENDENCY_UNAVAILABLE", async () => {
		const { dir, cleanup } = tempDir("mcw-a1-");
		try {
			const repo = createRepo(dir);
			await repo.put(programDraft("req-1", "lib.core"));
			const draft = programDraft("req-2", "user.app");
			draft.requiredAssets = ["lib.core@1"];
			const record = await repo.put(draft);
			expect(record.ref).toBe("user.app@1");

			const missing = programDraft("req-3", "user.other");
			missing.requiredAssets = ["lib.core@2"];
			await expectAssetFailure(() => repo.put(missing), "ASSET_DEPENDENCY_UNAVAILABLE");
			await expectAssetFailure(
				() => repo.put({ ...programDraft("req-4", "user.third"), requiredAssets: ["native:jump@1"] }),
				"ASSET_INVALID",
			);
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("证据保留：未注入端口拒绝声明；注入端口按 owner=requestId retain；失败时释放且不建悬空引用", async () => {
		const { dir, cleanup } = tempDir("mcw-a1-");
		try {
			// 未注入端口 + 声明 world 证据 → EVIDENCE_UNAVAILABLE。
			const bare = createRepo(dir);
			await expectAssetFailure(
				() => bare.put({ ...programDraft("req-1", "user.p1"), evidence: [{ owner: "world", ref: "mcw:ev:1" }] }),
				"EVIDENCE_UNAVAILABLE",
			);
			expect(await bare.search({ query: "user.p1" })).toMatchObject({ items: [] });
			await bare.close();

			// 注入端口：retain 携带 owner=requestId 与 refs；成功后修订可读。
			const evidence = fakeEvidence();
			const repo = createAssetRepository({
				dataDir: dir,
				worldEvidence: evidence.port,
				runtimeEvidence: evidence.port,
			});
			const record = await repo.put({
				...programDraft("req-2", "user.p2"),
				evidence: [
					{ owner: "world", ref: "mcw:ev:1" },
					{ owner: "runtime", ref: "run:1:seg:1" },
				],
			});
			expect(record.ref).toBe("user.p2@1");
			expect(evidence.retained).toEqual([
				{ owner: "req-2", refs: ["mcw:ev:1"] },
				{ owner: "req-2", refs: ["run:1:seg:1"] },
			]);
			expect(evidence.released).toEqual([]);
			const read = await repo.read("program", "user.p2@1");
			expect(read.evidence).toHaveLength(2);
			await repo.close();

			// retain 失败：不创建修订，释放已成功一侧的保留。
			const failing = fakeEvidence({ failRetain: true });
			const repo2 = createAssetRepository({ dataDir: dir, worldEvidence: failing.port, runtimeEvidence: failing.port });
			await expectAssetFailure(
				() => repo2.put({ ...programDraft("req-3", "user.p3"), evidence: [{ owner: "world", ref: "mcw:ev:2" }] }),
				"EVIDENCE_UNAVAILABLE",
			);
			expect(await repo2.search({ query: "user.p3" })).toMatchObject({ items: [] });
			await repo2.close();
		} finally {
			cleanup();
		}
	});

	it("search：默认 heads、versions=all、kind 过滤、query 匹配与分页 cursor", async () => {
		const { dir, cleanup } = tempDir("mcw-a1-");
		try {
			const repo = createRepo(dir);
			await repo.put(programDraft("r1", "user.alpha"));
			await repo.put(experienceDraft("r2", "user.beta"));
			await repo.revise(programRevision("r3", "user.alpha@1", "v2", programContent("return 2;")));

			const heads = await repo.search({ query: "" });
			expect(heads.items.map((item) => item.ref).sort()).toEqual(["user.alpha@2", "user.beta@1"]);
			const all = await repo.search({ query: "", versions: "all" });
			expect(all.items.map((item) => item.ref).sort()).toEqual(["user.alpha@1", "user.alpha@2", "user.beta@1"]);
			const programs = await repo.search({ query: "", kind: "program" });
			expect(programs.items.map((item) => item.ref)).toEqual(["user.alpha@2"]);
			const byQuery = await repo.search({ query: "beta" });
			expect(byQuery.items.map((item) => item.ref)).toEqual(["user.beta@1"]);
			const summary = (await repo.search({ query: "beta" })).items[0];
			expect(summary.schema).toBe("assets.experience@1");

			// 分页：limit 由实现固定，cursor 推进；非法 cursor 拒绝。
			const page1 = await repo.search({ query: "", versions: "all" });
			expect(page1.next).toBeUndefined();
			await expectAssetFailure(() => repo.search({ query: "", cursor: "-3" }), "ASSET_INVALID");
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("inspect 返回包封与 schemaAvailability；非法引用报 ASSET_INVALID，缺失报 ASSET_NOT_FOUND", async () => {
		const { dir, cleanup } = tempDir("mcw-a1-");
		try {
			const repo = createRepo(dir);
			await repo.put(experienceDraft("r1", "user.e1"));
			const inspection = await repo.inspect("user.e1@1");
			expect(inspection.kind).toBe("experience");
			expect(inspection.content).toMatchObject({ judgment: "白天挖矿更安全。" });
			expect(inspection.schemaAvailability.state).toBe("unknown");
			await expectAssetFailure(() => repo.inspect("not-a-ref" as ExactRef), "ASSET_INVALID");
			await expectAssetFailure(() => repo.inspect("missing@1"), "ASSET_NOT_FOUND");
			await repo.close();
		} finally {
			cleanup();
		}
	});

	it("对象暂存：put 必须引用同一 requestId 的 stage 记录且声明一致", async () => {
		const { dir, cleanup } = tempDir("mcw-a1-");
		try {
			const repo = createRepo(dir);
			const object = await repo.objects.stage(
				{ requestId: "req-1", key: "source", mediaType: "application/octet-stream", fileName: "a.schem" },
				byteStream("BYTES-1"),
			);
			// 声明的 digest 与暂存不符。
			await expectAssetFailure(
				() =>
					repo.put({
						...programDraft("req-1", "b1"),
						kind: "blueprint",
						content: blueprintContent("source"),
						objects: { source: { ...object, digest: "sha256:" + "0".repeat(64) } },
					}),
				"ASSET_INVALID",
			);
			// 不同 requestId 的暂存不可见。
			await expectAssetFailure(
				() =>
					repo.put({
						...programDraft("req-2", "b2"),
						kind: "blueprint",
						content: blueprintContent("source"),
						objects: { source: object },
					}),
				"ASSET_INVALID",
			);
			const record = await repo.put({
				...programDraft("req-1", "b3"),
				kind: "blueprint",
				content: blueprintContent("source"),
				objects: { source: object },
			});
			expect(record.ref).toBe("b3@1");
			await repo.close();
		} finally {
			cleanup();
		}
	});
});
