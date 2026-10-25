/**
 * use@1：普通右键与牌面编辑。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 use、driver §7.4/§7.6.1。
 * 普通右键只证明"这次交互被派发 + 观察到可核验变化"；容器/工作台/炉子明确拒绝，
 * 它们的完成口径属于 container/craft/smelt。牌面编辑先腾空主手再交给 body.writeSign。
 */

import type { BodyCallScope, CallContext, CallableDescriptor, NativeCallable } from "../../contracts/capabilities.js";
import type { BlockStateValue, EntityRef, ItemSelector, SelfState } from "../../contracts/body.js";
import { plain } from "../../contracts/values.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import { resolveEntity } from "../shared/entities.js";
import { readValue } from "../shared/observe.js";
import { ITEM_SELECTOR_SCHEMA, GRID_POS_SCHEMA } from "../shared/schema.js";
import { BLOCK_REACH, blockReach, ENTITY_REACH, round2 } from "../shared/reach.js";
import { faceVector, fail, resolveGrid, resolvePoint, stripNamespace } from "../shared/targets.js";
import { readBlockAt, readInventory } from "../shared/views.js";

const SIGN_LINE_LIMIT = 45;
const EFFECT_WINDOW_MS = 800;
/** 会打开窗口的方块不走 use：它们的完成口径在 container/craft/smelt。 */
const WINDOW_BLOCKS = new Set([
	"chest",
	"trapped_chest",
	"barrel",
	"ender_chest",
	"shulker_box",
	"crafting_table",
	"furnace",
	"blast_furnace",
	"smoker",
	"brewing_stand",
	"enchanting_table",
	"anvil",
	"chipped_anvil",
	"damaged_anvil",
	"grindstone",
	"loom",
	"smithing_table",
	"cartography_table",
	"stonecutter",
	"villager",
]);

interface UseInput {
	at?: unknown;
	text?: string;
	side?: "front" | "back";
	item?: string | ItemSelector;
	entity?: string | EntityRef;
	face?: "up" | "down" | "north" | "south" | "east" | "west";
	hand?: "main" | "off";
	times?: number;
}

const descriptor: CallableDescriptor = {
	ref: "use@1",
	summary:
		"Right-click with the held item (block/entity/air) or write a sign face; containers and stations belong to container/craft/smelt",
	tags: ["body", "interaction"],
	input: {
		oneOf: [
			{
				type: "object",
				properties: {
					at: GRID_POS_SCHEMA,
					text: { type: "string", maxLength: SIGN_LINE_LIMIT * 4 + 3 },
					side: { type: "string", enum: ["front", "back"] },
				},
				required: ["at", "text"],
				additionalProperties: false,
			},
			{
				type: "object",
				properties: {
					at: GRID_POS_SCHEMA,
					item: { oneOf: [{ type: "string", minLength: 1 }, ITEM_SELECTOR_SCHEMA] },
					face: { type: "string", enum: ["up", "down", "north", "south", "east", "west"] },
					hand: { type: "string", enum: ["main", "off"] },
					times: { type: "integer", minimum: 1, maximum: 16 },
				},
				required: ["at"],
				additionalProperties: false,
			},
			{
				type: "object",
				properties: {
					entity: { oneOf: [{ type: "string", minLength: 1 }, { type: "object" }] },
					item: { oneOf: [{ type: "string", minLength: 1 }, ITEM_SELECTOR_SCHEMA] },
					hand: { type: "string", enum: ["main", "off"] },
					times: { type: "integer", minimum: 1, maximum: 16 },
				},
				required: ["entity"],
				additionalProperties: false,
			},
			{
				type: "object",
				properties: {
					item: { oneOf: [{ type: "string", minLength: 1 }, ITEM_SELECTOR_SCHEMA] },
					hand: { type: "string", enum: ["main", "off"] },
					times: { type: "integer", minimum: 1, maximum: 16 },
				},
				additionalProperties: false,
			},
		],
	},
	output: {
		type: "object",
		properties: {
			effect: { type: "string" },
			at: { type: "object" },
			entity: { type: "object" },
			changed: { type: ["object", "boolean"] },
			side: { type: "string" },
			lines: { type: "array" },
		},
		required: ["effect"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"Normal use: an observable change (block state or item count) appears; sign form: the server sends a block-entity update for the edited sign",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "the block/entity is not there or not loaded" },
		{ code: "UNREACHABLE", meaning: "the target is out of interaction range (walk there first)" },
		{ code: "WRONG_STATE", meaning: "containers/stations, waxed signs, or a combination with no effect" },
		{ code: "TARGET_NOT_MET", meaning: "no observable effect after dispatch" },
		{ code: "MISSING_MATERIAL", meaning: "the requested item is not in the inventory" },
		{ code: "TIMEOUT", meaning: "the sign editor or a confirmation did not arrive in time" },
	],
	requires: ["connection", "body"],
	examples: [
		{ input: { at: { x: 4, y: 64, z: 0 } }, output: { effect: "block_used", changed: { state: "opened" } } },
		{
			input: { at: { x: 4, y: 64, z: 2 }, text: "home\nbase", side: "front" },
			output: { effect: "sign_written", side: "front", lines: ["home", "base", "", ""] },
		},
	],
	implementation: "native",
};

