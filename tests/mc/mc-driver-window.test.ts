import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WindowSession } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { ClientWindowObservation } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { ControlRetirement, DriverExecutionFact } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { BodySessionImpl, type BodySessionDeps } from "../../.uina/worlds/minecraft/driver/body/session.js";
import { PlayerPortImpl } from "../../.uina/worlds/minecraft/driver/body/player-port.js";
import { DriverControlArbiter } from "../../.uina/worlds/minecraft/driver/control-arbiter.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";
import { captureFailure, ownerT, placeT } from "./mc-fake-driver.js";
import { callFailure } from "../../.uina/worlds/minecraft/contracts/values.js";
import { createProgramHost } from "../../.uina/worlds/minecraft/runtime/program-host.js";
import type { CallContext } from "../../.uina/worlds/minecraft/contracts/capabilities.js";

const require = createRequire(import.meta.url);
const mfRequire = createRequire(require.resolve("mineflayer"));
const Item = mfRequire("prismarine-item")("1.21.11");
const windows = mfRequire("prismarine-windows")("1.21.11");
const target = { place: placeT(), block: { x: 0, y: 64, z: 0 } };
const empty = { item: null, count: 0 };
const stone = (count: number) => new Item(1, count);

function harness(autoTick = true, options: { type?: string; slots?: number } = {}) {
	const windowType = options.type ?? "minecraft:generic_9x3";
	const bot = new EventEmitter() as EventEmitter & Record<string, any>;
	const client = new EventEmitter() as EventEmitter & Record<string, any>;
	const writes: { name: string; data: any }[] = [];
	const observations: (ClientWindowObservation | null)[] = [];
	const facts: DriverExecutionFact[] = [];
	bot._client = client;
	bot.currentWindow = null;
	bot.inventory = windows.createWindow(0, "minecraft:inventory", "Inventory");
	bot.registry = mfRequire("prismarine-registry")("1.21.11");
	bot.version = "1.21.11";
	bot.supportFeature = (name: string) => bot.registry.supportFeature(name);
	bot.entity = { position: { x: 0, y: 64, z: 1 }, eyeHeight: 1.62 };
	bot.game = { dimension: "overworld" };
	bot.clearControlStates = () => {};
	bot.blockAt = () => ({ name: "chest", position: target.block });
	bot.lookAt = async () => {
		if (autoTick) queueMicrotask(() => queueMicrotask(() => bot.emit("physicsTick")));
	};
	bot.swingArm = () => {};
	bot.closeWindow = (window: any) => {
		client.write("close_window", { windowId: window.id });
		bot.currentWindow = null;
		bot.emit("windowClose", window);
	};
	let state = 1;
	const contents = Array.from({ length: options.slots ?? 63 }, () => null as any);
	contents[0] = stone(8);
	let carried: any = null;
	let respond = true;
	let accept = true;
	const full = (windowId = 1) =>
		client.emit("window_items", {
			windowId,
			stateId: state++,
			items: contents.map((item) => Item.toNotch(item)),
			carriedItem: Item.toNotch(carried),
		});
	client.on("window_items", (packet) => {
		const window = bot.currentWindow;
		if (window?.id !== packet.windowId) return;
		packet.items.forEach((item: any, i: number) => window.updateSlot(i, Item.fromNotch(item)));
		window.selectedItem = Item.fromNotch(packet.carriedItem);
	});
	client.write = (name: string, data: any) => {
		writes.push({ name, data });
		if (name === "block_place" || name === "use_entity") {
			queueMicrotask(() => {
				bot.currentWindow = windows.createWindow(1, windowType, "Chest");
				bot.emit("windowOpen", bot.currentWindow);
				full();
			});
		}
		if (name === "window_click" && data.mode === 0 && accept) {
			// Server executes the business click. The client stays unchanged until a raw full sync.
			const previous = contents[data.slot];
			contents[data.slot] = carried;
			carried = previous;
		}
		if (name === "window_click" && respond) queueMicrotask(() => full());
	};
	let serial = 0;
	const deps: BodySessionDeps = {
		assertActionAllowed: () => {},
		host: { state: "ready", identity: { connection: "conn:t1", incarnation: "inc:t1" }, on: () => () => {} },
		bot: () => bot as unknown as MineflayerBot,
		sampleSelf: () => null,
		sink: {
			record: (fact) => {
				facts.push(fact);
				return { instance: "rw:test", sequence: facts.length };
			},
		},
		mintOp: () => `op:${++serial}`,
		mintEff: () => `eff:${++serial}`,
		onClosed: () => {},
		publishWindow: (observation) => observations.push(observation),
	};
	const session = new BodySessionImpl("body:window-test", ownerT(1), deps);
	return {
		deps,
		session,
		bot,
		client,
		writes,
		observations,
		facts,
		contents,
		full,
		setRespond: (value: boolean) => {
			respond = value;
		},
		setAccept: (value: boolean) => {
			accept = value;
		},
	};
}

