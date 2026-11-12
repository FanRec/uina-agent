import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WindowSession } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { CallContext } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { ClientWindowObservation } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type {
	ControlRetirement,
	DriverExecutionFact,
	DriverExecutionSink,
} from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { callFailure } from "../../.uina/worlds/minecraft/contracts/values.js";
import { PlayerPortImpl } from "../../.uina/worlds/minecraft/driver/body/player-port.js";
import { type BodySessionDeps, BodySessionImpl } from "../../.uina/worlds/minecraft/driver/body/session.js";
import { DriverControlArbiter } from "../../.uina/worlds/minecraft/driver/control-arbiter.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";
import { createProgramHost } from "../../.uina/worlds/minecraft/runtime/program-host.js";
import { captureFailure, ownerT, placeT } from "./mc-fake-driver.js";

const require = createRequire(import.meta.url);
const mfRequire = createRequire(require.resolve("mineflayer"));
const Item = mfRequire("prismarine-item")("1.21.11");
const windows = mfRequire("prismarine-windows")("1.21.11");
const target = { place: placeT(), block: { x: 0, y: 64, z: 0 } };
const empty = { item: null, count: 0 };
const stone = (count: number) => new Item(1, count);

function harness(
	autoTick = true,
	options: {
		type?: string;
		slots?: number;
		fullBeforeLayout?: boolean;
		entities?: Record<number, unknown>;
	} = {},
) {
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
	bot.entity = { position: { x: 0, y: 64, z: 1 }, eyeHeight: 1.62, yaw: 0, pitch: 0 };
	bot.entities = options.entities ?? {};
	bot.game = { dimension: "overworld" };
	bot.clearControlStates = () => {};
	bot.blockAt = () => ({ name: "chest", position: target.block, shapes: [[0, 0, 0, 1, 1, 1]] });
	bot.lookAt = async () => {
		if (autoTick) queueMicrotask(() => queueMicrotask(() => bot.emit("physicsTick")));
	};
	// 闸门转头的 look 在夹具里即时生效（窗口测试不测转向节奏，只测派发顺序）。
	bot.look = async (yaw: number, pitch: number) => {
		bot.entity.yaw = yaw;
		bot.entity.pitch = pitch;
	};
	bot.swingArm = () => {};
	// 闸门世界：只有容器一个方块，采样射线首命中即容器本身（§4.1 夹具口径）。
	bot.world = {
		raycast: async () => ({ x: target.block.x, y: target.block.y, z: target.block.z }),
	};
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
	const emitFull = (stateId: number, windowId = 1) =>
		client.emit("window_items", {
			windowId,
			stateId,
			items: contents.map((item) => Item.toNotch(item)),
			carriedItem: Item.toNotch(carried),
		});
	const full = (windowId = 1) => emitFull(state++, windowId);
	/** 模拟"迟到的初始 full"：stateId 不推进，不能归因到之后发出的 click。 */
	const fullWithState = (stateId: number, windowId = 1) => emitFull(stateId, windowId);
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
				if (options.fullBeforeLayout) {
					client.emit("open_window", { windowId: 1, inventoryType: 2 });
					full();
				}
				bot.currentWindow = windows.createWindow(1, windowType, "Chest");
				bot.emit("windowOpen", bot.currentWindow);
				if (!options.fullBeforeLayout) full();
			});
		}
		if (name === "window_click" && data.mode === 0 && accept) {
			// Server executes the business click. The client stays unchanged until a raw full sync.
			const previous = contents[data.slot];
			contents[data.slot] = carried;
			carried = previous;
		}
		if (name === "window_click" && respond) queueMicrotask(() => full(data.windowId));
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
			async ensureDurable() {},
		},
		mintOp: () => `op:${++serial}`,
		mintEff: () => `eff:${++serial}`,
		onClosed: () => {},
		deadEntities: () => new Set<number>(),
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
		fullWithState,
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

