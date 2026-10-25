/**
 * craft@1 / smelt@1 的能力语义：配方选择、摆格、产物结算、失败面。
 *
 * 窗口用 mc-window-fixture 的 mode-0 小服务端：它只实现协议语义，产物规则由每个用例的
 * match/cook 决定。这样测的是"能力怎么摆、怎么点、怎么结算"，不是替身的玩法假设。
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { buildRegistryKnowledge, type RegistryLike } from "../../.uina/worlds/minecraft/driver/facts/knowledge.js";
import { failureOf, makeHarness, type HarnessState, type SlotFixture } from "./mc-capability-harness.js";
import { type FixtureStack, craftingWindow, furnaceWindow, stack, type WindowFixture } from "./mc-window-fixture.js";

const items = {
	oak_log: { id: 17, name: "oak_log", stackSize: 64 },
	oak_planks: { id: 36, name: "oak_planks", stackSize: 64 },
	stick: { id: 946, name: "stick", stackSize: 64 },
	crafting_table: { id: 332, name: "crafting_table", stackSize: 64 },
	iron_ingot: { id: 904, name: "iron_ingot", stackSize: 64 },
	raw_iron: { id: 903, name: "raw_iron", stackSize: 64 },
	iron_pickaxe: { id: 933, name: "iron_pickaxe", stackSize: 1 },
	furnace: { id: 334, name: "furnace", stackSize: 64 },
	coal: { id: 896, name: "coal", stackSize: 64 },
	dirt: { id: 2, name: "dirt", stackSize: 64 },
};

/** 小注册表：只放本文件需要的配方，形状与 minecraft-data 一致（shapeless 用 ingredients）。 */
const registry: RegistryLike = {
	version: { minecraftVersion: "1.21.11" },
	itemsByName: items,
	items: Object.fromEntries(Object.values(items).map((item) => [item.id, item])),
	blocksByName: {
		crafting_table: { id: 332, name: "crafting_table" },
		furnace: { id: 334, name: "furnace" },
	},
	blockLoot: {},
	entityLoot: {},
	entitiesByName: {},
	recipes: {
		36: [{ ingredients: [17], result: { id: 36, count: 4 } }],
		946: [{ inShape: [[36], [36]], result: { id: 946, count: 4 } }],
		332: [
			{
				inShape: [
					[36, 36],
					[36, 36],
				],
				result: { id: 332, count: 1 },
			},
		],
		933: [
			{
				inShape: [
					[904, 904, 904],
					[null, 946, null],
					[null, 946, null],
				],
				result: { id: 933, count: 1 },
			},
		],
	},
};
const knowledge = buildRegistryKnowledge(registry);

afterEach(() => vi.useRealTimers());

async function scheduled<T>(work: Promise<T>): Promise<T> {
	const [value] = await Promise.all([work, vi.runAllTimersAsync()]);
	return value;
}

function countsOf(slots: { name: string; count: number }[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const slot of slots) counts[slot.name] = (counts[slot.name] ?? 0) + slot.count;
	return counts;
}

function stateOf(player: Record<number, FixtureStack>): HarnessState {
	const slots: SlotFixture[] = Object.entries(player).map(([slot, item]) => ({
		slot: Number(slot),
		name: item.name,
		count: item.count,
	}));
	return { blocks: new Map(), inventory: { slots, counts: countsOf(slots), selectedSlot: 0 } };
}

/** 玩家区的窗口槽号与 inventory@1 的槽号（9..44）不一定相同：按区域起点折算。 */
function fixturePlayer(player: Record<number, FixtureStack>, regionStart: number): Record<number, FixtureStack> {
	const out: Record<number, FixtureStack> = {};
	for (const [slot, item] of Object.entries(player)) out[Number(slot) + (regionStart - 9)] = item;
	return out;
}

