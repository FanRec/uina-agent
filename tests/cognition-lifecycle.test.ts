/**
 * 认知扩展阶段 E / M6：整理 worker（手动触发第一版，automaticConsolidation 默认关闭）。
 *
 * 不变量（plan §8 / design §10 / 备忘 §3.6）：
 * 1. 无新材料 → 零模型调用；
 * 2. 重复触发只合并水位，不排一串重复任务、不并发调用；
 * 3. 迟到 patch（worker 被关闭/换人/generation 前进后）必被拒，不覆盖前台新写入，不假报成功；
 * 4. Provider 取消语义：响应 abort 的 fake 正常结算；不响应 abort 的 fake——
 *    worker 关闭显示"仍在关闭"，不假报完成，不提交迟到 patch；
 * 5. patch 提交经同一 writer（expectedHash 冲突返回 conflict，不覆盖）；
 * 6. 同一事件重复转述在 patch 生成输入中被标注为单份证据（同一 source 不重复计数）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type MemoryStore } from "../src/extensions/cognition/memory.js";
import { createConsolidationWorker, type ConsolidationModelInput, type ConsolidationPatch } from "../src/extensions/cognition/consolidation.js";

let root: string;
let store: MemoryStore;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "uina-cognition-worker-"));
	store = createMemoryStore({
		subjectId: "alice",
		memoryRoot: join(root, "memory"),
		stateRoot: join(root, "state"),
		sessionId: "default",
		validateSource: async () => true,
	});
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true }).catch(() => {});
});

const seedRecord = async () => {
	const created = await store.write({
		op: "create",
		record: { type: "note", basis: "reported", title: "部署偏好", body: "部署前先跑测试。", scope: {}, sources: [{ sessionId: "default", entryId: "e1" }], pinned: false },
	});
	if (created.status !== "committed") throw new Error("expected committed");
	return created;
};

/** fake 模型：响应 abort（正常取消）。 */
const responsiveModel = (patches: ConsolidationPatch[]) => async (_input: ConsolidationModelInput, signal?: AbortSignal): Promise<ConsolidationPatch[]> => {
	if (signal?.aborted) throw new Error("aborted");
	return patches;
};

describe("M6 整理 worker：水位与零调用", () => {
	it("无新材料 → 零模型调用，run 直接完成", async () => {
		let modelCalls = 0;
		const worker = createConsolidationWorker({
			store,
			stateRoot: join(root, "state"),
			runModel: async (input) => {
				modelCalls++;
				void input;
				return [];
			},
			// 水位之上无未整理证据 = 无新材料：不空转调用模型。
			listEvidence: () => [],
		});
		const result = await worker.run();
		expect(result).toEqual({ status: "completed", patchesSubmitted: 0, conflicts: 0, modelCalls: 0 });
		expect(modelCalls).toBe(0);
	});

	it("有新材料调用一次；重复触发合并水位（第二次 run 无新材料 → 零调用）", async () => {
		await seedRecord();
		let modelCalls = 0;
		const worker = createConsolidationWorker({
			store,
			stateRoot: join(root, "state"),
			runModel: async () => {
				modelCalls++;
				return [];
			},
			listEvidence: () => [{ sessionId: "default", entryId: "e1", text: "测试证据" }],
		});
		await worker.run();
		expect(modelCalls).toBe(1);
		// 水位已推进：同范围重复触发不再调用。
		const second = await worker.run();
		expect(modelCalls).toBe(1);
		expect(second.modelCalls).toBe(0);
	});

	it("同一事件重复转述在证据输入中合并为单份来源", async () => {
		await seedRecord();
		let seenSources = 0;
		const worker = createConsolidationWorker({
			store,
			stateRoot: join(root, "state"),
			runModel: async (input) => {
				seenSources = input.evidence.filter((e) => e.entryId === "e1").length;
				return [];
			},
			listEvidence: () => [
				{ sessionId: "default", entryId: "e1", text: "同一句话的转述一" },
				{ sessionId: "default", entryId: "e1", text: "同一句话的转述二" },
			],
		});
		await worker.run();
		// 同一 entryId 的重复转述只算一份证据。
		expect(seenSources).toBe(1);
	});
});

