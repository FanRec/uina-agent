/**
 * 对抗式审查回归测试：修复项的可观测证明。
 * 覆盖：ACK 跨流隔离、重生不重复接线、op ref 唯一性、
 * feedback signal listener 无泄漏、drive 取消携带 actualTicks、click 预测推进事实源。
 */

import { describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import {
	FakeClientBot,
	TEST_OWNER,
	createDriver,
	flushAsync,
	layFloor,
	makeDriver,
} from "./minecraft-driver-helpers.js";
import { ClientFactsSource } from "../.uina/worlds/minecraft/driver/internal/facts.js";

const signal = () => new AbortController().signal;
const place = { world: "w", worldRevision: "wr", dimension: "minecraft:overworld", position: { x: 0, y: 0, z: 0 } };

describe("minecraft driver review regressions", () => {
	it("ACK 按流隔离：另一流的 durableThrough 不得释放本流材料", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		bot.setBlock({ x: 1, y: 64, z: 0 }, { name: "minecraft:stone", properties: {} });
		bot.addEntity({
			networkId: 1,
			uuid: "u1",
			type: "minecraft:cow",
			position: { x: 2, y: 64, z: 2 },
			velocity: { x: 0, y: 0, z: 0 },
		});
		const driver = await makeDriver(bot);
		// driver.facts 运行时即内部源；materialCount 是修复引入的观察口。
		const source = driver.facts as unknown as ClientFactsSource;

		const records: { mark: { stream: string }; schema: string }[] = [];
		const sub = driver.facts.subscribe((n) => {
			if (n.kind === "evidence") records.push(...n.records.map((r) => ({ mark: r.mark, schema: r.schema })));
		});

		// 流一：entities（entityGone 证据）。
		bot.removeEntity(1);
		await flushAsync();
		// 流二：dig（本地预测证据）。
		const session = await driver.player.acquire(TEST_OWNER, signal());
		await session.dig({ place, block: { x: 1, y: 64, z: 0 } });
		await session.close();
		await flushAsync();

		const entitiesStream = records.find((r) => r.schema === "client.entities@1")!.mark.stream;
		const digStream = records.find((r) => r.schema === "driver.dig@1")!.mark.stream;
		expect(entitiesStream).not.toBe(digStream);
		expect(source.materialCount(entitiesStream)).toBe(1);
		expect(source.materialCount(digStream)).toBe(1);

		// 只 ACK entities 流且 durable 覆盖全部序号。
		sub.acknowledge({
			receiver: "world-1",
			stream: entitiesStream,
			durableThrough: 999,
		});
		// 修复前：另一流（dig）的 durableThrough 会误释放 entities 材料 —— 反向亦然。
		// 修复后：entities 材料被回收，dig 材料保留（无本流 ACK）。
		expect(source.materialCount(entitiesStream)).toBe(0);
		expect(source.materialCount(digStream)).toBe(1);
		sub.close();
		await driver.close();
	});

	it("死亡重生不重复接线：health 事件只推进一次 stamp", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		const driver = await makeDriver(bot);
		bot.die();
		bot.respawn();
		await flushAsync();

		const seqBefore = driver.facts.sample(() => 0).stamp.sequence;
		bot.setHealth(15);
		await flushAsync();
		const seqAfter = driver.facts.sample(() => 0).stamp.sequence;
		// 重复接线会让同一事件触发两次 commitSelfChanged。
		expect(seqAfter - seqBefore).toBe(1);
		await driver.close();
	});

	it("同毫秒连续操作的 op ref 单调不重名", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		bot.addEntity({
			networkId: 5,
			uuid: "u5",
			type: "minecraft:cow",
			position: { x: 1, y: 64, z: 1 },
			velocity: { x: 0, y: 0, z: 0 },
		});
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const ref = driver.facts.sample((v) => v.entities()).value.value.entities[0]!.ref;

		// 同步连续三次 attack：op ref 必须互不相同（Date.now 方案会重名）。
		const r1 = await session.attack(ref);
		const r2 = await session.attack(ref);
		const r3 = await session.attack(ref);
		const opRefs = [r1.effect, r2.effect, r3.effect].map((e) => e.split("-e")[0]);
		expect(new Set(opRefs).size).toBe(3);
		await session.close();
		await driver.close();
	});

	it("feedback.next 交付/取消后不留 signal listener", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 8);
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const stream = await session.feedback({});
		const ctrl = new AbortController();

		bot.stepPhysics(1);
		const f = await stream.next(null, ctrl.signal);
		// 交付后 listener 必须清零（每帧热路径，残留即泄漏）。
		expect(getEventListeners(ctrl.signal, "abort").length).toBe(0);

		// 等待取消路径同样清零。
		const pending = stream.next(f.sequence, ctrl.signal);
		ctrl.abort();
		await expect(pending).rejects.toMatchObject({ code: "CONTROL_INVALID" });
		expect(getEventListeners(ctrl.signal, "abort").length).toBe(0);

		await stream.close();
		await session.close();
		await driver.close();
	});

	it("drive 被撤销的错误携带实际消费步数", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 12);
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const p = session.drive({ keys: { forward: true } }, 100);
		const rejected = expect(p).rejects.toMatchObject({
			code: "CONTROL_INVALID",
			progress: { measures: [{ name: "actualTicks", value: 3, unit: "steps" }] },
		});
		bot.stepPhysics(3);
		session.close().catch(() => {});
		await rejected;
		await driver.close();
	});

	it("click 本地预测推进事实源：订阅者收到 window changed", async () => {
		const bot = new FakeClientBot({
			clickPrediction: (w) => {
				w.cursor = w.slots[0];
				w.slots[0] = null;
			},
		});
		layFloor(bot, 0, 4);
		bot.setBlock({ x: 0, y: 64, z: 0 }, { name: "minecraft:chest", properties: {} });
		bot.programWindow("minecraft:chest", 27, [
			{ name: "minecraft:iron_ingot", count: 5, components: null, remainingDurability: null },
			...new Array(26).fill(null),
		]);
		const driver = await makeDriver(bot);
		const kinds: string[] = [];
		driver.facts.subscribe((n) => {
			if (n.kind === "changed") kinds.push(...n.changed);
		});
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const win = await session.openContainer({ place, block: { x: 0, y: 64, z: 0 } });
		const snap = await win.snapshot();

		await win.click({
			slot: 0,
			button: 0,
			mode: 0,
			expectedRevision: snap.value.revision,
			expectedSlots: [{ slot: 0, stack: { item: { name: "minecraft:iron_ingot" }, count: 5 } }],
			expectedCursor: { item: null, count: 0 },
		});
		await flushAsync();
		// 预测不产生协议包，但事实订阅者必须看到窗口已变。
		expect(kinds).toContain("window");
		await session.close();
		await driver.close();
	});

	it("createDriver 返回的 facts 端口暴露材料观察口径不破坏合同形状", async () => {
		const bot = new FakeClientBot();
		const driver = await makeDriver(bot);
		// sample 返回形状不变。
		const capture = driver.facts.sample((v) => v.self());
		expect(capture.stamp.source).toBe("uina.driver.client-facts");
		expect(createDriver).toBeTypeOf("function");
		await driver.close();
	});
});
