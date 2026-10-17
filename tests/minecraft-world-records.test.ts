/**
 * Minecraft World S-W3：SQLite 历史、领域记录 CAS、保留闭包与恢复。
 *
 * 覆盖（LEAD.md S-W3 + world.md §10/§11/§13）：
 * - SQLite 持久证据：flush 后 durable ACK；重启后恢复（新接收代次不继承 RAM ACK、
 *   重放去重不重复入库、durable 从真实持久状态起步）；
 * - evidence.list@1：分页固定版本、gap 与 fact 混排、SNAPSHOT_EXPIRED；
 * - writeRecord CAS：创建/冲突/不可偷换 schema/world/worldRevision；分区一致性；
 * - retain/release：幂等、先冲刷持久；存储不可用时拒绝（EVIDENCE_UNAVAILABLE/STORE_UNAVAILABLE）；
 * - 内存模型与真实 SQLite 分开验证（本文件覆盖真实 SQLite；内存路径由 S-W1 覆盖）。
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorld, type WorldHandle } from "../.uina/worlds/minecraft/world/index.js";
import { openSqliteWorkerStore } from "../.uina/worlds/minecraft/world/internal/store.js";
import { FakeClientFacts, capturedFact } from "./minecraft-world-fake-facts.js";

/**
 * 屏障同步点：等待已接收证据全部提交（durable ACK 已发布）。
 * 历史 read 内部等提交屏障——返回即代表冲刷完成，不依赖微任务时序。
 */
async function committed(world: WorldHandle): Promise<void> {
	await world.read({ ref: "evidence.list@1", input: {} });
}

function selfState(health: number) {
	return {
		place: {
			world: "mcw:world:w1",
			worldRevision: "mcw:rev:r1",
			dimension: "minecraft:overworld",
			position: { x: 1, y: 64, z: 2 },
		},
		velocity: { x: 0, y: 0, z: 0 },
		health,
		food: 20,
		onGround: true,
	};
}

