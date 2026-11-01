/**
 * 工作站五动作的能力语义（批 15）：brew / enchant / anvil / grindstone / trade。
 *
 * 窗口仍用 mc-window-fixture 的 mode-0 小服务端，布局直接取真实的 `windowLayout()`——
 * 这样"槽位语义"和"能力怎么摆、怎么提交、怎么结算"一起被覆盖，而不是各写一份。
 * 服务端反应由每个用例的 hook 给出（附魔生效、铁砧出结果、商人填付款槽），
 * 能力必须靠这些观察证明完成，不能靠自己的返回值自证。
 */

import { describe, expect, test } from "vitest";
import type { ItemValue } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { windowLayout } from "../../.uina/worlds/minecraft/driver/window/layout.js";
import { failureOf, makeHarness, type HarnessState, type SlotFixture } from "./mc-capability-harness.js";
import { type FixtureStack, stack, WindowFixture } from "./mc-window-fixture.js";

function layoutOf(type: string, slotCount: number, invStart: number, invEnd: number) {
	const result = windowLayout(type, slotCount, invStart, invEnd);
	if (!("layout" in result)) throw new Error(result.reason);
	return result.layout;
}

const LAYOUT = {
	brewing_stand: layoutOf("minecraft:brewing_stand", 41, 5, 40),
	enchantment: layoutOf("minecraft:enchantment", 38, 2, 37),
	anvil: layoutOf("minecraft:anvil", 39, 3, 38),
	grindstone: layoutOf("minecraft:grindstone", 39, 3, 38),
	merchant: layoutOf("minecraft:merchant", 39, 3, 38),
};

/** 组件形状照真服实测：{added:[{type,data}], removed:[]}。 */
const components = (entries: { type: string; data: JsonValue }[]): JsonValue => ({ added: entries, removed: [] });
const potion = (potionId: number): JsonValue =>
	components([{ type: "potion_contents", data: { potionId, customEffects: [] } }]);
const enchanted = (levels: { id: number; level: number }[]): JsonValue =>
	components([{ type: "enchantments", data: { enchantments: levels } }]);
const named = (value: string): JsonValue => components([{ type: "custom_name", data: { type: "string", value } }]);

function countsOf(slots: { name: string; count: number }[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const slot of slots) counts[slot.name] = (counts[slot.name] ?? 0) + slot.count;
	return counts;
}

/** inventory@1 的替身要带组件：水瓶判定、附魔查询、耐久比较都读它。 */
function stateOf(player: Record<number, FixtureStack>, blocks: Record<string, string> = {}): HarnessState {
	const slots: SlotFixture[] = Object.entries(player).map(([slot, item]) => ({
		slot: Number(slot),
		name: item.name,
		count: item.count,
		...(item.components == null ? {} : { components: item.components }),
		...(item.durability == null ? {} : { durability: item.durability }),
	}));
	const map = new Map<string, { name: string; properties: Record<string, string> } | null>();
	for (const [where, name] of Object.entries(blocks)) {
		const [x, y, z] = where.split(",").map(Number) as [number, number, number];
		map.set(`${x},${y},${z}`, { name, properties: {} });
	}
	return { blocks: map, inventory: { slots, counts: countsOf(slots), selectedSlot: 0 } };
}

/** 玩家区槽号与 inventory@1 槽号（9..44）按区域起点折算。 */
function fixturePlayer(player: Record<number, FixtureStack>, regionStart: number): Record<number, FixtureStack> {
	const out: Record<number, FixtureStack> = {};
	for (const [slot, item] of Object.entries(player)) out[Number(slot) + (regionStart - 9)] = item;
	return out;
}

function sync(state: HarnessState, window: WindowFixture): void {
	const region = window.layout.regions.find((entry) => entry.name === "player")?.slots ?? [];
	const slots: SlotFixture[] = [];
	region.forEach((slot, index) => {
		const item = window.item(slot);
		if (item != null)
			slots.push({
				slot: 9 + index,
				name: item.name,
				count: item.count,
				...(item.components == null ? {} : { components: item.components }),
				...(item.durability == null ? {} : { durability: item.durability }),
			});
	});
	state.inventory = { slots, counts: countsOf(slots), selectedSlot: 0 };
}

