/**
 * 工作站五动作（批 15）：brew / enchant / anvil / grindstone / trade。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 的 K7 五条合同。
 * 分层：Driver 的窗口会话只承诺"提交包已进入连接"，这里的完成判据全部来自
 * 服务端推来的窗口内容——附魔出现在槽里、铁砧结果槽出现、砂轮结果无附魔、瓶子组件变号。
 *
 * 真服实测（archive/stations-implementation.md）固定了这些事实：
 * - 五类窗口槽数 41/38/39/39/39，属性 0..2=附魔三档等级要求、铁砧 0=费用、酿造 0=刻数；
 * - 附魔/改名/选交易三包都被服务端接受，`name_item` 不带 windowId；
 * - 商人 select_trade 会把**整摞**付款自动搬进付款槽并填好结果槽，点结果只扣应付量。
 */

import type { EntityRef, ItemValue, SelfState, WindowSession, WindowSnapshot } from "../../contracts/body.js";
import type { CallableDescriptor, CallContext, NativeCallable } from "../../contracts/capabilities.js";
import type { CallFailure, JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import { requireKnowledge } from "../shared/knowledge.js";
import { checkBudget, pollUntil } from "../shared/observe.js";
import { GRID_POS_SCHEMA } from "../shared/schema.js";
import { fail, stripNamespace } from "../shared/targets.js";
import { type InventorySnapshot, itemCountOf, readInventory, type SlotView, slotsOf } from "../shared/views.js";
import { windowRegion, windowSlot } from "../shared/window-transfer.js";
import {
	countInRegion,
	customNameOf,
	enchantmentsOf,
	moveExact,
	potionIdOf,
	putRegion,
	resolveStation,
	type Station,
	takeRegion,
	trimPayment,
	withEntity,
	withStation,
} from "../shared/workstation.js";

/** 各动作的内部预算：酿造要等 20 秒，其余都是几次点击的事。 */
const BREW_BUDGET_MS = 60_000;
const STATION_BUDGET_MS = 30_000;
/** 酿造一批的最多瓶数（酿造台三个药水槽）。 */
const BREW_BATCH = 3;

/** 动作返回的 at 是纯值（Place 带索引签名之外的身份字段，不能直接当 JsonValue）。 */
function placeOf(station: Station): JsonValue {
	return plain({ position: station.position, dimension: station.target.place.dimension });
}

function property(snapshot: WindowSnapshot, index: number): number | null {
	const value = snapshot.properties[String(index)];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 轮询窗口直到 done；超时按 timeoutCode 如实失败（不把"没看见"写成"完成了"）。 */
async function watch(
	ctx: CallContext,
	window: WindowSession,
	done: (snapshot: WindowSnapshot) => boolean,
	timeoutMs: number,
	message: string,
): Promise<WindowSnapshot> {
	const result = await pollUntil(async () => (await window.snapshot()).value, done, {
		timeoutMs,
		intervalMs: 250,
		signal: ctx.signal,
	});
	if (!result.ok || result.last == null) fail("TARGET_NOT_MET", message, { dispatch: "sent" });
	return result.last;
}

/** 把失败时的进度并进 CallFailure，保留已发生的搬运/产出。 */
function attachProgress(error: unknown, progress: () => Record<string, JsonValue>): never {
	if (error instanceof Error && error.name === "CallFailure") {
		const failure = error as CallFailure;
		if (failure.dispatch === "not_sent") failure.dispatch = "sent";
		failure.progress = plain({ ...failure.progress, ...progress() }) as CallFailure["progress"];
	}
	throw error;
}

/* ------------------------------------------------------------------ brew */

const brewDescriptor: CallableDescriptor = {
	ref: "brew@1",
	summary:
		"Brew one batch of potions on a brewing stand: load water bottles, one ingredient and blaze powder, wait for the brew and take the bottles back",
	tags: ["brew", "potion", "station", "alchemy"],
	input: {
		type: "object",
		properties: {
			potion: { type: "string", minLength: 1 },
			ingredient: { type: "string", minLength: 1 },
			count: { type: "integer", minimum: 1, maximum: BREW_BATCH },
			at: GRID_POS_SCHEMA,
			wait: { type: "boolean" },
		},
		required: ["potion", "ingredient"],
		additionalProperties: false,
	},
	output: { type: "object" },
	access: "act",
	implementation: "native",
	requires: ["connection", "body", "window"],
	completion: {
		scope: "capability",
		description:
			"wait=true: the loaded bottles report a different potion id than water after the server advanced the brew, and they were taken back. wait=false: one batch was confirmed loaded",
	},
	errors: [
		{ code: "MISSING_MATERIAL", meaning: "no water bottles, no ingredient, or no blaze powder and an empty fuel slot" },
		{ code: "WRONG_STATE", meaning: "no brewing stand available, or its sockets hold other potions" },
		{ code: "TARGET_NOT_MET", meaning: "the bottles never changed within the brew window" },
		{ code: "TIMEOUT", meaning: "the batch did not finish inside maxTimeMs" },
		{ code: "INTERRUPTED", meaning: "action was stopped" },
	],
	examples: [
		{
			input: { potion: "awkward", ingredient: "nether_wart", count: 3 },
			output: {
				produced: { awkward: 3 },
				consumed: {
					ingredient: { item: "nether_wart", count: 1 },
					bottle: { item: "potion", count: 3 },
					fuel: { item: "blaze_powder", count: 1 },
				},
				at: { position: { x: 2, y: 64, z: 1 }, dimension: "overworld" },
			},
		},
	],
};

/** 水瓶 = 带 potion_contents 且编号 0；没有组件的 potion 项不能当水瓶。 */
function waterBottles(inventory: InventorySnapshot): SlotView[] {
	return slotsOf(inventory, "potion").filter((slot) => potionIdOf(slot as unknown as ItemValue) === 0);
}

export function brewCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: brewDescriptor,
		async invoke(ctx, raw) {
			const input = raw as {
				potion: string;
				ingredient: string;
				count?: number;
				at?: unknown;
				wait?: boolean;
			};
			const deadline = Date.now() + BREW_BUDGET_MS;
			const knowledge = requireKnowledge(deps);
			const ingredient = knowledge.canonicalItemName(input.ingredient);
			if (ingredient == null) fail("NOT_FOUND", `${input.ingredient} is not a known item`);
			const wanted = input.count ?? 1;
			const before = await readInventory(ctx.world);
			const bottles = waterBottles(before);
			if (bottles.length === 0)
				fail("MISSING_MATERIAL", "no water bottles in the inventory", {
					hint: "fill glass bottles at a water source (use@1 with a bottle), or bring potion of water",
				});
			if (itemCountOf(before, ingredient) < 1)
				fail("MISSING_MATERIAL", `no ${ingredient} in the inventory`, {
					hint: `brew@1 consumes 1 ${ingredient} per batch`,
				});
			const batch = Math.min(wanted, bottles.length, BREW_BATCH);
			const loaded = {
				ingredient: { item: ingredient, count: 0 },
				bottle: { item: "potion", count: 0 },
				fuel: { item: "blaze_powder" as string | null, count: 0 },
			};
			const progress = (): Record<string, JsonValue> =>
				plain({ produced: {}, consumed: loaded }) as Record<string, JsonValue>;
			try {
				const station = await resolveStation(
					ctx,
					{
						block: "brewing_stand",
						at: input.at,
						deadline,
						hint: "craft a brewing stand (blaze rod + 3 cobblestone), place it, or pass at",
					},
					before,
				);
				const endpoint = placeOf(station);
				const outcome = await withStation(ctx, station, "minecraft:brewing_stand", deadline, async (window, first) => {
					for (const slot of windowRegion(first, "bottle")) {
						const item = windowSlot(first, slot);
						if (item != null && potionIdOf(item) !== 0)
							fail("WRONG_STATE", `the stand already holds ${item.name} (potion id ${potionIdOf(item)})`, {
								hint: "take the brewed potions out before starting a new batch",
							});
					}
					const existingIngredient = windowSlot(first, windowRegion(first, "ingredient")[0]);
					if (existingIngredient != null && existingIngredient.name !== ingredient)
						fail("WRONG_STATE", `the ingredient slot holds ${existingIngredient.name}, not ${ingredient}`);
					const fuelSlot = windowRegion(first, "fuel")[0];
					const fuelEmpty = windowSlot(first, fuelSlot) == null;
					if (fuelEmpty && itemCountOf(before, "blaze_powder") < 1)
						fail("MISSING_MATERIAL", "the stand has no fuel and there is no blaze powder in the inventory");
					checkBudget(ctx, deadline, "brewing");
					await putRegion(window, "bottle", "potion", batch);
					loaded.bottle.count = batch;
					if (existingIngredient == null) {
						await putRegion(window, "ingredient", ingredient, 1);
						loaded.ingredient.count = 1;
					}
					if (fuelEmpty) {
						await putRegion(window, "fuel", "blaze_powder", 1);
						loaded.fuel.count = 1;
					}
					loaded.fuel.item = "blaze_powder";
					if (input.wait === false)
						return plain({
							at: endpoint,
							loaded,
							readyAt: new Date(Date.now() + 25_000).toISOString(),
							hint: "the brew takes about 20 s; read container@1 or run brew@1 again after it finishes",
						});
					const finish = await watch(
						ctx,
						window,
						(snapshot) =>
							windowRegion(snapshot, "bottle").every((slot) => {
								const item = windowSlot(snapshot, slot);
								return item == null || potionIdOf(item) !== 0;
							}) && windowRegion(snapshot, "bottle").some((slot) => windowSlot(snapshot, slot) != null),
						30_000,
						"the bottles never finished brewing",
					);
					const ids = windowRegion(finish, "bottle")
						.map((slot) => windowSlot(finish, slot))
						.filter((item): item is ItemValue => item != null)
						.map((item) => potionIdOf(item));
					if (ids.some((id) => id == null || id === 0))
						fail("TARGET_NOT_MET", "a bottle slot still reports water after the brew window", {
							dispatch: "sent",
						});
					await takeRegion(window, "bottle");
					return plain({
						produced: { [stripNamespace(input.potion)]: ids.length },
						consumed: loaded,
						at: endpoint,
						// 服务端不下发 potion 注册表：名字按入参，编号是唯一可核实的证据。
						observedPotionIds: ids,
						hint: "produced is keyed by the requested potion; the protocol only carries numeric potion ids",
					});
				});
				return outcome;
			} catch (error) {
				return attachProgress(error, progress);
			}
		},
	};
}

