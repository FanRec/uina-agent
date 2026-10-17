/**
 * Minecraft World S-W2：Watch 无漏失效。
 *
 * 覆盖（LEAD.md S-W2 + world.md §9 + 可证伪场景表 §18）：
 * - read→watch→next 无漏：登记前已发生的变化首次 next 立即交付；
 * - 检查点 H>C（stamp 前进、通知未到）→ 保守失效，不用旧空间索引冒认；
 * - 跳号/乱序（22 的 B 先到、21 的 A 缺失）→ 全源保守覆盖，MAX 不证明未变；
 * - 同 H 不重复自激；迟到的 <=C 通知只细化、不回退水位；
 * - reset 语义：源 epoch 断裂 reset、connection 重建与 gap 走保守失效；
 * - 取消 next 只取消该次等待；close 幂等；close 后拒绝。
 */

import { describe, expect, it } from "vitest";
import { createWorld } from "../.uina/worlds/minecraft/world/index.js";
import { MemoryWorldStore } from "../.uina/worlds/minecraft/world/internal/store.js";
import { FakeClientFacts } from "./minecraft-world-fake-facts.js";
import type { ClientFactNotice } from "../.uina/worlds/minecraft/contracts/client-facts.js";

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

async function microtaskTurn(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("minecraft world watch（S-W2）", () => {
	it("read→watch→next：登记后变化即时交付，cursor 前进", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const observation = await world.read({ ref: "self@1", input: {} });
		const watch = await world.watch({ ref: "self@1", input: {} }, observation.cursor, new AbortController().signal);

		let delivered: unknown;
		const pending = watch.next(observation.cursor, new AbortController().signal).then((change) => {
			delivered = change;
			return change;
		});
		await microtaskTurn();
		expect(delivered).toBeUndefined(); // 无变化时挂起，不自激

		facts.setSelf(selfState(18));
		const change = await pending;
		expect(change.kind).toBe("changed");
		if (change.kind === "changed") {
			expect(change.cursor.sequence).toBeGreaterThan(observation.cursor.sequence);
			expect(change.changed).toContain("fact:self");
		}
		await watch.close();
		await world.close();
	});

	it("read 后变化、watch 登记前：首次 next 立即交付（§18 read→watch 之间变化）", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const observation = await world.read({ ref: "self@1", input: {} });
		facts.setSelf(selfState(16)); // watch 之前发生
		const watch = await world.watch({ ref: "self@1", input: {} }, observation.cursor, new AbortController().signal);
		const change = await watch.next(observation.cursor, new AbortController().signal);
		expect(change.kind).toBe("changed");
		await watch.close();
		await world.close();
	});

	it("stamp 已前进但通知未到（检查点 H>C）：watch 采样即保守失效一次（§18 20/21 反例）", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const first = await world.read({ ref: "self@1", input: {} }); // stamp=1, C=1
		facts.commitWithoutNotice(() => {}); // stamp=2，无通知（通知排队/丢失）
		const watch = await world.watch({ ref: "self@1", input: {} }, first.cursor, new AbortController().signal);
		const change = await watch.next(first.cursor, new AbortController().signal);
		expect(change.kind).toBe("changed");
		if (change.kind === "changed") {
			// 保守失效：范围未知，不冒认精确 refs
			expect(change.changed).toEqual([]);
			expect(change.cursor.sequence).toBeGreaterThan(first.cursor.sequence);
		}
		await watch.close();
		await world.close();
	});

	it("22 的 B 范围先到、21 的 A 缺失：保守覆盖到 22，MAX 不证明 A 未变（§18 反例）", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []); // stamp=1, C=1
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const first = await world.read({ ref: "self@1", input: {} });
		facts.emitChangedAt(22, ["fact:block:B"]); // 跳过 21
		const watch = await world.watch({ ref: "self@1", input: {} }, first.cursor, new AbortController().signal);
		const change = await watch.next(first.cursor, new AbortController().signal);
		expect(change.kind).toBe("changed");
		if (change.kind === "changed") expect(change.changed).toEqual([]); // (1,22] 不完整 → 全源保守
		await watch.close();
		await world.close();
	});

	it("同 H 不重复自激：迟到的 <=C 通知只细化，水位不回退", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []); // stamp=1, C=1
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const first = await world.read({ ref: "self@1", input: {} });
		facts.emitChangedAt(5, ["fact:block:B"]); // 跳号 → 保守失效，C=5
		const watch = await world.watch({ ref: "self@1", input: {} }, first.cursor, new AbortController().signal);
		const change = await watch.next(first.cursor, new AbortController().signal);
		expect(change.kind).toBe("changed");
		const reRead = await world.read({ ref: "self@1", input: {} });
		expect(reRead.cursor.sequence).toBe((change as { cursor: { sequence: number } }).cursor.sequence);

		// 迟到的 seq=3 通知（<=C）：只细化，不发布新失效。
		const stale: ClientFactNotice = {
			kind: "changed",
			stamp: { ...facts.currentStamp(), sequence: 3 },
			changed: ["fact:self"],
		};
		facts.emitRawNotice(stale);
		let woke = false;
		const pending = watch.next(reRead.cursor, new AbortController().signal).then((c) => {
			woke = true;
			return c;
		});
		await microtaskTurn();
		expect(woke).toBe(false); // 同 H 不重复分配失效 → 无新变化可等待
		pending.catch(() => {});
		await watch.close();
		await world.close();
	});

	it("源 epoch 断裂（incarnation_changed）：next 交付 reset(epoch_changed)", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const observation = await world.read({ ref: "self@1", input: {} });
		const watch = await world.watch({ ref: "self@1", input: {} }, observation.cursor, new AbortController().signal);
		const pending = watch.next(observation.cursor, new AbortController().signal);
		facts.emitReset("incarnation_changed", "mcw:test:epoch:e2");
		const change = await pending;
		expect(change.kind).toBe("reset");
		if (change.kind === "reset") expect(change.reason).toBe("epoch_changed");
		await watch.close();
		await world.close();
	});

	it("connection_changed（epoch 未变）：保守 changed，不是 reset（普通重连不换世界）", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const observation = await world.read({ ref: "self@1", input: {} });
		const watch = await world.watch({ ref: "self@1", input: {} }, observation.cursor, new AbortController().signal);
		const pending = watch.next(observation.cursor, new AbortController().signal);
		facts.emitReset("connection_changed");
		const change = await pending;
		expect(change.kind).toBe("changed"); // 当前覆盖失效走保守失效
		await watch.close();
		await world.close();
	});

	it("源 gap：保守失效，不用 reset 补事实", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const observation = await world.read({ ref: "self@1", input: {} });
		const watch = await world.watch({ ref: "self@1", input: {} }, observation.cursor, new AbortController().signal);
		const pending = watch.next(observation.cursor, new AbortController().signal);
		facts.emitReset("gap", "mcw:test:epoch:e1");
		const change = await pending;
		expect(change.kind).toBe("changed");
		await watch.close();
		await world.close();
	});

	it("绑定变化后 watch 采样即见新 scope：旧 epoch cursor 立即 reset(epoch_changed)", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const observation = await world.read({ ref: "self@1", input: {} });
		facts.setScope({ binding: "mcw:binding:b2" });
		const watch = await world.watch({ ref: "self@1", input: {} }, observation.cursor, new AbortController().signal);
		const change = await watch.next(observation.cursor, new AbortController().signal);
		expect(change.kind).toBe("reset");
		if (change.kind === "reset") expect(change.reason).toBe("epoch_changed");
		// 新 read 得到新 epoch cursor，世界照常可读。
		const reRead = await world.read({ ref: "self@1", input: {} });
		expect(reRead.cursor.epoch).not.toBe(observation.cursor.epoch);
		expect(reRead.value).toEqual(selfState(20));
		await watch.close();
		await world.close();
	});

	it("绑定在同一采样内变化：read cursor 属于新分区流，watch 正常等待（死流回归）", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		await world.read({ ref: "self@1", input: {} }); // 建立 b1 基线
		facts.setScope({ binding: "mcw:binding:b2", worldRevision: "mcw:rev:r2" }); // 静默换绑
		// 本次 read 的采样原子返回新 scope：cursor 必须属于新分区流，而非已死的 b1 流。
		const second = await world.read({ ref: "self@1", input: {} });
		const watch = await world.watch({ ref: "self@1", input: {} }, second.cursor, new AbortController().signal);
		let woke = false;
		const pending = watch.next(second.cursor, new AbortController().signal).then((c) => {
			woke = true;
			return c;
		});
		await microtaskTurn();
		facts.setSelf(selfState(17));
		await Promise.race([pending, new Promise((r) => setTimeout(r, 50))]);
		expect(woke).toBe(true); // 旧实现注册到死流，这里永不唤醒
		await watch.close();
		await world.close();
	});

	it("立即交付后不重放陈旧 pending（新 cursor 的 next 不收重复变化）", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const first = await world.read({ ref: "self@1", input: {} });
		const watch = await world.watch({ ref: "self@1", input: {} }, first.cursor, new AbortController().signal);
		facts.emitChangedAt(facts.currentStamp().sequence + 4, ["fact:block:B"]); // 跳号 → 保守失效，无等待者 → pending
		const change1 = await watch.next(first.cursor, new AbortController().signal); // 立即交付（新鲜）
		const reRead = await world.read({ ref: "self@1", input: {} });
		expect(reRead.cursor.sequence).toBe((change1 as { cursor: { sequence: number } }).cursor.sequence);

		let woke = false;
		const pending = watch.next(reRead.cursor, new AbortController().signal).then((c) => {
			woke = true;
			return c;
		});
		await microtaskTurn();
		expect(woke).toBe(false); // 陈旧 pending 不重放
		pending.catch(() => {});
		await watch.close();
		await world.close();
	});

	it("取消 next 只取消该次等待，不消费共享变化", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const observation = await world.read({ ref: "self@1", input: {} });
		const watch = await world.watch({ ref: "self@1", input: {} }, observation.cursor, new AbortController().signal);

		const controllerA = new AbortController();
		const pendingA = watch.next(observation.cursor, controllerA.signal);
		controllerA.abort();
		await expect(pendingA).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

		// 取消后变化仍可被下一次 next 观察（不消费共享状态）。
		const pendingB = watch.next(observation.cursor, new AbortController().signal);
		facts.setSelf(selfState(12));
		const change = await pendingB;
		expect(change.kind).toBe("changed");
		await watch.close();
		await world.close();
	});

	it("close 幂等；close 后 next 拒绝 REFERENCE_STALE", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const observation = await world.read({ ref: "self@1", input: {} });
		const watch = await world.watch({ ref: "self@1", input: {} }, observation.cursor, new AbortController().signal);
		await watch.close();
		await watch.close();
		await expect(watch.next(observation.cursor, new AbortController().signal)).rejects.toMatchObject({
			code: "REFERENCE_STALE",
		});
		await world.close();
	});

	it("证据接收不唤醒纯当前 watch（依赖类别分域）", async () => {
		const facts = new FakeClientFacts();
		facts.setSelf(selfState(20), []);
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		const observation = await world.read({ ref: "self@1", input: {} });
		const watch = await world.watch({ ref: "self@1", input: {} }, observation.cursor, new AbortController().signal);
		let woke = false;
		const pending = watch.next(observation.cursor, new AbortController().signal).then((c) => {
			woke = true;
			return c;
		});
		facts.emitEvidence([
			{
				ref: "ev:1",
				schema: "client.inventory@1",
				mark: { stream: "mcw:test:stream:ev1", sequence: 1 },
				stamp: facts.currentStamp(),
				scope: {
					binding: "mcw:binding:b1",
					world: "mcw:world:w1",
					worldRevision: "mcw:rev:r1",
					dimension: "minecraft:overworld",
				},
				fact: {
					value: {},
					observedAt: "2026-10-16T08:00:00.000Z",
					source: "server",
					coverage: "complete",
					unknown: [],
					evidence: [],
				},
			},
		]);
		await microtaskTurn();
		expect(woke).toBe(false); // 纯当前不被证据接收唤醒
		pending.catch(() => {});
		await watch.close();
		await world.close();
	});
});
