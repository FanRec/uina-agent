/**
 * place@1：按声明方块名/状态放置一格。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 place。
 * 目标格：显式 at，或按当前视角的短射线求"眼前那一格"。支撑面取六邻居里第一个
 * 可点击的实心方块；完成按目标格名字 + 显式 properties 复核，不按派发成功算。
 *
 * 判定与派发序列在 `place-cell.ts`（build@1 复用同一份），这里只做输入解析与失败码映射。
 */

import type { BlockSpec, SelfState } from "../../contracts/body.js";
import type { CallContext, CallableDescriptor, NativeCallable } from "../../contracts/capabilities.js";
import { plain } from "../../contracts/values.js";
import type { JsonValue } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import { readValue } from "../shared/observe.js";
import { BLOCK_REACH, round2 } from "../shared/reach.js";
import { BLOCK_SPEC_SCHEMA, FACE_SCHEMA, GRID_POS_SCHEMA } from "../shared/schema.js";
import { fail, resolveGrid, resolvePoint } from "../shared/targets.js";
import { commitPlacement, inspectPlacement } from "./place-cell.js";

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
	block: BlockSpec;
	at?: unknown;
	face?: "auto" | "up" | "down" | "north" | "south" | "east" | "west";
	replace?: boolean;
}

export function placeCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	void deps;
	return {
		descriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const raw = input as unknown as PlaceInput;
			const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			if (raw.at != null) {
				const point = resolvePoint(raw.at, self);
				if (point.dimension !== self.place.dimension) {
					fail("WRONG_STATE", `target is in ${point.dimension}, current dimension is ${self.place.dimension}`);
				}
			}
			const target = raw.at != null ? resolveGrid(raw.at, self) : null;

			// 先做不需要身体的判断（目标/冲突/支撑面/材料）：拿不到身体前就失败，
			// 不占队列、也不给别的调用制造无谓等待。
			const pre = await inspectPlacement(ctx.world, self, target, raw.block, { replace: raw.replace === true });
			switch (pre.kind) {
				case "already":
					// 目标已匹配：不重复消耗物品，也不假装做了一次放置。
					return plain({
						at: { position: pre.target, dimension: self.place.dimension },
						block: { name: pre.block.name, properties: pre.block.properties },
					});
				case "conflict":
					fail("CONFLICT", `cell already holds ${pre.by}`, {
						hint: "pass replace=true only when the design explicitly allows clearing",
					});
				case "missing":
					fail("MISSING_MATERIAL", `no ${pre.name} in the inventory`, {
						hint: `inventory holds: ${pre.held.join(", ") || "nothing"}`,
					});
				case "no-support":
					fail("UNREACHABLE", "no clickable support face for the target cell", {
						hint: "stand closer / clear the surroundings",
					});
				case "out-of-reach":
					fail("UNREACHABLE", pre.detail, {
						hint: `goto@1 closer first; place does not path (need <= ${BLOCK_REACH}, was ${round2(pre.distance)})`,
					});
				case "ready":
					break;
			}

			return await ctx.withBody(async (scope) => {
				const outcome = await commitPlacement(ctx, scope, self, raw.block, pre.aims, pre.heldName, {
					...(raw.face != null ? { face: raw.face } : {}),
				});
				if (outcome.kind === "not_met") {
					fail(
						"TARGET_NOT_MET",
						`cell ${outcome.target.x},${outcome.target.y},${outcome.target.z} is ${outcome.actual ?? "empty"}`,
						{
							hint: "the server may have rejected the placement or the state does not match the declaration",
							dispatch: "sent",
							progress: { at: outcome.target, expected: outcome.expected },
						},
					);
				}
				return plain({
					at: { position: pre.aims[0]!.target, dimension: self.place.dimension },
					block: { name: outcome.block.name, properties: outcome.block.properties },
				});
			});
		},
	};
}