/* --------------------------------------------------------------- enchant */

const enchantDescriptor: CallableDescriptor = {
	ref: "enchant@1",
	summary:
		"Enchant one item on an enchanting table: pick an offer slot, pay the lapis and levels, and report the enchantments the server actually applied",
	tags: ["enchant", "station", "experience"],
	input: {
		type: "object",
		properties: {
			item: { type: "string", minLength: 1 },
			slot: { type: "integer", enum: [1, 2, 3] },
			at: GRID_POS_SCHEMA,
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
		description: "the item reported enchantments from its own component after the selection and was taken back",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "the item is not in the inventory, or there is no enchanting table" },
		{ code: "MISSING_MATERIAL", meaning: "not enough lapis lazuli or experience levels for the chosen offer" },
		{ code: "WRONG_STATE", meaning: "experience level is unknown, or the table input slot is occupied" },
		{ code: "TARGET_NOT_MET", meaning: "the table offered nothing for this item, or the item came back unenchanted" },
		{ code: "INTERRUPTED", meaning: "action was stopped" },
	],
	examples: [
		{
			input: { item: "diamond_sword", slot: 1 },
			output: {
				enchantments: [{ name: "sharpness", level: 1 }],
				cost: 1,
				item: "diamond_sword",
				at: { position: { x: 2, y: 64, z: 1 }, dimension: "overworld" },
			},
		},
	],
};

