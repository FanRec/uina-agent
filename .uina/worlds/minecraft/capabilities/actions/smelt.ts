/** Furnace loading and collection use confirmed slot transfers; world waits release this call's body scope. */
import type { CallableDescriptor, NativeCallable } from "../../contracts/capabilities.js";
import type { WindowSnapshot } from "../../contracts/body.js";
import type { RegistryKnowledge } from "../../contracts/knowledge.js";
import type { CallFailure, JsonValue } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import { requireKnowledge } from "../shared/knowledge.js";
import { checkBudget, waitFor } from "../shared/observe.js";
import { GRID_POS_SCHEMA } from "../shared/schema.js";
import { fail, stripNamespace } from "../shared/targets.js";
import { readInventory } from "../shared/views.js";
import { countInRegion, resolveStation, stackLimit, withStation } from "../shared/workstation.js";
import { type TransferAmounts, transferWindow, windowRegion, windowSlot } from "../shared/window-transfer.js";

const SMELT_TIMEOUT_MS = 120_000;

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
	return snapshot.properties["0"] === 0;
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
			"wait=true: the requested new output was confirmed transferred from the furnace result slot into the player inventory. wait=false: one adequately fueled batch was confirmed loaded",
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

/** 炉内进度属性：只认服务端报过的数值，没收到就是 0（不猜）。 */
function ticks(snapshot: WindowSnapshot, property: string): number {
	const value = snapshot.properties[property];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

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
			const deadline = Date.now() + (input.maxTimeMs ?? SMELT_TIMEOUT_MS);
			const knowledge = requireKnowledge(deps);
			const name = stripNamespace(input.item);
			const wanted = input.count ?? 1;
			const wait = input.wait !== false;
			const before = await readInventory(ctx.world);
			const recipes = knowledge.recipesFor(name).filter((recipe) => recipe.station === "furnace");
			if (recipes.length === 0)
				fail("NOT_FOUND", `no furnace recipe for ${name}`, {
					hint: "smelt@1 covers furnace recipes; crafting uses craft@1",
				});
			const usable = recipes
				.filter((recipe) => (before.counts[recipe.ingredients[0].item] ?? 0) > 0)
				.sort((a, b) => (before.counts[b.ingredients[0].item] ?? 0) - (before.counts[a.ingredients[0].item] ?? 0));
			if (usable.length === 0)
				fail("MISSING_MATERIAL", `no smeltable input for ${name} in the inventory`, {
					hint: `needs one of ${[...new Set(recipes.map((recipe) => recipe.ingredients[0].item))].join(", ")}`,
				});
			const recipe = usable[0];
			const inputItem = recipe.ingredients[0].item;
			const cookTicks = recipe.cookTicks ?? 200;
			// Explicit unknown fuels fail before acquiring a body. Existing burning fuel may cover a batch.
			let fuel: FuelChoice | null = input.fuel != null ? resolveFuel(knowledge, input.fuel, before.counts) : null;
			const loaded = { input: { item: inputItem, count: 0 }, fuel: { item: fuel?.item ?? null, count: 0 } };
			const produced: Record<string, number> = {};
			let completed = 0;
			let dispatched = false;
			let endpoint: JsonValue | undefined;
			const progress = () =>
				plain({
					produced,
					consumed: loaded,
					loaded,
					remaining: Math.max(0, wanted - completed),
					...(endpoint == null ? {} : { at: endpoint }),
				});
			const record = (kind: "input" | "fuel" | "output", credit: boolean) => {
				let previous = 0;
				return async (amounts: TransferAmounts) => {
					const item = kind === "output" ? name : loaded[kind].item;
					const total = item == null ? 0 : (amounts.moved[item] ?? 0);
					const delta = total - previous;
					previous = total;
					if (Object.values(amounts.moved).some((count) => count > 0)) dispatched = true;
					if (delta > 0 && kind === "output") {
						produced[name] = (produced[name] ?? 0) + delta;
						if (credit) completed += delta;
					} else if (delta > 0 && kind !== "output") loaded[kind].count += delta;
					await ctx.progress(progress() as never);
					checkBudget(ctx, deadline, "smelting");
				};
			};
			try {
				const furnace = await resolveStation(
					ctx,
					{
						block: "furnace",
						at: input.at,
						deadline,
						hint: "craft a furnace from 8 cobblestone, place it, or pass at; blast_furnace and smoker are not supported yet",
					},
					before,
				);
				endpoint = plain({ position: furnace.position, dimension: furnace.target.place.dimension });
				while (completed < wanted) {
					const batch = await withStation(ctx, furnace, "minecraft:furnace", deadline, async (window) => {
						dispatched = true;
						let snapshot = (await window.snapshot()).value;
						checkBudget(ctx, deadline, "smelting");
						const resultSlot = windowRegion(snapshot, "result")[0];
						const inputSlot = windowRegion(snapshot, "input")[0];
						const fuelSlot = windowRegion(snapshot, "fuel")[0];
						if (windowSlot(snapshot, resultSlot) != null) {
							await transferWindow(
								window,
								{ direction: "from", all: true },
								{ regions: { block: "result", player: "player" }, onProgress: record("output", false) },
							);
							snapshot = (await window.snapshot()).value;
							checkBudget(ctx, deadline, "smelting");
						}
						assertSlotFree(snapshot, inputSlot, inputItem, "input");
						const existingFuel = windowSlot(snapshot, fuelSlot);
						if (fuel == null) {
							const slotTicks = existingFuel == null ? null : knowledge.item(existingFuel.name)?.fuel?.ticks;
							if (existingFuel != null && slotTicks != null) fuel = { item: existingFuel.name, unitTicks: slotTicks };
							else {
								const counts: Record<string, number> = {};
								for (const slot of windowRegion(snapshot, "player")) {
									const item = windowSlot(snapshot, slot);
									if (item != null) counts[item.name] = (counts[item.name] ?? 0) + item.count;
								}
								if (Object.keys(counts).some((item) => knowledge.item(item)?.fuel != null))
									fuel = resolveFuel(knowledge, undefined, counts);
							}
						}
						if (fuel != null) {
							loaded.fuel.item = fuel.item;
						}
						const existingInput = windowSlot(snapshot, inputSlot)?.count ?? 0;
						const availableInput = countInRegion(snapshot, "player", inputItem);
						const inputRoom = stackLimit(knowledge, snapshot, inputItem) - existingInput;
						const outputRoom = Math.floor(stackLimit(knowledge, snapshot, name) / recipe.output.count);
						const fuelAvailable = fuel == null ? 0 : countInRegion(snapshot, "player", fuel.item);
						const fuelCompatible = existingFuel == null || existingFuel.name === fuel?.item;
						const fuelRoom =
							fuel == null || !fuelCompatible
								? 0
								: stackLimit(knowledge, snapshot, fuel.item) - (existingFuel?.count ?? 0);
						const existingFuelTicks = existingFuel == null ? 0 : (knowledge.item(existingFuel.name)?.fuel?.ticks ?? 0);
						const knownBurn = ticks(snapshot, "0") + (existingFuel?.count ?? 0) * existingFuelTicks;
						let quantity = Math.min(
							Math.ceil((wanted - completed) / recipe.output.count),
							inputRoom,
							outputRoom,
							availableInput,
						);
						let fuelCount = 0;
						for (; quantity > 0; quantity--) {
							const requiredTicks = Math.max(
								0,
								cookTicks * (existingInput + quantity) - ticks(snapshot, "2") - knownBurn,
							);
							fuelCount = requiredTicks === 0 ? 0 : fuel == null ? Infinity : Math.ceil(requiredTicks / fuel.unitTicks);
							if (fuelCount <= fuelRoom && fuelCount <= fuelAvailable - (fuel?.item === inputItem ? quantity : 0))
								break;
						}
						if (quantity <= 0)
							fail("MISSING_MATERIAL", "not enough input, slot room, or confirmed fuel for another smelting batch");
						checkBudget(ctx, deadline, "smelting");
						await transferWindow(
							window,
							{ direction: "to", item: inputItem, count: quantity },
							{ regions: { block: "input", player: "player" }, onProgress: record("input", false) },
						);
						// Loading can span server ticks. Re-read actual burn/input before adding fuel.
						const afterLoad = (await window.snapshot()).value;
						checkBudget(ctx, deadline, "smelting");
						const remainingTicks = Math.max(
							0,
							cookTicks * countInRegion(afterLoad, "input", inputItem) -
								ticks(afterLoad, "2") -
								ticks(afterLoad, "0") -
								(windowSlot(afterLoad, fuelSlot)?.count ?? 0) *
									(knowledge.item(windowSlot(afterLoad, fuelSlot)?.name ?? "")?.fuel?.ticks ?? 0),
						);
						fuelCount = remainingTicks === 0 ? 0 : fuel == null ? Infinity : Math.ceil(remainingTicks / fuel.unitTicks);
						if (
							fuelCount > 0 &&
							(fuel == null ||
								fuelCount > countInRegion(afterLoad, "player", fuel.item) ||
								fuelCount > stackLimit(knowledge, afterLoad, fuel.item) - countInRegion(afterLoad, "fuel", fuel.item))
						)
							fail("MISSING_MATERIAL", "confirmed remaining fuel cannot cover the loaded input");
						if (fuelCount > 0 && fuel != null) {
							assertSlotFree(afterLoad, fuelSlot, fuel.item, "fuel");
							checkBudget(ctx, deadline, "smelting");
							await transferWindow(
								window,
								{ direction: "to", item: fuel.item, count: fuelCount },
								{ regions: { block: "fuel", player: "player" }, onProgress: record("fuel", false) },
							);
						}
						return { output: quantity * recipe.output.count, ticks: cookTicks * (existingInput + quantity) };
					});
					if (!wait) {
						return plain({
							at: endpoint,
							loaded,
							readyAt: new Date(Date.now() + Math.ceil(batch.ticks / 20) * 1000 + 1000).toISOString(),
							...(loaded.input.count < wanted ? { remaining: wanted - loaded.input.count } : {}),
							hint: `transfer@1 {from:{position:${JSON.stringify(furnace.position)}}, item:"${name}"} takes the output out; readyAt is an estimate`,
						});
					}
					const goal = completed + batch.output;
					let estimate = Math.max(1000, (batch.ticks / 20) * 1000);
					let idle = 0;
					while (completed < goal) {
						checkBudget(ctx, deadline, "smelting");
						await waitFor(ctx, Math.min(estimate, Math.max(0, deadline - Date.now())), "smelting");
						await withStation(ctx, furnace, "minecraft:furnace", deadline, async (window) => {
							const snapshot = (await window.snapshot()).value;
							checkBudget(ctx, deadline, "smelting");
							const resultSlot = windowRegion(snapshot, "result")[0];
							const available = producedIn(snapshot, resultSlot, name);
							if (available > 0)
								await transferWindow(
									window,
									{ direction: "from", item: name, count: Math.min(available, goal - completed) },
									{ regions: { block: "result", player: "player" }, onProgress: record("output", true) },
								);
							if (completed >= goal) return;
							idle = furnaceIdle(snapshot) && countInRegion(snapshot, "fuel", fuel?.item ?? "") === 0 ? idle + 1 : 0;
							if (idle >= 2) fail("TARGET_NOT_MET", "furnace stopped before producing the requested output");
							estimate = Math.max(
								1000,
								(((goal - completed) * cookTicks) / recipe.output.count - ticks(snapshot, "2")) * 50,
							);
						});
						await ctx.progress(progress() as never);
					}
				}
				checkBudget(ctx, deadline, "smelting");
				return plain({ produced, consumed: loaded, at: endpoint });
			} catch (error) {
				if (error instanceof Error && error.name === "CallFailure") {
					const failure = error as CallFailure;
					if (dispatched && failure.dispatch === "not_sent") failure.dispatch = "sent";
					failure.progress = plain({
						...failure.progress,
						...(progress() as Record<string, JsonValue>),
					}) as CallFailure["progress"];
				}
				throw error;
			}
		},
	};
}
