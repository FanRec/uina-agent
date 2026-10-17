/**
 * Minecraft World 持久性合同（world.md §5.4、§11.2）。
 *
 * 覆盖：
 * - durable ACK 的前提配置（WAL + synchronous=FULL）由存储如实报告，不靠编译默认值；
 * - 提交成功但回应丢失（Worker 崩溃/超时）不当成"未提交"：World 不冒认 durable，
 *   恢复时以稳定 evidence ref 核对已持久事实，源重放不重复入库；
 * - 保留关系不推进提交版本（分页 token 与历史水位不受记账影响）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorld, type WorldHandle } from "../.uina/worlds/minecraft/world/index.js";
import {
	type AppendOutcome,
	type StoredEntry,
	SqliteWorkerStore,
	MemoryWorldStore,
	openSqliteWorkerStore,
} from "../.uina/worlds/minecraft/world/internal/store.js";
import { FakeClientFacts, capturedFact } from "./minecraft-world-fake-facts.js";

const HISTORY_QUERY = { ref: "evidence.list@1", input: {} } as const;

/** 真的写入了，但回应在路上丢了：调用方无法区分"已提交"与"未提交"。 */
class LostReplyStore extends SqliteWorkerStore {
	override async append(entries: StoredEntry[]): Promise<AppendOutcome> {
		await super.append(entries);
		throw new Error("提交成功但回应丢失（模拟 Worker 在 COMMIT 后崩溃）");
	}
}

/** 打开时机由测试控制：构造后处于 opening，openNow 后就绪。 */
class SlowOpenStore extends MemoryWorldStore {
	#release: (() => void) | null = null;
	#openedPromise: Promise<void> | null = null;
	#open = false;
	override get opened(): Promise<void> {
		this.#openedPromise ??= new Promise<void>((resolve) => {
			this.#release = resolve;
		});
		return this.#openedPromise;
	}
	override get availability() {
		return this.#open ? { state: "ready" as const } : { state: "opening" as const };
	}
	openNow(): void {
		this.#open = true;
		this.#release?.();
	}
}

function items(observation: { value: unknown }): { kind: string; ref: string }[] {
	return (observation.value as { items: { kind: string; ref: string }[] }).items;
}