/** 把窗口玩家区同步回 inventory@1：能力的产物核验依赖它，不能只看窗口。 */
function sync(state: HarnessState, window: WindowFixture): void {
	const region = window.layout.regions.find((entry) => entry.name === "player")?.slots ?? [];
	const slots: SlotFixture[] = [];
	region.forEach((slot, index) => {
		const item = window.item(slot);
		if (item != null) slots.push({ slot: 9 + index, name: item.name, count: item.count });
	});
	state.inventory = { slots, counts: countsOf(slots), selectedSlot: 0 };
}

const oneLog = (grid: (FixtureStack | null)[]): FixtureStack | null =>
	grid.filter((item) => item != null).length === 1 && grid[0]?.name === "oak_log" ? stack("oak_planks", 4) : null;

const twoSticks = (grid: (FixtureStack | null)[]): FixtureStack | null =>
	grid[0]?.name === "oak_planks" && grid[2]?.name === "oak_planks" ? stack("stick", 4) : null;

const pickaxe = (grid: (FixtureStack | null)[]): FixtureStack | null =>
	grid[0]?.name === "iron_ingot" &&
	grid[1]?.name === "iron_ingot" &&
	grid[2]?.name === "iron_ingot" &&
	grid[4]?.name === "stick" &&
	grid[7]?.name === "stick"
		? stack("iron_pickaxe", 1)
		: null;

describe("craft@1", () => {
	test("手持 2×2：8 个木板按两批做出，产物与消耗以库存差值为准", async () => {
		const player = { 9: stack("oak_log", 8) };
		const state = stateOf(player);
		let window: WindowFixture | undefined;
		const harness = makeHarness(state, {
			knowledge,
			inventoryWindow: () =>
				(window = craftingWindow("hand", {
					player: fixturePlayer(player, 9),
					match: oneLog,
					onChange: (fixture) => sync(state, fixture),
				})),
		});
		const value = (await harness.callable("craft@1").invoke(harness.ctx, {
			item: "oak_planks",
			count: 8,
		})) as { crafted: number; produced: Record<string, number>; consumed: Record<string, number>; remaining: number };
		expect(value.crafted).toBe(8);
		expect(value.produced).toEqual({ oak_planks: 8 });
		expect(value.consumed).toEqual({ oak_log: 2 });
		expect(value.remaining).toBe(0);
		expect(window?.closed).toBe(1);
	});

	test("3×3：有工作台就走工作台窗口，摆出镐子图案", async () => {
		const player = { 9: stack("iron_ingot", 3), 10: stack("stick", 2) };
		const state = stateOf(player);
		state.blocks.set("11,64,10", { name: "crafting_table", properties: {} });
		let window: WindowFixture | undefined;
		const harness = makeHarness(state, {
			knowledge,
			openWindow: () =>
				(window = craftingWindow("table", {
					player: fixturePlayer(player, 10),
					match: pickaxe,
					onChange: (fixture) => sync(state, fixture),
				})),
		});
		const value = (await harness.callable("craft@1").invoke(harness.ctx, {
			item: "iron_pickaxe",
			count: 1,
		})) as { crafted: number; consumed: Record<string, number>; at: { position: { x: number; y: number; z: number } } };
		expect(value.crafted).toBe(1);
		expect(value.consumed).toEqual({ iron_ingot: 3, stick: 2 });
		expect(value.at.position).toEqual({ x: 11, y: 64, z: 10 });
		expect(harness.calls).toContain("openContainer");
		expect(window?.closed).toBe(1);
	});

	test("缺料在取身体之前失败，并给出差额", async () => {
		const state = stateOf({ 9: stack("stick", 2) });
		const harness = makeHarness(state, { knowledge });
		const failure = await failureOf(
			harness.callable("craft@1").invoke(harness.ctx, { item: "iron_pickaxe", count: 1 }),
		);
		expect(failure.code).toBe("MISSING_MATERIAL");
		expect(failure.dispatch).toBe("not_sent");
		expect(harness.bodyAcquired()).toBe(0);
		expect(failure.hint).toContain("iron_ingot x3");
	});

	test("3×3 配方既没有工作台也没有材料时是 MISSING_TOOL", async () => {
		const state = stateOf({ 9: stack("iron_ingot", 3), 10: stack("stick", 2) });
		const harness = makeHarness(state, { knowledge });
		const failure = await failureOf(
			harness.callable("craft@1").invoke(harness.ctx, { item: "iron_pickaxe", count: 1 }),
		);
		expect(failure.code).toBe("MISSING_TOOL");
		expect(harness.bodyAcquired()).toBe(0);
	});

	test("点击回执未知时立即失败且不重放", async () => {
		const player = { 9: stack("oak_log", 8) };
		const state = stateOf(player);
		let window: WindowFixture | undefined;
		const harness = makeHarness(state, {
			knowledge,
			inventoryWindow: () => {
				window = craftingWindow("hand", {
					player: fixturePlayer(player, 9),
					match: oneLog,
					onChange: (fixture) => sync(state, fixture),
				});
				window.unknownFrom = 2;
				return window;
			},
		});
		const failure = await failureOf(harness.callable("craft@1").invoke(harness.ctx, { item: "oak_planks", count: 4 }));
		expect(failure.code).toBe("TARGET_NOT_MET");
		expect(window?.clicks).toBe(3);
	});

	test("没有熔炼以外的配方时报 NOT_FOUND", async () => {
		const state = stateOf({ 9: stack("dirt", 1) });
		const harness = makeHarness(state, { knowledge });
		const failure = await failureOf(harness.callable("craft@1").invoke(harness.ctx, { item: "dirt", count: 1 }));
		expect(failure.code).toBe("NOT_FOUND");
	});
});