export function enchantCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: enchantDescriptor,
		async invoke(ctx, raw) {
			const input = raw as { item: string; slot?: 1 | 2 | 3; at?: unknown };
			const deadline = Date.now() + STATION_BUDGET_MS;
			const knowledge = requireKnowledge(deps);
			const name = knowledge.canonicalItemName(input.item);
			if (name == null) fail("NOT_FOUND", `${input.item} is not a known item`);
			const before = await readInventory(ctx.world);
			// 已附魔的物品在附魔台上没有任何档位（真服实测：三档全 0），所以优先挑没附魔的那一件；
			// 全都有附魔时如实失败，而不是把一件已附魔的塞进去空等。
			const candidates = slotsOf(before, name);
			const plainSlot = candidates.find((slot) => enchantmentsOf(slot as unknown as ItemValue, knowledge) == null);
			if (plainSlot == null)
				fail(
					candidates.length === 0 ? "NOT_FOUND" : "WRONG_STATE",
					candidates.length === 0
						? `no ${name} in the inventory`
						: `every ${name} in the inventory is already enchanted`,
					{ hint: "use anvil@1 with an enchanted book to add enchantments to an enchanted item" },
				);
			const lapis = itemCountOf(before, "lapis_lazuli");
			const self = await ctx.world.read<SelfState>({ ref: "self@1", input: {} });
			const levels = self.value?.xpLevel ?? null;
			if (levels == null)
				fail("WRONG_STATE", "experience level is unknown", {
					hint: "the server has not sent this player's experience yet",
				});
			const station = await resolveStation(
				ctx,
				{
					block: "enchanting_table",
					at: input.at,
					deadline,
					hint: "craft an enchanting table (obsidian + diamonds + book), place it, or pass at",
				},
				before,
			);
			const endpoint = placeOf(station);
			try {
				return await withStation(ctx, station, "minecraft:enchantment", deadline, async (window, first) => {
					if (windowSlot(first, windowRegion(first, "input")[0]) != null)
						fail("WRONG_STATE", "the enchanting table input slot is occupied");
					checkBudget(ctx, deadline, "enchanting");
					// 指名搬这一件：同名的已附魔副本不能被搬进去。
					const playerRegion = windowRegion(first, "player");
					const sourceSlot = playerRegion[plainSlot.slot - 9];
					if (sourceSlot == null) fail("NOT_FOUND", `${name} is not inside the window player area`);
					await moveExact(window, first, sourceSlot, windowRegion(first, "input")[0]);
					// 三档等级要求只有放了物品之后服务端才算出来。
					const offerPoll = await pollUntil(
						async () => (await window.snapshot()).value,
						(snapshot) => [0, 1, 2].some((index) => (property(snapshot, index) ?? 0) > 0),
						{ timeoutMs: 2_000, intervalMs: 250, signal: ctx.signal },
					);
					if (!offerPoll.ok) {
						const state = offerPoll.last;
						const input = state == null ? null : windowSlot(state, windowRegion(state, "input")[0]);
						fail(
							"TARGET_NOT_MET",
							`the enchanting table offered no enchantment for this item (input=${JSON.stringify(
								input,
							)}, properties=${JSON.stringify(state?.properties ?? {})}, levels=${levels}, lapis=${lapis})`,
							{ dispatch: "sent" },
						);
					}
					const loaded = offerPoll.last as WindowSnapshot;
					const costs = [0, 1, 2].map((index) => property(loaded, index) ?? 0);
					const affordable = [1, 2, 3].filter(
						(slot) => costs[slot - 1] > 0 && costs[slot - 1] <= levels && lapis >= slot,
					);
					const chosen = input.slot ?? affordable.at(-1) ?? 0;
					if (chosen === 0 || !affordable.includes(chosen))
						fail("MISSING_MATERIAL", `offer ${chosen === 0 ? "none" : chosen} is not affordable`, {
							hint: `offers cost ${costs.join("/")} levels; you have ${levels} levels and ${lapis} lapis`,
						});
					const cost = costs[chosen - 1];
					checkBudget(ctx, deadline, "enchanting");
					if (windowSlot(loaded, windowRegion(loaded, "lapis")[0]) == null)
						await putRegion(window, "lapis", "lapis_lazuli", chosen);
					await window.selectEnchant(chosen as 1 | 2 | 3);
					const applied = await watch(
						ctx,
						window,
						(snapshot) => enchantmentsOf(windowSlot(snapshot, windowRegion(snapshot, "input")[0]), knowledge) != null,
						5_000,
						"the item came back without enchantments",
					);
					const enchanted = windowSlot(applied, windowRegion(applied, "input")[0]);
					const enchantments = enchantmentsOf(enchanted, knowledge) ?? [];
					await takeRegion(window, "input");
					return plain({ enchantments, cost, item: name, at: endpoint });
				});
			} catch (error) {
				return attachProgress(error, () => ({ item: name, cost: 0 }));
			}
		},
	};
}

