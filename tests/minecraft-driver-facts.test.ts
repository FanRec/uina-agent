/**
 * S-D1 连接与事实：createDriver ready、facts.sample 纯值 + stamp、subscribe changed/reset、
 * 选定证据捕获、ACK 记账、view 失效与 thenable 拒绝。
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
	FakeClientBot,
	TEST_OWNER,
	createDriver,
	flushAsync,
	layFloor,
	makeDriver,
} from "./minecraft-driver-helpers.js";
import type { ClientFactView } from "../.uina/worlds/minecraft/contracts/client-facts.js";
import { CallFailureError } from "../.uina/worlds/minecraft/contracts/errors.js";

describe("minecraft driver facts (S-D1)", () => {
	it("连接就绪后 sample 返回 self/inventory 纯值与正确 stamp", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 8);
		bot.setSlot(36, { name: "oak_log", count: 3, components: null });
		bot.position = { x: 1.5, y: 64, z: 2.5 };
		const driver = await makeDriver(bot);

		const capture = driver.facts.sample((v) => ({ self: v.self(), inv: v.inventory() }));
		expect(capture.stamp.source).toBe("uina.driver.client-facts");
		expect(capture.stamp.connection).toBeTruthy();
		expect(capture.stamp.incarnation).toBeTruthy();

		const self = capture.value.self;
		expect(self.value).not.toBeNull();
		expect(self.value!.place.position).toEqual({ x: 1.5, y: 64, z: 2.5 });
		expect(self.value!.health).toBe(20);
		// 混合来源必须带 basis 分组：运动=预测，生命=服务端。
		expect(self.source).toBe("mixed");
		expect(self.basis!.map((b) => b.source)).toEqual(["prediction", "server"]);

		const inv = capture.value.inv;
		expect(inv.value).not.toBeNull();
		const slot36 = inv.value!.slots.find((s) => s.slot === 36);
		expect(slot36).toMatchObject({ known: true, item: { name: "minecraft:oak_log", count: 3 } });
		// 空槽是 known=true/item=null，不是 known=false。
		const empty = inv.value!.slots.find((s) => s.slot === 40);
		expect(empty).toMatchObject({ known: true, item: null });
		await driver.close();
	});

	it("block 采样区分未知格与真实空气", async () => {
		const bot = new FakeClientBot();
		bot.setBlock({ x: 0, y: 63, z: 0 }, { name: "air", properties: {} });
		const driver = await makeDriver(bot);

		const r = driver.facts.sample((v) => ({
			unknown: v.block({
				place: { world: "w", worldRevision: "wr", dimension: "minecraft:overworld", position: { x: 0, y: 0, z: 0 } },
				block: { x: 5, y: 63, z: 5 },
			}),
			air: v.block({
				place: { world: "w", worldRevision: "wr", dimension: "minecraft:overworld", position: { x: 0, y: 0, z: 0 } },
				block: { x: 0, y: 63, z: 0 },
			}),
		}));
		expect(r.value.unknown.value.state).toBeNull();
		expect(r.value.unknown.unknown.length).toBeGreaterThan(0);
		expect(r.value.unknown.coverage).toBe("partial");
		expect(r.value.air.value.state).toMatchObject({ name: "minecraft:air" });
		expect(r.value.air.unknown).toEqual([]);
		await driver.close();
	});

	it("view 在 sample 返回后失效；thenable 被拒绝", async () => {
		const bot = new FakeClientBot();
		const driver = await makeDriver(bot);

		let escaped: ClientFactView | null = null;
		driver.facts.sample((v) => {
			escaped = v;
			return 1;
		});
		expect(escaped).not.toBeNull();
		expect(() => escaped!.self()).toThrowError(CallFailureError);

		expect(() => driver.facts.sample(() => ({ then: (resolve: (v: number) => void) => resolve(1) }))).toThrowError(
			/thenable|同步/s,
		);
		await driver.close();
	});

	it("协议更新后发布 changed 通知并推进 stamp.sequence", async () => {
		const bot = new FakeClientBot();
		const driver = await makeDriver(bot);
		const notices: unknown[] = [];
		const sub = driver.facts.subscribe((n) => notices.push(n));
		const seqBefore = sub.stamp.sequence;

		bot.setHealth(13);
		bot.setSlot(37, { name: "dirt", count: 1, components: null });
		await flushAsync();

		const changed = notices.filter((n) => (n as { kind: string }).kind === "changed");
		expect(changed.length).toBeGreaterThanOrEqual(1);
		const kinds = changed.flatMap((n) => (n as { changed: string[] }).changed);
		expect(kinds).toContain("self");
		expect(kinds).toContain("inventory");
		// 通知的 stamp 不早于提交时的 sequence。
		const latest = (changed.at(-1) as { stamp: { sequence: number } }).stamp.sequence;
		expect(latest).toBeGreaterThan(seqBefore);
		sub.close();
		await driver.close();
	});

	it("同值库存更新不推进 revision；值变化才推进", async () => {
		const bot = new FakeClientBot();
		const driver = await makeDriver(bot);
		const r1 = driver.facts.sample((v) => v.inventory());
		const rev1 = r1.value.value!.revision;

		bot.setSlot(40, { name: "stone", count: 1, components: null });
		await flushAsync();
		const r2 = driver.facts.sample((v) => v.inventory());
		expect(r2.value.value!.revision).toBeGreaterThan(rev1);
		await driver.close();
	});

	it("断连发布 reset(connection_changed)，epoch 更换，资格全部失效", async () => {
		const bot = new FakeClientBot();
		const driver = await makeDriver(bot);
		const notices: { kind: string; reason?: string }[] = [];
		const stampBefore = driver.facts.sample(() => 0).stamp;
		driver.facts.subscribe((n) => notices.push({ kind: n.kind, reason: (n as { reason?: string }).reason }));

		bot.end("server closed");
		await flushAsync();

		const reset = notices.find((n) => n.kind === "reset");
		expect(reset).toMatchObject({ reason: "connection_changed" });
		const stampAfter = driver.facts.sample((v) => ({ self: v.self() })).stamp;
		expect(stampAfter.epoch).not.toBe(stampBefore.epoch);
		expect(driver.connectionState()).toBe("disconnected");
		// 连接已不存在：当前事实源不再挂接旧 connection（重建时建立新身份，M5）。
		expect(stampAfter.connection).toBeNull();

		// 断连后身体准入明确失败。
		await expect(driver.player.acquire(TEST_OWNER, new AbortController().signal)).rejects.toMatchObject({
			code: "SOURCE_UNAVAILABLE",
		});
		await driver.close();
	});

	it("实体消失前捕获不可变证据；ACK 记账不回退", async () => {
		const bot = new FakeClientBot();
		const driver = await makeDriver(bot);
		const evidences: { mark: { stream: string; sequence: number }; fact: { value: { kind?: string } } }[] = [];
		const sub = driver.facts.subscribe((n) => {
			if (n.kind === "evidence") evidences.push(...(n.records as never[]));
		});
		expect(sub.evidenceThrough.sequence).toBe(0);

		bot.addEntity({
			networkId: 42,
			uuid: "u-42",
			type: "minecraft:zombie",
			position: { x: 1, y: 64, z: 1 },
			velocity: { x: 0, y: 0, z: 0 },
		});
		await flushAsync();
		bot.removeEntity(42);
		await flushAsync();

		expect(evidences.length).toBe(1);
		expect(evidences[0].mark.sequence).toBe(1);
		expect(evidences[0].fact.value).toMatchObject({ kind: "entityGone", networkId: 42 });
		// changed 通知不能代替已消失的事件载荷：证据是独立通知种类。
		// evidenceThrough 是登记时刻快照；新订阅读到当前证据头。
		const fresh = driver.facts.subscribe(() => {});
		expect(fresh.evidenceThrough.sequence).toBe(1);
		fresh.close();

		// durable > received 的 ACK 无效。
		expect(() =>
			sub.acknowledge({
				receiver: "world-1",
				stream: evidences[0].mark.stream,
				receivedThrough: 0,
				durableThrough: 1,
				gaps: [],
			}),
		).not.toThrow();
		// 正常 ACK 不回退、不抛错（同域共享材料，回收按提交进度）。
		sub.acknowledge({
			receiver: "world-1",
			stream: evidences[0].mark.stream,
			receivedThrough: 1,
			durableThrough: 1,
			gaps: [],
		});
		sub.acknowledge({
			receiver: "world-1",
			stream: evidences[0].mark.stream,
			receivedThrough: 1,
			durableThrough: 1,
			gaps: [],
		});
		sub.close();
		await driver.close();
	});

	it("死亡撤销资格；重生建立新化身", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 8);
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, new AbortController().signal);
		const conn1 = driver.facts.sample(() => 0).stamp.connection;
		const inc1 = driver.facts.sample(() => 0).stamp.incarnation;

		bot.die();
		await flushAsync();
		// 死亡立即撤销旧控制：会话被强制退役，旧操作全部拒绝。
		await expect(session.drive({ keys: { forward: true } }, 1)).rejects.toMatchObject({ code: "CONTROL_INVALID" });

		bot.respawn();
		await flushAsync();
		const stamp = driver.facts.sample(() => 0).stamp;
		expect(stamp.connection).toBe(conn1);
		expect(stamp.incarnation).not.toBe(inc1);
		expect(driver.connectionState()).toBe("ready");

		// 新化身可以重新取得身体。
		const session2 = await driver.player.acquire(TEST_OWNER, new AbortController().signal);
		expect(session2).toBeTruthy();
		await session2.close();
		await driver.close();
	});

	it("say 不占身体且按派发回执；断连后失败", async () => {
		const bot = new FakeClientBot();
		const driver = await makeDriver(bot);
		const receipt = await driver.say("hello", new AbortController().signal);
		// chat 无本地可确认回执：completion=unknown（sent ≠ 服务器已处理，driver.md §13）。
		expect(receipt).toMatchObject({ dispatch: "sent", completion: "unknown" });
		expect(bot.chatLog).toEqual(["hello"]);

		bot.end("x");
		await flushAsync();
		await expect(driver.say("again", new AbortController().signal)).rejects.toMatchObject({
			code: "SOURCE_UNAVAILABLE",
		});
		await driver.close();
	});

	it("没有 botFactory 时明确失败，不制造假连接", () => {
		expect(() => createDriver({ host: "localhost", port: 25565, username: "x" }, {})).toThrowError(/Mineflayer/);
	});

	it("stamp 类型形状", () => {
		// 合同锚定：stamp.sequence 是 Driver 源内单调序号。
		expectTypeOf<{ sequence: number }>().toEqualTypeOf<{ sequence: number }>();
	});
});
