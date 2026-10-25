/**
 * 制作与熔炼：craft@1 摆格取产物，smelt@1 装料等待取回。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 craft / smelt。
 * 三条口径写在这里，代码按它们组织：
 * 1. 结果槽只在"恰好一批"时点击：服务端把原料吃干净、结果槽归空，与 Driver 的纯交换推演一致。
 *    因此不需要 mode-1 快速移动，也不需要为结果槽放宽完成判定；摆格前后都本地回读断言。
 * 2. 产物以 inventory@1 的前后差值为准，不拿点击次数冒充产量。
 * 3. 熔炼不预判产物：原料与燃料按知识表装进服务端槽位，烧出来什么看结果槽；
 *    wait:false 只下料，取货走 transfer@1 的 from（炉子只开结果槽搬出）。
 */
import type { BodyCallScope, CallContext, CallableDescriptor, NativeCallable } from "../../contracts/capabilities.js";
import type { BlockTarget, SelfState, WindowSession, WindowSnapshot } from "../../contracts/body.js";
import type { KnowledgeRecipe, RegistryKnowledge } from "../../contracts/knowledge.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import { approachBlock } from "../shared/approach.js";
import { requireKnowledge } from "../shared/knowledge.js";
import { pollUntil, readValue } from "../shared/observe.js";
import { GRID_POS_SCHEMA } from "../shared/schema.js";
import { findStation, placeStation } from "../shared/stations.js";
import { assertSameDimension, fail, resolveGrid, resolvePoint, stripNamespace } from "../shared/targets.js";
import { canAccept, readBlockAt, readInventory, type InventorySnapshot } from "../shared/views.js";
import {
	type WindowMoveState,
	moveState,
	transferWindow,
	windowClick,
	windowItem,
	windowRegion,
	windowSlot,
} from "../shared/window-transfer.js";

/** 服务端每个合成格恒为 1 件，一格一件是"一批"的唯一定义。 */
const MAX_STACK = 64;
const SMELT_POLL_MS = 400;
const SMELT_TIMEOUT_MS = 120_000;

const bare = (name: string): string => name.replace(/^minecraft:/, "");

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
	const empty = playerSlots(state.snapshot).find((slot) => windowSlot(state.snapshot, slot) == null);
	const stackable = playerSlots(state.snapshot).find((slot) => {
		const item = windowSlot(state.snapshot, slot);
		return (
			item != null && item.name === held.name && item.stackSize != null && item.count + held.count <= item.stackSize
		);
	});
	const target = empty ?? stackable;
	if (target == null)
		fail("INVENTORY_FULL", `no room for ${output.item} in the player inventory`, { dispatch: "sent" });
	await windowClick(window, state, target, 0);
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
			"The player inventory holds at least the requested count of the item, measured before and after; surplus from batch sizes is reported as produced",
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

