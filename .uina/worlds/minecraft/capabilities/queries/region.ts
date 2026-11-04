/**
 * region@1：读一片体素网格的方块状态（palette + 索引压缩）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 region。
 * "找方块用 blocks@1，读一片形状用 region@1"：上限 8192 体素，order 固定 xzy
 * （x 最快、z 次之、y 最慢）。未加载格索引 -1 并计进 missing——未知不是空气，
 * 不猜。palette 第 0 项恒为 {name:"air",properties:{}}，palette[cells[i]] 是该格
 * 实际状态。
 *
 * 逐格走同一提交边界的事实视图（block@1 同源数据）；8192 格有界同步采样，
 * 真服耗时在验收场景计时（超预算则改 driver 侧分批采样，合同不变）。
 */

import type { ClientFactView } from "../../contracts/client-facts.js";
import type { Fact, FactSource, JsonSchema, JsonValue, Vec3 } from "../../contracts/values.js";
import { callFailure } from "../../contracts/values.js";
import type { CapabilityDefinition, MinecraftCapabilityModule } from "../catalog.js";
import { factOf } from "../shared/facts.js";
import { GRID_POS_SCHEMA, GRID_VEC_SCHEMA } from "../shared/schema.js";
import { resolveGrid, resolvePoint, stripNamespace } from "../shared/targets.js";

/** 单次体素上限（capabilities §2 体积表）；超过在派发前拒绝。 */
const REGION_MAX_VOXELS = 8192;

const REGION_INPUT: JsonSchema = {
	oneOf: [
		{
			type: "object",
			properties: { from: GRID_POS_SCHEMA, to: GRID_POS_SCHEMA },
			required: ["from", "to"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: { at: GRID_POS_SCHEMA, size: GRID_VEC_SCHEMA },
			required: ["at", "size"],
			additionalProperties: false,
		},
	],
};

function invalid(message: string, hint?: string): never {
	throw callFailure({
		code: "INVALID_INPUT",
		source: "input",
		message,
		...(hint != null ? { hint } : {}),
		dispatch: "not_sent",
		effects: [],
		recoverable: true,
	});
}

const regionDefinition: CapabilityDefinition = {
	kind: "query",
	descriptor: {
		ref: "region@1",
		// 原点来自 self；体素读 block。
		facts: ["self", "blocks"],
		summary:
			"Voxel grid over a closed box as a BlockStateValue palette + xzy-ordered cell indices; unloaded cells are -1 (missing), never air",
		input: REGION_INPUT,
		output: { type: "object" },
		access: "read",
		watchable: true,
		feedback: false,
		examples: [
			{
				input: { from: { x: 0, y: 63, z: 0 }, to: { x: 7, y: 65, z: 7 } },
				output: {
					value: {
						origin: { x: 0, y: 63, z: 0 },
						shape: [8, 3, 8],
						palette: [
							{ name: "air", properties: {} },
							{ name: "stone", properties: {} },
						],
						cells: [1, 1, 0],
						order: "xzy",
						missing: 0,
						scanned: { chunksLoaded: 1 },
					},
				},
			},
		],
	},
	bind: () => ({
		kind: "current",
		cursor: "observed",
		read: (view: ClientFactView, input: JsonValue) => {
			const raw = input as { from?: unknown; to?: unknown; at?: unknown; size?: unknown };
			const self = view.self();
			if (self.value == null) return { ...self, value: null } as Fact<unknown>;
			let origin: Vec3;
			let max: Vec3;
			if (raw.from != null || raw.to != null) {
				if (raw.from == null || raw.to == null) invalid("region needs both from and to");
				const from = resolveGrid(raw.from, self.value);
				const to = resolveGrid(raw.to, self.value);
				origin = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) };
				max = { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) };
			} else {
				if (raw.at == null || raw.size == null) invalid("region needs from/to or at/size");
				origin = resolveGrid(raw.at, self.value);
				const size = raw.size as { x: number; y: number; z: number };
				for (const axis of ["x", "y", "z"] as const) {
					if (!Number.isInteger(size[axis]) || size[axis] < 1) {
						invalid(`size.${axis} must be a positive integer`, "size counts cells per axis, e.g. {x:16,y:16,z:32}");
					}
				}
				max = { x: origin.x + size.x - 1, y: origin.y + size.y - 1, z: origin.z + size.z - 1 };
			}
			const nx = max.x - origin.x + 1;
			const ny = max.y - origin.y + 1;
			const nz = max.z - origin.z + 1;
			const voxels = nx * ny * nz;
			if (voxels > REGION_MAX_VOXELS) {
				invalid(
					`region covers ${voxels} voxels (limit ${REGION_MAX_VOXELS})`,
					"slice the request, e.g. read one y-layer (16x16) or one 16x16x32 column at a time",
				);
			}
			// 跨维度不猜：维度不同时按未覆盖返回（block@1 同口径）。
			const asked = resolvePoint(raw.from ?? raw.at, self.value);
			if (asked.dimension !== self.value.place.dimension) {
				return factOf(null, {
					unknown: [`region is in ${asked.dimension}, current dimension is ${self.value.place.dimension}`],
					source: "server",
				});
			}

			const place = {
				world: self.value.place.world,
				worldRevision: self.value.place.worldRevision,
				dimension: self.value.place.dimension,
			};
			const palette: { name: string; properties: Record<string, string> }[] = [{ name: "air", properties: {} }];
			const paletteIndex = new Map<string, number>([["air{}", 0]]);
			const cells: number[] = new Array(voxels).fill(-1);
			const loadedChunks = new Set<string>();
			let source: FactSource | "mixed" | null = null;
			let missing = 0;
			// order "xzy"：x 最快、z 次之、y 最慢；i = (y-oy)*nx*nz + (z-oz)*nx + (x-ox)。
			for (let y = origin.y; y <= max.y; y++) {
				for (let z = origin.z; z <= max.z; z++) {
					for (let x = origin.x; x <= max.x; x++) {
						const i = (y - origin.y) * nx * nz + (z - origin.z) * nx + (x - origin.x);
						const block = view.block({
							place: { ...place, position: { x, y, z } },
							block: { x, y, z },
						});
						if (source == null) source = block.source;
						else if (source !== block.source) source = "mixed";
						const state = block.value?.state;
						if (state == null) {
							missing += 1;
							continue;
						}
						loadedChunks.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
						const name = stripNamespace(state.name);
						const key = name + JSON.stringify(state.properties ?? {});
						let index = paletteIndex.get(key);
						if (index == null) {
							index = palette.length;
							palette.push({ name, properties: state.properties ?? {} });
							paletteIndex.set(key, index);
						}
						cells[i] = index;
					}
				}
			}
			const unknown: string[] = [];
			if (missing > 0) unknown.push(`${missing} cell(s) not loaded; their cells are -1, not air`);
			return factOf(
				{
					origin,
					shape: [nx, ny, nz],
					palette,
					cells,
					order: "xzy",
					missing,
					scanned: { chunksLoaded: loadedChunks.size },
				},
				{ unknown, source: source ?? "server" },
			);
		},
	}),
};

export const regionModule: MinecraftCapabilityModule = {
	id: "region",
	definitions: [regionDefinition],
};