/**
 * 玩家自带窗口（windowId 0）靠协议层的 `window_items` 置位 `playerSynchronized`，
 * 而协议是**惰性挂接**的：没被任何操作创建之前的包不会被记录。所以先开再关一个容器
 * 把协议拉起来，再喂一份 window 0 的 full，才有"权威玩家库存"。
 */
async function primePlayerInventory(h: ReturnType<typeof harness>): Promise<void> {
	const window = await h.session.openContainer(target);
	await window.close();
	h.full(0);
}

afterEach(() => vi.useRealTimers());

describe("Driver window lifetime and server confirmation", () => {
	test("publishes the first authoritative snapshot when full arrives before the layout", async () => {
		const h = harness(true, { fullBeforeLayout: true });
		const window = await h.session.openContainer(target);
		expect(h.observations).toEqual([
			expect.objectContaining({
				target,
				snapshot: expect.objectContaining({
					slots: expect.arrayContaining([{ slot: 0, item: expect.objectContaining({ name: "stone", count: 8 }) }]),
				}),
			}),
		]);
		await window.close();
	});
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
	test("block activation follows the aim gate: blocked sight sends nothing, clear sight activates (§4.1)", async () => {
		const h = harness(false);
		// 隔墙：容器方块不可命中 → 派发前失败，没有任何写包。
		h.bot.world.raycast = async () => ({ x: 0, y: 65, z: 0 });
		const blocked = captureFailure(h.session.openContainer(target));
		await Promise.resolve();
		expect((await blocked).dispatch).toBe("not_sent");
		expect(h.writes.filter((write) => write.name === "block_place")).toHaveLength(0);
		await h.session.close();

		// 视线恢复：闸门通过 → 受控转头 → activate 携带真实命中面与 cursor。
		const h2 = harness(false);
		const window = await h2.session.openContainer(target);
		const place = h2.writes.find((write) => write.name === "block_place");
		expect(place?.data.location).toEqual(target.block);
		// 激活包携带真实命中点 cursor，不再默认顶面中心。
		expect(place?.data.cursorX).toBeTypeOf("number");
		await window.close();
		await h2.session.close();
	});

	test("aborting mid-aim leaves no packet and no lingering aim listeners", async () => {
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

	test("a stalled look send fails the open bounded without sending an interaction (§4.2)", async () => {
		vi.useFakeTimers();
		try {
			const h = harness(false);
			h.bot.look = () => new Promise<void>(() => {}); // 转头发送停滞（骑乘后停模拟形态）
			const opening = captureFailure(h.session.openContainer(target));
			await vi.advanceTimersByTimeAsync(1600);
			expect(await opening).toMatchObject({ code: "AIM_STALLED", dispatch: "not_sent" });
			expect(h.writes).toHaveLength(0);
			await h.session.close();
		} finally {
			vi.useRealTimers();
		}
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

	test("unsupported blocks are rejected before activation", async () => {
		const h = harness();
		// 批 15：附魔台/铁砧/砂轮/酿造台已经是受支持的窗口（layout.ts 的 opensWindow），
		// 真正该在派发前失败的是根本开不出窗口的方块。
		h.bot.blockAt = () => ({ name: "stone", position: target.block });
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

	test("an unchanged full cannot prove rejection: it stays unknown and is never retried", async () => {
		vi.useFakeTimers();
		const h = harness();
		const window = await h.session.openContainer(target);
		// 服务端不执行业务点击，但仍回权威 full。真服 SHELTER 证据表明：
		// 工作台窗口会先回一个"仅同步"的 full（内容不变），所以不能据此判拒绝。
		h.setAccept(false);
		const pending = window.click(await input(window));
		await vi.advanceTimersByTimeAsync(6000);
		const receipt = await pending;
		expect(receipt).toMatchObject({ dispatch: "sent", completion: "unknown", outcome: "unknown" });
		expect(receipt.diagnostics).toMatchObject({ slot: 0, button: 0, slotChanged: false, cursorChanged: false });
		expect(receipt.diagnostics?.recovery).toContain("no authoritative full");
		await h.session.close();
	});

	test("a delayed initial full with an older stateId cannot settle a dispatched click", async () => {
		vi.useFakeTimers();
		const h = harness();
		const window = await h.session.openContainer(target);
		h.setRespond(false);
		const pending = window.click(await input(window));
		// 迟到初始包：即使内容已经变化，stateId 倒退也不能归因到本次 click。
		h.fullWithState(0);
		await vi.advanceTimersByTimeAsync(6000);
		expect(await pending).toMatchObject({ dispatch: "sent", completion: "unknown", outcome: "unknown" });
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
		// 写前意图是真实异步屏障：等"包已发出"这个可观测事实，而不是猜 microtask 层数。
		await vi.waitFor(() => expect(h.writes.some((write) => write.name === "window_click")).toBe(true));
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
		// 写前意图是异步屏障：服务端回包不可能早于这次 click 真正发出。
		await vi.waitFor(() => expect(h.writes.filter((write) => write.name === "window_click")).toHaveLength(2));
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

	test("写前意图 ACK 丢失时窗口点击不发包，如实按 unknown 收口（C02）", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		const sink = h.deps.sink as DriverExecutionSink;
		sink.ensureDurable = async () => {
			throw new Error("sqlite ack lost");
		};
		await expect(window.click(await input(window))).rejects.toMatchObject({
			name: "CallFailure",
			code: "INTERNAL",
			dispatch: "unknown",
		});
		expect(h.writes.filter((write) => write.name === "window_click")).toHaveLength(0);
		// recorder 已故障：不能再追加一条看似已结算的事实，恢复侧只看到 intent，
		// 按 unknown 对账；任何"已结算"的假象都会让调用方误以为可以重放。
		expect(h.facts.filter((fact) => fact.contract === "body.window.click@1").map((fact) => fact.kind)).toEqual([
			"intent",
		]);
		await h.session.close();
	});

	test("写前意图没拿到 ACK 前绝不派发窗口点击包（端到端屏障时序）", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		const sink = h.deps.sink as DriverExecutionSink;
		let release!: () => void;
		sink.ensureDurable = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const pending = window.click(await input(window));
		const confirmed = expect(pending).resolves.toMatchObject({ dispatch: "sent", completion: "met" });
		await vi.waitFor(() => expect(h.facts.some((fact) => fact.kind === "intent")).toBe(true));
		await Promise.resolve();
		expect(h.writes.filter((write) => write.name === "window_click")).toHaveLength(0);
		release();
		await confirmed;
		expect(h.writes.filter((write) => write.name === "window_click")).toHaveLength(1);
		await h.session.close();
	});

	test("协议写端在发包瞬间抛错：包可能已发出，按 unknown 收口而非 not_sent", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		const original = h.client.write;
		h.client.write = (name: string, data: unknown) => {
			if (name === "window_click") throw new Error("socket write failed");
			return original(name, data);
		};
		await expect(window.click(await input(window))).rejects.toMatchObject({
			name: "CallFailure",
			dispatch: "unknown",
		});
		// intent 已持久、包未确认，不能追加"明确取消"的终态，也不能谎报已结算。
		expect(
			h.facts
				.filter((fact) => fact.contract === "body.window.click@1")
				.map((fact) => [fact.kind, fact.dispatch, fact.completion]),
		).toEqual([
			["intent", "unknown", "unknown"],
			["receipt", "unknown", "unknown"],
		]);
		await h.session.close();
	});

	test("revoke settles a pending click unknown; late response cannot publish or close a newer generation", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		h.setRespond(false);
		const pending = window.click(await input(window));
		// 写前意图是异步屏障：撤销要落在"包已派发之后"，才检验迟到回包的代次隔离。
		await vi.waitFor(() => expect(h.writes.filter((write) => write.name === "window_click")).toHaveLength(1));
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

	test("写前意图屏障期间被撤销：不发包，intent 由终态事实收口（C02/C09）", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		const sink = h.deps.sink as DriverExecutionSink;
		let release!: () => void;
		sink.ensureDurable = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const pending = window.click(await input(window));
		// 立刻挂上拒绝处理器，避免屏障解除瞬间的 unhandled rejection。
		const rejected = expect(pending).rejects.toMatchObject({ name: "CallFailure", dispatch: "not_sent" });
		// 节奏点（缺省 0ms）与屏障各隔微任务：自旋等 intent 落盘后再挂撤销。
		for (let i = 0; i < 50 && !h.facts.some((fact) => fact.kind === "intent"); i++) await Promise.resolve();
		expect(h.facts.some((fact) => fact.kind === "intent")).toBe(true);
		const closing = h.session.close();
		release();
		await rejected;
		await closing;
		expect(h.writes.filter((write) => write.name === "window_click")).toHaveLength(0);
		expect(
			h.facts
				.filter((fact) => fact.contract === "body.window.click@1")
				.map((fact) => [fact.kind, fact.dispatch, fact.completion]),
		).toEqual([
			["intent", "unknown", "unknown"],
			["cleanup", "not_sent", "not_met"],
		]);
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

/**
 * G34：每个不可安全重放的写端都必须先落写前意图，再发包。
 *
 * 这里钉的是驱动层的顺序与门槛，不是 Runtime 的记录格式（那由
 * mc-effect-intent 用真实 RecordQueue 证）。两个方向：
 * - 意图是这条 effect 的第一条事实，且早于 dispatch；
 * - intent 被 sink 拒收时一次包都不发，失败按 not_sent 收口。
 */
describe("G34 write ends record intent before dispatch", () => {
	const kindsOf = (facts: DriverExecutionFact[]) => facts.map((fact) => fact.kind);
	const entityRef = { connection: "conn:t1", incarnation: "inc:t1", appearance: "entity:zombie", networkId: 7 };

	test("block interaction records the intent before the placement packet", async () => {
		const h = harness();
		await h.session.interact({ target: target as never, hand: "main" });
		expect(kindsOf(h.facts)[0]).toBe("intent");
		expect(h.facts[0]).toMatchObject({ contract: "body.interact@1", dispatch: "unknown" });
		const dispatchAt = h.facts.findIndex((fact) => fact.kind === "dispatch");
		expect(dispatchAt).toBeGreaterThan(0);
		expect(h.writes.filter((write) => write.name === "block_place").length).toBeGreaterThan(0);
		await h.session.close();
	});

	test("using a held item records the intent before the activation packet", async () => {
		const h = harness();
		h.bot.heldItem = stone(1);
		await h.session.useItem("main");
		expect(kindsOf(h.facts)[0]).toBe("intent");
		expect(h.facts[0]).toMatchObject({ contract: "body.useItem@1" });
		expect(h.facts.findIndex((fact) => fact.kind === "dispatch")).toBeGreaterThan(0);
		await h.session.close();
	});

	test("attacking an entity records the intent before the swing", async () => {
		const h = harness();
		h.bot.entities = { 7: { id: 7, position: { x: 0, y: 64, z: 0 }, height: 1.8, name: "zombie" } };
		h.bot.attack = () => {};
		await h.session.attack(entityRef as never, { evidenceMs: 100 });
		expect(kindsOf(h.facts)[0]).toBe("intent");
		expect(h.facts[0]).toMatchObject({ contract: "body.attack@1" });
		expect(h.facts.findIndex((fact) => fact.kind === "receipt")).toBeGreaterThan(0);
		await h.session.close();
	});

	test("tossing records the intent before the first click and stays not_sent when it is refused", async () => {
		const h = harness();
		await primePlayerInventory(h);
		h.contents[12] = stone(3);
		h.full(0);
		await Promise.resolve();
		h.deps.sink.record = () => null;
		const failure = await captureFailure(h.session.toss({ name: "stone" }, 2));
		expect(failure).toMatchObject({ dispatch: "not_sent" });
		// sink 拒收 = 没有 intent = 确定没发：一个 window_click 都不许出去。
		expect(h.writes.filter((write) => write.name === "window_click")).toHaveLength(0);
		await h.session.close();
	});

	test("a workstation commit records the intent before the selection packet", async () => {
		const h = harness(true, { type: "minecraft:enchantment" });
		const window = await h.session.openContainer(target);
		// 打开窗口本身已经发过 block_place：这里只关心附魔包不许出去。
		const packetsBefore = h.writes.length;
		h.deps.sink.record = () => null;
		const failure = await captureFailure(window.selectEnchant(1));
		expect(failure).toMatchObject({ dispatch: "not_sent", code: "INTERNAL" });
		expect(h.writes.filter((write) => write.name === "enchant_item")).toHaveLength(0);
		expect(h.writes).toHaveLength(packetsBefore);
		// recorder 已故障：关窗也算写端，会被拒；这里只确认"故障之后不再出去任何包"。
		await window.close().catch(() => {});
		await h.session.close().catch(() => {});
	});
});

/**
 * 写前意图把"读快照"和"发包"之间插进了一次等盘。窗口前态检查（§7.7）不会替调用方
 * 续期——所以意图之后必须重新取快照，否则第一次点击必然拿旧 revision 撞 CONFLICT。
 * 这两条钉的就是这个缝隙。
 */
describe("G34 intent wait must not leave a stale pre-state behind", () => {
	test("a window that changes during the intent closes the effect instead of leaving only an intent", async () => {
		const h = harness(true, { type: "minecraft:enchantment" });
		const record = h.deps.sink.record;
		h.deps.sink.record = (fact) => {
			const ticket = record(fact);
			if (fact.kind === "intent") {
				// 意图期间窗口被退役：这一版不能再写包。
				h.bot.currentWindow = null;
			}
			return ticket;
		};
		const opening = await h.session.openContainer(target);
		await expect(opening.selectEnchant(1)).rejects.toMatchObject({ code: "REFERENCE_STALE" });
		const kinds = h.facts.map((fact) => `${fact.kind}:${fact.dispatch}:${fact.completion}`);
		expect(kinds).toContain("intent:unknown:unknown");
		expect(kinds.some((entry) => entry.startsWith("cleanup:not_sent:not_met"))).toBe(true);
		// 这条 effect 没有派发事实：只有 intent + 终态，恢复侧不会把它当"可能已发出"。
		const dispatchOfEffect = h.facts.filter(
			(fact) => fact.kind === "dispatch" && fact.contract.includes("selectEnchant"),
		);
		expect(dispatchOfEffect).toHaveLength(0);
	});
});

/**
 * 派发前态判据是"调用方声明的那几格 + 光标"，不是"这期间没有任何同步"。
 *
 * 真服上的形态：一次 equip/toss/craft 由多次点击组成，服务端对上一击的回执本身
 * 就会再推一次全量同步，玩家窗口的 revision 因此每击必涨——拿版本相等做准入会把
 * 正常的多次点击序列判成冲突（G36）。但"别人真动过窗口"仍然必须拦下，并且要说清
 * 差在哪一格。
 */
describe("G36 click pre-state is content, not sync count", () => {
	test("a sync that leaves the clicked slot and cursor alone does not block the click", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		const click = await input(window);
		// 别人往别处放了点东西：整窗 revision 前进，但这一击依赖的那格与光标没变。
		h.contents[10] = stone(2);
		h.full();
		const receipt = await window.click(click);
		expect(receipt).toMatchObject({ dispatch: "sent" });
		expect(h.writes.filter((write) => write.name === "window_click")).toHaveLength(1);
		await h.session.close();
	});

	test("the clicked slot moving is rejected before any packet and names the slot", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		const click = await input(window);
		h.contents[0] = stone(7);
		h.full();
		const failure = await captureFailure(window.click(click));
		expect(failure).toMatchObject({ code: "CONFLICT", dispatch: "not_sent" });
		expect(failure.message).toContain("slot 0");
		expect(failure.message).toContain("revision");
		expect(h.writes.filter((write) => write.name === "window_click")).toHaveLength(0);
		await h.session.close();
	});

	test("the cursor moving is rejected and names the cursor", async () => {
		const h = harness();
		const window = await h.session.openContainer(target);
		const first = await input(window);
		// 第一击把 8 块石头抓到光标上（服务端也会再推一次全量同步）。
		await window.click(first);
		const stale = first;
		h.contents[0] = stone(8);
		h.full();
		const failure = await captureFailure(window.click(stale));
		expect(failure).toMatchObject({ code: "CONFLICT" });
		expect(failure.message).toContain("cursor");
		await h.session.close();
	});

	test("the same holds for the player inventory window, where revision tracks every sync", async () => {
		const h = harness();
		await primePlayerInventory(h);
		h.contents[12] = stone(3);
		h.full(0);
		// withInventory 的作用域一返回窗口就退役，所以断言必须在作用域内部做。
		await h.session.withInventory(async (window) => {
			const snapshot = (await window.snapshot()).value;
			// 玩家窗口的 revision 每次 windowId=0 的全量同步都 +1：这里制造"只涨版本"。
			h.contents[20] = stone(1);
			h.full(0);
			const receipt = await window.click({
				slot: 12,
				button: 0,
				mode: 0,
				expectedRevision: snapshot.revision,
				expectedSlots: [{ slot: 12, stack: { item: { name: "stone" }, count: 3 } }],
				expectedCursor: empty,
			});
			expect(receipt).toMatchObject({ dispatch: "sent" });
		});
		await h.session.close();
	});
});

describe("实体交互与实体开窗（§4.1 实体）", () => {
	const ref = { connection: "conn:t1", incarnation: "inc:t1", appearance: "ap:7", networkId: 7 };
	// 工厂：换位用例会改实体位置，共享对象会让后续用例拿到被改过的坐标。
	const zombie = () => ({ id: 7, position: { x: 0, y: 64, z: 0.5 }, height: 1.8, width: 0.6 });
	const uses = (h: ReturnType<typeof harness>) => h.writes.filter((write) => write.name === "use_entity");

	test("a reachable merchant opens exactly one use_entity", async () => {
		const h = harness(true, { entities: { 7: zombie() } });
		h.bot.world.raycast = async () => null;
		const window = await h.session.openContainer(ref as never);
		expect(uses(h)).toHaveLength(1);
		await window.close();
	});

	test("an entity behind a wall is never activated", async () => {
		const h = harness(true, { entities: { 7: zombie() } });
		h.bot.world.raycast = async () => ({ x: 0, y: 65, z: 0 });
		const error = await captureFailure(h.session.openContainer(ref as never));
		expect(error).toMatchObject({ code: "UNREACHABLE", dispatch: "not_sent" });
		expect(uses(h)).toHaveLength(0);
	});

	test("an entity out of reach is never activated", async () => {
		const h = harness(true, { entities: { 7: { ...zombie(), position: { x: 0, y: 64, z: 5 } } } });
		h.bot.world.raycast = async () => null;
		const error = await captureFailure(h.session.openContainer(ref as never));
		expect(error).toMatchObject({ code: "UNREACHABLE", dispatch: "not_sent" });
		expect(uses(h)).toHaveLength(0);
	});

	test("an entity that moves out of reach while aiming is re-checked before activation", async () => {
		const h = harness(true, { entities: { 7: zombie() } });
		h.bot.world.raycast = async () => null;
		const original = h.bot.look;
		h.bot.look = async (yaw: number, pitch: number) => {
			await original(yaw, pitch);
			h.bot.entities[7].position = { x: 0, y: 64, z: 5 };
		};
		const error = await captureFailure(h.session.openContainer(ref as never));
		expect(error).toMatchObject({ code: "UNREACHABLE", dispatch: "not_sent" });
		expect(String(error.message)).toContain("target changed while aiming");
		expect(uses(h)).toHaveLength(0);
	});

	test("direct entity interact records intent before the activation packet", async () => {
		const h = harness(true, { entities: { 7: zombie() } });
		h.bot.world.raycast = async () => null;
		await h.session.interact({ target: ref as never, hand: "main" });
		expect(h.facts.filter((fact) => fact.contract === "body.interact@1").map((fact) => fact.kind)).toEqual([
			"intent",
			"dispatch",
			"receipt",
		]);
		expect(uses(h)).toHaveLength(1);
	});
});