/* ----------------------------------------------------------------- anvil */

const anvilDescriptor: CallableDescriptor = {
	ref: "anvil@1",
	summary:
		"Use an anvil to rename, combine or repair an item: place the base and material, pay the level cost and report the item that came out",
	tags: ["anvil", "station", "rename", "repair"],
	input: {
		type: "object",
		properties: {
			operation: { type: "string", enum: ["combine", "repair", "rename"] },
			base: { type: "string", minLength: 1 },
			material: { type: "string", minLength: 1 },
			name: { type: "string", minLength: 1, maxLength: 50 },
			at: GRID_POS_SCHEMA,
		},
		required: ["operation", "base"],
		additionalProperties: false,
	},
	output: { type: "object" },
	access: "act",
	implementation: "native",
	requires: ["connection", "body", "window"],
	completion: {
		scope: "capability",
		description:
			"the anvil result slot held an item that was paid for and taken back; cost comes from the window property",
	},
	errors: [
		{ code: "INVALID_INPUT", meaning: "combine/repair without material, or rename without name" },
		{ code: "NOT_FOUND", meaning: "the base item is not in the inventory, or there is no anvil" },
		{ code: "MISSING_MATERIAL", meaning: "not enough experience levels for this operation" },
		{ code: "WRONG_STATE", meaning: "the anvil inputs are occupied by other items" },
		{ code: "TARGET_NOT_MET", meaning: "the anvil produced no result for this combination" },
		{ code: "INTERRUPTED", meaning: "action was stopped" },
	],
	examples: [
		{
			input: { operation: "rename", base: "diamond_sword", name: "Excalibur" },
			output: {
				result: { name: "Excalibur", enchantments: null },
				cost: 1,
				at: { position: { x: 2, y: 64, z: 1 }, dimension: "overworld" },
			},
		},
	],
};

