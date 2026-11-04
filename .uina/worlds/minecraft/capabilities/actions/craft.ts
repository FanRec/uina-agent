/** Craft one server-confirmed batch at a time; retain confirmed consumption and inventory receipts. */

import type { BlockTarget, SelfState, WindowSession, WindowSnapshot } from "../../contracts/body.js";
import type { BodyCallScope, CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { KnowledgeRecipe, RegistryKnowledge } from "../../contracts/knowledge.js";
import type { CallFailure, JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import type { CapabilityDeps } from "../deps.js";
import { approachBlock } from "../shared/approach.js";
import { requireKnowledge } from "../shared/knowledge.js";
import { readValue } from "../shared/observe.js";
import { findStation, placeStation } from "../shared/stations.js";
import { fail, stripNamespace } from "../shared/targets.js";
import { readInventory } from "../shared/views.js";
import {
	moveState,
	placeCursor,
	type WindowMoveState,
	windowClick,
	windowItem,
	windowRegion,
	windowSlot,
} from "../shared/window-transfer.js";

function interrupted(ctx: CallContext, what: string): void {
	if (ctx.signal.aborted) fail("INTERRUPTED", `${what} action was stopped`, { recoverable: false });
}

function playerSlots(snapshot: WindowSnapshot): number[] {
	return windowRegion(snapshot, "player");
}

/** 一批的差额：按"需要多少批"折算出每种原料的总需求。 */
function missingFor(recipe: KnowledgeRecipe, batches: number, counts: Record<string, number>): Record<string, number> {
	const missing: Record<string, number> = {};
	for (const ingredient of recipe.ingredients) {
		const gap = ingredient.count * batches - (counts[ingredient.item] ?? 0);
		if (gap > 0) missing[ingredient.item] = (missing[ingredient.item] ?? 0) + gap;
	}
	return missing;
}

interface CraftChoice {
	recipe: KnowledgeRecipe;
	batches: number;
	missing: Record<string, number>;
}

/**
 * 候选配方按"缺得最少"排序，同分时优先手持（不用摆工作台）。
 * station="hand" 排除 3×3 配方；station="crafting_table" 允许把手持配方放到工作台上做。
 */
function craftChoices(
	knowledge: RegistryKnowledge,
	name: string,
	wanted: number,
	counts: Record<string, number>,
	station: "auto" | "hand" | "crafting_table",
): CraftChoice[] {
	return knowledge
		.recipesFor(name)
		.filter((recipe) => recipe.station !== "furnace")
		.filter((recipe) => station !== "hand" || recipe.station === "hand")
		.map((recipe) => {
			const batches = Math.max(1, Math.ceil(wanted / Math.max(1, recipe.output.count)));
			return { recipe, batches, missing: missingFor(recipe, batches, counts) };
		})
		.sort((a, b) => {
			const score = (choice: CraftChoice): number => {
				const kinds = Object.keys(choice.missing).length;
				const units = Object.values(choice.missing).reduce((sum, count) => sum + count, 0);
				return kinds * 10_000 + units * 10 + (choice.recipe.station === "crafting_table" ? 1 : 0);
			};
			return score(a) - score(b);
		});
}

/** 图案 → 具体格子；无形状配方按 ingredients 顺序（重复物品占多格）。 */
function placementOf(recipe: KnowledgeRecipe, grid: number[]): { slot: number; item: string }[] {
	const cols = grid.length === 4 ? 2 : 3;
	const cells: { slot: number; item: string }[] = [];
	if (recipe.pattern != null) {
		for (const [row, values] of recipe.pattern.entries()) {
			for (const [col, cell] of values.entries()) {
				if (cell == null) continue;
				const slot = grid[row * cols + col];
				if (slot == null) fail("WRONG_STATE", `recipe pattern does not fit a ${cols}x${cols} grid`);
				cells.push({ slot, item: cell });
			}
		}
		return cells;
	}
	let index = 0;
	for (const ingredient of recipe.ingredients) {
		for (let n = 0; n < ingredient.count; n++) {
			const slot = grid[index++];
			if (slot == null) fail("WRONG_STATE", `recipe needs ${index} grid cells but only ${grid.length} are available`);
			cells.push({ slot, item: ingredient.item });
		}
	}
	return cells;
}

function gridMatches(snapshot: WindowSnapshot, grid: number[], cells: { slot: number; item: string }[]): boolean {
	return grid.every((slot) => {
		const item = windowSlot(snapshot, slot);
		const want = cells.find((cell) => cell.slot === slot)?.item ?? null;
		if (want == null) return item == null;
		return item != null && item.name === want && item.count === 1;
	});
}

/** 从背包某格取 1 件放进指定格；余量立刻还回原格，光标必须干净。 */
async function placeOne(
	window: WindowSession,
	state: WindowMoveState,
	source: number,
	target: number,
	item: string,
): Promise<void> {
	await windowClick(window, state, source, 0);
	const held = windowItem(state.snapshot.cursor);
	if (held == null || held.name !== item) {
		fail("CONFLICT", `picking up ${item} from inventory slot ${source} was not confirmed`, {
			dispatch: "sent",
		});
	}
	await windowClick(window, state, target, 1);
	const placed = windowSlot(state.snapshot, target);
	if (placed == null || placed.name !== item || placed.count !== 1) {
		fail("TARGET_NOT_MET", `placing 1 ${item} in grid slot ${target} was not confirmed`, { dispatch: "sent" });
	}
	if (state.snapshot.cursor != null) await windowClick(window, state, source, 0);
	if (state.snapshot.cursor != null) {
		fail("TARGET_NOT_MET", `cursor remainder of ${item} could not be returned to inventory slot ${source}`, {
			dispatch: "sent",
		});
	}
}

/** 一批：空网格确认 → 逐格摆 → 回读断言 → 点结果槽 → 产物入包。 */
async function craftBatch(
	window: WindowSession,
	state: WindowMoveState,
	grid: number[],
	resultSlot: number,
	cells: { slot: number; item: string }[],
	output: { item: string; count: number },
	onConsumed: (items: Record<string, number>) => Promise<void>,
	onProduced: (item: string, count: number) => Promise<void>,
): Promise<void> {
	for (const slot of grid) {
		if (windowSlot(state.snapshot, slot) != null) {
			fail("WRONG_STATE", "crafting grid is not empty before placing", {
				dispatch: state.dispatched ? "sent" : "not_sent",
			});
		}
	}
	for (const cell of cells) {
		const source = playerSlots(state.snapshot).find((slot) => windowSlot(state.snapshot, slot)?.name === cell.item);
		if (source == null)
			fail("MISSING_MATERIAL", `ran out of ${cell.item}`, { dispatch: state.dispatched ? "sent" : "not_sent" });
		await placeOne(window, state, source, cell.slot, cell.item);
	}
	if (!gridMatches(state.snapshot, grid, cells)) {
		fail("TARGET_NOT_MET", "crafting grid does not match the recipe after placing", { dispatch: "sent" });
	}
	await windowClick(window, state, resultSlot, 0);
	const held = windowItem(state.snapshot.cursor);
	if (held == null || held.name !== output.item || held.count !== output.count) {
		fail(
			"TARGET_NOT_MET",
			`result slot gave ${held == null ? "nothing" : `${held.name} x${held.count}`}, expected ${output.item} x${output.count}`,
			{
				dispatch: "sent",
			},
		);
	}
	const consumed: Record<string, number> = {};
	for (const cell of cells) {
		const remaining = windowSlot(state.snapshot, cell.slot);
		if (remaining == null || remaining.name !== cell.item) consumed[cell.item] = (consumed[cell.item] ?? 0) + 1;
	}
	await onConsumed(consumed);
	await placeCursor(window, state, playerSlots(state.snapshot), held.count, (item, count) =>
		onProduced(item.name, count),
	);
	if (state.snapshot.cursor != null) {
		fail("TARGET_NOT_MET", "crafted output could not be moved into the inventory", { dispatch: "sent" });
	}
}

/** 3×3 需要工作台：附近有就用，没有就用背包里的放一个；都没有就是缺工具。 */
async function resolveTable(ctx: CallContext): Promise<Vec3> {
	const nearby = await findStation(ctx, "crafting_table", 8);
	if (nearby != null) {
		await approachBlock(ctx, nearby, "craft");
		return nearby;
	}
	const inventory = await readInventory(ctx.world);
	if ((inventory.counts.crafting_table ?? 0) > 0) return await placeStation(ctx, "crafting_table");
	fail("MISSING_TOOL", "a 3x3 recipe needs a crafting table", {
		hint: "craft a crafting_table from 4 planks on the hand grid first, or place one near you",
	});
}

async function withCraftWindow(
	ctx: CallContext,
	station: "hand" | "crafting_table",
	work: (window: WindowSession) => Promise<void>,
): Promise<{ position: Vec3; dimension: string } | null> {
	if (station === "hand") {
		await ctx.withBody(async (scope: BodyCallScope) => {
			interrupted(ctx, "craft");
			await scope.player.withInventory(work);
		});
		return null;
	}
	const position = await resolveTable(ctx);
	const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
	const target: BlockTarget = { block: position, place: { ...self.place, position } };
	await ctx.withBody(async (scope: BodyCallScope) => {
		interrupted(ctx, "craft");
		const window = await scope.player.openContainer(target);
		try {
			await work(window);
		} finally {
			await window.close({ force: true });
		}
	});
	return { position, dimension: self.place.dimension };
}

const craftDescriptor: CallableDescriptor = {
	ref: "craft@1",
	summary:
		"Craft an item by name: pick a recipe that fits the inventory, place the pattern on the grid, take the output; places a crafting table from the inventory when a 3x3 recipe needs one",
	tags: ["craft", "production", "knowledge"],
	input: {
		type: "object",
		properties: {
			item: { type: "string", minLength: 1 },
			count: { type: "integer", minimum: 1, maximum: 256 },
			station: { enum: ["auto", "hand", "crafting_table"] },
		},
		required: ["item"],
		additionalProperties: false,
	},
	output: { type: "object" },
	access: "act",
	implementation: "native",
	requires: ["connection", "body", "window"],
	completion: {
		scope: "capability",
		description:
			"The requested output reached the player inventory through confirmed slot moves; surplus batches and partial consumption are retained",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "no such item or no crafting recipe for it (smelting uses smelt@1)" },
		{ code: "MISSING_MATERIAL", meaning: "materials are short; hint and progress carry the missing amounts" },
		{ code: "MISSING_TOOL", meaning: "a 3x3 recipe needs a crafting table and none is nearby or in the inventory" },
		{ code: "INVENTORY_FULL", meaning: "the player inventory cannot hold the output" },
		{ code: "WRONG_STATE", meaning: "grid state or knowledge is unusable" },
		{ code: "TARGET_NOT_MET", meaning: "a click or the grid did not confirm; unknown clicks are never repeated" },
		{ code: "CONFLICT", meaning: "the window changed under a click" },
		{ code: "CONTROL_CONFLICT", meaning: "delegated body would need independent navigation" },
		{ code: "INTERRUPTED", meaning: "action was stopped" },
	],
	examples: [
		{
			input: { item: "iron_pickaxe", count: 1 },
			output: {
				crafted: 1,
				produced: { iron_pickaxe: 1 },
				consumed: { iron_ingot: 3, stick: 2 },
				remaining: 0,
				at: { position: { x: 3, y: 64, z: 1 }, dimension: "overworld" },
			},
		},
	],
};

export const craftModule: MinecraftCapabilityModule = {
	id: "craft",
	definitions: [
		{
			kind: "action",
			descriptor: craftDescriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, raw: JsonValue): Promise<JsonValue> => {
					const input = raw as { item: string; count?: number; station?: "auto" | "hand" | "crafting_table" };
					const knowledge = requireKnowledge(deps);
					const name = stripNamespace(input.item);
					const wanted = input.count ?? 1;
					const station = input.station ?? "auto";
					if (knowledge.item(name) == null) {
						fail("NOT_FOUND", `unknown item: ${name}`, {
							hint: `data version ${knowledge.dataVersion}; use registry ids like oak_log`,
						});
					}
					const before = await readInventory(ctx.world);
					const choices = craftChoices(knowledge, name, wanted, before.counts, station);
					if (choices.length === 0) {
						fail("NOT_FOUND", `no ${station === "auto" ? "" : `${station} `}crafting recipe for ${name}`, {
							hint:
								knowledge.recipesFor(name).length > 0
									? "only smelting recipes exist for this item; use smelt@1"
									: "this data version has no recipe for it",
						});
					}
					const best = choices[0];
					const short = Object.entries(best.missing);
					if (short.length > 0) {
						fail("MISSING_MATERIAL", `missing materials for ${name}`, {
							hint: short.map(([item, count]) => `${item} x${count}`).join(", "),
							progress: plain({ missing: best.missing }) as never,
						});
					}
					if (best.recipe.station === "furnace")
						fail("WRONG_STATE", "internal: a furnace recipe was selected for crafting");
					const gridStation = station === "crafting_table" ? "crafting_table" : best.recipe.station;
					const produced: Record<string, number> = {};
					const consumed: Record<string, number> = {};
					let state: WindowMoveState | undefined;
					const progress = () => ({
						crafted: produced[name] ?? 0,
						produced: { ...produced },
						consumed: { ...consumed },
						remaining: Math.max(0, wanted - (produced[name] ?? 0)),
					});
					let at: { position: Vec3; dimension: string } | null;
					try {
						at = await withCraftWindow(ctx, gridStation, async (window) => {
							state = moveState((await window.snapshot()).value);
							const grid = windowRegion(state.snapshot, "crafting");
							const resultSlot = windowRegion(state.snapshot, "result")[0];
							const cells = placementOf(best.recipe, grid);
							for (let batch = 0; batch < best.batches; batch++) {
								interrupted(ctx, "craft");
								await craftBatch(
									window,
									state,
									grid,
									resultSlot,
									cells,
									best.recipe.output,
									async (items) => {
										for (const [item, count] of Object.entries(items)) consumed[item] = (consumed[item] ?? 0) + count;
										await ctx.progress(plain(progress()) as never);
										interrupted(ctx, "craft");
									},
									async (item, count) => {
										produced[item] = (produced[item] ?? 0) + count;
										await ctx.progress(plain(progress()) as never);
										interrupted(ctx, "craft");
									},
								);
							}
						});
					} catch (error) {
						if (error instanceof Error && error.name === "CallFailure") {
							const failure = error as CallFailure;
							if (state?.dispatched && failure.dispatch === "not_sent") failure.dispatch = "sent";
							failure.progress = plain({ ...failure.progress, ...progress() }) as CallFailure["progress"];
						}
						throw error;
					}
					const gained = produced[name] ?? 0;
					if (gained < wanted) {
						fail("TARGET_NOT_MET", `crafted ${gained} of ${name}, expected ${wanted}`, {
							dispatch: "sent",
							progress: plain(progress()) as never,
						});
					}
					return plain({
						crafted: gained,
						produced,
						consumed,
						remaining: 0,
						...(at == null ? {} : { at: plain({ position: at.position, dimension: at.dimension }) }),
					}) as JsonValue;
				},
		},
	],
};
