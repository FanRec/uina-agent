import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, expect, test, vi } from "vitest";
import type { LocalScreenActivity } from "../../.uina/worlds/minecraft/contracts/protocol.js";
import { BodySessionImpl } from "../../.uina/worlds/minecraft/driver/body/session.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";
import { protocolFor } from "../../.uina/worlds/minecraft/driver/mineflayer/protocol.js";

/**
 * 个人背包展示边界（addons.md §4.3）。
 *
 * 只断言一件事：**只有真正进入个人背包窗口事务**才产生一对 open/close。
 * 读库存、捡拾、快捷栏切换、原版容器窗口都不经过 withInventoryScope，因此不在这里出现。
 * open 返回 false（没有包接收）时不得补发 close——close 只能跟着一次真实提交走。
 */

const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));

interface HarnessOptions {
	/** 不接展示口，模拟旧 HostView / 未启用任何包。 */
	withEmit?: boolean;
	/** emitLocalScreen 的返回值；false 表示没有任何包提交了 Payload。 */
	accept?: boolean;
	/** 让 emitLocalScreen 记录后抛出，验证游戏结果不受影响。 */
	throwOnOpen?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const bot = new EventEmitter() as EventEmitter & Record<string, any>;
	bot._client = new EventEmitter();
	bot.registry = mf("prismarine-registry")("1.21.11");
	bot.version = "1.21.11";
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
	let stopAfterResponse = Number.POSITIVE_INFINITY;
	let responses = 0;
	const events: LocalScreenActivity[] = [];
	const host: Record<string, unknown> = {
		state: "ready",
		identity: { connection: "con", incarnation: "inc" },
		on: () => () => {},
	};
	if (options.withEmit !== false)
		host.emitLocalScreen = (event: LocalScreenActivity): boolean => {
			events.push(event);
			if (options.throwOnOpen === true && event.phase === "open") throw new Error("presentation blew up");
			return options.accept ?? true;
		};
	const session = new BodySessionImpl(
		"body:inventory",
		{ kind: "run", run: "r", segment: "s", callId: "c" },
		{
			assertActionAllowed: () => {},
			host: host as never,
			bot: () => bot as unknown as MineflayerBot,
			sampleSelf: () => null,
			sink: { record: () => ({ instance: "i", sequence: ++serial }) },
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
		session,
		events,
		full,
		respond: (value: boolean) => {
			respond = value;
		},
		stop: (after = 1) => {
			stopAfterResponse = after;
		},
	};
}

/** 一对 open/close 的形状断言。 */
function expectPair(events: LocalScreenActivity[]): void {
	expect(events.map((event) => event.phase)).toEqual(["open", "close"]);
	const [open, close] = events as [LocalScreenActivity, LocalScreenActivity];
	expect(open.kind).toBe("player_inventory");
	expect(open.session).toBe(close.session);
	expect(open.connection).toBe("con");
	expect(open.incarnation).toBe("inc");
}

afterEach(() => vi.useRealTimers());

test("equip 产生且只产生一对 open/close，引用同一次事务", async () => {
	const h = harness();
	expect((await h.session.equip({ name: "dirt" }, "hand")).completion).toBe("met");
	expectPair(h.events);
	await h.session.close();
});

test("toss 走同一条边界", async () => {
	const h = harness();
	await h.session.toss({ name: "dirt" }, 5);
	expectPair(h.events);
	await h.session.close();
});

test("withInventory（2×2 合成入口）也走这条边界", async () => {
	const h = harness();
	await h.session.withInventory(async () => undefined);
	expectPair(h.events);
	await h.session.close();
});

test("物品操作失败也收尾：超时未确认仍只有一对，且 close 不重复", async () => {
	vi.useFakeTimers();
	const h = harness();
	h.respond(false);
	const pending = h.session.toss({ name: "dirt" }, 5).catch((error: unknown) => error);
	await vi.advanceTimersByTimeAsync(5100);
	expect(await pending).toMatchObject({ progress: { removed: {}, remaining: 5 } });
	expectPair(h.events);
	await h.session.close();
	expectPair(h.events);
});

test("会话在事务中途被关闭也只收尾一次", async () => {
	const h = harness();
	h.stop();
	await expect(h.session.toss({ name: "dirt" }, 5)).rejects.toMatchObject({ name: "CallFailure" });
	expectPair(h.events);
});

test("并发事务被拒绝时，被拒的那次不产生任何展示事件", async () => {
	const h = harness();
	let release = (): void => {};
	const held = h.session.withInventory(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	await vi.waitFor(() => expect(h.events).toHaveLength(1));
	await expect(h.session.equip({ name: "dirt" }, "hand")).rejects.toMatchObject({ code: "CONTROL_CONFLICT" });
	expect(h.events.map((event) => event.phase)).toEqual(["open"]);
	release();
	await held;
	expectPair(h.events);
	await h.session.close();
});

test("没有包接收（emitLocalScreen 返回 false）时不补发 close", async () => {
	const h = harness({ accept: false });
	await h.session.equip({ name: "dirt" }, "hand");
	expect(h.events.map((event) => event.phase)).toEqual(["open"]);
	await h.session.close();
});

test("HostView 没有展示口时物品操作照常完成", async () => {
	const h = harness({ withEmit: false });
	expect((await h.session.equip({ name: "dirt" }, "hand")).completion).toBe("met");
	expect(h.events).toEqual([]);
	await h.session.close();
});

test("展示口抛出不影响物品操作的真实结果，但会留下诊断", async () => {
	const h = harness({ throwOnOpen: true });
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	expect((await h.session.equip({ name: "dirt" }, "hand")).completion).toBe("met");
	expect(h.events.map((event) => event.phase)).toEqual(["open"]);
	expect(warn).toHaveBeenCalledWith(expect.stringContaining("local screen open failed"));
	warn.mockRestore();
	await h.session.close();
});
