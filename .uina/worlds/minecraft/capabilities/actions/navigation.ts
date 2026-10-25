/**
 * goto@1：当前维度内受控寻路。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 goto、driver §7.2。
 * 能力层只做目标换算与默认值；寻路、停止、写入资格都归 Driver/Runtime。
 * 返回 dug 是实测挖掘次数；placed 无法归属到本次导航，如实 null。
 */

import type { CallContext, CallableDescriptor, NativeCallable } from "../../contracts/capabilities.js";
import type { ControlOwner, SelfState } from "../../contracts/body.js";
import { plain } from "../../contracts/values.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import { readValue } from "../shared/observe.js";
import { POS_SCHEMA } from "../shared/schema.js";
import { distance, fail, resolvePoint } from "../shared/targets.js";

const descriptor: CallableDescriptor = {
	ref: "goto@1",
	summary:
		"Walk to a position inside the current dimension (controlled exclusive navigation; mutually exclusive with body qualifications)",
	tags: ["body", "navigation"],
	input: {
		type: "object",
		properties: {
			at: POS_SCHEMA,
			tolerance: { type: "integer", minimum: 1, maximum: 8, description: "GoalNear radius in blocks (default 2)" },
			digThrough: { type: "boolean", description: "allow digging through obstacles (default false)" },
			placeToReach: { type: "boolean", description: "allow placing blocks to reach (default true)" },
			sprint: { type: "boolean", description: "allow sprinting (default true)" },
			maxTimeMs: { type: "number", minimum: 1000, maximum: 600000, description: "wall-clock budget (default 120000)" },
		},
		required: ["at"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			at: { type: "object" },
			distance: { type: "number" },
			ticks: { type: "integer", minimum: 0 },
			dug: { type: "integer", minimum: 0 },
			placed: { type: ["integer", "null"], minimum: 0 },
		},
		required: ["at", "distance", "ticks", "dug"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "execution",
		description: "GoalNear proximity satisfied; standing-posture verification belongs to later capability work",
	},
	errors: [
		{ code: "UNREACHABLE", meaning: "pathfinder found no path or could not plan within its think budget" },
		{ code: "WRONG_STATE", meaning: "the target is in another dimension (portals are transit@1 work)" },
		{ code: "TIMEOUT", meaning: "wall-clock budget exhausted before arrival" },
		{ code: "CONTROL_CONFLICT", meaning: "a body qualification or another navigation holds the client" },
		{ code: "INTERRUPTED", meaning: "the run was stopped before arrival" },
		{ code: "DISCONNECTED", meaning: "the connection ended during navigation" },
		{ code: "INVALID_INPUT", meaning: "non-finite target, or tolerance/timeout out of range" },
	],
	requires: ["connection"],
	examples: [
		{
			input: { at: { x: 8, y: 64, z: 0 }, tolerance: 2 },
			output: { at: { x: 7.5, y: 64, z: 0 }, distance: 0.5, ticks: 24, dug: 0 },
		},
	],
	implementation: "native",
};

interface GotoInput {
	at: unknown;
	tolerance?: number;
	digThrough?: boolean;
	placeToReach?: boolean;
	sprint?: boolean;
	maxTimeMs?: number;
}

export function gotoCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const raw = input as unknown as GotoInput;
			const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			const target = resolvePoint(raw.at, self);
			if (target.dimension !== self.place.dimension) {
				fail("WRONG_STATE", `target is in ${target.dimension}, current dimension is ${self.place.dimension}`, {
					hint: "goto stays inside the current dimension; transit@1 will handle portals",
				});
			}
			const owner: ControlOwner = { kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId };
			const outcome = await deps.runtime().navigate(owner, () =>
				deps.gotoDirector.goto(
					{
						at: target.position,
						tolerance: raw.tolerance ?? 2,
						sprint: raw.sprint ?? true,
						digThrough: raw.digThrough ?? false,
						placeToReach: raw.placeToReach ?? true,
						timeoutMs: raw.maxTimeMs ?? 120000,
					},
					ctx.signal,
				),
			);
			return plain({
				at: outcome.at,
				distance: Math.round(distance(outcome.at, target.position) * 100) / 100,
				ticks: outcome.ticks,
				dug: outcome.dug,
				placed: outcome.placed,
			});
		},
	};
}

/** 供 mine/place 复用：目标与当前位置的直线距离。 */
export function flatDistance(a: Vec3, b: Vec3): number {
	return Math.hypot(a.x - b.x, a.z - b.z);
}