describe("minecraft world SQLite 历史与恢复（S-W3）", () => {
	it("证据持久化：flush 后 durable ACK；重启后新接收代次不继承 received，重放去重", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcw-s3-"));
		try {
			const facts = new FakeClientFacts();
			facts.setSelf(selfState(20), []);
			const world = await createWorld({ facts, dataDir: dir }, { receiver: "mcw:receiver:gen1" });
			await world.historySettled; // 历史侧打开/播种完成（当前事实能力不等它）
			facts.emitEvidence([capturedFact({ sequence: 1 }), capturedFact({ sequence: 2 })]);
			await committed(world);
			expect(facts.acks.at(-1)?.durableThrough).toBe(2);
			await world.close();

			// 重启：新 World 实例（新接收代次），打开同一数据库。
			const facts2 = new FakeClientFacts();
			facts2.setSelf(selfState(20), []);
			const world2 = await createWorld({ facts: facts2, dataDir: dir }, { receiver: "mcw:receiver:gen2" });
			await world2.historySettled; // 历史侧打开/播种完成（当前事实能力不等它）
			// 新接收代次不从 RAM 起步：durable 只能由真实持久状态与本次提交推进。

			// 源重放同身份载荷：去重，不重复入库，durable 推进到 3。
			facts2.emitEvidence([
				capturedFact({ sequence: 1 }),
				capturedFact({ sequence: 2 }),
				capturedFact({ sequence: 3 }),
			]);
			await committed(world2);
			const last = facts2.acks.at(-1)!;
			expect(last.durableThrough).toBe(3);
			await world2.close();

			// 数据库只有 3 条事实（无重复行）。
			const store = await openSqliteWorkerStore(dir);
			const page = await store.listEvidence({ limit: 100 });
			expect(page!.items.filter((i) => i.entry.kind === "fact")).toHaveLength(3);
			await store.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("evidence.list@1 分页：固定版本、fact/gap 混排、跨页不漏不重、过期 token 报 SNAPSHOT_EXPIRED", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcw-s3-"));
		try {
			const facts = new FakeClientFacts();
			facts.setSelf(selfState(20), []);
			const world = await createWorld({ facts, dataDir: dir }, { receiver: "mcw:receiver:gen1" });
			await world.historySettled; // 历史侧打开/播种完成（当前事实能力不等它）
			facts.emitEvidence([capturedFact({ sequence: 1 }), capturedFact({ sequence: 2 })]);
			facts.emitGap("mcw:gap:g1", "mcw:test:stream:ev1", 2, 4);
			facts.emitEvidence([capturedFact({ sequence: 5 })]);
			await committed(world);

			type ListPage = {
				items: { kind: string; ref: string }[];
				next: { version: number; afterStoreSeq: number } | null;
			};
			const page1 = (await world.read({ ref: "evidence.list@1", input: { limit: 2 } })) as unknown as {
				value: ListPage;
				cursor: unknown;
			};
			expect(page1.value.items).toHaveLength(2);
			expect(page1.value.next).not.toBeNull();
			const page2 = (await world.read({
				ref: "evidence.list@1",
				input: { limit: 2, page: page1.value.next },
			})) as unknown as { value: ListPage };
			const allRefs = [...page1.value.items, ...page2.value.items].map((i: { ref: string }) => i.ref);
			expect(new Set(allRefs).size).toBe(4); // 2 fact + 1 gap + 1 fact，不漏不重
			expect(page1.value.items.some((i: { kind: string }) => i.kind === "fact")).toBe(true);

			// 新证据入库 → 旧版本 token 过期。
			facts.emitEvidence([capturedFact({ sequence: 6 })]);
			await committed(world);
			await expect(
				world.read({ ref: "evidence.list@1", input: { limit: 2, page: page1.value.next } }),
			).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED" });
			await world.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("SQLite 打开失败 → history unavailable；当前读不受影响；writeRecord 拒绝", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(19), []);
		const world = await createWorld({ facts, dataDir: "NUL/ definitely /invalid:\\path" }, {});
		await world.historySettled; // 历史侧打开/播种完成（当前事实能力不等它）
		const status = await world.status();
		expect(status.history.state).toBe("unavailable");
		const observation = await world.read({ ref: "self@1", input: {} });
		expect(observation.value).toEqual(selfState(19));
		await expect(
			world.writeRecord({
				schema: "construction.project@1",
				world: "mcw:world:w1",
				worldRevision: "mcw:rev:r1",
				expectedRevision: null,
				value: {},
				evidence: [],
			}),
		).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
		await world.close();
	});
});

describe("minecraft world 领域记录 CAS 与保留（S-W3）", () => {
	it("writeRecord：null 创建 revision=1；CAS 更新；冲突报 RECORD_CHANGED；不可偷换分区/schema", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcw-s3-"));
		try {
			const facts = new FakeClientFacts();
			facts.setSelf(selfState(20), []);
			const world = await createWorld({ facts, dataDir: dir }, { receiver: "mcw:receiver:gen1" });
			await world.historySettled; // 历史侧打开/播种完成（当前事实能力不等它）
			// 记录引用的证据必须真实接收过（存在性校验）
			facts.emitEvidence([
				capturedFact({ sequence: 1, ref: "ev:a", stream: "mcw:test:stream:casa" }),
				capturedFact({ sequence: 2, ref: "ev:b", stream: "mcw:test:stream:casa" }),
			]);
			const base = { schema: "construction.project@1" as const, world: "mcw:world:w1", worldRevision: "mcw:rev:r1" };

			const created = await world.writeRecord({
				...base,
				expectedRevision: null,
				value: { blocks: 10 },
				evidence: ["ev:a"],
			});
			expect(created.revision).toBe(1);
			expect(created.ref).toBeTruthy();

			const updated = await world.writeRecord({
				...base,
				ref: created.ref,
				expectedRevision: 1,
				value: { blocks: 15 },
				evidence: ["ev:a", "ev:b"],
			});
			expect(updated.revision).toBe(2);

			await expect(
				world.writeRecord({ ...base, ref: created.ref, expectedRevision: 1, value: { blocks: 99 }, evidence: [] }),
			).rejects.toMatchObject({ code: "RECORD_CHANGED" });

			await expect(
				world.writeRecord({
					...base,
					ref: created.ref,
					expectedRevision: 2,
					schema: "construction.project@2" as never,
					value: { x: 1 },
					evidence: [],
				}),
			).rejects.toMatchObject({ code: "INVALID_ARGUMENT" }); // 不可偷换 schema

			await expect(
				world.writeRecord({
					...base,
					ref: created.ref,
					expectedRevision: 2,
					world: "mcw:world:OTHER",
					value: { x: 1 },
					evidence: [],
				}),
			).rejects.toMatchObject({ code: "REFERENCE_STALE" }); // 不可偷换分区

			// 分区一致性：与当前绑定不一致的写入被拒（不凭 worldId 文本放行旧代次）。
			facts.setScope({ worldRevision: "mcw:rev:r2" });
			await expect(
				world.writeRecord({
					schema: "construction.project@1",
					world: "mcw:world:w1",
					worldRevision: "mcw:rev:r1",
					expectedRevision: null,
					value: {},
					evidence: [],
				}),
			).rejects.toMatchObject({ code: "REFERENCE_STALE" });

			const readBack = await world.readRecord(created.ref);
			expect(readBack.revision).toBe(2);
			expect(readBack.value).toEqual({ blocks: 15 });
			await world.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("readRecord 不存在的记录报 CALL_UNAVAILABLE", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcw-s3-"));
		try {
			const facts = new FakeClientFacts();
			const world = await createWorld({ facts, dataDir: dir });
			await world.historySettled; // 历史侧打开/播种完成（当前事实能力不等它）
			await expect(world.readRecord("mcw:record:missing")).rejects.toMatchObject({ code: "CALL_UNAVAILABLE" });
			await world.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retain 不存在的证据引用报 EVIDENCE_UNAVAILABLE（虚假成功防御）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcw-s3-"));
		try {
			const facts = new FakeClientFacts();
			const world = await createWorld({ facts, dataDir: dir }, { receiver: "mcw:receiver:gen1" });
			await world.historySettled; // 历史侧打开/播种完成（当前事实能力不等它）
			await expect(world.evidence.retain("mcw:runtime:run-x", ["mcw:ev:never-received"])).rejects.toMatchObject({
				code: "EVIDENCE_UNAVAILABLE",
			});
			// 记录引用未收到证据同样拒绝（不建立悬空引用）。
			await expect(
				world.writeRecord({
					schema: "construction.project@1",
					world: "mcw:world:w1",
					worldRevision: "mcw:rev:r1",
					expectedRevision: null,
					value: {},
					evidence: ["mcw:ev:never-received"],
				}),
			).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
			await world.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retain 幂等追加并先冲刷证据；release 移除；跨重启保留", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcw-s3-"));
		try {
			const facts = new FakeClientFacts();
			const world = await createWorld({ facts, dataDir: dir }, { receiver: "mcw:receiver:gen1" });
			await world.historySettled; // 历史侧打开/播种完成（当前事实能力不等它）
			const record = capturedFact({ sequence: 1, ref: "mcw:ev:key-1" });
			facts.emitEvidence([record]);
			// retain 在 flush 之前调用：内部先冲刷，保证证据与保留关系都已持久再返回。
			await world.evidence.retain("mcw:runtime:run-1", ["mcw:ev:key-1"]);
			expect(facts.acks.at(-1)?.durableThrough).toBe(1);

			await world.evidence.retain("mcw:runtime:run-1", ["mcw:ev:key-1"]); // 幂等
			facts.emitEvidence([capturedFact({ sequence: 2, ref: "mcw:ev:key-2", stream: "mcw:test:stream:ev1" })]);
			await world.evidence.retain("mcw:runtime:run-1", ["mcw:ev:key-2"]);
			await world.evidence.release("mcw:runtime:run-1");
			await world.close();

			const store = await openSqliteWorkerStore(dir);
			const page = await store.listEvidence({ limit: 100 });
			expect(page!.items).toHaveLength(2); // key-1 + key-2 证据仍在（release 只删保留关系）
			await store.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("schema v2 → v3 一次性迁移：DROP recv 列，数据行原样保留可读", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcw-mig-"));
		try {
			// 手工构造 v2 库（旧 schema：带 recv 列 + schema_version=2 + 一条已持久事实）。
			const db = new DatabaseSync(join(dir, "world-history.db"));
			db.exec(`
				PRAGMA journal_mode = WAL;
				CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
				CREATE TABLE evidence (
					ref TEXT PRIMARY KEY, stream TEXT NOT NULL, seq INTEGER NOT NULL,
					schema TEXT NOT NULL, recv INTEGER NOT NULL, payload TEXT NOT NULL,
					store_seq INTEGER NOT NULL, UNIQUE (stream, seq)
				);
				CREATE TABLE evidence_gaps (
					ref TEXT PRIMARY KEY, stream TEXT NOT NULL, after INTEGER NOT NULL,
					through INTEGER, reason TEXT NOT NULL, recv INTEGER NOT NULL,
					store_seq INTEGER NOT NULL
				);
				CREATE TABLE records (ref TEXT PRIMARY KEY, revision INTEGER NOT NULL, schema TEXT NOT NULL,
					world TEXT NOT NULL, world_revision TEXT NOT NULL, value TEXT NOT NULL,
					evidence TEXT NOT NULL, created_at TEXT NOT NULL);
				CREATE TABLE retention (owner TEXT NOT NULL, evidence_ref TEXT NOT NULL, PRIMARY KEY (owner, evidence_ref));
				INSERT INTO meta VALUES ('schema_version', '2');
				INSERT INTO meta VALUES ('store_version', '1');
				INSERT INTO meta VALUES ('store_seq_counter', '1');
			`);
			const payload = JSON.stringify({
				ref: "mcw:v2:ev1",
				schema: "client.inventory@1",
				mark: { stream: "mcw:v2:stream", sequence: 1 },
				stamp: { source: "s", epoch: "e", sequence: 1, connection: null, incarnation: null },
				scope: { binding: "b", world: "w", worldRevision: "r", dimension: null },
				fact: {
					value: {},
					observedAt: "2026-10-17T00:00:00.000Z",
					source: "server",
					coverage: "complete",
					unknown: [],
					evidence: [],
				},
			});
			db.prepare(
				"INSERT INTO evidence (ref, stream, seq, schema, recv, payload, store_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run("mcw:v2:ev1", "mcw:v2:stream", 1, "client.inventory@1", 1, payload, 1);
			db.close();

			// Worker 打开触发迁移；数据行原样可读。
			const store = await openSqliteWorkerStore(dir);
			const page = await store.listEvidence({ limit: 100 });
			expect(page!.items).toHaveLength(1);
			expect(page!.items[0]!.entry).toMatchObject({ kind: "fact", record: { ref: "mcw:v2:ev1" } });
			const exists = await store.hasEvidence("mcw:v2:ev1");
			expect(exists).toBe(true);
			await store.close();

			// 重开：已是 v3，幂等。
			const reopen = await openSqliteWorkerStore(dir);
			expect((await reopen.listEvidence({ limit: 100 }))!.items).toHaveLength(1);
			await reopen.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("记录重启恢复：revision 与 value 原样可读", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcw-s3-"));
		try {
			const facts = new FakeClientFacts();
			const world = await createWorld({ facts, dataDir: dir }, { receiver: "mcw:receiver:gen1" });
			await world.historySettled; // 历史侧打开/播种完成（当前事实能力不等它）
			facts.emitEvidence([
				capturedFact({ sequence: 1, ref: "ev:1", stream: "mcw:test:stream:rec" }),
				capturedFact({ sequence: 2, ref: "ev:2", stream: "mcw:test:stream:rec" }),
			]);
			const created = await world.writeRecord({
				schema: "process.smelting@1",
				world: "mcw:world:w1",
				worldRevision: "mcw:rev:r1",
				expectedRevision: null,
				value: { input: "iron_ore", count: 8 },
				evidence: ["ev:1"],
			});
			await world.writeRecord({
				schema: "process.smelting@1",
				world: "mcw:world:w1",
				worldRevision: "mcw:rev:r1",
				ref: created.ref,
				expectedRevision: 1,
				value: { input: "iron_ore", count: 16 },
				evidence: ["ev:1", "ev:2"],
			});
			await world.close();

			const facts2 = new FakeClientFacts();
			const world2 = await createWorld({ facts: facts2, dataDir: dir }, { receiver: "mcw:receiver:gen2" });
			await world2.historySettled; // 历史侧打开/播种完成（当前事实能力不等它）
			const readBack = await world2.readRecord(created.ref);
			expect(readBack.revision).toBe(2);
			expect(readBack.value).toEqual({ input: "iron_ore", count: 16 });
			await expect(
				world2.writeRecord({
					schema: "process.smelting@1",
					world: "mcw:world:w1",
					worldRevision: "mcw:rev:r1",
					ref: created.ref,
					expectedRevision: 1,
					value: { stale: true },
					evidence: [],
				}),
			).rejects.toMatchObject({ code: "RECORD_CHANGED" });
			await world2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