export function anvilCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: anvilDescriptor,
		async invoke(ctx, raw) {
			const input = raw as {
				operation: "combine" | "repair" | "rename";
				base: string;
				material?: string;
				name?: string;
				at?: unknown;
			};
			const deadline = Date.now() + STATION_BUDGET_MS;
			const knowledge = requireKnowledge(deps);
			const base = knowledge.canonicalItemName(input.base);
			if (base == null) fail("NOT_FOUND", `${input.base} is not a known item`);
			const material = input.material == null ? null : knowledge.canonicalItemName(input.material);
			if (input.material != null && material == null) fail("NOT_FOUND", `${input.material} is not a known item`);
			if (input.operation !== "rename" && material == null)
				fail("INVALID_INPUT", `${input.operation} needs a material`);
			if (input.operation === "rename" && input.name == null) fail("INVALID_INPUT", "rename needs the new name");
			const before = await readInventory(ctx.world);
			if (itemCountOf(before, base) < 1) fail("NOT_FOUND", `no ${base} in the inventory`);
			if (material != null && itemCountOf(before, material) < 1)
				fail("MISSING_MATERIAL", `no ${material} in the inventory`);
			const levels = (await ctx.world.read<SelfState>({ ref: "self@1", input: {} })).value?.xpLevel ?? null;
			const station = await resolveStation(
				ctx,
				{
					block: "anvil",
					at: input.at,
					deadline,
					hint: "craft an anvil (3 iron blocks + 4 iron ingots), place it, or pass at",
				},
				before,
			);
			const endpoint = placeOf(station);
			try {
				return await withStation(ctx, station, "minecraft:anvil", deadline, async (window, first) => {
					const inputs = windowRegion(first, "input");
					if (windowSlot(first, inputs[0]) != null) fail("WRONG_STATE", "the anvil base slot is occupied");
					checkBudget(ctx, deadline, "anvil");
					await putRegion(window, "input", base, 1);
					if (material != null) await putRegion(window, "input", material, 1);
					if (input.operation === "rename" && input.name != null) await window.renameItem(input.name);
					const ready = await watch(
						ctx,
						window,
						(snapshot) => windowSlot(snapshot, windowRegion(snapshot, "result")[0]) != null,
						3_000,
						"the anvil produced no result for this combination",
					);
					const cost = property(ready, 0) ?? 0;
					if (levels != null && cost > levels)
						fail("MISSING_MATERIAL", `this operation costs ${cost} levels, you have ${levels}`, {
							dispatch: "sent",
						});
					const result = windowSlot(ready, windowRegion(ready, "result")[0]);
					const reported = {
						name: customNameOf(result) ?? result?.name ?? base,
						enchantments: enchantmentsOf(result, knowledge),
					};
					await takeRegion(window, "result");
					// 剩下的基材/材料取回：铁砧窗口关掉也会退还，但这里要一个可核实的收尾。
					for (const slot of inputs) {
						if (windowSlot((await window.snapshot()).value, slot) != null) await takeRegion(window, "input");
					}
					return plain({ result: reported, cost, at: endpoint });
				});
			} catch (error) {
				return attachProgress(error, () => ({ operation: input.operation, base }));
			}
		},
	};
}