/** 视角朝向 → 点击面；近距离取主导轴向，避免依赖上游 lookAt。 */
function faceToward(self: SelfState, block: Vec3): Vec3 {
	const dx = self.place.position.x - (block.x + 0.5);
	const dy = self.place.position.y + 1.62 - (block.y + 0.5);
	const dz = self.place.position.z - (block.z + 0.5);
	const ax = Math.abs(dx);
	const ay = Math.abs(dy);
	const az = Math.abs(dz);
	if (ax >= ay && ax >= az) return { x: Math.sign(dx) || 1, y: 0, z: 0 };
	if (ay >= az) return { x: 0, y: Math.sign(dy) || 1, z: 0 };
	return { x: 0, y: 0, z: Math.sign(dz) || 1 };
}

async function writeSign(ctx: CallContext, self: SelfState, raw: UseInput): Promise<JsonValue> {
	const at = raw.at;
	const text = raw.text ?? "";
	const lines = text.split("\n");
	if (lines.length > 4) {
		fail("INVALID_INPUT", `sign text has ${lines.length} lines, maximum is 4`, {
			hint: "split with LF; empty lines are allowed",
		});
	}
	for (const line of lines) {
		if (line.length > SIGN_LINE_LIMIT) {
			fail("INVALID_INPUT", `sign line is ${line.length} UTF-16 units, limit is ${SIGN_LINE_LIMIT}`);
		}
	}
	while (lines.length < 4) lines.push("");
	const side = raw.side ?? "front";
	const position = resolveGrid(at, self);
	const point = resolvePoint(at, self);
	if (point.dimension !== self.place.dimension) {
		fail("WRONG_STATE", `sign is in ${point.dimension}, current dimension is ${self.place.dimension}`);
	}
	const block = await readBlockAt(ctx.world, position);
	if (block == null) fail("NOT_FOUND", `no block at ${position.x},${position.y},${position.z}`);
	if (!block.name.includes("sign")) fail("NOT_FOUND", `${block.name} is not a sign`);
	if (block.properties.is_waxed === "true") fail("WRONG_STATE", "sign is waxed and cannot be edited");
	const signReach = blockReach(self, position);
	if (signReach > BLOCK_REACH) {
		fail("UNREACHABLE", `sign is out of reach (${round2(signReach)} > ${BLOCK_REACH})`, {
			hint: "goto@1 closer first; use does not path",
		});
	}

	return await ctx.withBody(async (scope: BodyCallScope) => {
		const inventory = await readInventory(scope.world);
		if (inventory.held != null) {
			await scope.player.equip(null, "hand");
		}
		const receipt = await scope.player.writeSign(
			{ place: placeOf(self, position), block: position },
			{ side, lines: lines as [string, string, string, string] },
		);
		if (receipt.completion === "unknown") {
			fail("TIMEOUT", "sign update was sent but no block-entity update confirmed it", {
				hint: "the write may have landed; re-read block@1 before writing again",
				dispatch: receipt.dispatch,
				effects: [receipt.effect],
				recoverable: false,
			});
		}
		return plain({
			effect: "sign_written",
			at: { position, dimension: self.place.dimension },
			side,
			lines,
			changed: true,
		});
	});
}