function fixture(
	type: keyof typeof LAYOUT,
	player: Record<number, FixtureStack>,
	state: HarnessState,
	hooks: ConstructorParameters<typeof WindowFixture>[3] = {},
): WindowFixture {
	const layout = LAYOUT[type];
	const slots: (FixtureStack | null)[] = Array.from({ length: layout.slotCount }, () => null);
	const regionStart = layout.regions.find((entry) => entry.name === "player")?.slots[0] ?? 0;
	for (const [slot, item] of Object.entries(fixturePlayer(player, regionStart))) slots[Number(slot)] = item;
	return new WindowFixture(
		type === "brewing_stand"
			? "minecraft:brewing_stand"
			: type === "enchantment"
				? "minecraft:enchantment"
				: type === "anvil"
					? "minecraft:anvil"
					: type === "grindstone"
						? "minecraft:grindstone"
						: "minecraft:merchant",
		layout,
		slots,
		{
			...hooks,
			afterClick: (window, slot, button) => {
				hooks.afterClick?.(window, slot, button);
				sync(state, window);
			},
		},
	);
}

describe("brew@1", () => {
	/** 药水不堆叠：几瓶就占几个槽，这样 count 才是"瓶数"而不是"槽数"。 */
	const bottles = (count: number): Record<number, FixtureStack> => {
		const out: Record<number, FixtureStack> = {};
		for (let index = 0; index < count; index++)
			out[9 + index] = { name: "potion", count: 1, stackSize: 1, components: potion(0) };
		out[12] = stack("nether_wart", 3);
		out[13] = stack("blaze_powder", 3);
		return out;
	};

	test("三瓶水 + 地狱疣：组件真的变号后才算产出，且把瓶子取回", async () => {
		const player = bottles(3);
		const state = stateOf(player, { "11,64,10": "brewing_stand" });
		let window: WindowFixture | undefined;
		let polls = 0;
		const harness = makeHarness(state, {
			openWindow: () => {
				window = fixture("brewing_stand", player, state, {
					beforeSnapshot: (w) => {
						// 只在料都放好之后推进：第 3 次快照起服务端报"酿好了"。
						const ready = w.item(3) != null && w.item(4) != null;
						if (!ready) return;
						if (++polls < 3) return;
						for (const slot of [0, 1, 2]) {
							const item = w.item(slot);
							if (item != null) w.set(slot, { ...item, components: potion(3) });
						}
					},
				});
				return window;
			},
		});
		const value = (await harness.callable("brew@1").invoke(harness.ctx, {
			potion: "awkward",
			ingredient: "nether_wart",
			count: 3,
		})) as { produced: Record<string, number>; consumed: { bottle: { count: number } }; observedPotionIds: number[] };
		expect(value.produced).toEqual({ awkward: 3 });
		expect(value.observedPotionIds).toEqual([3, 3, 3]);
		expect(value.consumed.bottle.count).toBe(3);
		expect(state.inventory.counts.nether_wart).toBe(2);
		expect(window?.closed).toBe(1);
	});

	test("没有水瓶在拿身体之前失败", async () => {
		const state = stateOf(
			{ 9: stack("glass_bottle", 3), 10: stack("nether_wart", 1) },
			{ "11,64,10": "brewing_stand" },
		);
		const harness = makeHarness(state, { openWindow: () => fixture("brewing_stand", {}, state) });
		const failure = await failureOf(
			harness.callable("brew@1").invoke(harness.ctx, { potion: "awkward", ingredient: "nether_wart" }),
		);
		expect(failure.code).toBe("MISSING_MATERIAL");
		expect(harness.bodyAcquired()).toBe(0);
	});

	test("酿造台里已经有成品时明确拒绝，不混装", async () => {
		const player = bottles(3);
		const state = stateOf(player, { "11,64,10": "brewing_stand" });
		const harness = makeHarness(state, {
			openWindow: () => {
				const window = fixture("brewing_stand", player, state);
				window.set(0, { name: "potion", count: 1, stackSize: 1, components: potion(7) });
				return window;
			},
		});
		const failure = await failureOf(
			harness.callable("brew@1").invoke(harness.ctx, { potion: "awkward", ingredient: "nether_wart", count: 1 }),
		);
		expect(failure.code).toBe("WRONG_STATE");
	});

	test("wait:false 只装料，不宣称已产出", async () => {
		const player = bottles(2);
		const state = stateOf(player, { "11,64,10": "brewing_stand" });
		const harness = makeHarness(state, {
			openWindow: () => fixture("brewing_stand", player, state),
		});
		const value = (await harness.callable("brew@1").invoke(harness.ctx, {
			potion: "awkward",
			ingredient: "nether_wart",
			count: 2,
			wait: false,
		})) as { loaded: { bottle: { count: number } }; readyAt: string };
		expect(value.loaded.bottle.count).toBe(2);
		expect(typeof value.readyAt).toBe("string");
	});
});