/* ------------------------------------------------------------- grindstone */

const grindstoneDescriptor: CallableDescriptor = {
	ref: "grindstone@1",
	summary:
		"Strip enchantments (and repair durability) on a grindstone: place the item, take the result and report what was removed",
	tags: ["grindstone", "station", "enchantment"],
	input: {
		type: "object",
		properties: { item: { type: "string", minLength: 1 }, at: GRID_POS_SCHEMA },
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
			"the grindstone result slot held the item and it was taken back; removed enchantments come from the component diff",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "the item is not in the inventory, or there is no grindstone" },
		{ code: "MISSING_MATERIAL", meaning: "the item has nothing to grind (no enchantment and no damage)" },
		{ code: "WRONG_STATE", meaning: "the grindstone input slot is occupied" },
		{ code: "TARGET_NOT_MET", meaning: "the grindstone produced no result" },
		{ code: "INTERRUPTED", meaning: "action was stopped" },
	],
	examples: [
		{
			input: { item: "diamond_sword" },
			output: {
				repaired: 0,
				removedEnchantments: [{ name: "sharpness", level: 1 }],
				xp: null,
				at: { position: { x: 2, y: 64, z: 1 }, dimension: "overworld" },
			},
		},
	],
};

export function grindstoneCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: grindstoneDescriptor,
		async invoke(ctx, raw) {
			const input = raw as { item: string; at?: unknown };
			const deadline = Date.now() + STATION_BUDGET_MS;
			const knowledge = requireKnowledge(deps);
			const name = knowledge.canonicalItemName(input.item);
			if (name == null) fail("NOT_FOUND", `${input.item} is not a known item`);
			const before = await readInventory(ctx.world);
			const candidates = slotsOf(before, name);
			const target = candidates.find(
				(slot) =>
					enchantmentsOf(slot as unknown as ItemValue, knowledge) != null || typeof slot.durability === "number",
			);
			if (target == null)
				fail(
					candidates.length === 0 ? "NOT_FOUND" : "MISSING_MATERIAL",
					candidates.length === 0 ? `no ${name} in the inventory` : `${name} has no enchantment and no damage to grind`,
				);
			const station = await resolveStation(
				ctx,
				{
					block: "grindstone",
					at: input.at,
					deadline,
					hint: "craft a grindstone (4 sticks + 2 stone slabs + 2 planks), place it, or pass at",
				},
				before,
			);
			const endpoint = placeOf(station);
			try {
				return await withStation(ctx, station, "minecraft:grindstone", deadline, async (window, first) => {
					if (windowSlot(first, windowRegion(first, "input")[0]) != null)
						fail("WRONG_STATE", "the grindstone input slot is occupied");
					checkBudget(ctx, deadline, "grindstone");
					// 同样指名搬这一件：砂轮要磨的是刚刚检验过的那一件。
					const playerRegion = windowRegion(first, "player");
					const sourceSlot = playerRegion[target.slot - 9];
					if (sourceSlot == null) fail("NOT_FOUND", `${name} is not inside the window player area`);
					await moveExact(window, first, sourceSlot, windowRegion(first, "input")[0]);
					const ready = await watch(
						ctx,
						window,
						(snapshot) => windowSlot(snapshot, windowRegion(snapshot, "result")[0]) != null,
						2_000,
						"the grindstone produced no result",
					);
					const result = windowSlot(ready, windowRegion(ready, "result")[0]);
					const kept = enchantmentsOf(result, knowledge) ?? [];
					const removed = (enchantmentsOf(target as unknown as ItemValue, knowledge) ?? []).filter(
						(entry) => !kept.some((keptEntry) => keptEntry.name === entry.name),
					);
					const beforeDurability = typeof target.durability === "number" ? target.durability : null;
					const afterDurability = typeof result?.durability === "number" ? result.durability : null;
					await takeRegion(window, "result");
					return plain({
						repaired:
							beforeDurability == null || afterDurability == null
								? null
								: Math.max(0, afterDurability - beforeDurability),
						removedEnchantments: removed,
						// 砂轮返还的是经验球，需要拾取且无法归因到本次动作；按合同缺省保持未知。
						xp: null,
						at: endpoint,
					});
				});
			} catch (error) {
				return attachProgress(error, () => ({ item: name }));
			}
		},
	};
}