export function craftCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: craftDescriptor,
		async invoke(ctx, raw) {
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
			const total = best.recipe.output.count * best.batches;
			if (canAccept(before, name, knowledge.item(name)?.stackSize ?? null, total) === false) {
				fail("INVENTORY_FULL", `the player inventory cannot hold ${name} x${total}`, {
					hint: "free some main-inventory slots first",
				});
			}
			if (best.recipe.station === "furnace")
				fail("WRONG_STATE", "internal: a furnace recipe was selected for crafting");
			const gridStation = station === "crafting_table" ? "crafting_table" : best.recipe.station;
			const at = await withCraftWindow(ctx, gridStation, async (window) => {
				const state = moveState((await window.snapshot()).value);
				const grid = windowRegion(state.snapshot, "crafting");
				const resultSlot = windowRegion(state.snapshot, "result")[0];
				const cells = placementOf(best.recipe, grid);
				for (let batch = 0; batch < best.batches; batch++) {
					interrupted(ctx, "craft");
					await craftBatch(window, state, grid, resultSlot, cells, best.recipe.output);
					await ctx.progress(plain({ batches: batch + 1, planned: best.batches, item: name }) as never);
				}
			});
			const after = await readInventory(ctx.world);
			const produced: Record<string, number> = {};
			const gained = (after.counts[name] ?? 0) - (before.counts[name] ?? 0);
			if (gained > 0) produced[name] = gained;
			const consumed: Record<string, number> = {};
			for (const ingredient of best.recipe.ingredients) {
				const spent = (before.counts[ingredient.item] ?? 0) - (after.counts[ingredient.item] ?? 0);
				if (spent > 0) consumed[ingredient.item] = spent;
			}
			if (gained < wanted) {
				fail("TARGET_NOT_MET", `crafted ${gained} of ${name}, expected ${wanted}`, {
					dispatch: "sent",
					progress: plain({ produced, consumed }) as never,
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
	};
}

/** 熔炼产物计数：结果槽里只认目标名。 */
function producedIn(snapshot: WindowSnapshot, resultSlot: number, name: string): number {
	const item = windowSlot(snapshot, resultSlot);
	return item != null && item.name === name ? item.count : 0;
}

/**
 * 服务端明确报"没在烧"（属性 0 = 剩余燃烧刻数）。烹饪必须以燃烧为前提，
 * 所以 lit=0 且产物还不够时，炉子已经停了；只认服务端报过的属性，没属性包时不猜。
 */
function furnaceIdle(snapshot: WindowSnapshot): boolean {
	return "0" in snapshot.properties && Number(snapshot.properties["0"] ?? 0) === 0;
}

interface FuelChoice {
	item: string;
	unitTicks: number;
}

function resolveFuel(
	knowledge: RegistryKnowledge,
	requested: string | undefined,
	counts: Record<string, number>,
): FuelChoice {
	const ticksOf = (name: string): number | null => knowledge.item(name)?.fuel?.ticks ?? null;
	if (requested != null) {
		const name = stripNamespace(requested);
		const unit = ticksOf(name);
		if (unit == null) {
			fail("MISSING_MATERIAL", `${name} has no known burn time`, {
				hint: "only fuels in the item table have a known burn time; item@1 reports fuel.ticks",
			});
		}
		if ((counts[name] ?? 0) === 0) fail("MISSING_MATERIAL", `no ${name} in the inventory`);
		return { item: name, unitTicks: unit };
	}
	const options = Object.keys(counts)
		.map((name) => ({ name, unit: ticksOf(name) }))
		.filter((entry): entry is { name: string; unit: number } => entry.unit != null && (counts[entry.name] ?? 0) > 0)
		.sort((a, b) => b.unit - a.unit);
	if (options.length === 0) {
		fail("MISSING_MATERIAL", "no fuel with a known burn time in the inventory", {
			hint: "pass fuel explicitly (e.g. coal, charcoal, planks) or pick some up",
		});
	}
	return { item: options[0].name, unitTicks: options[0].unit };
}

interface Furnace {
	position: Vec3;
	target: BlockTarget;
}

async function resolveFurnace(ctx: CallContext, raw: unknown, inventory: InventorySnapshot): Promise<Furnace> {
	const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
	let position: Vec3;
	if (raw != null) {
		const point = resolvePoint(raw, self);
		assertSameDimension(point, self, "furnace");
		position = resolveGrid(raw, self);
	} else {
		const nearby = await findStation(ctx, "furnace", 8);
		if (nearby != null) {
			position = nearby;
		} else if ((inventory.counts.furnace ?? 0) > 0) {
			position = await placeStation(ctx, "furnace");
		} else {
			fail("WRONG_STATE", "no furnace nearby and none in the inventory", {
				hint: "craft a furnace from 8 cobblestone, place it, or pass at",
			});
		}
	}
	const block = await readBlockAt(ctx.world, position);
	if (block == null || bare(block.name) !== "furnace") {
		fail("NOT_FOUND", "target is not an observed furnace", {
			hint: "smelt@1 supports the furnace only; blast_furnace and smoker are not supported yet",
		});
	}
	await approachBlock(ctx, position, "smelt");
	return { position, target: { block: position, place: { ...self.place, position } } };
}

/** 装料槽里已有的异名物品必须先由人处理：静默混装会让熔炼产出无法归因。 */
function assertSlotFree(snapshot: WindowSnapshot, slot: number, expected: string, where: string): void {
	const item = windowSlot(snapshot, slot);
	if (item != null && item.name !== expected) {
		fail("WRONG_STATE", `furnace ${where} slot holds ${item.name}, not ${expected}`, {
			hint: `take the ${item.name} out of the furnace first`,
		});
	}
}

const smeltDescriptor: CallableDescriptor = {
	ref: "smelt@1",
	summary:
		"Smelt an item in a furnace: load the input and fuel from the inventory and either wait for the output or return after loading",
	tags: ["smelt", "production", "knowledge", "furnace"],
	input: {
		type: "object",
		properties: {
			item: { type: "string", minLength: 1 },
			count: { type: "integer", minimum: 1, maximum: 256 },
			fuel: { type: "string", minLength: 1 },
			at: GRID_POS_SCHEMA,
			wait: { type: "boolean" },
			maxTimeMs: { type: "integer", minimum: 1000, maximum: 600000 },
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
			"wait=true: the player inventory gained the requested output, measured before and after. wait=false: the furnace sockets hold the input and fuel the server accepted",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "no smelting recipe for the item or the target is not a furnace" },
		{ code: "MISSING_MATERIAL", meaning: "input or fuel is missing, or the fuel has no known burn time" },
		{ code: "WRONG_STATE", meaning: "no furnace available, or its sockets hold other items" },
		{ code: "TARGET_NOT_MET", meaning: "the furnace stopped before producing the requested output" },
		{ code: "TIMEOUT", meaning: "the output did not arrive within maxTimeMs; progress keeps what was produced" },
		{ code: "CONFLICT", meaning: "the window changed under a click" },
		{ code: "CONTROL_CONFLICT", meaning: "delegated body would need independent navigation" },
		{ code: "INTERRUPTED", meaning: "action was stopped" },
	],
	examples: [
		{
			input: { item: "iron_ingot", count: 3, fuel: "coal" },
			output: {
				produced: { iron_ingot: 3 },
				consumed: { input: { item: "raw_iron", count: 3 }, fuel: { item: "coal", count: 1 } },
				at: { position: { x: 2, y: 64, z: 1 }, dimension: "overworld" },
			},
		},
	],
};

export function smeltCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: smeltDescriptor,
		async invoke(ctx, raw) {
			const input = raw as {
				item: string;
				count?: number;
				fuel?: string;
				at?: unknown;
				wait?: boolean;
				maxTimeMs?: number;
			};
			const knowledge = requireKnowledge(deps);
			const name = stripNamespace(input.item);
			const wanted = input.count ?? 1;
			const wait = input.wait !== false;
			const before = await readInventory(ctx.world);
			const recipes = knowledge.recipesFor(name).filter((recipe) => recipe.station === "furnace");
			if (recipes.length === 0) {
				fail("NOT_FOUND", `no furnace recipe for ${name}`, {
					hint: "smelt@1 covers furnace recipes from this data version; crafting uses craft@1",
				});
			}
			const usable = recipes
				.filter((recipe) => (before.counts[recipe.ingredients[0].item] ?? 0) > 0)
				.sort((a, b) => (before.counts[b.ingredients[0].item] ?? 0) - (before.counts[a.ingredients[0].item] ?? 0));
			if (usable.length === 0) {
				const inputs = [...new Set(recipes.map((recipe) => recipe.ingredients[0].item))];
				fail("MISSING_MATERIAL", `no smeltable input for ${name} in the inventory`, {
					hint: `needs one of ${inputs.join(", ")}`,
				});
			}
			const recipe = usable[0];
			const inputItem = recipe.ingredients[0].item;
			const cookTicks = recipe.cookTicks ?? 200;
			const fuel = resolveFuel(knowledge, input.fuel, before.counts);
			const furnace = await resolveFurnace(ctx, input.at, before);
			const endpoint = plain({ position: furnace.position, dimension: furnace.target.place.dimension });
			const batches: number[] = [];
			for (let left = wanted; left > 0; left -= MAX_STACK) batches.push(Math.min(left, MAX_STACK));
			const planned = wait ? batches : batches.slice(0, 1);

			let loaded = { item: inputItem, count: 0 };
			let loadedFuel = { item: fuel.item, count: 0 };
			const deadline = Date.now() + (input.maxTimeMs ?? SMELT_TIMEOUT_MS);
			try {
				await ctx.withBody(async (scope: BodyCallScope) => {
					interrupted(ctx, "smelt");
					const window = await scope.player.openContainer(furnace.target);
					try {
						const initial = (await window.snapshot()).value;
						const resultSlot = windowRegion(initial, "result")[0];
						const inputSlot = windowRegion(initial, "input")[0];
						const fuelSlot = windowRegion(initial, "fuel")[0];
						// 下料前先收走结果槽里的旧成品，否则新产物无处落。
						if (windowSlot(initial, resultSlot) != null) {
							await transferWindow(
								window,
								{ direction: "from", all: true },
								{
									regions: { block: "result", player: "player" },
								},
							);
						}
						for (const batch of planned) {
							interrupted(ctx, "smelt");
							const snapshot = (await window.snapshot()).value;
							assertSlotFree(snapshot, inputSlot, inputItem, "input");
							assertSlotFree(snapshot, fuelSlot, fuel.item, "fuel");
							await transferWindow(
								window,
								{ direction: "to", item: inputItem, count: batch },
								{ regions: { block: "input", player: "player" } },
							);
							const fuelCount = Math.min(MAX_STACK, Math.ceil((cookTicks * batch) / fuel.unitTicks));
							await transferWindow(
								window,
								{ direction: "to", item: fuel.item, count: fuelCount },
								{ regions: { block: "fuel", player: "player" } },
							);
							loaded = { item: inputItem, count: batch };
							loadedFuel = { item: fuel.item, count: fuelCount };
							if (!wait) break;
							// 停炉也是"完成"的一种：烧出足够产物，或连续两次看到 lit=0。
							// 单次 lit=0 可能只是 set_data 包还没到，连续两次才认定炉子停了。
							let stalled = 0;
							const settled = await pollUntil(
								async () => (await window.snapshot()).value,
								(state) => {
									if (producedIn(state, resultSlot, name) >= batch) return true;
									stalled = furnaceIdle(state) ? stalled + 1 : 0;
									return stalled >= 2;
								},
								{ timeoutMs: Math.max(0, deadline - Date.now()), intervalMs: SMELT_POLL_MS, signal: ctx.signal },
							);
							const last = settled.last;
							const produced = last == null ? 0 : producedIn(last, resultSlot, name);
							if (produced < batch) {
								const failureProgress = plain({ produced: produced > 0 ? { [name]: produced } : {} }) as never;
								if (last != null && furnaceIdle(last)) {
									fail("TARGET_NOT_MET", `furnace stopped before producing ${batch} ${name}`, {
										dispatch: "sent",
										progress: failureProgress,
									});
								}
								fail("TIMEOUT", `furnace produced ${produced} of ${batch} ${name} within the budget`, {
									dispatch: "sent",
									progress: failureProgress,
								});
							}
							await transferWindow(
								window,
								{ direction: "from", item: name, count: batch },
								{
									regions: { block: "result", player: "player" },
								},
							);
							await ctx.progress(plain({ produced: batch, planned: wanted }) as never);
						}
					} finally {
						await window.close({ force: true });
					}
				});
			} catch (err) {
				if (err instanceof Error && err.name === "CallFailure") {
					const failure = err as { progress?: JsonValue };
					failure.progress = plain({
						...(failure.progress as Record<string, JsonValue> | undefined),
						at: endpoint,
						loaded: plain({ input: loaded, fuel: loadedFuel }),
					}) as never;
				}
				throw err;
			}

			if (!wait) {
				// 估算值：燃料刻数已知，但区块不模拟时服务端会停烧，所以只作为复查提示。
				const readyAt = new Date(Date.now() + Math.ceil((cookTicks * loaded.count) / 20) * 1000 + 1000).toISOString();
				return plain({
					at: endpoint,
					loaded: plain({ input: loaded, fuel: loadedFuel }),
					readyAt,
					...(loaded.count < wanted ? { remaining: wanted - loaded.count } : {}),
					hint: `transfer@1 {from:{position:${JSON.stringify(furnace.position)}}, item:"${name}"} takes the output out; readyAt is an estimate`,
				}) as JsonValue;
			}

			const after = await readInventory(ctx.world);
			const gained = (after.counts[name] ?? 0) - (before.counts[name] ?? 0);
			const produced = gained > 0 ? { [name]: gained } : {};
			if (gained < wanted) {
				fail("TARGET_NOT_MET", `smelted ${gained} of ${name}, expected ${wanted}`, {
					dispatch: "sent",
					progress: plain({ produced, at: endpoint }) as never,
				});
			}
			const spentInput = (before.counts[inputItem] ?? 0) - (after.counts[inputItem] ?? 0);
			const spentFuel = (before.counts[fuel.item] ?? 0) - (after.counts[fuel.item] ?? 0);
			return plain({
				produced,
				consumed: {
					input: { item: inputItem, count: Math.max(0, spentInput) },
					fuel: { item: fuel.item, count: Math.max(0, spentFuel) },
				},
				at: endpoint,
			}) as JsonValue;
		},
	};
}
