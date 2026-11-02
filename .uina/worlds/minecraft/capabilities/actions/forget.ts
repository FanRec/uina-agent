/**
 * forget@1：从 World 领域记录删除一个命名地点。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §5 记录。
 * 删除走 WorldPort.removeRecord（按当前绑定分区）；记录不存在如实 NOT_FOUND。
 */

import type { CallableDescriptor, CallContext, NativeCallable } from "../../contracts/capabilities.js";
import type { JsonValue } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import { placeRef } from "../../world/places.js";
import type { CapabilityDeps } from "../deps.js";
import { fail } from "../shared/targets.js";
import { normalizePlaceName } from "./remember.js";

const descriptor: CallableDescriptor = {
	ref: "forget@1",
	summary: "Remove a named place from Uina's per-world record; unknown names fail with NOT_FOUND",
	tags: ["records"],
	input: {
		type: "object",
		properties: { name: { type: "string", minLength: 1, maxLength: 32 } },
		required: ["name"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: { removed: { type: "boolean" } },
		required: ["removed"],
		additionalProperties: false,
	},
	access: "act",
	completion: { scope: "capability", description: "the record row is deleted from the world record store" },
	errors: [
		{ code: "INVALID_INPUT", meaning: "name is empty, whitespace-only, over 32 chars or has control characters" },
		{ code: "NOT_FOUND", meaning: "no record with this name in the current world partition" },
	],
	requires: [],
	examples: [{ input: { name: "base" }, output: { removed: true } }],
	implementation: "native",
};

export function forgetCallable(_deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	void _deps;
	return {
		descriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const raw = input as unknown as { name: string };
			const name = normalizePlaceName(raw.name);
			const { removed } = await ctx.world.removeRecord(placeRef(name));
			if (!removed) {
				fail("NOT_FOUND", `no remembered place named ${JSON.stringify(name)}`, {
					hint: "read places@1 to list the current names",
				});
			}
			return plain({ removed: true });
		},
	};
}
