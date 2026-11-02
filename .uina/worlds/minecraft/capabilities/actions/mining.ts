/**
 * mine@1：破坏一格够得着的方块。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 mine、driver §7.3。
 * 完成 = 服务端确认该格变为空气；掉落只在短窗口内观察，观察不到就不报数量。
 * 工具按方块真实掉落要求选择（知识数据），不匹配时在派发前拒绝，不让上游慢慢失败。
 * 不寻路：够不着就是 UNREACHABLE，站位由调用方用 goto@1 安排（§4 可达性归调用方）。
 */

import type { ItemSelector, SelfState } from "../../contracts/body.js";
import type { BodyCallScope, CallableDescriptor, CallContext, NativeCallable } from "../../contracts/capabilities.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import { pollUntil, readValue } from "../shared/observe.js";
import { BLOCK_REACH, blockReach, round2 } from "../shared/reach.js";
import { GRID_POS_SCHEMA, ITEM_SELECTOR_SCHEMA } from "../shared/schema.js";
import { fail, matchesItem, resolveGrid, resolvePoint, stripNamespace } from "../shared/targets.js";
import { chooseTool } from "../shared/tools.js";
import { type InventorySnapshot, itemCountOf, readBlockAt, readInventory } from "../shared/views.js";

/** 服务端拾取结算有 delay；只在这个窗口里看背包增量，等不到就不报 dropped。 */
const PICKUP_TIMEOUT_MS = 2500;
const PICKUP_INTERVAL_MS = 200;

const descriptor: CallableDescriptor = {
	ref: "mine@1",
	summary: "Break one reachable block at integer coordinates, choosing a suitable tool and observing the drop",
	tags: ["body", "mining"],
	input: {
		type: "object",
		properties: {
			at: GRID_POS_SCHEMA,
			tool: { oneOf: [{ type: "string", minLength: 1 }, ITEM_SELECTOR_SCHEMA] },
			collect: { type: "boolean", description: "wait briefly for the drop to reach the inventory (default true)" },
		},
		required: ["at"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			broken: { type: "boolean" },
			dropped: {
				type: "object",
				properties: { name: { type: "string" }, count: { type: "integer" } },
				required: ["name", "count"],
				additionalProperties: false,
			},
			tool: { type: "string" },
		},
		required: ["broken"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"The server confirmed the target block became air; `dropped` is reported only when the pickup is observed within a short window",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "the block is air or not loaded" },
		{ code: "UNREACHABLE", meaning: "the block is out of reach" },
		{ code: "WRONG_STATE", meaning: "the target is in another dimension" },
		{ code: "MISSING_TOOL", meaning: "no inventory tool can harvest this block (hint carries required)" },
		{ code: "MISSING_MATERIAL", meaning: "the requested tool is not in the inventory" },
		{ code: "TARGET_NOT_MET", meaning: "the server did not confirm the break (e.g. protected area)" },
		{ code: "INTERRUPTED", meaning: "the run was stopped during the operation" },
	],
	requires: ["connection", "body"],
	examples: [
		{ input: { at: { x: 8, y: 63, z: 0 } }, output: { broken: true, dropped: { name: "cobblestone", count: 1 } } },
	],
	implementation: "native",
};

interface MineInput {
	at: unknown;
	tool?: string | ItemSelector;
	collect?: boolean;
}

function dropDelta(
	before: InventorySnapshot,
	after: InventorySnapshot,
	expected: string[],
): { name: string; count: number } | null {
	for (const item of expected) {
		const delta = itemCountOf(after, item) - itemCountOf(before, item);
		if (delta > 0) return { name: item, count: delta };
	}
	return null;
}

export function mineCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const raw = input as unknown as MineInput;
			const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			const target = resolvePoint(raw.at, self);
			if (target.dimension !== self.place.dimension) {
				fail("WRONG_STATE", `target is in ${target.dimension}, current dimension is ${self.place.dimension}`);
			}
			const position = resolveGrid(raw.at, self);
			const block = await readBlockAt(ctx.world, position);
			if (block == null) {
				fail("NOT_FOUND", `block at ${position.x},${position.y},${position.z} is not loaded or is air`, {
					hint: "read block@1 first; unloaded chunks are not holes",
				});
			}
			if (block.name === "air") {
				fail("NOT_FOUND", `block at ${position.x},${position.y},${position.z} is already air`);
			}
			const reach = blockReach(self, position);
			if (reach > BLOCK_REACH) {
				fail("UNREACHABLE", `${block.name} at ${position.x},${position.y},${position.z} is out of reach`, {
					hint: `goto@1 closer first; mine does not path (need <= ${BLOCK_REACH}, was ${round2(reach)})`,
				});
			}
			const knowledge = deps.knowledge();
			const expected = knowledge?.blockDrops(block.name)?.items ?? [];

			return await ctx.withBody(async (scope: BodyCallScope) => {
				const inventory = await readInventory(scope.world);
				const tool = chooseTool(knowledge, inventory, block.name, raw.tool);
				const selector: ItemSelector | null =
					tool == null ? null : { ...(typeof raw.tool === "object" ? raw.tool : {}), name: tool, substitutions: [] };
				if (selector != null) {
					const heldSlot =
						inventory.selectedSlot == null
							? null
							: inventory.slots.find((slot) => slot.slot === inventory.selectedSlot! + 36);
					if (heldSlot == null || !matchesItem(selector, heldSlot)) {
						const equipped = await scope.player.equip(selector, "hand");
						if (equipped.completion !== "met")
							fail("TARGET_NOT_MET", "tool equipment has no confirmed server result", {
								dispatch: equipped.dispatch,
								effects: [equipped.effect],
							});
					}
				}
				const receipt = await scope.player.dig({ place: placeOf(self, position), block: position });
				if (receipt.completion !== "met")
					fail("TARGET_NOT_MET", "the server did not confirm the target block was broken", {
						dispatch: receipt.dispatch,
						effects: [receipt.effect],
						progress: { broken: false, at: position, block: block.name },
					});

				let dropped: { name: string; count: number } | null = null;
				if (raw.collect !== false && expected.length > 0 && knowledge != null) {
					// 掉落可能没捡到（背包满/被抢），观察不到就省略，不猜数量。
					const picked = await pollUntil(
						async () => await readInventory(scope.world),
						(inv) => dropDelta(inventory, inv, expected) != null,
						{ timeoutMs: PICKUP_TIMEOUT_MS, intervalMs: PICKUP_INTERVAL_MS, signal: ctx.signal },
					);
					if (picked.ok && picked.last != null) dropped = dropDelta(inventory, picked.last, expected);
				}

				return plain({
					broken: true,
					...(dropped != null ? { dropped } : {}),
					...(tool != null ? { tool: stripNamespace(tool) } : {}),
				});
			});
		},
	};
}

function placeOf(self: SelfState, position: Vec3) {
	return {
		world: self.place.world,
		worldRevision: self.place.worldRevision,
		dimension: self.place.dimension,
		position,
	};
}
