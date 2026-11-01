import { describe, expect, test } from "vitest";
import { fixedLayout, isPlainContainer, windowLayout } from "../../.uina/worlds/minecraft/driver/window/layout.js";

/**
 * 窗口布局表是玩家快照与打开窗口的唯一真源：区域名错了，能力层就会按索引猜格子。
 * 这里锁住四件事：普通容器的 container/player 划分、工作站不产出 container、
 * 固定类型必须槽数精确匹配、未知类型显式拒绝。
 */

describe("window layout", () => {
	test("普通容器：业务槽 + 36 格玩家区", () => {
		const result = windowLayout("minecraft:generic_9x3", 63, 27, 63);
		if (!("layout" in result)) throw new Error(result.reason);
		expect(result.layout.regions.map((region) => region.name)).toEqual(["container", "player"]);
		expect(result.layout.regions[0]?.slots).toHaveLength(27);
		expect(result.layout.regions[1]?.slots).toEqual(Array.from({ length: 36 }, (_, i) => 27 + i));
		expect(isPlainContainer("minecraft:hopper")).toBe(true);
		expect(isPlainContainer("minecraft:crafting")).toBe(false);
	});

	test("玩家窗口：结果槽与 2×2 网格分开，护甲/副手各自独立", () => {
		const layout = fixedLayout("minecraft:inventory");
		expect(layout?.slotCount).toBe(46);
		expect(layout?.regions).toEqual([
			{ name: "result", slots: [0] },
			{ name: "crafting", slots: [1, 2, 3, 4] },
			{ name: "armor", slots: [5, 6, 7, 8] },
			{ name: "player", slots: Array.from({ length: 36 }, (_, i) => 9 + i) },
			{ name: "offhand", slots: [45] },
		]);
	});

	test("工作台与熔炉：只给业务槽与玩家区，不给 container", () => {
		const table = windowLayout("minecraft:crafting", 46, 10, 45);
		if (!("layout" in table)) throw new Error(table.reason);
		expect(table.layout.regions.map((region) => region.name)).toEqual(["result", "crafting", "player"]);
		expect(table.layout.regions[1]?.slots).toHaveLength(9);

		const furnace = windowLayout("minecraft:furnace", 39, 3, 38);
		if (!("layout" in furnace)) throw new Error(furnace.reason);
		expect(furnace.layout.regions).toEqual([
			{ name: "input", slots: [0] },
			{ name: "fuel", slots: [1] },
			{ name: "result", slots: [2] },
			{ name: "player", slots: Array.from({ length: 36 }, (_, i) => 3 + i) },
		]);
		// 按 container 取格的调用方必须在炉子上显式失败，而不是把 input 当普通格。
		expect(furnace.layout.regions.some((region) => region.name === "container")).toBe(false);
	});

	test("固定类型的槽数不符时拒绝（不猜布局）", () => {
		const result = windowLayout("minecraft:furnace", 46, 10, 45);
		expect("reason" in result && result.reason).toContain("39");
	});

	test("未知窗口类型与残缺玩家区都拒绝", () => {
		// 真实存在但本批未接的窗口（beacon/stonecutter 等）必须显式失败，不猜布局。
		expect("reason" in windowLayout("minecraft:beacon", 38, 2, 37)).toBe(true);
		expect("reason" in windowLayout("minecraft:generic_9x3", 62, 27, 62)).toBe(true);
	});

	test("工作站五类：业务槽各自命名，且都不产出 container", () => {
		const stand = windowLayout("minecraft:brewing_stand", 41, 5, 40);
		if (!("layout" in stand)) throw new Error(stand.reason);
		expect(stand.layout.regions).toEqual([
			{ name: "bottle", slots: [0, 1, 2] },
			{ name: "ingredient", slots: [3] },
			{ name: "fuel", slots: [4] },
			{ name: "player", slots: Array.from({ length: 36 }, (_, i) => 5 + i) },
		]);

		const enchant = windowLayout("minecraft:enchantment", 38, 2, 37);
		if (!("layout" in enchant)) throw new Error(enchant.reason);
		expect(enchant.layout.regions).toEqual([
			{ name: "input", slots: [0] },
			{ name: "lapis", slots: [1] },
			{ name: "player", slots: Array.from({ length: 36 }, (_, i) => 2 + i) },
		]);

		for (const type of ["minecraft:anvil", "minecraft:grindstone", "minecraft:merchant"]) {
			const result = windowLayout(type, 39, 3, 38);
			if (!("layout" in result)) throw new Error(`${type}: ${result.reason}`);
			expect(result.layout.regions).toEqual([
				{ name: "input", slots: [0, 1] },
				{ name: "result", slots: [2] },
				{ name: "player", slots: Array.from({ length: 36 }, (_, i) => 3 + i) },
			]);
			expect(result.layout.regions.some((region) => region.name === "container")).toBe(false);
		}

		// 槽数不符仍按固定表拒绝（自诊断报出实际槽数）。
		const wrong = windowLayout("minecraft:merchant", 38, 2, 37);
		expect("reason" in wrong && wrong.reason).toContain("39");
	});
});