export function useCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	void deps;
	return {
		descriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const raw = input as unknown as UseInput;
			const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			if (raw.text != null) return await writeSign(ctx, self, raw);
			const hand = raw.hand ?? "main";
			const times = raw.times ?? 1;

			return await ctx.withBody(async (scope: BodyCallScope) => {
				if (raw.item != null) {
					const selector: ItemSelector = typeof raw.item === "string" ? { name: raw.item } : raw.item;
					const receipt = await scope.player.equip(selector, hand === "main" ? "hand" : "offhand");
					if (receipt.completion === "unknown") {
						fail("TARGET_NOT_MET", "the requested item could not be equipped into the hand", {
							dispatch: receipt.dispatch,
							effects: [receipt.effect],
						});
					}
				}

				if (raw.at != null) {
					const point = resolvePoint(raw.at, self);
					if (point.dimension !== self.place.dimension) {
						fail("WRONG_STATE", `target is in ${point.dimension}, current dimension is ${self.place.dimension}`);
					}
					const position = resolveGrid(raw.at, self);
					const targetReach = blockReach(self, position);
					if (targetReach > BLOCK_REACH) {
						fail("UNREACHABLE", `target is out of reach (${round2(targetReach)} > ${BLOCK_REACH})`, {
							hint: "goto@1 closer first; use does not path",
						});
					}
					const block = await readBlockAt(scope.world, position);
					if (block == null) fail("NOT_FOUND", `no block at ${position.x},${position.y},${position.z}`);
					if (block.name === "air") fail("NOT_FOUND", `block at ${position.x},${position.y},${position.z} is air`);
					if (WINDOW_BLOCKS.has(block.name)) {
						fail("WRONG_STATE", `${block.name} opens a window; use container@1/craft@1/smelt@1`, {
							hint: "use only covers effects observable without a window",
						});
					}
					const face = raw.face != null ? faceVector(raw.face) : faceToward(self, position);
					for (let time = 0; time < times; time++) {
						await scope.player.interact({
							target: { place: placeOf(self, position), block: position },
							hand,
							face,
						});
					}
					await new Promise((resolve) => setTimeout(resolve, EFFECT_WINDOW_MS));
					const after = await readBlockAt(scope.world, position);
					const changed = changeOf(block as BlockStateValue, after as BlockStateValue | null);
					if (changed == null) {
						fail("TARGET_NOT_MET", `no observable change on ${block.name}`, {
							hint: "this (item, target) combination may have no effect in this version",
							dispatch: "sent",
						});
					}
					return plain({
						effect: "block_used",
						at: { position, dimension: self.place.dimension },
						changed,
					});
				}

				if (raw.entity != null) {
					const entity = await resolveEntity(ctx.world, raw.entity);
					if (entity.distance > ENTITY_REACH) {
						fail("UNREACHABLE", `${entity.name} is ${entity.distance} blocks away`, { hint: "goto@1 closer first" });
					}
					for (let time = 0; time < times; time++) {
						await scope.player.interact({ target: entity.ref, hand });
					}
					return plain({ effect: "entity_used", entity: { name: entity.name, networkId: entity.ref.networkId } });
				}

				// 空手/手持物品右键：激活一次；可观察的变化是物品数量（例如投掷/放置/消耗）。
				const before = await readInventory(scope.world);
				for (let time = 0; time < times; time++) {
					await scope.player.useItem(hand);
				}
				await new Promise((resolve) => setTimeout(resolve, EFFECT_WINDOW_MS));
				const after = await readInventory(scope.world);
				const consumed = diffCounts(before.counts, after.counts);
				if (Object.keys(consumed).length === 0) {
					fail("TARGET_NOT_MET", "no observable effect from using the held item", {
						hint: "this item may need a target block/entity; pass at or entity",
						dispatch: "sent",
					});
				}
				return plain({ effect: "item_used", changed: consumed });
			});
		},
	};
}

function changeOf(before: BlockStateValue, after: BlockStateValue | null): Record<string, JsonValue> | null {
	if (after == null) return null;
	if (before.name !== after.name) return { block: { from: before.name, to: after.name } };
	const beforeKeys = Object.keys(before.properties).sort();
	const afterKeys = Object.keys(after.properties).sort();
	if (beforeKeys.join(",") !== afterKeys.join(","))
		return { properties: { from: before.properties, to: after.properties } };
	for (const key of beforeKeys) {
		if (before.properties[key] !== after.properties[key]) {
			return { [key]: { from: before.properties[key], to: after.properties[key] } };
		}
	}
	return null;
}

function diffCounts(before: Record<string, number>, after: Record<string, number>): Record<string, JsonValue> {
	const out: Record<string, JsonValue> = {};
	for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const from = before[name] ?? 0;
		const to = after[name] ?? 0;
		if (from !== to) out[stripNamespace(name)] = { from, to };
	}
	return out;
}

function placeOf(self: SelfState, position: Vec3) {
	return {
		world: self.place.world,
		worldRevision: self.place.worldRevision,
		dimension: self.place.dimension,
		position,
	};
}
