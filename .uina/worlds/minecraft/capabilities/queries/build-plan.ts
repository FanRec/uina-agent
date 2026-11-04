/**
 * build.plan@1 的查询声明：读材料与现场差异，不执行拆除、放置或开箱。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 build.plan、§2.5、§2.11。
 * 与 build 共用同一份 BuildTargetRequest（maxTimeMs 只控制执行期限，不属于计划）；
 * 计划不可等待（version=null，派生结果不能进 waitUntil），要等材料变化就等 inventory@1。
 * 不引入 plan ID：计划与执行之间唯一的跨调用身份是 blueprint.digest。
 */

import type { JsonSchema } from "../../contracts/values.js";
import type { CapabilityDefinition, MinecraftCapabilityModule } from "../catalog.js";
import { buildTargetSchema } from "../shared/schema.js";

const BUILD_PLAN_INPUT: JsonSchema = buildTargetSchema();

const buildPlanDefinition: CapabilityDefinition = {
	kind: "query",
	descriptor: {
		ref: "build.plan@1",
		summary:
			"Normalize a build target (cells or a library blueprint) and diff it against the scene: targets, material need/missing, blocked cells, structural gaps and a rough tick estimate; a pure read that never digs, places or opens containers",
		input: BUILD_PLAN_INPUT,
		output: { type: "object" },
		access: "read",
		watchable: false,
		feedback: false,
		examples: [
			{
				input: {
					from: { kind: "blueprint", name: "oak_hut" },
					at: { x: 100, y: 64, z: 100 },
					airPolicy: "preserve",
				},
				output: {
					value: {
						blueprint: { ref: "blueprint:oak_hut", digest: "9f2c…" },
						targets: [{ at: { x: 100, y: 64, z: 100 }, kind: "set", block: "oak_planks" }],
						need: { oak_planks: 26, oak_door: 1 },
						missing: { oak_door: 1 },
						blocked: [],
						unreachable: [],
						estTicks: 248,
					},
				},
			},
		],
	},
	bind: () => null,
};

export const buildPlanModule: MinecraftCapabilityModule = {
	id: "build-plan",
	definitions: [buildPlanDefinition],
};