/* ----------------------------------------------------------------- trade */

const MERCHANT_NAMES = new Set(["villager", "wandering_trader"]);

interface EntityRow {
	ref: EntityRef;
	name: string;
	position: Vec3;
	distance: number;
}

const tradeDescriptor: CallableDescriptor = {
	ref: "trade@1",
	summary: "Trade with a villager: pick an offer (by product or by index), pay its price and take the result",
	tags: ["trade", "villager", "merchant"],
	input: {
		type: "object",
		properties: {
			target: { type: "object" },
			offer: { type: "integer", minimum: 1 },
			item: { type: "string", minLength: 1 },
		},
		additionalProperties: false,
	},
	output: { type: "object" },
	access: "act",
	implementation: "native",
	requires: ["connection", "body", "window"],
	completion: {
		scope: "capability",
		description:
			"the merchant result slot held the offer's product and it was taken back; the price comes from the offer list",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "no merchant nearby, or no offer sells the requested item" },
		{ code: "MISSING_MATERIAL", meaning: "the inventory cannot pay the offer price" },
		{ code: "WRONG_STATE", meaning: "the offer is disabled or out of uses" },
		{ code: "TARGET_NOT_MET", meaning: "the merchant never produced the result" },
		{ code: "INTERRUPTED", meaning: "action was stopped" },
	],
	examples: [
		{
			input: { item: "bread" },
			output: {
				traded: [{ item: "bread", count: 1 }],
				cost: { emerald: 1 },
				at: { position: { x: 3, y: 64, z: 1 }, dimension: "overworld" },
			},
		},
	],
};

