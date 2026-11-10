import type { CallableDescriptor } from "../../contracts/capabilities.js";
import { collectProgram } from "../../program/collect.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import { ITEM_SELECTOR_SCHEMA } from "../shared/schema.js";

const descriptor: CallableDescriptor = {
	ref: "collect@1",
	summary: "Gather a number of an item by mining the blocks that drop it, walking to each one",
	tags: ["body", "gathering"],
	input: {
		type: "object",
		properties: {
			item: { type: "string", minLength: 1 },
			count: { type: "integer", minimum: 1, maximum: 1024 },
			radius: { type: "integer", minimum: 4, maximum: 64 },
			digThrough: { type: "boolean" },
			tool: { oneOf: [{ type: "string", minLength: 1 }, ITEM_SELECTOR_SCHEMA] },
		},
		required: ["item"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			mined: { type: "integer", minimum: 0 },
			acquired: { type: "integer", minimum: 0 },
			collected: { type: "object" },
			remaining: { type: "integer", minimum: 0 },
			toolsUsed: { type: "array", items: { type: "string" } },
		},
		required: ["mined", "acquired", "collected", "remaining", "toolsUsed"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"The inventory gained at least the requested count of the item during this call; blocks broken without a pickup do not count",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "the item has no block source, or no source block is left within the radius" },
		{ code: "MISSING_TOOL", meaning: "no inventory tool can harvest any source block (hint carries required)" },
		{ code: "MISSING_MATERIAL", meaning: "the requested tool is not in the inventory" },
		{ code: "INVENTORY_FULL", meaning: "no room for another matching item" },
		{ code: "UNREACHABLE", meaning: "too many source blocks could not be reached or broken" },
		{ code: "TIMEOUT", meaning: "the internal budget ran out with fewer items than requested" },
		{ code: "WRONG_STATE", meaning: "static knowledge is not ready" },
		{ code: "CONTROL_CONFLICT", meaning: "another run held the client while a sub-call needed it" },
		{ code: "DISCONNECTED", meaning: "the connection ended during the operation" },
		{ code: "INTERRUPTED", meaning: "the run was stopped" },
	],
	requires: ["connection"],
	examples: [
		{
			input: { item: "oak_log", count: 8 },
			output: { mined: 8, acquired: 8, collected: { oak_log: 8 }, remaining: 0, toolsUsed: [] },
		},
	],
	implementation: "program",
};

export const collectModule: MinecraftCapabilityModule = {
	id: "collect",
	definitions: [{ kind: "program", descriptor, source: collectProgram }],
};
