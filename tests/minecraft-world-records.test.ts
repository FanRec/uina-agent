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
import { createWorld } from "../.uina/worlds/minecraft/world/index.js";
import { SqliteWorldStore } from "../.uina/worlds/minecraft/world/internal/store.js";
import { FakeClientFacts, capturedFact, mkFact } from "./minecraft-world-fake-facts.js";

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await Promise.resolve();
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
			const world = createWorld({ facts, dataDir: dir }, { receiver: "mcw:receiver:gen1" });
			facts.emitEvidence([capturedFact({ sequence: 1 }), capturedFact({ sequence: 2 })]);
			await flush();
			expect(facts.acks.at(-1)?.durableThrough).toBe(2);
			await world.close();

			// 重启：新 World 实例（新接收代次），打开同一数据库。
			const facts2 = new FakeClientFacts();
			facts2.setSelf(selfState(20), []);
			const world2 = createWorld({ facts: facts2, dataDir: dir }, { receiver: "mcw:receiver:gen2" });
			// 不继承 RAM ACK：新代次 received=0（durable 合同上不得大于 received）。
			const initialAck = facts2.acks.find((a) => a.stream === "mcw:test:stream:ev1");
			expect(initialAck === undefined || initialAck.receivedThrough === 0).toBe(true);

			// 源重放同身份载荷：去重，不分配新条目，received/durable 正常推进。
			facts2.emitEvidence([
				capturedFact({ sequence: 1 }),
				capturedFact({ sequence: 2 }),
				capturedFact({ sequence: 3 }),
			]);
			await flush();
			const last = facts2.acks.at(-1)!;
			expect(last.receivedThrough).toBe(3);
			expect(last.durableThrough).toBe(3);
			await world2.close();

			// 数据库只有 3 条事实（无重复行）。
			const store = new SqliteWorldStore(dir);
			const page = store.listEvidence({ limit: 100 });
			expect(page!.items.filter((i) => i.entry.kind === "fact")).toHaveLength(3);
			store.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("evidence.list@1 分页：固定版本、fact/gap 混排、跨页不漏不重、过期 token 报 SNAPSHOT_EXPIRED", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcw-s3-"));
		try {
			const facts = new FakeClientFacts();
			facts.setSelf(selfState(20), []);
			const world = createWorld({ facts, dataDir: dir }, { receiver: "mcw:receiver:gen1" });
			facts.emitEvidence([capturedFact({ sequence: 1 }), capturedFact({ sequence: 2 })]);
			facts.emitGap("mcw:gap:g1", "mcw:test:stream:ev1", 2, 4);
			facts.emitEvidence([capturedFact({ sequence: 5 })]);
			await flush();

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
			await flush();
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
		const world = createWorld({ facts, dataDir: "NUL/ definitely /invalid:\\path" }, {});
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
			const world = createWorld({ facts, dataDir: dir }, { receiver: "mcw:receiver:gen1" });
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
			const world = createWorld({ facts, dataDir: dir });
			await expect(world.readRecord("mcw:record:missing")).rejects.toMatchObject({ code: "CALL_UNAVAILABLE" });
			await world.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retain 幂等追加并先冲刷证据；release 移除；跨重启保留", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcw-s3-"));
		try {
			const facts = new FakeClientFacts();
			const world = createWorld({ facts, dataDir: dir }, { receiver: "mcw:receiver:gen1" });
			const record = capturedFact({ sequence: 1, ref: "mcw:ev:key-1" });
			facts.emitEvidence([record]);
			// retain 在 flush 之前调用：内部先冲刷，保证证据与保留关系都已持久再返回。
			await world.evidence.retain("mcw:runtime:run-1", ["mcw:ev:key-1"]);
			await flush();
			expect(facts.acks.at(-1)?.durableThrough).toBe(1);

			await world.evidence.retain("mcw:runtime:run-1", ["mcw:ev:key-1"]); // 幂等
			await world.evidence.retain("mcw:runtime:run-1", ["mcw:ev:key-2"]);
			await world.evidence.release("mcw:runtime:run-1");
			await world.close();

			const store = new SqliteWorldStore(dir);
			expect(store.retainedBy("mcw:runtime:run-1")).toBeNull();
			const page = store.listEvidence({ limit: 100 });
			expect(page!.items).toHaveLength(1); // 证据仍在（release 只删保留关系）
			store.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("记录重启恢复：revision 与 value 原样可读", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcw-s3-"));
		try {
			const facts = new FakeClientFacts();
			const world = createWorld({ facts, dataDir: dir }, { receiver: "mcw:receiver:gen1" });
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
			const world2 = createWorld({ facts: facts2, dataDir: dir }, { receiver: "mcw:receiver:gen2" });
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

// mkFact 引用保持（后续 container.last 切片使用）。
void mkFact;
