/**
 * 能力输入 JSON Schema 片段：描述符是唯一事实来源，Runtime/Ajv 依此校验一次。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §2.2（Pos/GridPos/BlockSpec）。
 * 这里只放跨能力复用的形状；单个能力独有的字段写在各自描述符里。
 */

import type { JsonSchema } from "../../contracts/values.js";

export const VEC3_SCHEMA: JsonSchema = {
	type: "object",
	properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
	required: ["x", "y", "z"],
	additionalProperties: false,
};

export const GRID_VEC_SCHEMA: JsonSchema = {
	type: "object",
	properties: { x: { type: "integer" }, y: { type: "integer" }, z: { type: "integer" } },
	required: ["x", "y", "z"],
	additionalProperties: false,
};

/** Pos = 连续坐标 | {position, dimension} | {rel}。 */
export const POS_SCHEMA: JsonSchema = {
	oneOf: [
		VEC3_SCHEMA,
		{
			type: "object",
			properties: { position: VEC3_SCHEMA, dimension: { type: "string", minLength: 1 } },
			required: ["position", "dimension"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: { rel: VEC3_SCHEMA },
			required: ["rel"],
			additionalProperties: false,
		},
	],
};

/** GridPos = 整数格 | {position, dimension} | {rel}（rel 各分量也须为整数）。 */
export const GRID_POS_SCHEMA: JsonSchema = {
	oneOf: [
		GRID_VEC_SCHEMA,
		{
			type: "object",
			properties: { position: GRID_VEC_SCHEMA, dimension: { type: "string", minLength: 1 } },
			required: ["position", "dimension"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: { rel: GRID_VEC_SCHEMA },
			required: ["rel"],
			additionalProperties: false,
		},
	],
};

export const BLOCK_SPEC_SCHEMA: JsonSchema = {
	oneOf: [
		{ type: "string", minLength: 1 },
		{
			type: "object",
			properties: {
				name: { type: "string", minLength: 1 },
				properties: { type: "object", additionalProperties: { type: "string" } },
			},
			required: ["name"],
			additionalProperties: false,
		},
	],
};

export const ITEM_SELECTOR_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		name: { type: "string", minLength: 1 },
		components: {},
		minDurability: { type: "integer", minimum: 0 },
		substitutions: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 16 },
	},
	required: ["name"],
	additionalProperties: false,
};

export const FACE_SCHEMA: JsonSchema = {
	type: "string",
	enum: ["auto", "up", "down", "north", "south", "east", "west"],
};

/** 查询/动作通用的空输入。 */
export const EMPTY_INPUT: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