async function input(window: WindowSession) {
	const snapshot = (await window.snapshot()).value;
	return {
		slot: 0,
		button: 0,
		mode: 0,
		expectedRevision: snapshot.revision,
		expectedSlots: [{ slot: 0, stack: { item: { name: "stone" }, count: 8 } }],
		expectedCursor: empty,
	};
}

afterEach(() => vi.useRealTimers());

describe("Driver window lifetime and server confirmation", () => {
	test("suspended parent window keeps server observations and can revalidate after delegation", async () => {
		const h = harness();
		let suspended = false;
		const window = await h.session.runScoped(
			{
				signal: new AbortController().signal,
				owner: ownerT(1),
				guard: () => {
					if (suspended)
						throw callFailure({
							code: "BODY_SUSPENDED",
							source: "capability",
							message: "delegated",
							dispatch: "not_sent",
							effects: [],
							recoverable: true,
						});
				},
			},
			() => h.session.openContainer(target),
		);
		suspended = true;
		h.contents[0] = stone(3);
		h.full();
		await expect(window.snapshot()).rejects.toMatchObject({ code: "BODY_SUSPENDED" });
		suspended = false;
		expect((await window.snapshot()).value.slots[0]?.item).toMatchObject({ name: "stone", count: 3 });
		await window.close();
		await h.session.close();
	});
	test("guest can use the same window handle to return a nonempty cursor after close is refused", async () => {
		const h = harness();
		const resources = new Set<() => Promise<void>>();
		const ctx = {
			signal: new AbortController().signal,
			world: { read: async () => ({ value: { place: placeT() } }) },
			withBody: async (work: Function) => work({ ...ctx, player: h.session }),
		} as unknown as CallContext;
		const host = createProgramHost(ctx, resources, () => undefined);
		const body = await host.acquireBody({});
		const window = (await host.handleOp({
			handle: body.handle,
			op: "openContainer",
			args: { target: { x: 0, y: 64, z: 0 } },
		})) as { handle: string };
		await host.handleOp({ handle: window.handle, op: "snapshot", args: {} });
		await host.handleOp({ handle: window.handle, op: "click", args: { slot: 0 } });
		await expect(host.closeHandle({ handle: window.handle })).rejects.toMatchObject({ code: "CURSOR_NOT_EMPTY" });
		await host.handleOp({ handle: window.handle, op: "click", args: { slot: 0 } });
		await host.closeHandle({ handle: window.handle });
		await host.releaseBody({ handle: body.handle });
		await h.session.close();
	});
	test("block activation waits for the actual physics step after look", async () => {
		const h = harness(false);
		const opening = h.session.openContainer(target);
		await Promise.resolve();
		expect(h.writes).toHaveLength(0);
		expect(h.bot.listenerCount("physicsTick")).toBe(1);
		h.bot.emit("physicsTick");
		const window = await opening;
		expect(h.writes.filter((write) => write.name === "block_place")).toHaveLength(1);
		expect(h.bot.listenerCount("physicsTick")).toBe(0);
		await window.close();
		await h.session.close();
	});

	test("aborting before the activation boundary removes the exact listeners and sends no packet", async () => {
		const h = harness(false);
		const opening = captureFailure(h.session.openContainer(target));
		await Promise.resolve();
		const closing = h.session.close();
		expect((await opening).dispatch).toBe("not_sent");
		await closing;
		h.bot.emit("physicsTick");
		expect(h.writes).toHaveLength(0);
		expect(h.bot.listenerCount("physicsTick")).toBe(0);
		expect(h.bot.listenerCount("end")).toBe(1); // connection protocol capture outlives this operation
		h.bot.emit("end", "test complete");
		expect(h.bot.listenerCount("end")).toBe(0);
	});

	test("a stalled pre-activation physics boundary times out without sending an interaction", async () => {
		vi.useFakeTimers();
		const h = harness(false);
		const opening = captureFailure(h.session.openContainer(target));
		await vi.advanceTimersByTimeAsync(2100);
		expect(await opening).toMatchObject({ code: "TIMEOUT", dispatch: "not_sent" });
		expect(h.writes).toHaveLength(0);
		expect(h.bot.listenerCount("physicsTick")).toBe(0);
		await h.session.close();
	});

	test("authoritative full content has stable regions and a click synchronizes without local prediction", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		const initial = await window.snapshot();
		expect(initial.source).toBe("server");
		expect(initial.value.layout.regions.map((region) => [region.name, region.slots.length])).toEqual([
			["container", 27],
			["player", 36],
		]);
		expect(initial.value.slots[0].item).toMatchObject({ name: "stone", count: 8, stackSize: 64 });
		const pending = window.click(await input(window));
		expect(h.bot.currentWindow.slots[0].count).toBe(8);
		expect(h.bot.currentWindow.selectedItem).toBe(null);
		const receipt = await pending;
		expect(receipt).toMatchObject({
			dispatch: "sent",
			completion: "met",
			needsSnapshot: false,
			confirmed: { cursor: { name: "stone", count: 8 } },
		});
		expect(receipt.confirmed?.slots[0]).toEqual({ slot: 0, item: null });
		expect(receipt.confirmed?.window).toBe(initial.value.window);
		expect(receipt.confirmed?.slots).toHaveLength(initial.value.layout.slotCount);
		expect(
			h.writes.filter((write) => write.name === "window_click").map((write) => [write.data.mode, write.data.stateId]),
		).toEqual([[0, -1]]);
		expect(h.bot.currentWindow.selectedItem.count).toBe(8);
		await window.close({ force: true });
		expect(h.observations.at(-1)).toBe(null);
		await h.session.close();
	});

	test("modern player inventory updates advance the matching player-region slot and revision", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		const before = (await window.snapshot()).value;
		h.client.emit("set_player_inventory", { slotId: 0, contents: Item.toNotch(stone(2)) });
		const after = (await window.snapshot()).value;
		expect(after.revision).toBeGreaterThan(before.revision);
		expect(after.slots[54].item).toMatchObject({ name: "stone", count: 2 });
		expect(h.bot.currentWindow.slots[54].count).toBe(2);
		h.client.emit("set_cursor_item", { contents: Item.toNotch(stone(3)) });
		expect((await window.snapshot()).value.cursor).toMatchObject({ name: "stone", count: 3 });
		expect(h.bot.currentWindow.selectedItem.count).toBe(3);
		await h.session.close();
	});

	test("cancellation during look prevents the later activation write", async () => {
		const h = harness();
		let release = () => {};
		h.bot.lookAt = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const pending = captureFailure(h.session.openContainer(target));
		const closing = h.session.close();
		release();
		expect((await pending).dispatch).toBe("not_sent");
		await closing;
		expect(h.writes).toHaveLength(0);
	});

	test("cancelled dispatched opening seals the connection when a late native window cannot be retired", async () => {
		const h = harness();
		const retirements: ControlRetirement[] = [];
		let onActivation = () => {};
		const activated = new Promise<void>((resolve) => {
			onActivation = resolve;
		});
		h.client.write = (name: string, data: unknown) => {
			h.writes.push({ name, data });
			if (name === "block_place") onActivation();
		};
		const port = new PlayerPortImpl({
			...h.deps,
			arbiter: new DriverControlArbiter(),
			mintBody: () => "body:late-open",
			requireRetirement: (notice) => retirements.push(notice),
		});
		const cancellation = new AbortController();
		const body = await port.acquire(ownerT(2), cancellation.signal);
		const pending = captureFailure(body.openContainer(target));
		await activated;
		expect(h.writes.some((write) => write.name === "block_place")).toBe(true);
		cancellation.abort();
		expect((await pending).dispatch).toBe("sent");
		await body.close();
		expect(retirements).toEqual([
			{ source: "driver", subject: "body:late-open", code: "CONTROL_ISOLATION_FAILED", detail: expect.any(String) },
		]);
		h.bot.currentWindow = windows.createWindow(1, "minecraft:generic_9x3", "Late response");
		h.bot.emit("windowOpen", h.bot.currentWindow);
		h.full();
		expect((await captureFailure(port.acquire(ownerT(3), new AbortController().signal))).code).toBe("CONTROL_INVALID");
		expect(h.observations).toEqual([null]);
	});

	test("unsupported workstation targets are rejected before activation", async () => {
		const h = harness();
		h.bot.blockAt = () => ({ name: "enchanting_table", position: target.block });
		expect((await captureFailure(h.session.openContainer(target))).code).toBe("UNSUPPORTED_WINDOW");
		expect(h.writes).toHaveLength(0);
		await h.session.close();
	});

	test("crafting table windows expose result and crafting regions", async () => {
		const h = harness(true, { type: "minecraft:crafting", slots: 46 });
		h.bot.blockAt = () => ({ name: "crafting_table", position: target.block });
		const window = await h.session.openContainer(target);
		const snapshot = (await window.snapshot()).value;
		expect(snapshot.type).toBe("minecraft:crafting");
		expect(snapshot.layout.regions.map((region) => region.name)).toEqual(["result", "crafting", "player"]);
		expect(snapshot.layout.regions.find((region) => region.name === "crafting")?.slots).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9,
		]);
		// 工作站窗口没有 container 区域：按 container 取格的调用方必须显式失败。
		expect(snapshot.layout.regions.some((region) => region.name === "container")).toBe(false);
		await window.close({ force: true });
		await h.session.close();
	});

	test("furnace progress packets keep the click revision unchanged", async () => {
		const h = harness(true, { type: "minecraft:furnace", slots: 39 });
		h.bot.blockAt = () => ({ name: "furnace", position: target.block });
		const window = await h.session.openContainer(target);
		const before = (await window.snapshot()).value;
		expect(before.layout.regions.map((region) => region.name)).toEqual(["input", "fuel", "result", "player"]);
		h.client.emit("craft_progress_bar", { windowId: 1, property: 2, value: 7 });
		const progressed = (await window.snapshot()).value;
		expect(progressed.properties).toEqual({ "2": 7 });
		expect(progressed.revision).toBe(before.revision);
		h.contents[0] = stone(3);
		h.full();
		expect((await window.snapshot()).value.revision).toBe(before.revision + 1);
		await window.close({ force: true });
		await h.session.close();
	});

	test("a pending click conflicts deterministically and reopened windows get a new Operation ref", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		const firstRef = (await window.snapshot()).value.window;
		h.setRespond(false);
		const click = await input(window);
		const pending = window.click(click);
		expect((await captureFailure(window.click(click))).code).toBe("CONTROL_CONFLICT");
		await window.close({ force: true });
		expect((await pending).completion).toBe("unknown");
		const reopened = await h.session.openContainer(target);
		expect((await reopened.snapshot()).value.window).not.toBe(firstRef);
		await h.session.close();
	});

	test("stale revisions and slot expectations reject before any click packet", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		const click = await input(window);
		h.contents[0] = stone(7);
		h.full();
		expect((await captureFailure(window.click(click))).code).toBe("CONFLICT");
		click.expectedRevision = (await window.snapshot()).value.revision;
		expect((await captureFailure(window.click(click))).code).toBe("CONFLICT");
		expect(h.writes.filter((write) => write.name === "window_click")).toHaveLength(0);
		await h.session.close();
	});

	test("click expectations must cover the touched slot and contain valid stack counts", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		const click = await input(window);
		expect((await captureFailure(window.click({ ...click, expectedSlots: [] }))).code).toBe("INVALID_INPUT");
		for (const count of [-1, 0.5]) {
			expect(
				(
					await captureFailure(
						window.click({ ...click, expectedSlots: [{ slot: 0, stack: { item: { name: "stone" }, count } }] }),
					)
				).code,
			).toBe("INVALID_INPUT");
		}
		expect((await captureFailure(window.click({ ...click, expectedCursor: { item: null, count: 1 } }))).code).toBe(
			"INVALID_INPUT",
		);
		expect(h.writes.filter((write) => write.name === "window_click")).toHaveLength(0);
		await window.close();
		await h.session.close();
	});

	test("ordinary close refuses a held cursor while explicit forced cleanup retires it", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		await window.click(await input(window));
		expect((await captureFailure(window.close())).code).toBe("CURSOR_NOT_EMPTY");
		expect(h.bot.currentWindow).not.toBe(null);
		await window.close({ force: true });
		expect(h.bot.currentWindow).toBe(null);
		expect(h.facts.at(-1)).toMatchObject({ contract: "body.window.close@1", completion: "unknown" });
		await h.session.close();
	});

	test("an unchanged full packet cannot prove rejection versus a delayed initial packet", async () => {
		vi.useFakeTimers();
		const h = harness();
		const window = await h.session.openContainer(target);
		h.setAccept(false);
		const pending = window.click(await input(window));
		await vi.advanceTimersByTimeAsync(6000);
		expect(await pending).toMatchObject({ dispatch: "sent", completion: "unknown", needsSnapshot: true });
		await h.session.close();
	});

	test("one forced-resync packet per click prevents a previous sync response settling the next click", async () => {
		const h = harness();
		let initial: unknown;
		h.client.once("window_items", (packet) => {
			initial = structuredClone(packet);
		});
		const window = await h.session.openContainer(target);
		h.setRespond(false);
		let settled = false;
		const first = window.click(await input(window)).then((value) => {
			settled = true;
			return value;
		});
		h.client.emit("window_items", initial);
		await Promise.resolve();
		expect(settled).toBe(false);
		h.full();
		expect((await first).completion).toBe("met");
		const value = (await window.snapshot()).value;
		const second = window.click({
			slot: 1,
			button: 0,
			mode: 0,
			expectedRevision: value.revision,
			expectedSlots: [{ slot: 1, stack: empty }],
			expectedCursor: { item: { name: "stone" }, count: 8 },
		});
		h.full();
		expect((await second).completion).toBe("met");
		expect(
			h.writes.filter((write) => write.name === "window_click").map((write) => [write.data.mode, write.data.stateId]),
		).toEqual([
			[0, -1],
			[0, -1],
		]);
		await h.session.close();
	});

	test("revoke settles a pending click unknown; late response cannot publish or close a newer generation", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		h.setRespond(false);
		const pending = window.click(await input(window));
		await h.session.close();
		expect(await pending).toMatchObject({ dispatch: "sent", completion: "unknown", needsSnapshot: true });
		const newer = windows.createWindow(1, "minecraft:generic_9x3", "New chest");
		h.bot.currentWindow = newer;
		const count = h.observations.length;
		h.full();
		await window.close();
		expect(h.bot.currentWindow).toBe(newer);
		expect(h.observations).toHaveLength(count);
		expect(h.client.listenerCount("window_items")).toBe(2);
		h.bot.emit("end", "test complete");
		expect(h.client.listenerCount("window_items")).toBe(1);
	});

	test("a newer native window invalidates an old handle even with the same network id", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		const click = await input(window);
		h.bot.currentWindow = windows.createWindow(1, "minecraft:generic_9x3", "Replacement");
		h.bot.emit("windowOpen", h.bot.currentWindow);
		expect((await captureFailure(window.click(click))).dispatch).toBe("not_sent");
		await window.close();
		expect(h.writes.filter((write) => write.name === "close_window")).toHaveLength(0);
		await h.session.close();
	});

	test("missing full server sync returns unknown and seals further clicks until a fresh snapshot", async () => {
		vi.useFakeTimers();
		const h = harness();
		const window = await h.session.openContainer(target);
		h.setRespond(false);
		const click = await input(window);
		const pending = window.click(click);
		await vi.advanceTimersByTimeAsync(6000);
		expect(await pending).toMatchObject({ completion: "unknown", needsSnapshot: true });
		expect((await captureFailure(window.click(click))).dispatch).toBe("not_sent");
		await h.session.close();
	});
});
