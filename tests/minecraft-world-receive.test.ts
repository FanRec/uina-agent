/**
 * Minecraft World S-W1：证据接收、ACK 水位与当前读。
 *
 * 覆盖（LEAD.md S-W1 + world.md §5）：
 * - 先订阅后采样；read(self/inventory/block) 返回 Observation + 同点 cursor；
 * - received/durable 水位连续推进，gap 不越洞，open-ended gap 不越过封口；
 * - 乱序、重传去重、同身份不同载荷故障；
 * - 存储失败时 D 暂停、当前读不受影响；close 冲刷后关闭。
 */

import { describe, expect, it } from "vitest";
import type { JsonValue } from "../.uina/worlds/minecraft/contracts/values.js";
import type { ClientInventoryValue } from "../.uina/worlds/minecraft/contracts/client-facts.js";
import { createWorld, type WorldHandle } from "../.uina/worlds/minecraft/world/index.js";
import { MemoryWorldStore, type WorldStore } from "../.uina/worlds/minecraft/world/internal/store.js";
import { FakeClientFacts, blockTarget, capturedFact } from "./minecraft-world-fake-facts.js";

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

describe("minecraft world 接收与当前读（S-W1）", () => {
	it("先订阅后采样，read(self@1) 返回 Observation 与 cursor", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []); // 静默提交，避免构造期通知
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		expect(facts.callLog[0]).toBe("subscribe");
		expect(facts.callLog[1]).toBe("sample");

		const observation = await world.read({ ref: "self@1", input: {} });
		expect(observation.value).toEqual(selfState(20));
		expect(observation.observedAt).toBe("2026-10-16T08:00:00.000Z");
		expect(observation.cursor.stream).toContain("self@1");
		expect(observation.cursor.sequence).toBeGreaterThanOrEqual(0);
		expect(observation.source).toBe("server");
		await world.close();
	});

	it("read(inventory@1) 与 read(block@1) 透传 Driver 纯值与未知标注", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		facts.setInventory({
			revision: 3,
			layout: { slotCount: 36, regions: [{ name: "main", slots: Array.from({ length: 36 }, (_, i) => i) }] },
			slots: [{ slot: 0, known: true, item: { name: "minecraft:oak_log", count: 19, components: null } }],
			selectedSlot: 0,
		});
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });

		const inventory = await world.read({ ref: "inventory@1", input: {} });
		expect((inventory.value as ClientInventoryValue | null)?.slots[0]).toEqual({
			slot: 0,
			known: true,
			item: { name: "minecraft:oak_log", count: 19, components: null },
		});

		const block = await world.read({ ref: "block@1", input: blockTarget(3, 64, 4) as unknown as JsonValue });
		expect((block.value as { state: unknown }).state).toBeNull(); // 未设置 → 未知格，不冒充空气
		expect(block.coverage).toBe("partial");
		await world.close();
	});

	it("未知查询与非法输入分别报 CALL_UNAVAILABLE / INVALID_ARGUMENT", async () => {
		const facts = new FakeClientFacts();
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		await expect(world.read({ ref: "nope@1", input: {} })).rejects.toMatchObject({ code: "CALL_UNAVAILABLE" });
		await expect(world.read({ ref: "block@1", input: { block: { x: 1.5, y: 2, z: 3 } } })).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
		});
		await world.close();
	});

	it("durable ACK 连续推进；乱序不越洞（缺前缀不冒认持久）", async () => {
		const facts = new FakeClientFacts();
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		facts.emitEvidence([capturedFact({ sequence: 2 })]);
		await committed(world);
		expect(facts.acks.at(-1)?.durableThrough).toBe(0); // 缺 E=1：E2 已持久但前缀未连续，不冒认
		facts.emitEvidence([capturedFact({ sequence: 1 })]);
		await committed(world);
		expect(facts.acks.at(-1)?.durableThrough).toBe(2);
		await world.close();
	});

	it("有限区间 gap 越洞：持久缺口覆盖计入 durable 前缀", async () => {
		const facts = new FakeClientFacts();
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		facts.emitEvidence([capturedFact({ sequence: 1 })]);
		facts.emitGap("mcw:gap:g1", "mcw:test:stream:ev1", 1, 3);
		await committed(world);
		expect(facts.acks.at(-1)?.durableThrough).toBe(3); // E1 载荷 + (1,3] 持久缺口
		await world.close();
	});

	it("through=null 的未知后缀 gap 不授权越洞；封口后闭合", async () => {
		const facts = new FakeClientFacts();
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		facts.emitEvidence([capturedFact({ sequence: 1 })]);
		facts.emitGap("mcw:gap:open", "mcw:test:stream:ev1", 1, null);
		await committed(world);
		expect(facts.acks.at(-1)?.durableThrough).toBe(1); // 未知后缀不越洞
		facts.emitEvidence([capturedFact({ sequence: 5 })]);
		await committed(world);
		expect(facts.acks.at(-1)?.durableThrough).toBe(1); // E5 已持久，但不证明 (1,5) 已对账
		facts.emitEnd({ stream: "mcw:test:stream:ev1", sequence: 5 });
		await committed(world);
		expect(facts.acks.at(-1)?.durableThrough).toBe(5); // 封口后 gap 闭合为 (1,5]
		await world.close();
	});

	it("重传同身份同载荷去重，不分配新接收序号", async () => {
		const facts = new FakeClientFacts();
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const record = capturedFact({ sequence: 1 });
		facts.emitEvidence([record]);
		await committed(world);
		const first = (await world.read({ ref: "evidence.list@1", input: {} })) as unknown as {
			value: { items: unknown[] };
		};
		facts.emitEvidence([{ ...record, stamp: { ...record.stamp } }]); // 同 ref 重传
		await committed(world);
		const second = (await world.read({ ref: "evidence.list@1", input: {} })) as unknown as {
			value: { items: unknown[] };
		};
		expect(facts.acks.at(-1)?.durableThrough).toBe(1);
		expect(second.value.items).toHaveLength(first.value.items.length); // 无新提交
		await world.close();
	});

	it("同身份不同载荷是源协议故障：不覆盖、保留诊断", async () => {
		const facts = new FakeClientFacts();
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		facts.emitEvidence([capturedFact({ sequence: 1 })]);
		facts.emitEvidence([capturedFact({ sequence: 1, ref: "mcw:test:stream:ev1:1- conflicting" })]);
		const impl = world as unknown as { getDiagnosticLog(): readonly string[] };
		expect(impl.getDiagnosticLog().some((line) => line.includes("同身份不同载荷"))).toBe(true);
		await committed(world);
		expect(facts.acks.at(-1)?.durableThrough).toBe(1); // 先到版本保留
		await world.close();
	});

	it("存储提交失败：D 不前进、不发 durable ACK；当前读不受影响", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(18), []);
		const brokenStore: WorldStore = {
			availability: { state: "unavailable", reason: "模拟磁盘故障" },
			description: "模拟磁盘故障",
			opened: Promise.reject(new Error("模拟磁盘故障")),
			append: async () => ({ ok: false }),
			listEvidence: async (filter) => new MemoryWorldStore().listEvidence(filter),
			hasEvidence: async () => false,
			recoverySnapshot: async () => null,
			writeRecord: async () => ({ ok: false, reason: "store_failed" as const }),
			readRecord: async () => null,
			retain: async () => false,
			release: async () => false,
			close: async () => {},
		};
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: brokenStore });
		facts.emitEvidence([capturedFact({ sequence: 1 })]);
		expect(facts.acks.at(-1)?.durableThrough).toBe(0); // 不冒认持久

		const observation = await world.read({ ref: "self@1", input: {} });
		expect(observation.value).toEqual(selfState(18)); // 当前事实仍可读
		const status = await world.status();
		expect(status.history.state).toBe("unavailable");
		await expect(world.read({ ref: "evidence.list@1", input: {} })).rejects.toMatchObject({
			code: "STORE_UNAVAILABLE", // 屏障以明确故障解除，不悬挂
		});
		await world.close();
	});

	it("close 冲刷待落盘前缀后关闭；关闭后 read 拒绝", async () => {
		const facts = new FakeClientFacts();
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		facts.emitEvidence([capturedFact({ sequence: 1 })]);
		await world.close(); // 最终冲刷串入提交队列：关闭返回即 durable ACK 已发布
		expect(facts.acks.at(-1)?.durableThrough).toBe(1);
		await expect(world.read({ ref: "self@1", input: {} })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
	});

	it("read 的 cursor 随当前源失效推进：stamp 跳号后新 cursor 反映保守水位", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const first = await world.read({ ref: "self@1", input: {} });
		// Driver 提交到 seq=5 且通知丢失（合并/跳号）：下一次 read 的检查点必须保守失效。
		facts.commitWithoutNotice(() => {
			/* 状态仅 stamp 前进 */
		});
		facts.commitWithoutNotice(() => {
			/* seq 前进 */
		});
		const second = await world.read({ ref: "self@1", input: {} });
		expect(second.cursor.sequence).toBeGreaterThan(first.cursor.sequence);
		await world.close();
	});

	it("绑定代次变化后旧 cursor 无法继续使用（read 正常返回新分区 cursor）", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const first = await world.read({ ref: "self@1", input: {} });
		facts.setScope({ binding: "mcw:binding:b2" });
		const second = await world.read({ ref: "self@1", input: {} });
		expect(second.cursor.epoch).not.toBe(first.cursor.epoch);
		expect(second.value).toEqual(selfState(20));
		await world.close();
	});
});

describe("minecraft world 状态可用性（world.status@1）", () => {
	it("current/history/binding 分别表达", async () => {
		const facts = new FakeClientFacts();
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const status = await world.status();
		expect(status.current.state).toBe("ready");
		expect(status.history.state).toBe("ready");
		expect(status.history.reason).toContain("内存"); // 如实说明非持久
		expect(status.binding).toEqual({
			state: "bound",
			binding: "mcw:binding:b1",
			world: "mcw:world:w1",
			worldRevision: "mcw:rev:r1",
		});
		await world.close();
	});
});
