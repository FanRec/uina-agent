/**
 * place@1：按声明方块名/状态放置一格。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 place。
 * 目标格：显式 at，或按当前视角的短射线求"眼前那一格"。支撑面取六邻居里第一个
 * 可点击的实心方块；完成按目标格名字 + 显式 properties 复核，不按派发成功算。
 */

import type { BodyCallScope, CallContext, CallableDescriptor, NativeCallable } from "../../contracts/capabilities.js";
import type { BlockStateValue, SelfState } from "../../contracts/body.js";
import { plain } from "../../contracts/values.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import { pollUntil, readValue } from "../shared/observe.js";
import { BLOCK_REACH, blockReach, round2 } from "../shared/reach.js";
import { BLOCK_SPEC_SCHEMA, FACE_SCHEMA, GRID_POS_SCHEMA } from "../shared/schema.js";
import {
	fail,
	faceVector,
	matchBlockSpec,
	NEIGHBORS,
	resolveGrid,
	resolvePoint,
	specName,
	stripNamespace,
} from "../shared/targets.js";
import { itemCountOf, readBlockAt, readInventory } from "../shared/views.js";

const BLOCK_CHECK_TIMEOUT_MS = 1500;
const BLOCK_CHECK_INTERVAL_MS = 150;
/** 可被直接替换的方块：空气/流体/常见地表植物。其余需要 replace=true。 */
const REPLACEABLE = new Set([
	"air",
	"cave_air",
	"void_air",
	"water",
	"lava",
	"short_grass",
	"tall_grass",
	"fern",
	"large_fern",
	"dead_bush",
	"snow",
	"vine",
	"seagrass",
	"tall_seagrass",
]);

const descriptor: CallableDescriptor = {
	ref: "place@1",
	summary: "Place one block by name/state at the target cell (or the cell in front of the player)",
	tags: ["body", "building"],
	input: {
		type: "object",
		properties: {
			block: BLOCK_SPEC_SCHEMA,
			at: GRID_POS_SCHEMA,
			face: FACE_SCHEMA,
			replace: { type: "boolean", description: "allow replacing a non-replaceable block (default false)" },
		},
		required: ["block"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			at: { type: "object" },
			block: { type: "object" },
		},
		required: ["at", "block"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description: "The target cell holds the declared name and every explicitly declared property",
	},
	errors: [
		{ code: "MISSING_MATERIAL", meaning: "no matching block item in the inventory" },
		{ code: "CONFLICT", meaning: "target cell holds a different block and replace is false" },
		{ code: "UNREACHABLE", meaning: "no clickable support face within reach" },
		{ code: "TARGET_NOT_MET", meaning: "the placed state does not match the declaration" },
		{ code: "WRONG_STATE", meaning: "no target cell could be derived from the current aim" },
	],
	requires: ["connection", "body"],
	examples: [
		{
			input: { block: { name: "oak_stairs", properties: { facing: "east", half: "top" } }, at: { x: 1, y: 64, z: 2 } },
			output: { at: { position: { x: 1, y: 64, z: 2 }, dimension: "overworld" }, block: { name: "oak_stairs" } },
		},
	],
	implementation: "native",
};

interface PlaceInput {
	block: string | { name: string; properties?: Record<string, string> };
	at?: unknown;
	face?: "auto" | "up" | "down" | "north" | "south" | "east" | "west";
	replace?: boolean;
}

interface AimHit {
	target: Vec3;
	support: Vec3;
	face: "up" | "down" | "north" | "south" | "east" | "west";
}

/** 视角短射线：返回"眼前要放的那一格"与可点击的支撑面。 */
async function aimedCell(world: BodyCallScope["world"], self: SelfState): Promise<AimHit | null> {
	const look = self.look;
	if (look == null) return null;
	const yaw = look.yaw;
	const pitch = look.pitch;
	const dir = {
		x: -Math.sin(yaw) * Math.cos(pitch),
		y: -Math.sin(pitch),
		z: Math.cos(yaw) * Math.cos(pitch),
	};
	const eye = { x: self.place.position.x, y: self.place.position.y + 1.62, z: self.place.position.z };
	let previous = { x: Math.floor(eye.x), y: Math.floor(eye.y), z: Math.floor(eye.z) };
	for (let step = 1; step <= 22; step++) {
		const point = { x: eye.x + dir.x * step * 0.2, y: eye.y + dir.y * step * 0.2, z: eye.z + dir.z * step * 0.2 };
		const cell = { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) };
		if (cell.x === previous.x && cell.y === previous.y && cell.z === previous.z) continue;
		const block = await readBlockAt(world, cell);
		if (block != null && !REPLACEABLE.has(block.name)) {
			const dx = previous.x - cell.x;
			const dy = previous.y - cell.y;
			const dz = previous.z - cell.z;
			const face =
				Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= Math.abs(dz)
					? dx > 0
						? "east"
						: "west"
					: Math.abs(dy) >= Math.abs(dz)
						? dy > 0
							? "up"
							: "down"
						: dz > 0
							? "south"
							: "north";
			return { target: previous, support: cell, face };
		}
		previous = cell;
	}
	return null;
}

