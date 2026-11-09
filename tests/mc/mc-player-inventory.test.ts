import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, expect, test, vi } from "vitest";
import { BodySessionImpl } from "../../.uina/worlds/minecraft/driver/body/session.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";
import { protocolFor } from "../../.uina/worlds/minecraft/driver/mineflayer/protocol.js";

const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));
function harness(version = "1.21.11") {
	const bot = new EventEmitter() as EventEmitter & Record<string, any>;
	bot._client = new EventEmitter();
	bot.registry = mf("prismarine-registry")("1.21.11");
	bot.version = version;
	const Item = mf("prismarine-item")(bot.registry);
	const windows = mf("prismarine-windows")("1.21.11");
	bot.inventory = windows.createWindow(0, "minecraft:inventory", "Inventory");
	const server = windows.createWindow(0, "minecraft:inventory", "Inventory");
	server.updateSlot(9, new Item(bot.registry.itemsByName.dirt.id, 12));
	bot.currentWindow = null;
	bot.quickBarSlot = 0;
	bot.clearControlStates = () => {};
	bot.closeWindow = () => {};
	bot.toss = () => {
		throw new Error("native toss must not run");
	};
	bot.equip = () => {
		throw new Error("native equip must not run");
	};
	let serial = 0;
	let respond = true;
	let stopAfterResponse = Infinity;
	let responses = 0;
	let failAtWrite = Infinity;
	const writes: { slot: number; state: string }[] = [];
	const session = new BodySessionImpl(
		"body:inventory",
		{ kind: "run", run: "r", segment: "s", callId: "c" },
		{
			assertActionAllowed: () => {},
			host: { state: "ready", identity: { connection: "con", incarnation: "inc" }, on: () => () => {} },
			bot: () => bot as unknown as MineflayerBot,
			sampleSelf: () => null,
			sink: { record: () => ({ instance: "i", sequence: ++serial }), async ensureDurable() {} },
			mintOp: () => `op:${++serial}`,
			mintEff: () => `eff:${++serial}`,
			onClosed: () => {},
			deadEntities: () => new Set<number>(),
		},
	);
	protocolFor(bot as unknown as MineflayerBot);
	const full = () =>
		bot._client.emit("window_items", {
			windowId: 0,
			stateId: serial++,
			items: server.slots.map((item: unknown) => Item.toNotch(item)),
			carriedItem: Item.toNotch(server.selectedItem),
		});
	bot._client.write = (name: string, data: { slot: number; mouseButton: number }) => {
		if (name !== "window_click") return;
		writes.push({ slot: data.slot, state: session.sessionState });
		if (writes.length === failAtWrite) throw new Error("socket write failed");
		server.acceptClick({
			slot: data.slot,
			mouseButton: data.mouseButton,
			mode: 0,
			item: server.slots[data.slot] ?? null,
		});
		if (respond)
			queueMicrotask(() => {
				full();
				if (++responses === stopAfterResponse) void session.close();
			});
	};
	full();
	return {
		full,
		failWrite: (at: number) => {
			failAtWrite = at;
		},
		session,
		server,
		writes,
		respond: (value: boolean) => {
			respond = value;
		},
		stop: (after = 1) => {
			stopAfterResponse = after;
		},
	};
}
afterEach(() => vi.useRealTimers());
test("precise toss confirms removal and restores cursor remainder without native transfer", async () => {
	const h = harness();
	const result = await h.session.toss({ name: "dirt" }, 5);
	expect(result).toMatchObject({ receipt: { completion: "met" }, removed: { dirt: 5 }, remaining: 0 });
	expect(h.server.slots[9]?.count).toBe(7);
	expect(h.server.selectedItem).toBeNull();
	await h.session.close();
});
test("equip uses the same confirmed player slot path", async () => {
	const h = harness();
	expect((await h.session.equip({ name: "dirt" }, "hand")).completion).toBe("met");
	expect(h.server.slots[36]?.count).toBe(12);
	expect(h.server.slots[9]).toBeNull();
	await h.session.close();
});
test("cancel between confirmed source and drop never sends a late drop", async () => {
	const h = harness();
	h.stop();
	await expect(h.session.toss({ name: "dirt" }, 5)).rejects.toMatchObject({ name: "CallFailure" });
	expect(h.writes.map((write) => write.slot)).toEqual([9]);
	expect(h.writes.every((write) => write.state === "active")).toBe(true);
	await h.session.close();
});
test("missing server response cannot certify a removed stack", async () => {
	vi.useFakeTimers();
	const h = harness();
	h.respond(false);
	const pending = h.session.toss({ name: "dirt" }, 5).catch((error: unknown) => error);
	await vi.advanceTimersByTimeAsync(5100);
	expect(await pending).toMatchObject({ progress: { removed: {}, remaining: 5 } });
	expect(h.writes.map((write) => write.slot)).toEqual([9]);
	await expect(h.session.toss({ name: "dirt" }, 1)).rejects.toMatchObject({ code: "WRONG_STATE" });
	expect(() => h.full()).not.toThrow();
	expect(h.writes.map((write) => write.slot)).toEqual([9]);
	await h.session.close();
});
test("socket failure preserves confirmed removal progress and ambiguous dispatch", async () => {
	const h = harness();
	h.failWrite(3);
	await expect(h.session.toss({ name: "dirt" }, 5)).rejects.toMatchObject({
		name: "CallFailure",
		dispatch: "unknown",
		progress: { removed: { dirt: 1 }, remaining: 4 },
	});
	await h.session.close();
});
test("unsupported protocol fails admission before building an inventory session", async () => {
	const h = harness("1.21.4");
	await expect(h.session.equip({ name: "dirt" }, "hand")).rejects.toMatchObject({
		code: "UNSUPPORTED_PROTOCOL",
		dispatch: "not_sent",
	});
	expect(h.writes).toHaveLength(0);
	await h.session.close();
});
test("partial cancellation retains only confirmed removals and never compensates", async () => {
	const h = harness();
	h.stop(3);
	await expect(h.session.toss({ name: "dirt" }, 5)).rejects.toMatchObject({
		progress: { removed: { dirt: 1 }, remaining: 4 },
	});
	expect(h.writes.map((write) => write.slot)).toEqual([9, -999, -999]);
	await h.session.close();
});
