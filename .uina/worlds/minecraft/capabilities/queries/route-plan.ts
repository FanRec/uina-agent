/**
 * route.plan@1 的查询声明：只读试算，执行期限不参与计划。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md#route.plan、§2.11。
 * 字段和默认值与 goto 相同（tolerance 2、digThrough=false、placeToReach=true、sprint=true）；
 * maxTimeMs 只控制执行期限，不在这里。计划不可等待（version=null）；
 * 执行前按新现场复核，相同请求不保证世界未变，不引入 plan ID。
 */

import type { JsonSchema } from "../../contracts/values.js";
import type { CapabilityDefinition, MinecraftCapabilityModule } from "../catalog.js";
import { POS_SCHEMA } from "../shared/schema.js";

const ROUTE_PLAN_INPUT: JsonSchema = {
	type: "object",
	properties: {
		at: POS_SCHEMA,
		tolerance: { type: "integer", minimum: 1, maximum: 8, description: "GoalNear radius in blocks (default 2)" },
		digThrough: { type: "boolean", description: "allow digging through obstacles (default false)" },
		placeToReach: { type: "boolean", description: "allow placing blocks to reach (default true)" },
		sprint: { type: "boolean", description: "allow sprinting (default true)" },
	},
	required: ["at"],
	additionalProperties: false,
};

const routePlanDefinition: CapabilityDefinition = {
	kind: "query",
	descriptor: {
		ref: "route.plan@1",
		summary:
			"Trial-computed route to a target with per-step actions and blockers; a pure read that never moves — goto@1 executes and re-verifies the scene",
		input: ROUTE_PLAN_INPUT,
		output: { type: "object" },
		access: "read",
		watchable: false,
		feedback: false,
		examples: [
			{
				input: { at: { x: 130, y: 64, z: -30 } },
				output: {
					value: {
						ok: false,
						distance: 64,
						steps: [],
						needs: { dig: 0, place: 0 },
						blockers: [{ at: { x: 130, y: 64, z: -30 }, reason: "pathfinding stopped short of the goal" }],
						estTimeSec: null,
					},
				},
			},
		],
	},
	bind: () => null,
};

export const routePlanModule: MinecraftCapabilityModule = {
	id: "route-plan",
	definitions: [routePlanDefinition],
};