describe("enchant@1", () => {
	const player = (lapis: number): Record<number, FixtureStack> => ({
		9: stack("diamond_sword", 1),
		10: stack("lapis_lazuli", lapis),
		11: { name: "enchanting_table", count: 1 },
	});

	test("自动挑最高可负担档，报告服务端实际给出的附魔与费用", async () => {
		const inventory = player(8);
		const state = stateOf(inventory, { "11,64,10": "enchanting_table" });
		let window: WindowFixture | undefined;
		const harness = makeHarness(state, {
			self: { xpLevel: 30 },
			openWindow: () => {
				window = fixture("enchantment", inventory, state, {
					beforeSnapshot: (w) => {
						// 三档等级要求只有放了物品才算：1 / 6 / 0（第三档本次不可用）。
						w.properties = w.item(0) == null ? {} : { "0": 1, "1": 6, "2": 0, "3": -30985 };
					},
					afterSelect: (w, kind) => {
						if (kind !== "enchant") return;
						const item = w.item(0);
						if (item != null) w.set(0, { ...item, components: enchanted([{ id: 33, level: 1 }]) });
						const lapis = w.item(1);
						if (lapis != null) w.set(1, lapis.count > 1 ? { ...lapis, count: lapis.count - 2 } : null);
					},
				});
				return window;
			},
		});
		const value = (await harness.callable("enchant@1").invoke(harness.ctx, { item: "diamond_sword" })) as {
			enchantments: { name: string; level: number }[];
			cost: number;
			item: string;
		};
		expect(value.enchantments).toEqual([{ name: "sharpness", level: 1 }]);
		expect(value.cost).toBe(6);
		expect(value.item).toBe("diamond_sword");
		expect(window?.selections).toEqual([{ kind: "enchant", value: 2 }]);
		expect(window?.closed).toBe(1);
	});

	test("等级不够时在派发前失败，并报出三档价格", async () => {
		const inventory = player(8);
		const state = stateOf(inventory, { "11,64,10": "enchanting_table" });
		const harness = makeHarness(state, {
			openWindow: () =>
				fixture("enchantment", inventory, state, {
					beforeSnapshot: (w) => {
						w.properties = w.item(0) == null ? {} : { "0": 1, "1": 6, "2": 0 };
					},
				}),
		});
		const failure = await failureOf(harness.callable("enchant@1").invoke(harness.ctx, { item: "diamond_sword" }));
		expect(failure.code).toBe("MISSING_MATERIAL");
		expect(failure.hint).toContain("1/6/0");
	});

	test("只有已附魔的成品时明确拒绝（附魔台不会给已附魔物品出档位）", async () => {
		const inventory = {
			9: { name: "diamond_sword", count: 1, stackSize: 1, components: enchanted([{ id: 33, level: 1 }]) },
			10: stack("lapis_lazuli", 8),
		};
		const state = stateOf(inventory, { "11,64,10": "enchanting_table" });
		const harness = makeHarness(state, { self: { xpLevel: 30 } });
		const failure = await failureOf(harness.callable("enchant@1").invoke(harness.ctx, { item: "diamond_sword" }));
		expect(failure.code).toBe("WRONG_STATE");
		expect(failure.hint).toContain("anvil@1");
		expect(harness.bodyAcquired()).toBe(0);
	});
});

