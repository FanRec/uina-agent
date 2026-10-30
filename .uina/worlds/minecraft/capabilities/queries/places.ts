/**
 * places@1 的查询声明。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md#places、§5 记录。
 * 读取实现归 World（领域记录存储 + 提交屏障 + record_version 观察）；
 * 记录 schema/ref/过滤语义在 world/places.ts 单点维护。
 */

import type { JsonSchema } from "../../contracts/values.js";
import type { QuerySpec } from "../shared/query.js";

const PLACES_INPUT: JsonSchema = {
	type: "object",
	properties: {
		kind: { type: "string", enum: ["home", "mine", "farm", "other"], description: "only places of this kind" },
		near: {
			type: "number",
			minimum: 0,
			maximum: 10000,
			description: "only places within this Euclidean distance in the current dimension (excludes other dimensions)",
		},
	},
	additionalProperties: false,
};

export const placesQuery: QuerySpec = {
	descriptor: {
		ref: "places@1",
		summary:
			"Named places Uina remembered in this world (home/mine/farm/other), surviving restarts; `near` filters by current position in the current dimension",
		input: PLACES_INPUT,
		output: { type: "object" },
		access: "read",
		watchable: true,
		feedback: false,
		examples: [
			{
				input: { kind: "home" },
				output: {
					value: {
						places: [
							{
								name: "base",
								at: { position: { x: 128, y: 64, z: -256 }, dimension: "minecraft:overworld" },
								kind: "home",
								note: "main storage",
								savedAt: "2026-01-01T00:00:00.000Z",
							},
						],
					},
				},
			},
		],
	},
};
