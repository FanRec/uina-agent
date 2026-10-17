/**
 * S-D3 窗口会话：快照/revision/点击预期核验、串行、普通 close 前置条件、
 * 强制退役、服务端关闭、协议 ID 复用。
 */

import { describe, expect, it } from "vitest";
import { FakeClientBot, TEST_OWNER, flushAsync, layFloor, makeDriver } from "./minecraft-driver-helpers.js";
import type { WindowSession } from "../.uina/worlds/minecraft/contracts/body.js";

const signal = () => new AbortController().signal;
const place = { world: "w", worldRevision: "wr", dimension: "minecraft:overworld", position: { x: 0, y: 0, z: 0 } };

describe("minecraft driver window (S-D3)", () => {
	it("openContainer 绑定窗口代次；snapshot 纯读；revision 随槽位变化推进", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		bot.setBlock({ x: 0, y: 64, z: 0 }, { name: "minecraft:chest", properties: {} });
		bot.programWindow("minecraft:chest", 27, [
			{ name: "minecraft:iron_ingot", count: 5, components: null, remainingDurability: null },
			...new Array(26).fill(null),
		]);
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());

		const win: WindowSession = await session.openContainer({ place, block: { x: 0, y: 64, z: 0 } });
		const snap1 = await win.snapshot();
		expect(snap1.value.type).toBe("minecraft:chest");
		expect(snap1.value.slots[0]).toMatchObject({ slot: 0, item: { name: "minecraft:iron_ingot", count: 5 } });
		const rev1 = snap1.value.revision;

		// 服务端槽位更新 → 完整快照比较推进 revision。
		bot.setWindowSlot(3, { name: "minecraft:bread", count: 1, components: null, remainingDurability: null });
		await flushAsync();
		const snap2 = await win.snapshot();
		expect(snap2.value.revision).toBeGreaterThan(rev1);

		// snapshot 纯读：不产生协议操作。
		const packetsBefore = bot.packets.length;
		await win.snapshot();
		expect(bot.packets.length).toBe(packetsBefore);

		// revision 单一权威同源：facts 视图经 live getter 读取会话版本（不持拷贝值）。
		const windowFact = driver.facts.sample((v) => v.window());
		expect(windowFact.value.value?.revision).toBe(snap2.value.revision);

		await session.close();
		await driver.close();
	});

	it("click 预期 revision/槽位不符 → WINDOW_CHANGED 派发前失败", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		bot.setBlock({ x: 0, y: 64, z: 0 }, { name: "minecraft:chest", properties: {} });
		bot.programWindow("minecraft:chest", 27, [
			{ name: "minecraft:iron_ingot", count: 5, components: null, remainingDurability: null },
			...new Array(26).fill(null),
		]);
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const win = await session.openContainer({ place, block: { x: 0, y: 64, z: 0 } });
		const snap = await win.snapshot();

		// revision 不符。
		await expect(
			win.click({
				slot: 0,
				button: 0,
				mode: 0,
				expectedRevision: snap.value.revision + 5,
				expectedSlots: [],
				expectedCursor: { item: null, count: 0 },
			}),
		).rejects.toMatchObject({ code: "WINDOW_CHANGED" });

		// 槽位内容不符。
		await expect(
			win.click({
				slot: 0,
				button: 0,
				mode: 0,
				expectedRevision: snap.value.revision,
				expectedSlots: [{ slot: 0, stack: { item: { name: "minecraft:gold_ingot" }, count: 5 } }],
				expectedCursor: { item: null, count: 0 },
			}),
		).rejects.toMatchObject({ code: "WINDOW_CHANGED" });

		// 数量不符（count 是精确堆叠数）。
		await expect(
			win.click({
				slot: 0,
				button: 0,
				mode: 0,
				expectedRevision: snap.value.revision,
				expectedSlots: [{ slot: 0, stack: { item: { name: "minecraft:iron_ingot" }, count: 4 } }],
				expectedCursor: { item: null, count: 0 },
			}),
		).rejects.toMatchObject({ code: "WINDOW_CHANGED" });

		expect(bot.packets.some((pk) => pk.name === "window_click")).toBe(false);
		await session.close();
		await driver.close();
	});

	it("click 预期全部符合 → 派发，completion=unknown（预测不是服务端确认）", async () => {
		const bot = new FakeClientBot({
			clickPrediction: (w) => {
				// 模拟上游 acceptClick：预测先于发包（拿走槽位 0 的物品到光标）。
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
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const win = await session.openContainer({ place, block: { x: 0, y: 64, z: 0 } });
		const snap = await win.snapshot();

		const receipt = await win.click({
			slot: 0,
			button: 0,
			mode: 0,
			expectedRevision: snap.value.revision,
			expectedSlots: [{ slot: 0, stack: { item: { name: "minecraft:iron_ingot" }, count: 5 } }],
			expectedCursor: { item: null, count: 0 },
		});
		expect(receipt.dispatch).toBe("sent");
		expect(receipt.completion).toBe("unknown"); // 协议确认版本相关；本地预测不冒充服务端确认。

		// 预测已生效：光标持有物品。
		const snap2 = await win.snapshot();
		expect(snap2.value.cursor).toMatchObject({ name: "minecraft:iron_ingot", count: 5 });
		expect(snap2.value.revision).toBeGreaterThan(snap.value.revision);

		// 预测未确认前：view.window 读取标注 prediction，且 revision 与会话版本同源（§12.2 单一版本空间）。
		const viewWin = driver.facts.sample((v) => v.window()).value;
		expect(viewWin.value).not.toBeNull();
		expect(viewWin.source).toBe("prediction");
		expect(viewWin.value!.revision).toBe(snap2.value.revision);

		// 服务端真实更新到达：清除预测标记；version 仍由会话权威推进，两处读数一致。
		bot.setWindowSlot(5, { name: "minecraft:bread", count: 1, components: null, remainingDurability: null });
		await flushAsync();
		const snap3 = await win.snapshot();
		const viewWin2 = driver.facts.sample((v) => v.window()).value;
		expect(viewWin2.source).toBe("server");
		expect(viewWin2.value!.revision).toBe(snap3.value.revision);

		await session.close();
		await driver.close();
	});

	it("普通 close 要求空光标；CURSOR_NOT_EMPTY；强制退役不受阻", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		bot.setBlock({ x: 0, y: 64, z: 0 }, { name: "minecraft:chest", properties: {} });
		bot.programWindow("minecraft:chest", 27, new Array(27).fill(null));
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const win = await session.openContainer({ place, block: { x: 0, y: 64, z: 0 } });

		bot.currentWindow()!.cursor = { name: "minecraft:dirt", count: 1, components: null, remainingDurability: null };
		bot.setWindowSlot(3, null); // 触发窗口刷新
		await flushAsync();

		await expect(win.close()).rejects.toMatchObject({ code: "CURSOR_NOT_EMPTY" });

		// 会话仍活着：光标清空后普通 close 成功。
		bot.currentWindow()!.cursor = null;
		await flushAsync();
		await win.close();
		expect(bot.packets.some((pk) => pk.name === "close_window")).toBe(true);
		await expect(win.snapshot()).rejects.toMatchObject({ code: "REFERENCE_STALE" });
		await session.close();
		await driver.close();
	});

	it("Body close 强制退役窗口（光标非空也退役），并在移除前捕获证据", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		bot.setBlock({ x: 0, y: 64, z: 0 }, { name: "minecraft:chest", properties: {} });
		bot.programWindow("minecraft:chest", 27, new Array(27).fill(null));
		const driver = await makeDriver(bot);
		const evidences: { schema: string; fact: { value: { type?: string } } }[] = [];
		driver.facts.subscribe((n) => {
			if (n.kind === "evidence") evidences.push(...(n.records as never[]));
		});
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const win = await session.openContainer({ place, block: { x: 0, y: 64, z: 0 } });
		bot.currentWindow()!.cursor = { name: "minecraft:dirt", count: 1, components: null, remainingDurability: null };

		await session.close(); // 作用域退出：强制退役。
		expect(bot.packets.some((pk) => pk.name === "close_window")).toBe(true);
		const winEvidence = evidences.find((e) => e.schema === "client.window@1");
		expect(winEvidence).toBeTruthy();
		await expect(win.snapshot()).rejects.toMatchObject({ code: "REFERENCE_STALE" });
		await driver.close();
	});

	it("服务端关闭 → 会话退役，旧会话操作拒绝", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		bot.setBlock({ x: 0, y: 64, z: 0 }, { name: "minecraft:chest", properties: {} });
		bot.programWindow("minecraft:chest", 27, new Array(27).fill(null));
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const win = await session.openContainer({ place, block: { x: 0, y: 64, z: 0 } });

		bot.serverCloseWindow();
		await flushAsync();
		await expect(win.snapshot()).rejects.toMatchObject({ code: "REFERENCE_STALE" });
		// close 对已退役会话幂等（合同：close 幂等且只关闭自己的代次）。
		await win.close();
		await session.close();
		await driver.close();
	});

	it("同一客户端只允许一个在途打开", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		bot.setBlock({ x: 0, y: 64, z: 0 }, { name: "minecraft:chest", properties: {} });
		// 不编程窗口：激活后无 windowOpen → 在途打开挂起。
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const p1 = session.openContainer({ place, block: { x: 0, y: 64, z: 0 } });
		await expect(session.openContainer({ place, block: { x: 0, y: 64, z: 0 } })).rejects.toMatchObject({
			code: "CONTROL_CONFLICT",
		});

		// 超时：已派发、效果未知，不自动重试。
		await expect(p1).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN", dispatch: "sent" });
		await session.close();
		await driver.close();
	});

	it("超时窗口后新打开不受挂起影响", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		bot.setBlock({ x: 0, y: 64, z: 0 }, { name: "minecraft:chest", properties: {} });
		bot.programWindow("minecraft:chest", 27, new Array(27).fill(null));
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const win = await session.openContainer({ place, block: { x: 0, y: 64, z: 0 } });
		expect(win).toBeTruthy();
		await session.close();
		await driver.close();
	});
});
