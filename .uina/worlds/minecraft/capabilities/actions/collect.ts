import type { CallableDescriptor } from "../../contracts/capabilities.js";
import { COLLECT_DEFAULT_COUNT, collectProgram } from "../../program/collect.js";
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
			count: {
				type: "integer",
				minimum: 1,
				maximum: 1024,
				default: COLLECT_DEFAULT_COUNT,
				description: "net inventory gain to reach (default 1)",
			},
			radius: {
				type: "integer",
				minimum: 4,
				maximum: 64,
				description:
					"loaded-candidate search radius re-queried around the CURRENT position each round (default 32); not a boundary anchored to the call's start",
			},
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
		{
			code: "NOT_FOUND",
			meaning:
				"the canonical item is unknown, this version's data has no block source for it, or no source block was found within the radius of the current position",
		},
		{
			code: "MISSING_TOOL",
			meaning: "harvest requirements known to need tools but no inventory tool matches (hint carries required)",
		},
		{ code: "MISSING_MATERIAL", meaning: "the requested tool is not in the inventory" },
		{ code: "INVENTORY_FULL", meaning: "no room for another matching item" },
		{ code: "UNREACHABLE", meaning: "too many source blocks could not be reached or broken" },
		{ code: "TIMEOUT", meaning: "the internal budget ran out with fewer items than requested" },
		{
			code: "WRONG_STATE",
			meaning: "static knowledge is not ready, or a source block's harvest requirements are unknown",
		},
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
	definitions: [{ kind: "program", descriptor, source: collectProgram, publishSource: true }],
};