describe("anvil@1", () => {
	test("改名：结果槽物品带 custom_name，费用取窗口属性", async () => {
		const inventory = { 9: stack("diamond_sword", 1) };
		const state = stateOf(inventory, { "11,64,10": "anvil" });
		let window: WindowFixture | undefined;
		const harness = makeHarness(state, {
			self: { xpLevel: 30 },
			openWindow: () => {
				window = fixture("anvil", inventory, state, {
					afterSelect: (w, kind, value) => {
						if (kind !== "rename" || typeof value !== "string") return;
						w.set(2, { name: "diamond_sword", count: 1, stackSize: 1, components: named(value) });
						w.properties = { "0": 1 };
					},
				});
				return window;
			},
		});
		const value = (await harness.callable("anvil@1").invoke(harness.ctx, {
			operation: "rename",
			base: "diamond_sword",
			name: "Excalibur",
		})) as { result: { name: string; enchantments: unknown }; cost: number };
		expect(value.result.name).toBe("Excalibur");
		expect(value.result.enchantments).toBe(null);
		expect(value.cost).toBe(1);
		expect(window?.selections).toEqual([{ kind: "rename", value: "Excalibur" }]);
	});

	test("合并没给材料 / 改名没给名字都在派发前拒绝", async () => {
		const inventory = { 9: stack("diamond_sword", 1) };
		const state = stateOf(inventory, { "11,64,10": "anvil" });
		const harness = makeHarness(state, { self: { xpLevel: 30 } });
		expect(
			(
				await failureOf(
					harness.callable("anvil@1").invoke(harness.ctx, { operation: "combine", base: "diamond_sword" }),
				)
			).code,
		).toBe("INVALID_INPUT");
		expect(
			(await failureOf(harness.callable("anvil@1").invoke(harness.ctx, { operation: "rename", base: "diamond_sword" })))
				.code,
		).toBe("INVALID_INPUT");
		expect(harness.bodyAcquired()).toBe(0);
	});

	test("不可合并时按结果槽为空如实失败", async () => {
		const inventory = { 9: stack("diamond_sword", 1), 10: stack("emerald", 1) };
		const state = stateOf(inventory, { "11,64,10": "anvil" });
		const harness = makeHarness(state, {
			self: { xpLevel: 30 },
			openWindow: () => fixture("anvil", inventory, state),
		});
		const failure = await failureOf(
			harness
				.callable("anvil@1")
				.invoke(harness.ctx, { operation: "combine", base: "diamond_sword", material: "emerald" }),
		);
		expect(failure.code).toBe("TARGET_NOT_MET");
	});
});

describe("grindstone@1", () => {
	test("报告被移除的附魔与修复量，xp 保持未知", async () => {
		const inventory = {
			9: {
				name: "diamond_sword",
				count: 1,
				stackSize: 1,
				components: enchanted([{ id: 33, level: 2 }]),
				durability: 1500,
			},
		};
		const state = stateOf(inventory, { "11,64,10": "grindstone" });
		let window: WindowFixture | undefined;
		const harness = makeHarness(state, {
			openWindow: () => {
				window = fixture("grindstone", inventory, state, {
					beforeSnapshot: (w) => {
						const input = w.item(0);
						if (input == null) return;
						w.set(2, { name: "diamond_sword", count: 1, stackSize: 1, components: undefined, durability: 1561 });
					},
				});
				return window;
			},
		});
		const value = (await harness.callable("grindstone@1").invoke(harness.ctx, { item: "diamond_sword" })) as {
			repaired: number;
			removedEnchantments: { name: string; level: number }[];
			xp: null;
		};
		expect(value.removedEnchantments).toEqual([{ name: "sharpness", level: 2 }]);
		expect(value.repaired).toBe(61);
		expect(value.xp).toBe(null);
	});

	test("没有附魔也没有磨损的物品在取身体之前失败", async () => {
		const state = stateOf({ 9: { name: "diamond_sword", count: 1, stackSize: 1 } }, { "11,64,10": "grindstone" });
		const harness = makeHarness(state);
		expect(
			(await failureOf(harness.callable("grindstone@1").invoke(harness.ctx, { item: "diamond_sword" }))).code,
		).toBe("MISSING_MATERIAL");
		expect(harness.bodyAcquired()).toBe(0);
	});
});

