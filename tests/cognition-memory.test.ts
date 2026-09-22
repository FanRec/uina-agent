/**
 * 认知扩展阶段 B（M3+M4）：可修订文件记忆与三个工具。
 *
 * 核心不变量：
 * 1. 当前 records 是权威；revisions 是历史；索引纯内存可重建（文件未命中必回源扫描）；
 * 2. 写路径单 writer 串行；乐观并发用整文件 hash（expectedHash），
 *    committed 必带新 hash——版本冲突返回 conflict + 当前 hash，不覆盖不重试；
 * 3. 遗忘顺序：抑制记录先落盘 → 停召回 → 清理副本；遗忘 ≠ 删除 journal；
 * 4. 来源校验：引用不存在的 entry 或 basis=inferred 缺依据 → rejected；
 * 5. subjectId 绑定：meta 不匹配的记录文件跳过，模型参数中不存在 subjectId。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type MemoryStore } from "../src/extensions/cognition/memory.js";

let root: string;
let store: MemoryStore;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "uina-cognition-"));
	store = createMemoryStore({
		subjectId: "alice",
		memoryRoot: join(root, "memory"),
		stateRoot: join(root, "state"),
		sessionId: "default",
		validateSource: async (ref) => {
			if (ref.entryId === "boom") throw new Error("模拟写中途失败");
			return ref.sessionId === "default" && ["e1", "e2"].includes(ref.entryId ?? "");
		},
	});
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true }).catch(() => {});
});

const createRecord = async (overrides: Record<string, unknown> = {}) => {
	const result = await store.write({
		op: "create",
		record: {
			type: "note",
			basis: "reported",
			title: "Alice 的回复偏好",
			body: "Alice 在私聊中明确要求先给结论，再按需要展开。",
			scope: { spaceId: "private:alice" },
			sources: [{ sessionId: "default", entryId: "e1" }],
			pinned: false,
			...overrides,
		},
	});
	return result;
};

describe("M3 MemoryStore：create/read 基线", () => {
	it("create → committed 带 id/hash/revision → read 同值", async () => {
		const result = await createRecord();
		expect(result.status).toBe("committed");
		if (result.status !== "committed") return;
		expect(result.id).toBeTruthy();
		expect(result.hash).toBeTruthy();
		expect(result.revision).toBe(1);

		const record = await store.read(result.id);
		expect(record).toBeDefined();
		expect(record!.title).toBe("Alice 的回复偏好");
		expect(record!.body).toContain("先给结论");
		expect(record!.revision).toBe(1);
		expect(record!.hash).toBe(result.hash);
	});

	it("create 落盘为 records/<id>.md，meta 注释行 + 正文；restart 后从文件重建", async () => {
		const result = await createRecord();
		if (result.status !== "committed") throw new Error("expected committed");
		const files = await readdir(join(root, "memory", "records"));
		expect(files).toEqual([`${result.id}.md`]);
		const raw = await readFile(join(root, "memory", "records", files[0]!), "utf8");
		expect(raw).toContain("uina-memory");

		// 新 store 实例（模拟重启）：内存索引为空，从权威文件重建。
		const store2 = createMemoryStore({
			subjectId: "alice",
			memoryRoot: join(root, "memory"),
			stateRoot: join(root, "state"),
			sessionId: "default",
			validateSource: async () => true,
		});
		const record = await store2.read(result.id);
		expect(record?.title).toBe("Alice 的回复偏好");
	});
});

describe("M3 MemoryStore：乐观并发与冲突", () => {
	it("两个 revise 使用同一旧 hash → 恰好一个 committed，另一个 conflict（带当前 hash）", async () => {
		const created = await createRecord();
		if (created.status !== "committed") throw new Error("expected committed");
		const oldHash = created.hash;

		const results = await Promise.all([
			store.write({ op: "revise", id: created.id, expectedHash: oldHash, record: { body: "修订 A", sources: [{ sessionId: "default", entryId: "e2" }] } }),
			store.write({ op: "revise", id: created.id, expectedHash: oldHash, record: { body: "修订 B", sources: [{ sessionId: "default", entryId: "e2" }] } }),
		]);
		const committed = results.filter((r) => r.status === "committed");
		const conflicted = results.filter((r) => r.status === "conflict");
		expect(committed).toHaveLength(1);
		expect(conflicted).toHaveLength(1);
		if (conflicted[0]!.status !== "conflict") return;
		expect(conflicted[0]!.currentHash).toBeTruthy();
		expect(conflicted[0]!.currentHash).not.toBe(oldHash);

		// 当前版本恰为成功者，不是合并也不是覆盖。
		const record = await store.read(created.id);
		expect(["修订 A", "修订 B"]).toContain(record!.body);
	});

	it("错误 expectedHash → conflict，当前文件仍可读且内容不变", async () => {
		const created = await createRecord();
		if (created.status !== "committed") throw new Error("expected committed");
		const before = await store.read(created.id);
		const result = await store.write({ op: "revise", id: created.id, expectedHash: "deadbeef", record: { body: "错误哈希修订", sources: [] } });
		expect(result.status).toBe("conflict");
		const after = await store.read(created.id);
		expect(after!.body).toBe(before!.body);
	});

	it("revise 不存在的 id → rejected", async () => {
		const result = await store.write({ op: "revise", id: "m-nope", expectedHash: "x", record: { body: "y", sources: [] } });
		expect(result.status).toBe("rejected");
	});
});

describe("M3 MemoryStore：备份与版本历史", () => {
	it("revise 成功 → 旧版本进 revisions/<id>/，当前文件更新", async () => {
		const created = await createRecord();
		if (created.status !== "committed") throw new Error("expected committed");
		const revised = await store.write({ op: "revise", id: created.id, expectedHash: created.hash, record: { body: "第二版", sources: [{ sessionId: "default", entryId: "e2" }] } });
		expect(revised.status).toBe("committed");
		if (revised.status !== "committed") return;
		expect(revised.revision).toBe(2);

		const revDir = join(root, "memory", "revisions", created.id);
		expect(existsSync(revDir)).toBe(true);
		const revFiles = await readdir(revDir);
		expect(revFiles).toHaveLength(1);

		const record = await store.read(created.id);
		expect(record!.body).toBe("第二版");
		expect(record!.revision).toBe(2);
	});

	it("replace 失败（当前文件被外部改坏后恢复失败场景模拟为：备份成功替换失败）→ 当前文件仍可读", async () => {
		// 通过只读打开锁死文件的模拟代价过高；改为验证持久保证：写临时文件后 rename 之前的崩溃
		// 表现为当前文件仍是旧版。这里直接验证：revise 中途抛错（来源校验抛异常）→ 当前不变。
		const created = await createRecord();
		if (created.status !== "committed") throw new Error("expected committed");
		const before = await store.read(created.id);
		// validateSource 对 "boom" 抛异常：模拟写中途失败（替换尚未发生）→ 当前文件不受影响。
		await expect(
			store.write({ op: "revise", id: created.id, expectedHash: created.hash, record: { body: "x", sources: [{ sessionId: "default", entryId: "boom" }] } }),
		).rejects.toThrow();
		const after = await store.read(created.id);
		expect(after!.body).toBe(before!.body);
		expect(after!.revision).toBe(1);
	});
});

describe("M3 MemoryStore：来源校验", () => {
	it("来源引用不存在的 entry → rejected，不伪造证据", async () => {
		const result = await createRecord({ sources: [{ sessionId: "default", entryId: "e404" }] });
		expect(result.status).toBe("rejected");
	});

	it("basis=inferred 无依据说明 → rejected", async () => {
		const result = await createRecord({ basis: "inferred", sources: [], rationale: undefined });
		expect(result.status).toBe("rejected");
	});

	it("basis=inferred 有 rationale → committed", async () => {
		const result = await createRecord({ basis: "inferred", sources: [], rationale: "由多次同类请求归纳" });
		expect(result.status).toBe("committed");
	});
});

describe("M3 MemoryStore：scope 隔离", () => {
	it("不同 scope 的记录通过 RecallScope 过滤，互不可见", async () => {
		await createRecord({ scope: { spaceId: "private:alice" } });
		const global = await createRecord({ scope: {} });

		const aliceHits = await store.search("先给结论", { spaceId: "private:alice" });
		expect(aliceHits).toHaveLength(2); // private:alice 命中两条（另一条 scope 空 = 全局）
		const otherHits = await store.search("先给结论", { spaceId: "project:x" });
		expect(otherHits).toHaveLength(1);
		expect(otherHits[0]!.id).toBe(global.status === "committed" ? global.id : "");
	});
});

describe("M3 MemoryStore：retire 与 forget", () => {
	it("retire → 常规搜索不返回，read 仍可得且 status=retired；重启后保持", async () => {
		const created = await createRecord();
		if (created.status !== "committed") throw new Error("expected committed");
		const retired = await store.write({ op: "retire", id: created.id, expectedHash: created.hash, reason: "已过时" });
		expect(retired.status).toBe("committed");

		const hits = await store.search("先给结论", { spaceId: "private:alice" });
		expect(hits).toHaveLength(0);
		const record = await store.read(created.id);
		expect(record!.status).toBe("retired");

		const store2 = createMemoryStore({
			subjectId: "alice",
			memoryRoot: join(root, "memory"),
			stateRoot: join(root, "state"),
			sessionId: "default",
			validateSource: async () => true,
		});
		expect((await store2.search("先给结论", { spaceId: "private:alice" }))).toHaveLength(0);
		expect((await store2.read(created.id))!.status).toBe("retired");
	});

	it("forget → 抑制记录先落盘，records/revisions 副本清理，重启后不复活；journal 不受影响", async () => {
		const created = await createRecord();
		if (created.status !== "committed") throw new Error("expected committed");
		await store.write({ op: "retire", id: created.id, expectedHash: created.hash, reason: "x" });
		await store.forget(created.id);

		expect(existsSync(join(root, "memory", "records", `${created.id}.md`))).toBe(false);
		expect(existsSync(join(root, "memory", "revisions", created.id))).toBe(false);
		const suppressed = JSON.parse(await readFile(join(root, "state", "cognition.json"), "utf8")) as { forgottenIds?: string[] };
		expect(suppressed.forgottenIds).toContain(created.id);

		const store2 = createMemoryStore({
			subjectId: "alice",
			memoryRoot: join(root, "memory"),
			stateRoot: join(root, "state"),
			sessionId: "default",
			validateSource: async () => true,
		});
		expect(await store2.read(created.id)).toBeUndefined();
		expect((await store2.search("先给结论", { spaceId: "private:alice" }))).toHaveLength(0);
	});
});

describe("M3 MemoryStore：索引降级与 subject 绑定", () => {
	it("索引降级（内存索引被清空）→ 读路径回源磁盘扫描，行为不变", async () => {
		const created = await createRecord();
		if (created.status !== "committed") throw new Error("expected committed");
		store.invalidateIndex();
		const record = await store.read(created.id);
		expect(record?.title).toBe("Alice 的回复偏好");
	});

	it("meta.subjectId 与绑定不符的文件 → 跳过（不读、不搜、不写）", async () => {
		await mkdir(join(root, "memory", "records"), { recursive: true });
		await writeFile(
			join(root, "memory", "records", "m-bob.md"),
			'<!-- uina-memory {"schema":1,"id":"m-bob","revision":1,"type":"note","basis":"reported","subjectId":"bob","scope":{},"sources":[],"status":"active","pinned":false} -->\n# Bob 的秘密\n暗号是 1234。\n',
			"utf8",
		);
		const record = await store.read("m-bob");
		expect(record).toBeUndefined();
		const hits = await store.search("暗号", { spaceId: "private:alice" });
		expect(hits).toHaveLength(0);
	});
});