describe("smelt@1", () => {
	const furnaceAt = { x: 11, y: 64, z: 10 };

	function smeltHarness(
		player: Record<number, FixtureStack>,
		cook: (input: FixtureStack) => { name: string; count: number } | null,
		ticksPerPoll = 200,
	) {
		const state = stateOf(player);
		state.blocks.set("11,64,10", { name: "furnace", properties: {} });
		let window: WindowFixture | undefined;
		const harness = makeHarness(state, {
			knowledge,
			// 同一个炉子跨调用复用：wait:false 之后还要用 transfer@1 取产物。
			openWindow: () =>
				(window ??= furnaceWindow({
					player: fixturePlayer(player, 3),
					cook,
					ticksPerPoll,
					onChange: (fixture) => sync(state, fixture),
				})),
		});
		return { harness, state, window: () => window };
	}

	const rawIronToIngot = (input: FixtureStack) => (input.name === "raw_iron" ? { name: "iron_ingot", count: 1 } : null);

	test("wait:true 装料、等产物、取回，并按库存结算", async () => {
		vi.useFakeTimers();
		const { harness, window } = smeltHarness({ 9: stack("raw_iron", 3), 10: stack("coal", 1) }, rawIronToIngot);
		const value = (await scheduled(
			harness.callable("smelt@1").invoke(harness.ctx, {
				item: "iron_ingot",
				count: 3,
				fuel: "coal",
				at: furnaceAt,
				maxTimeMs: 120000,
			}),
		)) as {
			produced: Record<string, number>;
			consumed: { input: { item: string; count: number }; fuel: { item: string; count: number } };
		};
		expect(value.produced).toEqual({ iron_ingot: 3 });
		expect(value.consumed.input).toEqual({ item: "raw_iron", count: 3 });
		expect(value.consumed.fuel).toEqual({ item: "coal", count: 1 });
		expect(window()?.closed).toBeGreaterThanOrEqual(2);
	});

	test("wait:false 只下料并给出复查提示，不假装产物已到手", async () => {
		const { harness, window } = smeltHarness({ 9: stack("raw_iron", 3), 10: stack("coal", 1) }, rawIronToIngot);
		const value = (await harness.callable("smelt@1").invoke(harness.ctx, {
			item: "iron_ingot",
			count: 3,
			fuel: "coal",
			at: furnaceAt,
			wait: false,
		})) as {
			loaded: { input: { item: string; count: number }; fuel: { item: string; count: number } };
			readyAt: string;
			hint: string;
		};
		expect(value.loaded.input).toEqual({ item: "raw_iron", count: 3 });
		expect(value.loaded.fuel).toEqual({ item: "coal", count: 1 });
		expect(value.readyAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(value.hint).toContain("transfer@1");
		expect(window()?.closed).toBe(1);
		// 料在炉里，产物还没进背包
		expect(window()?.item(0)?.name).toBe("raw_iron");
	});

	test("燃料燃烧刻数未知时拒绝，而不是瞎等", async () => {
		const { harness, window } = smeltHarness({ 9: stack("raw_iron", 3), 10: stack("dirt", 1) }, rawIronToIngot);
		const failure = await failureOf(
			harness.callable("smelt@1").invoke(harness.ctx, { item: "iron_ingot", count: 3, fuel: "dirt", at: furnaceAt }),
		);
		expect(failure.code).toBe("MISSING_MATERIAL");
		expect(window()).toBeUndefined();
		expect(harness.bodyAcquired()).toBe(0);
	});

	test("炉子烧不出目标物时以 TARGET_NOT_MET 结束，而不是拖到超时", async () => {
		vi.useFakeTimers();
		const { harness } = smeltHarness({ 9: stack("raw_iron", 3), 10: stack("coal", 1) }, () => null, 400);
		const failure = await scheduled(
			failureOf(
				harness.callable("smelt@1").invoke(harness.ctx, {
					item: "iron_ingot",
					count: 3,
					fuel: "coal",
					at: furnaceAt,
					maxTimeMs: 600000,
				}),
			),
		);
		expect(failure.code).toBe("TARGET_NOT_MET");
		expect(failure.dispatch).toBe("sent");
	});

	test("没有可烧的原料时报 MISSING_MATERIAL 并列出候选", async () => {
		const { harness } = smeltHarness({ 10: stack("coal", 1) }, rawIronToIngot);
		const failure = await failureOf(
			harness.callable("smelt@1").invoke(harness.ctx, { item: "iron_ingot", count: 1, at: furnaceAt }),
		);
		expect(failure.code).toBe("MISSING_MATERIAL");
		expect(failure.hint).toContain("raw_iron");
	});

	test("wait:false 之后用 container@1 看进度、transfer@1 取产物；往炉子里塞料被拒绝", async () => {
		const { harness, window } = smeltHarness({ 9: stack("raw_iron", 3), 10: stack("coal", 1) }, rawIronToIngot);
		await harness.callable("smelt@1").invoke(harness.ctx, {
			item: "iron_ingot",
			count: 3,
			fuel: "coal",
			at: furnaceAt,
			wait: false,
		});
		// 熔炉按轮询推进：手动让它烧完
		for (let i = 0; i < 6; i++) await window()?.snapshot();
		const contents = (await harness.callable("container@1").invoke(harness.ctx, { at: furnaceAt })) as {
			type: string;
			slots: { region: string; slot: number; name: string; count: number }[];
		};
		expect(contents.type).toBe("minecraft:furnace");
		expect(contents.slots).toContainEqual({ region: "result", slot: 2, name: "iron_ingot", count: 3 });

		const taken = (await harness.callable("transfer@1").invoke(harness.ctx, {
			from: { position: furnaceAt, dimension: "overworld" },
			item: "iron_ingot",
			count: 3,
		})) as { moved: Record<string, number> };
		expect(taken.moved).toEqual({ iron_ingot: 3 });

		const refusal = await failureOf(
			harness.callable("transfer@1").invoke(harness.ctx, {
				to: { position: furnaceAt, dimension: "overworld" },
				item: "raw_iron",
				count: 1,
			}),
		);
		expect(refusal.code).toBe("WRONG_STATE");
		expect(refusal.dispatch).toBe("not_sent");
	});
});

describe("stick 的手持配方", () => {
	test("1×2 图案落在 2×2 网格的第一列", async () => {
		const player = { 9: stack("oak_planks", 4) };
		const state = stateOf(player);
		let window: WindowFixture | undefined;
		const harness = makeHarness(state, {
			knowledge,
			inventoryWindow: () =>
				(window = craftingWindow("hand", {
					player: fixturePlayer(player, 9),
					match: twoSticks,
					onChange: (fixture) => sync(state, fixture),
				})),
		});
		const value = (await harness.callable("craft@1").invoke(harness.ctx, {
			item: "stick",
			count: 4,
		})) as { crafted: number; consumed: Record<string, number> };
		expect(value.crafted).toBe(4);
		expect(value.consumed).toEqual({ oak_planks: 2 });
		expect(window?.closed).toBe(1);
	});
});

describe("craft confirmed progress and destination space", () => {
	function craftHarness(player: Record<number, FixtureStack>, match = oneLog) {
		const state = stateOf(player);
		const window = craftingWindow("hand", { player, match, onChange: (value) => sync(state, value) });
		const harness = makeHarness(state, { knowledge, inventoryWindow: () => window });
		return { state, window, ...harness };
	}
	function full(player: Record<number, FixtureStack>): Record<number, FixtureStack> {
		return Object.fromEntries(
			Array.from({ length: 36 }, (_, index) => [index + 9, player[index + 9] ?? stack("dirt", 64)]),
		);
	}

	test("consuming the last log frees the output slot in a full inventory", async () => {
		const h = craftHarness(full({ 9: stack("oak_log", 1) }));
		const result = await h.callable("craft@1").invoke(h.ctx, { item: "oak_planks", count: 4 });
		expect(result).toMatchObject({ crafted: 4, consumed: { oak_log: 1 }, remaining: 0 });
		expect(h.state.inventory.counts.oak_planks).toBe(4);
	});

	test("output fills multiple compatible partial stacks", async () => {
		const h = craftHarness(
			full({ 9: stack("stick", 62), 10: stack("stick", 62), 11: stack("oak_planks", 64) }),
			twoSticks,
		);
		const result = await h.callable("craft@1").invoke(h.ctx, { item: "stick", count: 4 });
		expect(result).toMatchObject({ crafted: 4, produced: { stick: 4 } });
		expect(h.window.item(9)?.count).toBe(64);
		expect(h.window.item(10)?.count).toBe(64);
		expect(h.window.cursor).toBeNull();
	});

	test("output skips a same-name stack with incompatible components", async () => {
		const special = { ...stack("stick", 1), components: { custom_name: "keep" } };
		const h = craftHarness(full({ 9: special, 10: stack("stick", 1), 11: stack("oak_planks", 64) }), twoSticks);
		await h.callable("craft@1").invoke(h.ctx, { item: "stick", count: 4 });
		expect(h.window.item(9)).toEqual(special);
		expect(h.window.item(10)?.count).toBe(5);
		expect(h.window.cursor).toBeNull();
	});

	test("cancellation after one batch keeps confirmed production and consumption", async () => {
		const h = craftHarness({ 9: stack("oak_log", 8) });
		const abort = new AbortController();
		const ctx = {
			...h.ctx,
			signal: abort.signal,
			progress: async (value: unknown) => {
				if ((value as { crafted: number }).crafted === 4) abort.abort();
			},
		};
		const error = await failureOf(h.callable("craft@1").invoke(ctx, { item: "oak_planks", count: 8 }));
		expect(error).toMatchObject({
			code: "INTERRUPTED",
			dispatch: "sent",
			progress: { crafted: 4, produced: { oak_planks: 4 }, consumed: { oak_log: 1 }, remaining: 4 },
		});
	});

	test("unknown output placement keeps confirmed consumption but never claims the cursor as inventory", async () => {
		const h = craftHarness({ 9: stack("oak_log", 1) });
		h.window.unknownFrom = 3;
		const error = await failureOf(h.callable("craft@1").invoke(h.ctx, { item: "oak_planks", count: 4 }));
		expect(error).toMatchObject({
			dispatch: "unknown",
			progress: { crafted: 0, produced: {}, consumed: { oak_log: 1 }, remaining: 4 },
		});
		expect(h.window.clicks).toBe(4);
	});
});
