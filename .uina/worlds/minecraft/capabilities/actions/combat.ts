/**
 * attack@1：走近到攻击距离后打一次，并给出命中证据。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 attack、driver §7.4。
 * 低层只承诺派发；hit 来自 Driver 的受击/死亡证据窗口：
 * true=观察到受击，false=窗口内没观察到，null=窗口未走完（中止/断线）。
 * 不把"没看到"写成"打中了"，也不把 miss 当失败——攻击确实执行过。
 */

import type { BodyCallScope, CallContext, CallableDescriptor, NativeCallable } from "../../contracts/capabilities.js";
import type { EntityRef, SelfState } from "../../contracts/body.js";
import { plain } from "../../contracts/values.js";
import type { JsonValue } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import { resolveEntity } from "../shared/entities.js";
import { readValue } from "../shared/observe.js";
import { ENTITY_REACH } from "../shared/reach.js";
import { fail } from "../shared/targets.js";

const EVIDENCE_MS = 600;

const descriptor: CallableDescriptor = {
	ref: "attack@1",
	summary: "Attack one tracked entity once and report whether a hit was observed",
	tags: ["body", "combat"],
	input: {
		type: "object",
		properties: {
			target: { oneOf: [{ type: "string", minLength: 1 }, { type: "object" }] },
		},
		required: ["target"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			hit: { type: ["boolean", "null"] },
			target: {
				type: "object",
				properties: { name: { type: "string" }, health: { type: ["number", "null"] } },
				required: ["name"],
				additionalProperties: false,
			},
		},
		required: ["hit", "target"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"One attack was dispatched; hit reports observed damage/death evidence within the window (null = unobserved)",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "no tracked entity matches the target within 16 blocks" },
		{ code: "UNREACHABLE", meaning: "the target is beyond attack range (walk there first)" },
		{ code: "REFERENCE_STALE", meaning: "the entity reference is no longer tracked" },
		{ code: "INTERRUPTED", meaning: "the run was stopped" },
	],
	requires: ["connection", "body"],
	examples: [{ input: { target: "zombie" }, output: { hit: true, target: { name: "zombie", health: null } } }],
	implementation: "native",
};

export function attackCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	void deps;
	return {
		descriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const raw = input as { target: string | EntityRef };
			await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			const entity = await resolveEntity(ctx.world, raw.target);
			if (entity.distance > ENTITY_REACH) {
				fail("UNREACHABLE", `${entity.name} is ${entity.distance} blocks away`, {
					hint: "goto@1 closer first; attack does not path",
				});
			}
			return await ctx.withBody(async (scope: BodyCallScope) => {
				const outcome = await scope.player.attack(entity.ref, { evidenceMs: EVIDENCE_MS });
				return plain({
					hit: outcome.hit,
					target: { name: entity.name, health: null },
				});
			});
		},
	};
}
