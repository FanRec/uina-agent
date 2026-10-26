/**
 * 地形类查询：block@1（单格状态 + 可采性）与 blocks@1（按名搜索）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 block/blocks。
 * 搜索的"扫哪里"归 Driver facts（section palette 跳过），"取哪些/计数多少"归这里；
 * 单格未加载与空气严格区分：null 状态 + unknown，不冒充 minecraft:air。
 */

import type { ClientFactView } from "../../contracts/client-facts.js";
import type { RegistryKnowledge } from "../../contracts/knowledge.js";
import type { Fact, JsonValue, Vec3 } from "../../contracts/values.js";
import { factOf } from "../shared/facts.js";
import { BLOCK_SPEC_SCHEMA, GRID_POS_SCHEMA } from "../shared/schema.js";
import { resolveGrid, resolvePoint, specName, stripNamespace } from "../shared/targets.js";
import { canHarvest, harvestRequirement } from "../shared/tools.js";
import type { QuerySpec } from "../shared/query.js";

export interface TerrainDeps {
	knowledge: () => RegistryKnowledge | null;
}

/** 可采性：手头最好的工具能不能让这格掉落（capabilities §3 block.harvest）。 */
function harvestOf(
	blockName: string,
	knowledge: RegistryKnowledge | null,
	inventory: { name: string; count: number }[],
): { harvest: { ok: boolean; requiredTools?: string[] } | null; unknown: string[] } {
	const requirement = harvestRequirement(knowledge, blockName);
	if (requirement.kind === "unknown")
		return { harvest: null, unknown: [`harvest requirements of ${blockName} are unknown`] };
	return {
		harvest: {
			ok: canHarvest(
				knowledge,
				{ slots: inventory.map((item, slot) => ({ ...item, slot })), counts: {} },
				blockName,
				undefined,
			),
			...(requirement.kind === "tools" ? { requiredTools: requirement.names } : {}),
		},
		unknown: [],
	};
}

const blockQuery = (deps: TerrainDeps): QuerySpec => ({
	descriptor: {
		ref: "block@1",
		summary: "Single block state at integer coordinates (+ whether the current inventory can harvest it)",
		input: {
			oneOf: [
				{
					type: "object",
					properties: { at: GRID_POS_SCHEMA },
					required: ["at"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { below: { type: "integer", minimum: 1, maximum: 4 } },
					required: ["below"],
					additionalProperties: false,
				},
			],
		},
		output: { type: "object" },
		access: "read",
		watchable: true,
		feedback: true,
		examples: [
			{
				input: { at: { x: 120, y: 63, z: -30 } },
				output: { value: { block: { name: "stone", position: { x: 120, y: 63, z: -30 }, harvest: { ok: true } } } },
			},
		],
	},
	reader: {
		kind: "current",
		read: (view: ClientFactView, input: JsonValue): Fact<unknown> => {
			const raw = input as { at?: unknown; below?: number };
			const self = view.self();
			if (self.value == null) return { ...self, value: null } as Fact<unknown>;
			let position: Vec3;
			if (raw.below != null) {
				position = {
					x: Math.floor(self.value.place.position.x),
					y: Math.floor(self.value.place.position.y) - raw.below,
					z: Math.floor(self.value.place.position.z),
				};
			} else {
				const target = resolvePoint(raw.at, self.value);
				position = resolveGrid(raw.at, self.value);
				if (target.dimension !== self.value.place.dimension) {
					return factOf(
						{ block: null },
						{ unknown: [`block is in ${target.dimension}, current dimension is ${self.value.place.dimension}`] },
					);
				}
			}
			const block = view.block({
				place: {
					world: self.value.place.world,
					worldRevision: self.value.place.worldRevision,
					dimension: self.value.place.dimension,
					position,
				},
				block: position,
			});
			const unknown = [...block.unknown];
			if (block.value.state == null) {
				unknown.push(`block at ${position.x},${position.y},${position.z} is not loaded (null is not air)`);
				return factOf({ block: null }, { unknown, source: block.source });
			}
			const inventory = view.inventory();
			const items =
				inventory.value == null
					? []
					: inventory.value.slots.flatMap((slot) =>
							slot.item == null ? [] : [{ name: slot.item.name, count: slot.item.count }],
						);
			if (inventory.value == null) unknown.push("inventory not received; harvest judgement uses no tools");
			const { harvest, unknown: harvestUnknown } = harvestOf(
				stripNamespace(block.value.state.name),
				deps.knowledge(),
				items,
			);
			unknown.push(...harvestUnknown);
			const value = {
				block: {
					name: stripNamespace(block.value.state.name),
					position,
					properties: block.value.state.properties,
					sign: block.value.sign,
					...(harvest != null ? { harvest } : {}),
				},
			};
			return factOf(value, { unknown, source: block.source });
		},
	},
});

const blocksQuery: QuerySpec = {
	descriptor: {
		ref: "blocks@1",
		summary: "Nearest blocks of one name within a horizontal radius (loaded range only)",
		input: {
			type: "object",
			properties: {
				name: BLOCK_SPEC_SCHEMA,
				radius: { type: "integer", minimum: 4, maximum: 64 },
				limit: { type: "integer", minimum: 1, maximum: 256 },
				exclude: { type: "array", items: { type: "object" }, maxItems: 32 },
			},
			required: ["name"],
			additionalProperties: false,
		},
		output: { type: "object" },
		access: "read",
		watchable: false,
		feedback: false,
		examples: [
			{
				input: { name: "oak_log", radius: 32 },
				output: {
					value: { blocks: [{ position: { x: 118, y: 64, z: -28 }, name: "oak_log" }], count: 1, truncated: false },
				},
			},
		],
	},
	reader: {
		kind: "current",
		read: (view: ClientFactView, input: JsonValue): Fact<unknown> => {
			const raw = input as unknown as {
				name: string | { name: string };
				radius?: number;
				limit?: number;
				exclude?: Vec3[];
			};
			const name = specName(raw.name);
			const radius = raw.radius ?? 32;
			const limit = raw.limit ?? 64;
			const search = view.searchBlocks({
				name,
				radius,
				// Driver 侧保留一点余量用于 exclude 与计数，最终切片在下面做。
				limit: Math.min(4096, Math.max(limit, 1) * 4),
				exclude: (raw.exclude ?? []).map((entry) => ({ x: entry.x, y: entry.y, z: entry.z })),
			});
			const unknown = [...search.unknown];
			const blocks = search.value.matches.slice(0, limit);
			const count = search.value.matches.length;
			const truncated = search.value.capped || count > limit;
			return factOf({ blocks, count, truncated, scanned: search.value.scanned }, { unknown, source: search.source });
		},
	},
};

export function terrainQueries(deps: TerrainDeps): QuerySpec[] {
	return [blockQuery(deps), blocksQuery];
}