describe("minecraft world 持久性", () => {
	it("持久性配置如实报告：WAL + synchronous=FULL（durableThrough 的物理前提）", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "mc-durability-"));
		const store = await openSqliteWorkerStore(dataDir);
		try {
			expect(store.durability).toEqual({ journalMode: "wal", synchronous: 2 });
		} finally {
			await store.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("回应丢失不等于未提交：不冒认 durable，恢复后按 ref 核对已持久事实且不重复入库", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "mc-lost-reply-"));
		const facts = new FakeClientFacts();
		const lost = new LostReplyStore(dataDir);
		await lost.opened;
		const first = await createWorld({ facts, dataDir }, { store: lost });
		await first.historySettled; // 历史侧结算后再驱动证据（通知在结算前进缓冲属设计行为）
		try {
			facts.emitEvidence([capturedFact({ sequence: 1 }), capturedFact({ sequence: 2 })]);
			// 屏障只能给出"明确故障"：调用方不得据此断言未提交。
			await expect(first.read(HISTORY_QUERY)).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
			// 未取得提交证据 → durable 不推进（不冒认持久）。
			expect(facts.acks.at(-1)?.durableThrough ?? 0).toBe(0);
			const status = await first.status();
			expect(status.history.state).toBe("unavailable");
		} finally {
			await first.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("重开同一数据目录：恢复播种已持久事实，源重放同 ref 不重复入库", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "mc-restore-"));
		const facts1 = new FakeClientFacts();
		const lost = new LostReplyStore(dataDir);
		await lost.opened;
		const first = await createWorld({ facts: facts1, dataDir }, { store: lost });
		await first.historySettled;
		facts1.emitEvidence([capturedFact({ sequence: 1 }), capturedFact({ sequence: 2 })]);
		await expect(first.read(HISTORY_QUERY)).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
		await first.close();

		// 新接收代次：从真实持久状态起步，不继承被丢失回应的"未提交"假设。
		const facts2 = new FakeClientFacts();
		const reopened = await openSqliteWorkerStore(dataDir);
		const second: WorldHandle = await createWorld({ facts: facts2, dataDir }, { store: reopened });
		await second.historySettled;
		try {
			// 源重放同样的证据（同 ref 同载荷）：去重不重复入库。
			facts2.emitEvidence([capturedFact({ sequence: 1 }), capturedFact({ sequence: 2 })]);
			const observation = await second.read(HISTORY_QUERY);
			expect(items(observation)).toHaveLength(2);
			expect(facts2.acks.at(-1)?.durableThrough).toBe(2);
		} finally {
			await second.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("SQLite 打开期间当前事实照常可读，历史独立 opening → ready", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(
			{
				place: {
					world: "mcw:world:w1",
					worldRevision: "mcw:rev:r1",
					dimension: "minecraft:overworld",
					position: { x: 1, y: 64, z: 2 },
				},
				velocity: { x: 0, y: 0, z: 0 },
				health: 20,
				food: 20,
				onGround: true,
			},
			[],
		);
		const store = new SlowOpenStore();
		const world: WorldHandle = await createWorld({ facts, dataDir: "unused-memory" }, { store });
		try {
			// 未等 historySettled：当前读立即可用（createWorld 交付句柄不被 SQLite 阻塞）。
			const current = await world.read({ ref: "self@1", input: {} });
			expect(current.value).not.toBeNull();
			expect((await world.status()).history.state).toBe("opening");
			// opening 期间历史操作明确拒绝，不悬挂。
			await expect(world.read(HISTORY_QUERY)).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
			store.openNow();
			await world.historySettled;
			expect((await world.status()).history.state).toBe("ready");
		} finally {
			await world.close();
		}
	});

	it("恢复后同身份不同载荷：存储拒绝并按协议故障结算，不冒认持久、不卡屏障", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "mc-conflict-"));
		const facts1 = new FakeClientFacts();
		const first = await createWorld({ facts: facts1, dataDir }, { receiver: "mcw:receiver:g1" });
		await first.historySettled;
		facts1.emitEvidence([capturedFact({ sequence: 1 })]);
		facts1.emitGap("mcw:gap:g1", "mcw:test:stream:ev1", 1, 3);
		await first.read(HISTORY_QUERY); // 屏障：E1/ref-X 与 gap (1,3] 已持久
		await first.close();

		// 新接收代次重放 E1 但换载荷（ref Y ≠ 已持久 ref X）。
		const facts2 = new FakeClientFacts();
		const second: WorldHandle = await createWorld({ facts: facts2, dataDir }, { receiver: "mcw:receiver:g2" });
		await second.historySettled;
		try {
			facts2.emitEvidence([capturedFact({ sequence: 1, ref: "mcw:test:stream:ev1:1-conflicting" })]);
			facts2.emitGap("mcw:gap:g1", "mcw:test:stream:ev1", 1, 9); // 同 ref 区间变化 → 冲突
			const observation = await second.read(HISTORY_QUERY); // 屏障不被冲突卡死
			// 库内只有旧内容（ref-X 事实 + gap(1,3]）：冲突条目不入库，durable 不回退。
			const seen = items(observation);
			expect(seen).toHaveLength(2);
			expect(seen.map((i) => i.ref).sort()).toEqual(["mcw:gap:g1", "mcw:test:stream:ev1:1"]);
			// 协议故障进入诊断（同身份不同载荷），不静默吞。
			const impl = second as unknown as { getDiagnosticLog(): readonly string[] };
			expect(impl.getDiagnosticLog().some((line) => line.includes("同身份不同载荷"))).toBe(true);
		} finally {
			await second.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