/** 显式 at：选第一个可点击的邻居作为支撑面（下→上→北→南→西→东）。 */
async function supportFor(world: BodyCallScope["world"], target: Vec3): Promise<AimHit | null> {
	for (const neighbor of NEIGHBORS) {
		const support = {
			x: target.x + neighbor.offset.x,
			y: target.y + neighbor.offset.y,
			z: target.z + neighbor.offset.z,
		};
		const block = await readBlockAt(world, support);
		if (block == null || REPLACEABLE.has(block.name)) continue;
		return { target, support, face: neighbor.face };
	}
	return null;
}

export function placeCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	void deps;
	return {
		descriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const raw = input as unknown as PlaceInput;
			const name = specName(raw.block);
			const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			if (raw.at != null) {
				const point = resolvePoint(raw.at, self);
				if (point.dimension !== self.place.dimension) {
					fail("WRONG_STATE", `target is in ${point.dimension}, current dimension is ${self.place.dimension}`);
				}
			}

			// 先做不需要身体的判断（目标/冲突/支撑面/材料）：拿不到身体前就失败，
			// 不占队列、也不给别的调用制造无谓等待。
			const target = raw.at != null ? resolveGrid(raw.at, self) : null;
			const existing = target == null ? null : await readBlockAt(ctx.world, target);
			if (target != null && existing != null && matchBlockSpec(raw.block, existing as BlockStateValue)) {
				// 目标已匹配：不重复消耗物品，也不假装做了一次放置。
				return plain({
					at: { position: target, dimension: self.place.dimension },
					block: { name: existing.name, properties: existing.properties },
				});
			}
			if (target != null && existing != null && !REPLACEABLE.has(existing.name) && raw.replace !== true) {
				fail("CONFLICT", `cell already holds ${existing.name}`, {
					hint: "pass replace=true only when the design explicitly allows clearing",
				});
			}
			const inventory = await readInventory(ctx.world);
			if (itemCountOf(inventory, name) <= 0) {
				fail("MISSING_MATERIAL", `no ${name} in the inventory`, {
					hint: `inventory holds: ${inventory.slots.map((slot) => slot.name).join(", ") || "nothing"}`,
				});
			}
			const aim = target != null ? await supportFor(ctx.world, target) : await aimedCell(ctx.world, self);
			if (aim == null) {
				fail("UNREACHABLE", "no clickable support face for the target cell", {
					hint: target == null ? "aim at a block within 4 blocks, or pass at" : "stand closer / clear the surroundings",
				});
			}
			// 真正被点的是支撑面，射程就按它量（§4 可达性归调用方）。
			const reach = blockReach(self, aim.support);
			if (reach > BLOCK_REACH) {
				fail("UNREACHABLE", `support ${aim.support.x},${aim.support.y},${aim.support.z} is out of reach`, {
					hint: `goto@1 closer first; place does not path (need <= ${BLOCK_REACH}, was ${round2(reach)})`,
				});
			}

			return await ctx.withBody(async (scope: BodyCallScope) => {
				if (inventory.held?.name !== name) {
					await scope.player.equip({ name }, "hand");
				}
				await scope.player.interact({
					target: { place: placeOf(self, aim.support), block: aim.support },
					hand: "main",
					face: faceVector(raw.face != null && raw.face !== "auto" ? raw.face : aim.face),
				});

				const settled = await pollUntil(
					async () => await readBlockAt(scope.world, aim.target),
					(block) => matchBlockSpec(raw.block, block as BlockStateValue | null),
					{ timeoutMs: BLOCK_CHECK_TIMEOUT_MS, intervalMs: BLOCK_CHECK_INTERVAL_MS, signal: ctx.signal },
				);
				if (!settled.ok) {
					fail(
						"TARGET_NOT_MET",
						`cell ${aim.target.x},${aim.target.y},${aim.target.z} is ${settled.last?.name ?? "empty"}`,
						{
							hint: "the server may have rejected the placement or the state does not match the declaration",
							dispatch: "sent",
							progress: { at: aim.target, expected: name },
						},
					);
				}
				const placed = settled.last;
				return plain({
					at: { position: aim.target, dimension: self.place.dimension },
					block: { name: stripNamespace(placed?.name ?? name), properties: placed?.properties ?? {} },
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
