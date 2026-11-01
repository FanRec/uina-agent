/**
 * 施工计划：差异、材料缺口、冲突、结构支撑与粗估。
 *
 * 这里用一个 Map 当作现场读数，只替换"世界读"这一处外部边界；
 * 判定逻辑全部走真实实现（与 mc-spatial-planner 的分工相同）。
 */

import { describe, expect, test } from "vitest";
import { MAX_PLAN_TARGETS, planConstruction, type FieldView } from "../../.uina/worlds/minecraft/construction/plan.js";
import { ConstructionError } from "../../.uina/worlds/minecraft/construction/target.js";
import type { TargetCell } from "../../.uina/worlds/minecraft/construction/target.js";

function key(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

/**
 * 现场读数：包围盒内未登记的格是空气，盒外是未知（null）。
 * 这个区别很重要——`null` 在计划里表示"未加载"，不会被当成"已满足"或"缺支撑"。
 */
function fieldOf(blocks: Map<string, string>, bounds = { min: -2048, max: 2048 }): FieldView {
	return {
		blockAt: (at) => {
			const name = blocks.get(key(at.x, at.y, at.z));
			if (name != null) return { name, properties: {} };
			const inside = [at.x, at.y, at.z].every((value) => value >= bounds.min && value <= bounds.max);
			return inside ? { name: "air", properties: {} } : null;
		},
	};
}

function set(x: number, y: number, z: number, block = "oak_planks"): TargetCell {
	return { at: { x, y, z }, kind: "set", block };
}

describe("planConstruction 差异与材料", () => {
	test("空场地三格：need 全量，missing 按背包扣减", () => {
		const plan = planConstruction(
			{ cells: [set(0, 64, 0), set(1, 64, 0), set(0, 65, 0, "oak_door")], replace: false },
			fieldOf(new Map()),
			{ oak_planks: 1, oak_door: 0 },
		);
		expect(plan.targets).toHaveLength(3);
		expect(plan.need).toEqual({ oak_door: 1, oak_planks: 2 });
		expect(plan.missing).toEqual({ oak_door: 1, oak_planks: 1 });
		expect(plan.blocked).toEqual([]);
		expect(plan.unreachable).toEqual([]);
	});

	test("已匹配的格不进 need，但仍在 targets 里（targets 不是待办清单）", () => {
		const field = fieldOf(new Map([[key(0, 64, 0), "oak_planks"]]));
		const plan = planConstruction({ cells: [set(0, 64, 0), set(1, 64, 0)], replace: false }, field, {});
		expect(plan.targets).toHaveLength(2);
		expect(plan.need).toEqual({ oak_planks: 1 });
	});

	test("状态不符且方块不可替换：算冲突，不算缺料", () => {
		const plan = planConstruction(
			{
				cells: [{ at: { x: 0, y: 64, z: 0 }, kind: "set", block: { name: "oak_door", properties: { half: "upper" } } }],
				replace: false,
			},
			{ blockAt: () => ({ name: "oak_door", properties: { half: "lower" } }) },
			{ oak_door: 1 },
		);
		expect(plan.blocked).toEqual([{ at: { x: 0, y: 64, z: 0 }, by: "oak_door" }]);
		expect(plan.need).toEqual({});
	});

	test("replace=true 时状态不符改为先挖再放，进 need", () => {
		const plan = planConstruction(
			{
				cells: [{ at: { x: 0, y: 64, z: 0 }, kind: "set", block: { name: "oak_door", properties: { half: "upper" } } }],
				replace: true,
			},
			{ blockAt: () => ({ name: "oak_door", properties: { half: "lower" } }) },
			{ oak_door: 1 },
		);
		expect(plan.blocked).toEqual([]);
		expect(plan.need).toEqual({ oak_door: 1 });
	});

	test("现场被别的实心方块占住且 replace=false：进 blocked，不算材料", () => {
		const field = fieldOf(new Map([[key(0, 64, 0), "stone"]]));
		const plan = planConstruction({ cells: [set(0, 64, 0)], replace: false }, field, {});
		expect(plan.blocked).toEqual([{ at: { x: 0, y: 64, z: 0 }, by: "stone" }]);
		expect(plan.need).toEqual({});
	});

	test("replace=true 时同一格改为需要先挖再放", () => {
		const field = fieldOf(new Map([[key(0, 64, 0), "stone"]]));
		const plan = planConstruction({ cells: [set(0, 64, 0)], replace: true }, field, { oak_planks: 4 });
		expect(plan.blocked).toEqual([]);
		expect(plan.need).toEqual({ oak_planks: 1 });
		expect(plan.estTicks).toBe(40 + 15 + 8);
	});

	test("可替换方块（空气/草）不算冲突", () => {
		const field = fieldOf(new Map([[key(0, 64, 0), "short_grass"]]));
		const plan = planConstruction({ cells: [set(0, 64, 0)], replace: false }, field, { oak_planks: 1 });
		expect(plan.blocked).toEqual([]);
		expect(plan.need).toEqual({ oak_planks: 1 });
	});

	test("clear 只统计还不是空气的格", () => {
		const field = fieldOf(new Map([[key(0, 64, 0), "stone"]]));
		const plan = planConstruction(
			{
				cells: [
					{ at: { x: 0, y: 64, z: 0 }, kind: "clear" },
					{ at: { x: 1, y: 64, z: 0 }, kind: "clear" },
				],
				replace: false,
			},
			{ blockAt: (at) => (at.x === 1 ? { name: "air", properties: {} } : field.blockAt(at)) },
			{},
		);
		expect(plan.need).toEqual({});
		// 一格待挖 = 一次短腿 + 一次挖掘。
		expect(plan.estTicks).toBe(40 + 15);
	});

	test("preserve 与 unknown 不改现场也不计入材料与估计", () => {
		const plan = planConstruction(
			{
				cells: [
					{ at: { x: 0, y: 64, z: 0 }, kind: "preserve" },
					{ at: { x: 1, y: 64, z: 0 }, kind: "unknown", reason: "来源不明" },
				],
				replace: false,
			},
			fieldOf(new Map([[key(0, 64, 0), "chest"]])),
			{},
		);
		expect(plan.targets.map((cell) => cell.kind)).toEqual(["preserve", "unknown"]);
		expect(plan.need).toEqual({});
		expect(plan.blocked).toEqual([]);
		expect(plan.unreachable).toEqual([]);
		expect(plan.estTicks).toBe(0);
	});
});

describe("planConstruction 结构支撑", () => {
	test("悬空的 set 格进 unreachable（六邻居都不可点击）", () => {
		const plan = planConstruction({ cells: [set(0, 64, 0)], replace: false }, fieldOf(new Map()), {});
		expect(plan.unreachable).toEqual([{ at: { x: 0, y: 64, z: 0 } }]);
	});

	test("现场实心邻居可以充当支撑", () => {
		const field = fieldOf(new Map([[key(0, 63, 0), "stone"]]));
		const plan = planConstruction({ cells: [set(0, 64, 0)], replace: false }, field, {});
		expect(plan.unreachable).toEqual([]);
	});

	test("同一计划内的 set 邻居也算支撑（自下而上施工）", () => {
		const plan = planConstruction({ cells: [set(0, 64, 0), set(0, 65, 0)], replace: false }, fieldOf(new Map()), {});
		// 下层悬空，上层以它为支撑。
		expect(plan.unreachable).toEqual([{ at: { x: 0, y: 64, z: 0 } }]);
	});

	test("已匹配的格不参与支撑判定也不进 unreachable", () => {
		const field = fieldOf(new Map([[key(0, 64, 0), "oak_planks"]]));
		const plan = planConstruction({ cells: [set(0, 64, 0)], replace: false }, field, {});
		expect(plan.unreachable).toEqual([]);
		expect(plan.need).toEqual({});
	});
});

describe("planConstruction 边界", () => {
	test("空目标拒绝", () => {
		expect(() => planConstruction({ cells: [], replace: false }, fieldOf(new Map()), {})).toThrow(ConstructionError);
	});

	test("超过 targets 上限拒绝并给出切分建议", () => {
		const cells: TargetCell[] = [];
		for (let index = 0; index <= MAX_PLAN_TARGETS; index++) cells.push(set(index, 64, 0));
		const error = (() => {
			try {
				planConstruction({ cells, replace: false }, fieldOf(new Map()), {});
				return null;
			} catch (caught) {
				return caught as ConstructionError;
			}
		})();
		expect(error?.code).toBe("INVALID_INPUT");
		expect(error?.message).toContain(`${MAX_PLAN_TARGETS} limit`);
		expect(error?.hint).toContain("split the design");
	});

	test("输出顺序固定为 (y, z, x)", () => {
		const plan = planConstruction(
			{ cells: [set(1, 65, 0), set(0, 64, 1), set(0, 64, 0)], replace: false },
			fieldOf(new Map()),
			{},
		);
		expect(plan.targets.map((cell) => `${cell.at.x},${cell.at.y},${cell.at.z}`)).toEqual([
			"0,64,0",
			"0,64,1",
			"1,65,0",
		]);
	});

	test("blueprint 身份原样带回（plan 与 build 共用的摘要）", () => {
		const plan = planConstruction(
			{ cells: [set(0, 64, 0)], replace: false, blueprint: { ref: "blueprint:house", digest: "abc" } },
			fieldOf(new Map()),
			{},
		);
		expect(plan.blueprint).toEqual({ ref: "blueprint:house", digest: "abc" });
	});
});