export function tradeCallable(_deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: tradeDescriptor,
		async invoke(ctx, raw) {
			const input = raw as { target?: EntityRef; offer?: number; item?: string };
			const deadline = Date.now() + STATION_BUDGET_MS;
			const wanted = input.item == null ? null : stripNamespace(input.item);
			let merchant: EntityRow | null = null;
			if (input.target != null) {
				const rows = await ctx.world.read<{ entities: EntityRow[] }>({
					ref: "entities@1",
					input: { radius: 32, kind: "all", limit: 64 },
				});
				const match = rows.value?.entities.find(
					(entity) =>
						entity.ref.networkId === input.target?.networkId &&
						entity.ref.incarnation === input.target.incarnation &&
						entity.ref.connection === input.target.connection &&
						entity.ref.appearance === input.target.appearance,
				);
				if (match == null) fail("NOT_FOUND", "the merchant reference is no longer tracked");
				merchant = match;
			} else {
				const rows = await ctx.world.read<{ entities: EntityRow[] }>({
					ref: "entities@1",
					input: { radius: 8, kind: "passive", limit: 32 },
				});
				merchant =
					(rows.value?.entities ?? [])
						.filter((entity) => MERCHANT_NAMES.has(stripNamespace(entity.name)))
						.sort((a, b) => a.distance - b.distance)[0] ?? null;
				if (merchant == null)
					fail("NOT_FOUND", "no villager or wandering trader within 8 blocks", {
						hint: "walk closer with goto@1, or pass a tracked target ref from entities@1",
					});
			}
			const self = await ctx.world.read<SelfState>({ ref: "self@1", input: {} });
			const endpoint = plain({ position: merchant.position, dimension: self.value?.place.dimension ?? null });
			const before = await readInventory(ctx.world);
			try {
				const outcome = await withEntity(
					ctx,
					merchant.ref,
					merchant.position,
					"minecraft:merchant",
					deadline,
					async (window) => {
						const listed = await pollUntil(
							async () => (await window.offers()).value,
							(value) => value != null && value.length > 0,
							{ timeoutMs: 3_000, intervalMs: 200, signal: ctx.signal },
						);
						const offers = listed.last ?? [];
						if (offers.length === 0)
							fail("TARGET_NOT_MET", "the merchant never sent its offer list", { dispatch: "sent" });
						const offer =
							wanted == null
								? offers[input.offer == null ? 0 : input.offer - 1]
								: offers.find((entry) => entry.output.item === wanted);
						if (offer == null)
							fail(
								"NOT_FOUND",
								wanted == null ? `the merchant has no offer ${input.offer}` : `no offer sells ${wanted}`,
								{ hint: `offers: ${offers.map((entry) => entry.output.item).join(", ")}` },
							);
						if (offer.disabled || (offer.maxUses > 0 && offer.uses >= offer.maxUses))
							fail("WRONG_STATE", `the ${offer.output.item} offer is used up or locked`, {
								hint: `uses ${offer.uses}/${offer.maxUses}; trade something else or restock the villager`,
							});
						const snapshot = (await window.snapshot()).value;
						for (const cost of offer.cost) {
							const have = countInRegion(snapshot, "player", cost.item);
							if (have < cost.count)
								fail("MISSING_MATERIAL", `the offer costs ${cost.count} ${cost.item}, the inventory has ${have}`, {
									hint: "get the payment items first; select_trade would move the whole stack",
								});
						}
						checkBudget(ctx, deadline, "trading");
						await window.selectTrade(offer.index);
						// 1) 等付款被搬进付款槽；2) 收敛成正好一份；3) 等结果槽出现。
						const paid = await watch(
							ctx,
							window,
							(state) => windowSlot(state, windowRegion(state, "input")[0]) != null,
							3_000,
							"the merchant never took the payment",
						);
						const payment = windowRegion(paid, "input")[0];
						await trimPayment(window, paid, payment, offer.cost[0]?.count ?? 1);
						const ready = await watch(
							ctx,
							window,
							(state) => windowSlot(state, windowRegion(state, "result")[0]) != null,
							3_000,
							"the merchant never produced the offer result",
						);
						const product = windowSlot(ready, windowRegion(ready, "result")[0]);
						// 付款已收敛成一份：取货是纯交换，回执必须可确认（不留 unknown 效果）。
						await takeRegion(window, "result");
						return { product, cost: offer.cost };
					},
				);
				const product = outcome.product;
				if (product == null) fail("TARGET_NOT_MET", "the merchant result slot was empty", { dispatch: "sent" });
				// 关窗后库存是异步补上的：等观察到增量再结算，不用一次过早读数判死。
				const settled = await pollUntil(
					() => readInventory(ctx.world),
					(inventory) => itemCountOf(inventory, product.name) - itemCountOf(before, product.name) >= product.count,
					{ timeoutMs: 3_000, intervalMs: 250, signal: ctx.signal },
				);
				const after = settled.last ?? before;
				const gained = itemCountOf(after, product.name) - itemCountOf(before, product.name);
				if (gained < product.count)
					fail("TARGET_NOT_MET", `expected ${product.count} ${product.name} in the inventory, gained ${gained}`, {
						dispatch: "sent",
					});
				const price: Record<string, JsonValue> = {};
				for (const cost of outcome.cost) {
					const spent = itemCountOf(before, cost.item) - itemCountOf(after, cost.item);
					// 关窗时服务端把整摞余款退回：净支出应当正好是报价，不是整摞。
					if (spent !== cost.count)
						fail("TARGET_NOT_MET", `the offer costs ${cost.count} ${cost.item}, the inventory lost ${spent}`, {
							dispatch: "sent",
						});
					price[cost.item] = cost.count;
				}
				return plain({ traded: [{ item: product.name, count: product.count }], cost: price, at: endpoint });
			} catch (error) {
				return attachProgress(error, () => ({ at: endpoint }));
			}
		},
	};
}
