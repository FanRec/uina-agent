import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { protocolFor } from "../../.uina/worlds/minecraft/driver/mineflayer/protocol.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";
import { matchesItem } from "../../.uina/worlds/minecraft/contracts/items.js";
import type { ItemValue } from "../../.uina/worlds/minecraft/contracts/body.js";
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
