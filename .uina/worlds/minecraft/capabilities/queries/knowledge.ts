/**
 * 知识类查询：item@1（静态物品知识）与 recipe@1（配方 + 按当前背包的差额计划）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 item/recipe。
 * item 是版本静态知识（无连接也可读、无观察水位）；recipe 的 plan 依赖当前库存，
 * 因此走 current 读取但 cursor="none"——它读当前事实，不发布观察水位。
 * 配方含合成（hand/crafting_table）与熔炼（furnace）；熔炼一条配方一个原料，见 driver/facts/knowledge.ts。
 */

import type { ClientFactView } from "../../contracts/client-facts.js";
import type { RegistryKnowledge } from "../../contracts/knowledge.js";
import type { Fact, JsonValue } from "../../contracts/values.js";
import type { CapabilityDefinition, MinecraftCapabilityModule } from "../catalog.js";
import { factOf } from "../shared/facts.js";
import { requireKnowledge } from "../shared/knowledge.js";
import { fail, stripNamespace } from "../shared/targets.js";

const itemDefinition: CapabilityDefinition = {
	kind: "query",
	descriptor: {
		ref: "item@1",
		summary: "Static item knowledge: stack size, food, tool, placement and how the item can be obtained",
		input: {
			type: "object",
			properties: { name: { type: "string", minLength: 1 } },
			required: ["name"],
			additionalProperties: false,
		},
		output: { type: "object" },
		access: "read",
		watchable: false,
		feedback: false,
		examples: [
			{
				input: { name: "iron_pickaxe" },
				output: {
					value: {
						name: "iron_pickaxe",
						stackSize: 1,
						tool: { type: "pickaxe", tier: "iron", durability: 250 },
						sources: [{ kind: "craft" }],
						sourcesComplete: false,
					},
				},
			},
		],
	},
	bind: (deps) => ({
		kind: "static",
		read: (input: JsonValue): Fact<unknown> => {
			const name = stripNamespace((input as { name: string }).name);
			const knowledge = requireKnowledge(deps);
			const item = knowledge.item(name);
			if (item == null) {
				fail("NOT_FOUND", `unknown item: ${name}`, {
					hint: `data version ${knowledge.dataVersion}; use registry ids like oak_log`,
				});
			}
			const unknown: string[] = [];
			if (!item.sourcesComplete) {
				unknown.push("trade sources are absent from this data version; sources may be incomplete");
			}
			if (item.fuel == null) unknown.push("fuel burn time is unknown for this item");
			return factOf({ ...item, dataVersion: knowledge.dataVersion }, { unknown, source: "derived" });
		},
	}),
};

const recipeDefinition: CapabilityDefinition = {
	kind: "query",
	descriptor: {
		ref: "recipe@1",
		facts: ["inventory"],
		summary: "Recipes (crafting and smelting) for an item plus the missing-material plan against the current inventory",
		input: {
			type: "object",
			properties: {
				item: { type: "string", minLength: 1 },
				count: { type: "integer", minimum: 1, maximum: 256 },
			},
			required: ["item"],
			additionalProperties: false,
		},
		output: { type: "object" },
		access: "read",
		watchable: false,
		feedback: false,
		examples: [
			{
				input: { item: "iron_pickaxe" },
				output: {
					value: {
						recipes: [
							{
								station: "crafting_table",
								ingredients: [
									{ item: "iron_ingot", count: 3 },
									{ item: "stick", count: 2 },
								],
								output: { item: "iron_pickaxe", count: 1 },
								pattern: [
									["iron_ingot", "iron_ingot", "iron_ingot"],
									[null, "stick", null],
									[null, "stick", null],
								],
							},
						],
						plan: {
							action: "craft",
							steps: [{ item: "iron_ingot", count: 3, action: "smelt" }],
							need: { iron_ingot: 3, stick: 2 },
							have: {},
							missing: { iron_ingot: 3, stick: 2 },
						},
					},
				},
			},
		],
	},
	bind: (deps) => ({
		kind: "current",
		cursor: "none",
		read: (view: ClientFactView, input: JsonValue): Fact<unknown> => {
			const raw = input as { item: string; count?: number };
			const name = stripNamespace(raw.item);
			const wanted = raw.count ?? 1;
			const knowledge = requireKnowledge(deps);
			const recipes = knowledge.recipesFor(name);
			const unknown: string[] = [];
			if (recipes.length === 0) {
				fail("NOT_FOUND", `no recipe for ${name} in data version ${knowledge.dataVersion}`, {
					hint: "trade and stonecutting recipes are not part of this data version",
				});
			}
			const inventory = view.inventory();
			let plan: unknown = undefined;
			if (inventory.value == null) {
				unknown.push("inventory not received; plan omitted");
			} else {
				plan = planOf(recipes, wanted, inventory.value.slots, knowledge);
			}
			return factOf({ recipes, ...(plan == null ? {} : { plan }) }, { unknown, source: "derived" });
		},
	}),
};

/** 选"缺得最少"的配方：先看缺料种类数，再看缺料总量；steps 只列本版本能合成的中间物。 */
function planOf(
	recipes: {
		station: string;
		ingredients: { item: string; count: number }[];
		output: { item: string; count: number };
	}[],
	wanted: number,
	slots: { item: { name: string; count: number } | null }[],
	knowledge: RegistryKnowledge,
): unknown {
	const have: Record<string, number> = {};
	for (const slot of slots) {
		if (slot.item == null) continue;
		have[slot.item.name] = (have[slot.item.name] ?? 0) + slot.item.count;
	}
	let best: { recipe: (typeof recipes)[number]; need: Record<string, number>; missing: Record<string, number> } | null =
		null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const recipe of recipes) {
		const batches = Math.max(1, Math.ceil(wanted / Math.max(1, recipe.output.count)));
		const need: Record<string, number> = {};
		for (const ingredient of recipe.ingredients)
			need[ingredient.item] = (need[ingredient.item] ?? 0) + ingredient.count * batches;
		const missing: Record<string, number> = {};
		let kinds = 0;
		let units = 0;
		for (const [item, count] of Object.entries(need)) {
			const gap = Math.max(0, count - (have[item] ?? 0));
			if (gap > 0) {
				missing[item] = gap;
				kinds++;
				units += gap;
			}
		}
		const score = kinds * 1000 + units;
		if (score < bestScore) {
			bestScore = score;
			best = { recipe, need, missing };
		}
	}
	if (best == null) return undefined;
	const steps: { item: string; count: number; action: "craft" | "smelt" }[] = [];
	for (const [item, count] of Object.entries(best.missing)) {
		const options = knowledge.recipesFor(item);
		if (options.length === 0) continue;
		steps.push({ item, count, action: options.some((recipe) => recipe.station !== "furnace") ? "craft" : "smelt" });
	}
	// 选中配方的最终执行方式（§3 recipe）：铁锭这类目标必须走 smelt@1，
	// 组合 Program 不该硬编码 craft@1——配方的执行方式由知识给出，不猜。
	const action: "craft" | "smelt" = best.recipe.station === "furnace" ? "smelt" : "craft";
	return { action, steps, need: best.need, have, missing: best.missing };
}

export const knowledgeModule: MinecraftCapabilityModule = {
	id: "knowledge",
	definitions: [itemDefinition, recipeDefinition],
};
