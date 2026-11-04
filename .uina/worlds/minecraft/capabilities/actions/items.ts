/**
 * 物品类动作：equip@1 与 eat@1。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 equip/eat、driver §7.5–§7.6.1。
 * equip 只做"装到槽位"，物品从哪来由 inventory 事实说话；eat 用持续使用（drive hold）
 * 触发进食，按 food/saturation 的真实变化判定，结束时一定释放使用状态。
 */

import type { EquipSlot, ItemSelector, SelfState } from "../../contracts/body.js";
import type { BodyCallScope, CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { JsonValue } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import type { CapabilityDeps } from "../deps.js";
import { pollUntil, readValue } from "../shared/observe.js";
import { ITEM_SELECTOR_SCHEMA } from "../shared/schema.js";
import { fail, matchesItem, stripNamespace } from "../shared/targets.js";
import { type InventorySnapshot, readInventory, type SlotView } from "../shared/views.js";

const SLOTS: EquipSlot[] = ["hand", "offhand", "head", "chest", "legs", "feet"];
const SLOT_INDEX: Record<EquipSlot, (selected: number | null) => number> = {
	hand: (selected) => 36 + (selected ?? 0),
	offhand: () => 45,
	head: () => 5,
	chest: () => 6,
	legs: () => 7,
	feet: () => 8,
};

interface EquipInput {
	item: string | ItemSelector | null;
	slot?: EquipSlot;
}

function itemInSlot(inventory: InventorySnapshot, slot: EquipSlot): Omit<SlotView, "slot"> | null {
	const index = SLOT_INDEX[slot](inventory.selectedSlot ?? null);
	const found = inventory.slots.find((entry) => entry.slot === index);
	if (found == null) return null;
	const { slot: _slot, ...item } = found;
	return item;
}

const equipDescriptor: CallableDescriptor = {
	ref: "equip@1",
	summary: "Equip an item into a hand or armor slot, or empty a hand without dropping anything",
	tags: ["body", "inventory"],
	input: {
		oneOf: [
			{
				type: "object",
				properties: {
					item: { oneOf: [{ type: "string", minLength: 1 }, ITEM_SELECTOR_SCHEMA] },
					slot: { type: "string", enum: SLOTS },
				},
				required: ["item"],
				additionalProperties: false,
			},
			{
				type: "object",
				properties: {
					item: { type: "null" },
					slot: { type: "string", enum: ["hand", "offhand"] },
				},
				required: ["item"],
				additionalProperties: false,
			},
		],
	},
	output: {
		type: "object",
		properties: {
			slot: { type: "string" },
			item: {
				oneOf: [
					{ type: "null" },
					{
						type: "object",
						properties: { name: { type: "string" }, count: { type: "integer" } },
						required: ["name", "count"],
						additionalProperties: true,
					},
				],
			},
			previous: { type: ["object", "null"] },
		},
		required: ["slot", "item"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description: "The target slot is observed to hold the requested item (or to be empty after item=null)",
	},
	errors: [
		{ code: "MISSING_MATERIAL", meaning: "no inventory item matches the selector" },
		{ code: "INVENTORY_FULL", meaning: "no safe slot to empty the hand into" },
		{ code: "WRONG_STATE", meaning: "the item cannot go into that slot (e.g. armor slot with a tool)" },
		{ code: "TARGET_NOT_MET", meaning: "the slot does not hold the requested item after the move" },
	],
	requires: ["connection", "body"],
	examples: [
		{ input: { item: "stone_pickaxe" }, output: { slot: "hand", item: { name: "stone_pickaxe", count: 1 } } },
		{ input: { item: null }, output: { slot: "hand", item: null } },
	],
	implementation: "native",
};

// ---- eat ----

const BITE_TIMEOUT_MS = 3000;
const BITE_INTERVAL_MS = 250;
/** 吃一口约 32 tick；多给一点余量，按 food 变化判定结束。 */
const BITE_TICKS = 40;
const MAX_BITES = 16;

interface EatInput {
	food?: string | ItemSelector;
	until?: "full" | "count";
	count?: number;
}

/** 显式点名的食物：先校验它到底是什么，再谈饿不饿（输入错误不该被状态掩盖）。 */
function requestedFood(
	inventory: InventorySnapshot,
	knowledge: NonNullable<ReturnType<CapabilityDeps["knowledge"]>>,
	requested: string | ItemSelector,
): { name: string } {
	const match = inventory.slots.find((slot) => matchesItem(requested, slot));
	if (match == null) {
		const want = typeof requested === "string" ? requested : requested.name;
		fail("NOT_FOUND", `${want} is not in the inventory`, {
			hint: `inventory holds: ${inventory.slots.map((slot) => slot.name).join(", ") || "nothing"}`,
		});
	}
	if (knowledge.item(match.name)?.food == null) {
		fail("WRONG_STATE", `${match.name} is not food`, { hint: "check item@1 for the food field" });
	}
	return { name: match.name };
}

/** 没点名时按食物价值挑一个（saturation 优先，hunger 次之）。 */
function bestFood(
	inventory: InventorySnapshot,
	knowledge: NonNullable<ReturnType<CapabilityDeps["knowledge"]>>,
): { name: string } | null {
	let best: { name: string; score: number } | null = null;
	for (const slot of inventory.slots) {
		const food = knowledge.item(slot.name)?.food;
		if (food == null) continue;
		const score = food.saturation * 100 + food.hunger;
		if (best == null || score > best.score) best = { name: slot.name, score };
	}
	return best == null ? null : { name: best.name };
}

const eatDescriptor: CallableDescriptor = {
	ref: "eat@1",
	summary: "Eat food from the inventory until full or for a requested count",
	tags: ["body", "survival"],
	input: {
		type: "object",
		properties: {
			food: { oneOf: [{ type: "string", minLength: 1 }, ITEM_SELECTOR_SCHEMA] },
			until: { type: "string", enum: ["full", "count"] },
			count: { type: "integer", minimum: 1, maximum: MAX_BITES },
		},
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			eaten: {
				type: "array",
				items: {
					type: "object",
					properties: { name: { type: "string" }, count: { type: "integer" } },
					required: ["name", "count"],
					additionalProperties: false,
				},
			},
			food: { type: "object" },
			saturation: { type: "object" },
		},
		required: ["eaten", "food", "saturation"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description: "Food/saturation increased by the observed bites; the item count in the inventory decreased",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "no food in the inventory" },
		{ code: "WRONG_STATE", meaning: "not hungry, or the selected item is not food" },
		{ code: "TARGET_NOT_MET", meaning: "food/saturation did not change after a bite" },
		{ code: "INTERRUPTED", meaning: "the run was stopped" },
	],
	requires: ["connection", "body"],
	examples: [{ input: {}, output: { eaten: [{ name: "bread", count: 1 }], food: { before: 14, after: 20 } } }],
	implementation: "native",
};

export const itemsModule: MinecraftCapabilityModule = {
	id: "items",
	definitions: [
		{
			kind: "action",
			descriptor: equipDescriptor,
			bind:
				() =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as EquipInput;
					const slot: EquipSlot = raw.slot ?? "hand";
					const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
					void self;
					const before = await readInventory(ctx.world);
					const previous = itemInSlot(before, slot);
					return await ctx.withBody(async (scope: BodyCallScope) => {
						if (raw.item == null) {
							const receipt = await scope.player.equip(null, slot);
							if (receipt.completion !== "met")
								fail("TARGET_NOT_MET", `emptying slot ${slot} has no confirmed server result`, {
									dispatch: receipt.dispatch,
									effects: [receipt.effect],
								});
							const after = await readInventory(scope.world);
							const current = itemInSlot(after, slot);
							if (current != null) {
								fail("TARGET_NOT_MET", `slot ${slot} still holds ${current.name}`, {
									hint: "another item may have been moved into the slot",
									dispatch: "sent",
								});
							}
							return plain({ slot, item: null, ...(previous != null ? { previous } : {}) });
						}
						const selector: ItemSelector = typeof raw.item === "string" ? { name: raw.item } : raw.item;
						const receipt = await scope.player.equip(selector, slot);
						if (receipt.completion !== "met") {
							fail("TARGET_NOT_MET", `equip dispatched but slot ${slot} was not confirmed`, {
								hint: "read inventory@1 to see the current slot content",
								dispatch: receipt.dispatch,
								effects: [receipt.effect],
							});
						}
						const after = await readInventory(scope.world);
						const current = itemInSlot(after, slot);
						const wanted = typeof raw.item === "string" ? stripNamespace(raw.item) : stripNamespace(raw.item.name);
						if (current == null || !matchesItem(selector, current)) {
							fail("TARGET_NOT_MET", `slot ${slot} holds ${current?.name ?? "nothing"}, expected ${wanted}`, {
								dispatch: "sent",
								effects: [receipt.effect],
							});
						}
						return plain({ slot, item: current, ...(previous != null ? { previous } : {}) });
					});
				},
		},
		{
			kind: "action",
			descriptor: eatDescriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as EatInput;
					const knowledge = deps.knowledge();
					if (knowledge == null) {
						fail("WRONG_STATE", "game knowledge is not available yet", {
							hint: "food ranking needs the version registry (connection handshake)",
						});
					}
					const before = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
					const until = raw.until ?? "full";
					const target = until === "count" ? (raw.count ?? 1) : MAX_BITES;
					const inventory = await readInventory(ctx.world);
					// 顺序是有意的：点名的东西不是食物属于输入错误，先说它；吃饱与否是状态事实。
					const requested = raw.food == null ? null : requestedFood(inventory, knowledge, raw.food);
					if (until === "full" && before.food != null && before.food >= 20) {
						fail("WRONG_STATE", "food is already full", { hint: "eating would waste the item" });
					}
					const food = requested ?? bestFood(inventory, knowledge);
					if (food == null) {
						fail("NOT_FOUND", "no edible item in the inventory", {
							hint: `inventory holds: ${inventory.slots.map((slot) => slot.name).join(", ") || "nothing"}`,
						});
					}
					return await ctx.withBody(async (scope: BodyCallScope) => {
						const eaten: { name: string; count: number }[] = [];
						let current = before;
						try {
							for (let bite = 0; bite < target; bite++) {
								if (until === "full" && current.food != null && current.food >= 20) break;
								const held = await readInventory(scope.world);
								const selector: ItemSelector = {
									...(typeof raw.food === "object" ? raw.food : {}),
									name: food.name,
									substitutions: [],
								};
								const currentHeld =
									held.selectedSlot == null
										? held.held
										: held.slots.find((slot) => slot.slot === held.selectedSlot! + 36);
								if (currentHeld == null || !matchesItem(selector, currentHeld)) {
									const receipt = await scope.player.equip(selector, "hand");
									if (receipt.completion !== "met")
										fail("TARGET_NOT_MET", "food equipment has no confirmed server result", {
											dispatch: receipt.dispatch,
											effects: [receipt.effect],
											progress: { eaten },
										});
								}
								const foodBefore = current.food;
								await scope.player.drive({ keys: {}, use: { mode: "hold", hand: "main" } }, BITE_TICKS);
								const settled = await pollUntil(
									async () => await readValue<SelfState>(scope.world, "self@1", {}, ctx.signal, "self state"),
									(state) => state.food != null && foodBefore != null && state.food > foodBefore,
									{ timeoutMs: BITE_TIMEOUT_MS, intervalMs: BITE_INTERVAL_MS, signal: ctx.signal },
								);
								if (!settled.ok || settled.last == null) {
									fail("TARGET_NOT_MET", `food did not increase after biting ${food.name}`, {
										hint: "the item may not be edible in this state, or the server rejected it",
										dispatch: "sent",
										progress: { eaten },
									});
								}
								current = settled.last;
								const last = eaten[eaten.length - 1];
								if (last != null && last.name === food.name) last.count++;
								else eaten.push({ name: food.name, count: 1 });
							}
						} finally {
							// 释放使用状态：不给未结束的 use 留钩子。
							await scope.player.endUse().catch(() => undefined);
						}
						return plain({
							eaten,
							food: { before: before.food, after: current.food },
							saturation: { before: before.saturation, after: current.saturation },
						});
					});
				},
		},
	],
};
