/**
 * 知识类查询：item@1（静态物品知识）与 recipe@1（配方 + 按当前背包的差额计划）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 item/recipe。
 * item 是版本静态知识（无连接也可读、无观察水位）；recipe 的 plan 依赖当前库存，
 * 因此走 current 读取但 cursor="none"——它读当前事实，不发布观察水位。
 */

import type { ClientFactView } from "../../contracts/client-facts.js";
import type { RegistryKnowledge } from "../../contracts/knowledge.js";
import type { Fact, JsonValue } from "../../contracts/values.js";
import { factOf } from "../shared/facts.js";
import type { QuerySpec } from "../shared/query.js";
import { fail, stripNamespace } from "../shared/targets.js";

export interface KnowledgeDeps {
	knowledge: () => RegistryKnowledge | null;
}

function knowledgeOf(deps: KnowledgeDeps): RegistryKnowledge {
	const knowledge = deps.knowledge();
	if (knowledge == null) {
		fail("WRONG_STATE", "game knowledge is not available yet", {
			hint: "item/recipe need a live connection: the data version comes from the server handshake",
			recoverable: true,
		});
	}
	return knowledge;
}

const itemQuery = (deps: KnowledgeDeps): QuerySpec => ({
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
	reader: {
		kind: "static",
		read: (input: JsonValue): Fact<unknown> => {
			const name = stripNamespace((input as { name: string }).name);
			const knowledge = knowledgeOf(deps);
			const item = knowledge.item(name);
			if (item == null) {
				fail("NOT_FOUND", `unknown item: ${name}`, {
					hint: `data version ${knowledge.dataVersion}; use registry ids like oak_log`,
				});
			}
			const unknown: string[] = [];
			if (!item.sourcesComplete) {
				unknown.push("smelting and trade sources are absent from this data version; sources may be incomplete");
			}
			if (item.fuel == null) unknown.push("fuel burn time is not part of this data version");
			return factOf({ ...item, dataVersion: knowledge.dataVersion }, { unknown, source: "derived" });
		},
	},
});

const recipeQuery = (deps: KnowledgeDeps): QuerySpec => ({
	descriptor: {
		ref: "recipe@1",
		summary: "Crafting recipes for an item plus the missing-material plan against the current inventory",
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
								ingredients: [{ item: "iron_ingot", count: 3 }],
								output: { item: "iron_pickaxe", count: 1 },
							},
						],
						plan: { steps: [], need: { iron_ingot: 3 }, have: {}, missing: { iron_ingot: 3 } },
					},
				},
			},
		],
	},
	reader: {
		kind: "current",
		cursor: "none",
		read: (view: ClientFactView, input: JsonValue): Fact<unknown> => {
			const raw = input as { item: string; count?: number };
			const name = stripNamespace(raw.item);
			const wanted = raw.count ?? 1;
			const knowledge = knowledgeOf(deps);
			const recipes = knowledge.recipesFor(name);
			const unknown: string[] = [];
			if (recipes.length === 0) {
				fail("NOT_FOUND", `no crafting recipe for ${name} in data version ${knowledge.dataVersion}`, {
					hint: "smelting/trade recipes are not part of this data version yet",
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
	},
});

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
		if (knowledge.recipesFor(item).length > 0) steps.push({ item, count, action: "craft" });
	}
	return { steps, need: best.need, have, missing: best.missing };
}

export function knowledgeQueries(deps: KnowledgeDeps): QuerySpec[] {
	return [itemQuery(deps), recipeQuery(deps)];
}
