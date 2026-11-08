import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import type { ItemValue } from "../../.uina/worlds/minecraft/contracts/body.js";
import { matchesItem } from "../../.uina/worlds/minecraft/contracts/items.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";
import { protocolFor } from "../../.uina/worlds/minecraft/driver/mineflayer/protocol.js";

const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));
function bot(version = "1.21.11") {
	const b = new EventEmitter() as EventEmitter & Record<string, any>;
	b._client = new EventEmitter();
	b._client.write = () => {};
	b.version = version;
	b.registry = mf("prismarine-registry")(version);
	return b as unknown as MineflayerBot;
}
test("a connection owns one adapter, unsupported versions reject writes", () => {
	const b = bot();
	expect(protocolFor(b)).toBe(protocolFor(b));
	expect(() => protocolFor(bot("1.21.4")).startDig({ x: 0, y: 64, z: 0 }, 1)).toThrowError(/1.21.4/);
});
test("only real full server contents create a player snapshot; end retires capture", () => {
	const b = bot();
	const protocol = protocolFor(b);
	expect(protocol.playerSnapshot()).toBeNull();
	const Item = mf("prismarine-item")(b.registry);
	b._client.emit("window_items", {
		windowId: 0,
		stateId: 1,
		items: Array.from({ length: 46 }, (_, slot) => Item.toNotch(slot === 9 ? new Item(1, 3) : null)),
		carriedItem: Item.toNotch(null),
	});
	expect(protocol.playerSnapshot()?.slots[9]?.item).toMatchObject({ name: "stone", count: 3 });
	b.emit("end", "review");
	expect(protocol.playerSnapshot()).toBeNull();
});
test("late closed-window player slots remain authoritative until replacement", () => {
	const b = bot();
	const p = protocolFor(b);
	const Item = mf("prismarine-item")(b.registry);
	const windows = mf("prismarine-windows")("1.21.11");
	const stack = (count: number) => Item.toNotch(new Item(b.registry.itemsByName.dirt.id, count));
	b._client.emit("window_items", {
		windowId: 0,
		items: Array.from({ length: 46 }, (_, i) => (i === 9 ? stack(12) : Item.toNotch(null))),
		carriedItem: Item.toNotch(null),
	});
	const closed = windows.createWindow(7, "minecraft:generic_9x3", "Chest");
	b.currentWindow = closed;
	b.emit("windowOpen", closed);
	b.currentWindow = null;
	b.emit("windowClose", closed);
	b._client.emit("set_slot", { windowId: 7, slot: 27, item: stack(7) });
	expect(p.playerSnapshot()?.slots[9]?.item).toMatchObject({ count: 7 });
	b._client.emit("window_items", {
		windowId: 7,
		items: Array.from({ length: 63 }, (_, i) => (i === 27 ? stack(5) : Item.toNotch(null))),
		carriedItem: Item.toNotch(null),
	});
	expect(p.playerSnapshot()?.slots[9]?.item).toMatchObject({ count: 5 });
	b._client.emit("open_window", { windowId: 8 });
	b.currentWindow = windows.createWindow(8, "minecraft:generic_9x3", "Replacement");
	b._client.emit("set_slot", { windowId: 7, slot: 27, item: stack(1) });
	expect(p.playerSnapshot()?.slots[9]?.item).toMatchObject({ count: 5 });
	b.emit("end", "test complete");
});
test("current item components override registry stack and durability defaults", () => {
	const b = bot();
	const p = protocolFor(b);
	const wire = (name: string, components: unknown[], removeComponents: unknown[] = []) => ({
		itemCount: 1,
		itemId: b.registry.itemsByName[name].id,
		components,
		removeComponents,
	});
	const pickaxe = p.decode(
		wire("iron_pickaxe", [
			{ type: "max_damage", data: 50 },
			{ type: "damage", data: 40 },
		]),
	) as unknown as ItemValue;
	expect(pickaxe.durability).toBe(10);
	expect(matchesItem({ name: "iron_pickaxe", minDurability: 100 }, pickaxe)).toBe(false);
	expect(p.decode(wire("dirt", [{ type: "max_stack_size", data: 16 }]))).toMatchObject({ stackSize: 16 });
	expect(p.decode(wire("iron_pickaxe", [], ["max_damage"]))).toMatchObject({ durability: null });
	b.emit("end", "test complete");
});
test("trade_list resolves item ids to registry names and keeps both payment items", () => {
	const b = bot();
	const p = protocolFor(b);
	const notices: { kind: string; offers?: unknown[] }[] = [];
	p.subscribe((notice) => notices.push(notice as never));
	const id = (name: string) => b.registry.itemsByName[name].id;
	b._client.emit("trade_list", {
		windowId: 9,
		trades: [
			{
				inputItem1: { itemId: id("emerald"), itemCount: 3 },
				outputItem: { itemCount: 6, itemId: id("bread") },
				tradeDisabled: false,
				nbTradeUses: 1,
				maximumNbTradeUses: 12,
				xp: 2,
			},
			{
				inputItem1: { itemId: id("emerald"), itemCount: 1 },
				inputItem2: { itemId: id("dirt"), itemCount: 4 },
				outputItem: { itemCount: 1, itemId: id("apple") },
				tradeDisabled: true,
				nbTradeUses: 0,
				maximumNbTradeUses: 0,
				xp: 0,
			},
			// 空产物槽：itemCount=0 即空，不编造物品名。
			{ inputItem1: { itemId: id("emerald"), itemCount: 1 }, outputItem: { itemCount: 0 } },
		],
	});
	const trades = notices.find((notice) => notice.kind === "trades") as unknown as {
		windowId: number;
		offers: unknown[];
	};
	expect(trades.windowId).toBe(9);
	expect(trades.offers).toEqual([
		{
			index: 0,
			cost: [{ item: "emerald", count: 3 }],
			output: { item: "bread", count: 6 },
			disabled: false,
			uses: 1,
			maxUses: 12,
			xp: 2,
		},
		{
			index: 1,
			cost: [
				{ item: "emerald", count: 1 },
				{ item: "dirt", count: 4 },
			],
			output: { item: "apple", count: 1 },
			disabled: true,
			uses: 0,
			maxUses: 0,
			xp: 0,
		},
		{
			index: 2,
			cost: [{ item: "emerald", count: 1 }],
			output: { item: "unknown", count: 0 },
			disabled: false,
			uses: 0,
			maxUses: 0,
			xp: 0,
		},
	]);
	b.emit("end", "test complete");
});
test("workstation selects write their own packets and reject nothing locally", () => {
	const b = bot();
	const p = protocolFor(b);
	const windows = mf("prismarine-windows")("1.21.11");
	const window = windows.createWindow(9, "minecraft:merchant", "Villager");
	const writes: [string, unknown][] = [];
	b._client.write = (name: string, payload: unknown) => writes.push([name, payload]);
	// enchant_item 的 enchantment 是 0..2 的档位下标；name_item 不带 windowId；select_trade 的 slot 是报价下标。
	p.selectEnchant(window, 2);
	p.renameItem("Excalibur");
	p.selectTrade(1);
	expect(writes).toEqual([
		["enchant_item", { windowId: 9, enchantment: 1 }],
		["name_item", { name: "Excalibur" }],
		["select_trade", { slot: 1 }],
	]);
	b.emit("end", "test complete");
});
test("custom payload channels are declared before the first write (server only replies to declared channels)", () => {
	const b = bot();
	const writes: [string, unknown][] = [];
	const client = b._client as unknown as { state?: string };
	client.state = "connecting";
	b._client.write = (name: string, payload: unknown) => writes.push([name, payload]);
	const p = protocolFor(b);
	p.registerChannels(["uina:example"]);
	// attach 早于 login：登记排队，不在错误协议阶段写入。
	expect(writes).toEqual([]);
	client.state = "play";
	b._client.emit("login");
	expect(writes).toEqual([
		["custom_payload", { channel: "minecraft:register", data: Buffer.from("uina:example\0", "utf8") }],
	]);
	writes.length = 0;
	p.customPayload("uina:example", "{}");
	// 已登记：只发业务负载，不重复注册；未登记通道会在发送前补注册。
	expect(writes).toEqual([["custom_payload", { channel: "uina:example", data: Buffer.from("{}", "utf8") }]]);
	expect(() => p.customPayload("Not A Channel", "x")).toThrowError(/ResourceLocation/);
	b.emit("end", "test complete");
});
test("registration failure stays pending and is retried before the payload", () => {
	const b = bot();
	const writes: [string, unknown][] = [];
	(b._client as unknown as { state?: string }).state = "play";
	let failing = true;
	b._client.write = (name: string, payload: unknown) => {
		if (failing) throw new Error("socket closed");
		writes.push([name, payload]);
	};
	const p = protocolFor(b);
	expect(() => p.customPayload("uina:example", "{}")).toThrowError(/socket closed/);
	// 上一次没写出去：通道仍留在 pending，下一次先补注册再发业务负载。
	failing = false;
	p.customPayload("uina:example", "{}");
	expect(writes).toHaveLength(2);
	expect(writes[0]?.[1]).toMatchObject({ channel: "minecraft:register" });
	expect(writes[1]?.[1]).toMatchObject({ channel: "uina:example" });
	b.emit("end", "test complete");
});
test("G7 slot marks keep per-slot last-changed revisions and retire with the connection", () => {
	const b = bot();
	(b as unknown as { inventory: EventEmitter }).inventory = new EventEmitter();
	const p = protocolFor(b);
	const Item = mf("prismarine-item")(b.registry);
	const stack = (name: string, count: number) => Item.toNotch(new Item(b.registry.itemsByName[name].id, count));
	const full = (specials: Record<number, ReturnType<typeof stack>>) =>
		Array.from({ length: 46 }, (_, slot) => specials[slot] ?? Item.toNotch(null));
	// 首次同步：无前值，全部槽位标记为当前 revision。
	b._client.emit("window_items", {
		windowId: 0,
		items: full({ 9: stack("stone", 3) }),
		carriedItem: Item.toNotch(null),
	});
	expect(p.playerSnapshot()?.revision).toBe(1);
	expect(p.playerSlotMarks()).toEqual(Array.from({ length: 46 }, () => 1));
	// 相同内容的全量重同步：revision 前进，标记不动（差量不会误报全库）。
	b._client.emit("window_items", {
		windowId: 0,
		items: full({ 9: stack("stone", 3) }),
		carriedItem: Item.toNotch(null),
	});
	expect(p.playerSnapshot()?.revision).toBe(2);
	expect(p.playerSlotMarks()?.[9]).toBe(1);
	// 单槽写入：revision 与该槽标记一起推进；光标推进 revision 但不算槽位变更。
	b._client.emit("set_cursor_item", { contents: Item.toNotch(null) });
	expect(p.playerSnapshot()?.revision).toBe(3);
	expect(p.playerSlotMarks()?.[9]).toBe(1);
	b._client.emit("set_slot", { windowId: 0, slot: 9, item: stack("stone", 5) });
	expect(p.playerSnapshot()?.revision).toBe(4);
	expect(p.playerSlotMarks()?.[9]).toBe(4);
	expect(p.playerSlotMarks()?.[10]).toBe(1);
	b.emit("end", "test complete");
	expect(p.playerSlotMarks()).toBeNull();
});