describe("trade@1", () => {
	const merchantRef = {
		connection: "c:1",
		incarnation: "i:1",
		appearance: "ap:42",
		networkId: 42,
	};
	const offers = [
		{
			index: 0,
			cost: [{ item: "emerald", count: 1 }],
			output: { item: "bread", count: 1 },
			disabled: false,
			uses: 0,
			maxUses: 12,
			xp: 1,
		},
		{
			index: 1,
			cost: [{ item: "emerald", count: 3 }],
			output: { item: "apple", count: 2 },
			disabled: false,
			uses: 4,
			maxUses: 4,
			xp: 1,
		},
	];

	/** 商人窗口替身：选完交易由服务端搬付款、填结果；取货后扣款并把产品放进背包。 */
	function merchantHarness(
		inventory: Record<number, FixtureStack>,
		window: (state: HarnessState) => WindowFixture,
	): { harness: ReturnType<typeof makeHarness>; state: HarnessState } {
		const state = stateOf(inventory);
		state.entities = [
			{
				ref: merchantRef,
				name: "villager",
				kind: "passive",
				position: { x: 11, y: 64, z: 10 },
				distance: 1,
				item: null,
			},
		];
		return { harness: makeHarness(state, { openWindow: () => window(state) }), state };
	}

	test("按产物挑报价：付款与产出都按服务端结果结算", async () => {
		const inventory = { 9: stack("emerald", 8) };
		let window: WindowFixture | undefined;
		const { harness, state } = merchantHarness(inventory, (world) => {
			window = fixture("merchant", inventory, world, {
				afterSelect: (w, kind, value) => {
					if (kind !== "trade" || typeof value !== "number") return;
					const offer = offers[value] as (typeof offers)[number];
					// 服务端把整摞付款搬进付款槽（从背包移出），并把结果槽填好。
					const player = w.layout.regions.find((region) => region.name === "player")?.slots ?? [];
					const paidSlot = player.find((entry) => w.item(entry)?.name === "emerald");
					const paidCount = paidSlot == null ? 0 : (w.item(paidSlot) as FixtureStack).count;
					if (paidSlot != null) w.set(paidSlot, null);
					w.set(0, { name: "emerald", count: paidCount, stackSize: 64 });
					w.set(2, { name: offer.output.item, count: offer.output.count, stackSize: 64 });
				},
				afterClick: (w, slot) => {
					// 只在结果槽真的有货时结算一次（同一槽位的后续点击不应重复记账）。
					if (slot !== 2 || w.item(2) == null) return;
					// 取货：付款槽清空（付款已收敛成正好一份），产物进背包。
					w.set(0, null);
					w.set(2, null);
					const player = w.layout.regions.find((region) => region.name === "player")?.slots ?? [];
					const free = player.find((entry) => w.item(entry) == null);
					if (free != null) w.set(free, { name: "bread", count: 1, stackSize: 64 });
				},
			});
			window.offersValue = offers;
			return window;
		});
		const value = (await harness.callable("trade@1").invoke(harness.ctx, { item: "bread" })) as {
			traded: { item: string; count: number }[];
			cost: Record<string, number>;
		};
		expect(value.traded).toEqual([{ item: "bread", count: 1 }]);
		expect(value.cost).toEqual({ emerald: 1 });
		expect(window?.selections).toEqual([{ kind: "trade", value: 0 }]);
		expect(window?.closed).toBe(1);
		expect(state.inventory.counts.emerald).toBe(7);
		expect(state.inventory.counts.bread).toBe(1);
	});

	test("报价用完/锁定的明确拒绝，且不派发选择", async () => {
		const inventory = { 9: stack("emerald", 8) };
		let window: WindowFixture | undefined;
		const { harness } = merchantHarness(inventory, (world) => {
			window = fixture("merchant", inventory, world);
			window.offersValue = offers;
			return window;
		});
		const failure = await failureOf(harness.callable("trade@1").invoke(harness.ctx, { offer: 2 }));
		expect(failure.code).toBe("WRONG_STATE");
		expect(window?.selections).toEqual([]);
	});

	test("付不起价时在选交易之前失败", async () => {
		const inventory = {};
		let window: WindowFixture | undefined;
		const { harness } = merchantHarness(inventory, (world) => {
			window = fixture("merchant", inventory, world);
			window.offersValue = offers;
			return window;
		});
		const failure = await failureOf(harness.callable("trade@1").invoke(harness.ctx, { item: "bread" }));
		expect(failure.code).toBe("MISSING_MATERIAL");
		expect(window?.selections).toEqual([]);
	});

	test("附近没有商人时如实 NOT_FOUND", async () => {
		const state = stateOf({ 9: stack("emerald", 1) });
		const harness = makeHarness(state);
		expect((await failureOf(harness.callable("trade@1").invoke(harness.ctx, {}))).code).toBe("NOT_FOUND");
	});
});

describe("工作站窗口语义", () => {
	test("五类窗口都不产出 container 区域，按 container 取格必须失败", async () => {
		for (const layout of Object.values(LAYOUT)) {
			expect(layout.regions.some((region) => region.name === "container")).toBe(false);
		}
	});

	test("附魔列表只认组件：没有组件就是 null，不从物品名猜", async () => {
		const { enchantmentsOf } = await import("../../.uina/worlds/minecraft/capabilities/shared/workstation.js");
		const { knowledge } = await import("./mc-capability-harness.js");
		expect(
			enchantmentsOf({ name: "diamond_sword", count: 1, stackSize: 1, components: null, durability: null }, knowledge),
		).toBe(null);
		expect(
			enchantmentsOf(
				{
					name: "diamond_sword",
					count: 1,
					stackSize: 1,
					components: enchanted([
						{ id: 33, level: 3 },
						{ id: 99, level: 1 },
					]),
					durability: null,
				} as unknown as ItemValue,
				knowledge,
			),
		).toEqual([
			{ name: "sharpness", level: 3 },
			{ name: "#99", level: 1 },
		]);
	});
});
