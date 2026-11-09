/** Furnace loading and collection use confirmed slot transfers; world waits release this call's body scope. */

import type { WindowSnapshot } from "../../contracts/body.js";
import type { CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { RegistryKnowledge } from "../../contracts/knowledge.js";
import type { JsonValue } from "../../contracts/values.js";
import { plain, createSuspendError } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import type { CapabilityDeps } from "../deps.js";
import { settleFailure } from "../shared/failure.js";
import { requireKnowledge } from "../shared/knowledge.js";
import { checkBudget, waitFor } from "../shared/observe.js";
import { GRID_POS_SCHEMA } from "../shared/schema.js";
import { fail, stripNamespace } from "../shared/targets.js";
import { readInventory } from "../shared/views.js";
import { type TransferAmounts, transferWindow, windowRegion, windowSlot } from "../shared/window-transfer.js";
import { countInRegion, resolveStation, stackLimit, withStation } from "../shared/workstation.js";

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
			/** true/false 是原有语义；"durable" 是显式可持久模式，挂起后由 Runtime 续段。 */
			wait: { enum: [true, false, "durable"] },
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

/**
 * 一次"装好料就交还给世界"的持久挂起里，必须跨进程活下来的全部内容。
 * 都是纯 JSON：炉位、这一炉还差多少、已经装进去多少、预算到期时刻。
 */
interface SmeltWait {
	kind: "smelt@1";
	at: JsonValue;
	item: string;
	wanted: number;
	completed: number;
	/** 这一炉还差几件产物；恢复后只用它算目标，不重新装料。 */
	outstanding: number;
	/** 这一炉预计需要的刻数，用来定第一次复查的时机。 */
	batchTicks: number;
	produced: Record<string, number>;
	loaded: { input: { item: string; count: number }; fuel: { item: string | null; count: number } };
	deadlineAt: string;
}

/**
 * 只接受本能力自己写下的检查点。形状不对说明这份检查点不是这一炉的进度，
 * 拿它推算"已经装了多少"会直接导致重复投料。
 */
function readSmeltWait(checkpoint: JsonValue | null): SmeltWait | null {
	if (checkpoint == null) return null;
	const cp = checkpoint as Partial<SmeltWait>;
	if (
		cp.kind !== "smelt@1" ||
		cp.at == null ||
		typeof cp.item !== "string" ||
		typeof cp.wanted !== "number" ||
		typeof cp.completed !== "number" ||
		typeof cp.outstanding !== "number" ||
		cp.loaded == null ||
		typeof cp.deadlineAt !== "string" ||
		Number.isNaN(Date.parse(cp.deadlineAt))
	)
		fail("WRONG_STATE", "the resume checkpoint is not a smelt@1 furnace progress", {
			hint: "a durable wait can only be resumed by the call that created it",
		});
	return {
		kind: "smelt@1",
		at: cp.at,
		item: cp.item,
		wanted: cp.wanted,
		completed: cp.completed,
		outstanding: cp.outstanding,
		batchTicks: cp.batchTicks ?? 0,
		produced: cp.produced ?? {},
		loaded: cp.loaded,
		deadlineAt: cp.deadlineAt,
	};
}

export const smeltModule: MinecraftCapabilityModule = {
	id: "smelt",
	definitions: [
		{
			kind: "action",
			descriptor: smeltDescriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, raw: JsonValue): Promise<JsonValue> => {
					const input = raw as {
						item: string;
						count?: number;
						fuel?: string;
						at?: unknown;
						wait?: boolean | "durable";
						maxTimeMs?: number;
					};
					const knowledge = requireKnowledge(deps);
					const name = stripNamespace(input.item);
					const durable = input.wait === "durable";
					// 显式可持久模式的重入：料和燃料上次就送进去了，这一段只能观察与取产物。
					const resume = durable ? readSmeltWait(ctx.checkpoint) : null;
					if (resume != null && resume.item !== name)
						fail("WRONG_STATE", `the durable wait belongs to ${resume.item}, not ${name}`, {
							hint: "resume the same item; another item needs its own furnace run",
						});
					const wanted = resume?.wanted ?? input.count ?? 1;
					const wait = input.wait !== false;
					const deadline =
						resume == null
							? Date.now() + (input.maxTimeMs ?? SMELT_TIMEOUT_MS)
							: // 续段也得先看一眼才谈得上"超时"：留一次观察的最低窗口，其余仍受原预算约束。
								Math.max(Date.parse(resume.deadlineAt), Date.now() + 2000);
					const before = await readInventory(ctx.world);
					const recipes = knowledge.recipesFor(name).filter((recipe) => recipe.station === "furnace");
					if (recipes.length === 0)
						fail("NOT_FOUND", `no furnace recipe for ${name}`, {
							hint: "smelt@1 covers furnace recipes; crafting uses craft@1",
						});
					const usable = recipes
						.filter((recipe) => (before.counts[recipe.ingredients[0].item] ?? 0) > 0)
						.sort((a, b) => (before.counts[b.ingredients[0].item] ?? 0) - (before.counts[a.ingredients[0].item] ?? 0));
					// 重入时原材料已经在炉里，背包里没有是正常的：按检查点认原料，不重判可用性。
					if (usable.length === 0 && resume == null)
						fail("MISSING_MATERIAL", `no smeltable input for ${name} in the inventory`, {
							hint: `needs one of ${[...new Set(recipes.map((recipe) => recipe.ingredients[0].item))].join(", ")}`,
						});
					const recipe =
						resume == null
							? usable[0]
							: (recipes.find((candidate) => candidate.ingredients[0].item === resume.loaded.input.item) ??
								usable[0] ??
								recipes[0]);
					const inputItem = resume?.loaded.input.item ?? recipe.ingredients[0].item;
					const cookTicks = recipe.cookTicks ?? 200;
					// Explicit unknown fuels fail before acquiring a body. Existing burning fuel may cover a batch.
					let fuel: FuelChoice | null =
						resume != null
							? resume.loaded.fuel.item == null
								? null
								: {
										item: resume.loaded.fuel.item,
										unitTicks: knowledge.item(resume.loaded.fuel.item)?.fuel?.ticks ?? 0,
									}
							: input.fuel != null
								? resolveFuel(knowledge, input.fuel, before.counts)
								: null;
					const loaded = resume?.loaded ?? {
						input: { item: inputItem, count: 0 },
						fuel: { item: fuel?.item ?? null, count: 0 },
					};
					const produced: Record<string, number> = { ...(resume?.produced ?? {}) };
					let completed = resume?.completed ?? 0;
					/** 这一炉还差几件产物；重入段的目标由它算，不重新装料。 */
					let outstanding = resume?.outstanding ?? 0;
					let batchTicks = resume?.batchTicks ?? 0;
					/** 本段还没装过料：重入段的头一次循环只观察。 */
					let needsLoad = resume == null || outstanding <= 0;
					let dispatched = false;
					let endpoint: JsonValue | undefined = resume == null ? undefined : plain(resume.at);
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
								at: resume?.at ?? input.at,
								deadline,
								hint: "craft a furnace from 8 cobblestone, place it, or pass at; blast_furnace and smoker are not supported yet",
							},
							before,
						);
						endpoint = plain({ position: furnace.position, dimension: furnace.target.place.dimension });
						while (completed < wanted) {
							if (!needsLoad) {
								// 这一炉的料已经装好：只观察与取产物。重入段不允许再投一次料。
								const goal = completed + outstanding;
								let estimate = resume == null ? Math.max(1000, (batchTicks / 20) * 1000) : 0;
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
										idle =
											furnaceIdle(snapshot) && countInRegion(snapshot, "fuel", fuel?.item ?? "") === 0 ? idle + 1 : 0;
										if (idle >= 2) fail("TARGET_NOT_MET", "furnace stopped before producing the requested output");
										estimate = Math.max(
											1000,
											(((goal - completed) * cookTicks) / recipe.output.count - ticks(snapshot, "2")) * 50,
										);
									});
									await ctx.progress(progress() as never);
								}
								needsLoad = true;
								continue;
							}
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
									if (existingFuel != null && slotTicks != null)
										fuel = { item: existingFuel.name, unitTicks: slotTicks };
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
								const existingFuelTicks =
									existingFuel == null ? 0 : (knowledge.item(existingFuel.name)?.fuel?.ticks ?? 0);
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
									fuelCount =
										requiredTicks === 0 ? 0 : fuel == null ? Infinity : Math.ceil(requiredTicks / fuel.unitTicks);
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
								fuelCount =
									remainingTicks === 0 ? 0 : fuel == null ? Infinity : Math.ceil(remainingTicks / fuel.unitTicks);
								if (
									fuelCount > 0 &&
									(fuel == null ||
										fuelCount > countInRegion(afterLoad, "player", fuel.item) ||
										fuelCount >
											stackLimit(knowledge, afterLoad, fuel.item) - countInRegion(afterLoad, "fuel", fuel.item))
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
							outstanding = batch.output;
							batchTicks = batch.ticks;
							if (durable) {
								// 装料已经确认（含服务端回执），现在把这一炉交给世界：释放窗口与身体，
								// 只留纯 JSON 进度，到点由 Runtime 用同一入口续段。
								await ctx.progress(progress() as never);
								throw createSuspendError({
									reason: `furnace at ${JSON.stringify(furnace.position)} holds ${inputItem}; ${Math.max(0, wanted - completed)} of ${name} still to collect`,
									checkpoint: plain({
										kind: "smelt@1",
										at: endpoint,
										item: name,
										wanted,
										completed,
										outstanding,
										batchTicks,
										produced,
										loaded,
										deadlineAt: new Date(deadline).toISOString(),
									}),
									recheckAfterMs: Math.max(1000, (batchTicks / 20) * 1000),
									deadlineAfterMs: Math.max(0, deadline - Date.now()),
								});
							}
							needsLoad = false;
						}
						checkBudget(ctx, deadline, "smelting");
						return plain({ produced, consumed: loaded, at: endpoint });
					} catch (error) {
						settleFailure(error, { dispatched, progress: progress() as Record<string, JsonValue> });
					}
				},
		},
	],
};