describe("M6 整理 worker：patch 提交与冲突", () => {
	it("前台新写入抢先完成 → 后台旧 patch conflict，不覆盖", async () => {
		const created = await seedRecord();
		let capturedPatches: ConsolidationPatch[] | undefined;
		const worker = createConsolidationWorker({
			store,
			stateRoot: join(root, "state"),
			runModel: async () => [{ op: "revise", id: created.id, expectedHash: created.hash, record: { body: "后台修订" } }],
			listEvidence: () => [{ sessionId: "default", entryId: "e1", text: "证据" }],
			/** 模型调用前钩子：在后台 patch 提交前模拟前台抢先写入。 */
			onModelCalled: async () => {
				await store.write({ op: "revise", id: created.id, expectedHash: created.hash, record: { body: "前台抢先修订" } });
			},
		});
		const result = await worker.run();
		expect(result.status).toBe("completed");
		expect(result.conflicts).toBe(1);
		expect(result.patchesSubmitted).toBe(0);

		const record = await store.read(created.id);
		expect(record!.body).toBe("前台抢先修订");
		void capturedPatches;
	});

	it("正常 patch 提交经同一 writer → committed；已提交部分保留", async () => {
		const created = await seedRecord();
		const worker = createConsolidationWorker({
			store,
			stateRoot: join(root, "state"),
			runModel: async () => [{ op: "revise", id: created.id, expectedHash: created.hash, record: { body: "整理后的版本" } }],
			listEvidence: () => [{ sessionId: "default", entryId: "e1", text: "证据" }],
		});
		const result = await worker.run();
		expect(result.patchesSubmitted).toBe(1);
		const record = await store.read(created.id);
		expect(record!.body).toBe("整理后的版本");
	});
});

describe("M6 整理 worker：关闭与迟到 patch", () => {
	it("close 后 generation 前进 → 迟到 patch 被拒，不提交、不假报成功", async () => {
		const created = await seedRecord();
		const worker = createConsolidationWorker({
			store,
			stateRoot: join(root, "state"),
			runModel: async () => [{ op: "revise", id: created.id, expectedHash: created.hash, record: { body: "迟到的修订" } }],
			listEvidence: () => [{ sessionId: "default", entryId: "e1", text: "证据" }],
		});
		const runPromise = worker.run();
		await worker.close("换人");
		const result = await runPromise;
		// 关闭后 run 以 aborted 收场，patch 不提交。
		expect(result.status).toBe("aborted");
		expect(result.patchesSubmitted).toBe(0);
		const record = await store.read(created.id);
		expect(record!.body).toBe("部署前先跑测试。");
	});

	it("不响应取消的 Provider：close 显示仍在关闭（不假报完成），迟到 patch 不提交", async () => {
		const created = await seedRecord();
		let workerAborted = false;
		const worker = createConsolidationWorker({
			store,
			stateRoot: join(root, "state"),
			// 坏 Provider：收到 abort 挂起不结算。
			runModel: async (_input, signal) => {
				signal?.addEventListener("abort", () => {
					workerAborted = true;
				});
				await new Promise<never>(() => {}); // 永不结算
				return [];
			},
			listEvidence: () => [{ sessionId: "default", entryId: "e1", text: "证据" }],
		});
		const runPromise = worker.run();
		// 给 run 一点时间进入模型调用。
		await new Promise((r) => setTimeout(r, 10));
		await worker.close("关停");
		expect(workerAborted).toBe(true);
		// run promise 未结算（坏 Provider 挂起）——close 不能假报完成，只能标记状态。
		expect(worker.isSettled()).toBe(false);
		expect(await worker.closeReport()).toEqual({ closed: true, providerSettled: false, message: "仍在关闭：Provider 未响应取消" });
		void runPromise;
		// 迟到 patch 无法提交：store 无变化。
		const record = await store.read(created.id);
		expect(record!.body).toBe("部署前先跑测试。");
	});

	it("响应取消的 Provider：close 正常结算并报告完成", async () => {
		await seedRecord();
		const worker = createConsolidationWorker({
			store,
			stateRoot: join(root, "state"),
			runModel: responsiveModel([]),
			listEvidence: () => [{ sessionId: "default", entryId: "e1", text: "证据" }],
		});
		const runPromise = worker.run();
		await new Promise((r) => setTimeout(r, 10));
		await worker.close("关停");
		await runPromise.catch(() => {});
		expect(worker.isSettled()).toBe(true);
		expect(await worker.closeReport()).toEqual({ closed: true, providerSettled: true, message: "已关闭" });
	});

	it("close 前的 closeReport 如实报告运行中（未关闭分支）", async () => {
		await seedRecord();
		const worker = createConsolidationWorker({
			store,
			stateRoot: join(root, "state"),
			runModel: responsiveModel([]),
			listEvidence: () => [],
		});
		expect(await worker.closeReport()).toEqual({ closed: false, providerSettled: true, message: "运行中" });
	});

	it("close 后水位与抑制状态落盘（cognition.json 持久化）", async () => {
		await seedRecord();
		const worker = createConsolidationWorker({
			store,
			stateRoot: join(root, "state"),
			runModel: responsiveModel([]),
			listEvidence: () => [{ sessionId: "default", entryId: "e1", text: "证据" }],
		});
		await worker.run();
		const raw = JSON.parse(await readFile(join(root, "state", "cognition.json"), "utf8")) as { consolidationWatermark?: number };
		expect(raw.consolidationWatermark).toBeGreaterThan(0);
	});
});
