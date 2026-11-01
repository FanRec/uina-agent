/**
 * Construction Target 的纯值语义：规范化、镜像/旋转、状态变换。
 *
 * 这些判据不依赖世界也不依赖文件：坐标错了后面全错，所以先在最小范围钉死。
 */

import { describe, expect, test } from "vitest";
import {
	applyTransform,
	ConstructionError,
	isReplaceableName,
	matchesDeclared,
	normalizeTarget,
	transformedSize,
	transformBlockState,
} from "../../.uina/worlds/minecraft/construction/target.js";
import type { ConstructionTarget, TargetCell } from "../../.uina/worlds/minecraft/construction/target.js";

function cell(x: number, y: number, z: number, block = "oak_planks"): TargetCell {
	return { at: { x, y, z }, kind: "set", block };
}

function targetOf(cells: TargetCell[], size?: { x: number; y: number; z: number }): ConstructionTarget {
	return normalizeTarget(cells, size);
}

describe("normalizeTarget", () => {
	test("包围盒由实际格推导，绝对坐标折成本地偏移", () => {
		const target = targetOf([cell(10, 64, 10), cell(11, 64, 10), cell(10, 65, 10)]);
		expect(target.size).toEqual({ x: 2, y: 2, z: 1 });
		expect(target.cells.map((entry) => entry.at)).toEqual([
			{ x: 0, y: 0, z: 0 },
			{ x: 1, y: 0, z: 0 },
			{ x: 0, y: 1, z: 0 },
		]);
	});

	test("声明的 size 与格范围不符时拒绝", () => {
		expect(() => targetOf([cell(0, 0, 0)], { x: 2, y: 1, z: 1 })).toThrow(ConstructionError);
	});

	test("重复格拒绝：同一位置不能有两个声明", () => {
		expect(() => targetOf([cell(0, 0, 0), cell(0, 0, 0, "stone")])).toThrow(/duplicate target cell/);
	});

	test("空设计直接拒绝", () => {
		expect(() => normalizeTarget([])).toThrow(/no cells/);
	});
});

describe("applyTransform 坐标", () => {
	const design: ConstructionTarget = {
		size: { x: 2, y: 1, z: 1 },
		cells: [cell(0, 0, 0, "a"), cell(1, 0, 0, "b")],
	};

	test("rotate 90 是绕 Y 顺时针：东→南，x/z 轴长互换", () => {
		const placed = applyTransform(design, { x: 0, y: 0, z: 0 }, { rotate: 90 });
		expect(transformedSize(design.size, { rotate: 90 })).toEqual({ x: 1, y: 1, z: 2 });
		// 原来沿 +x 的两个格，旋转后沿 +z。
		expect(placed.map((entry) => entry.at)).toEqual([
			{ x: 0, y: 0, z: 0 },
			{ x: 0, y: 0, z: 1 },
		]);
	});

	test("rotate 180 / 270 由 90 反复应用得到，回到原轴长", () => {
		expect(transformedSize(design.size, { rotate: 180 })).toEqual({ x: 2, y: 1, z: 1 });
		// 180 之后 b 回到原点、a 到 +x（输出按 (y,z,x) 排序，所以先 b 后 a）。
		expect(
			applyTransform(design, { x: 0, y: 0, z: 0 }, { rotate: 180 }).map((entry) => ({
				at: entry.at,
				block: entry.block,
			})),
		).toEqual([
			{ at: { x: 0, y: 0, z: 0 }, block: "b" },
			{ at: { x: 1, y: 0, z: 0 }, block: "a" },
		]);
		expect(transformedSize(design.size, { rotate: 270 })).toEqual({ x: 1, y: 1, z: 2 });
	});

	test("mirror 在自身包围盒内翻转，不产生负坐标也不改尺寸", () => {
		expect(transformedSize(design.size, { mirror: "x" })).toEqual({ x: 2, y: 1, z: 1 });
		expect(
			applyTransform(design, { x: 0, y: 0, z: 0 }, { mirror: "x" }).map((entry) => ({
				at: entry.at,
				block: entry.block,
			})),
		).toEqual([
			{ at: { x: 0, y: 0, z: 0 }, block: "b" },
			{ at: { x: 1, y: 0, z: 0 }, block: "a" },
		]);
	});

	test("mirror 先于 rotate，锚点最后加", () => {
		// mirror x 之后是 [b@1, a@0]（block 跟着走），rotate 90 再把它们摆到 z 轴上。
		const placed = applyTransform(design, { x: 100, y: 64, z: 100 }, { mirror: "x", rotate: 90 });
		expect(placed.map((entry) => ({ at: entry.at, block: entry.block }))).toEqual([
			{ at: { x: 100, y: 64, z: 100 }, block: "b" },
			{ at: { x: 100, y: 64, z: 101 }, block: "a" },
		]);
	});

	test("越出设计盒的格拒绝", () => {
		expect(() =>
			applyTransform({ size: { x: 1, y: 1, z: 1 }, cells: [cell(1, 0, 0)] }, { x: 0, y: 0, z: 0 }, {}),
		).toThrow(/outside the 1x1x1 design box/);
	});

	test("输出按 (y, z, x) 固定排序", () => {
		const design2 = targetOf([cell(1, 2, 0), cell(0, 0, 1), cell(0, 0, 0)]);
		const placed = applyTransform(design2, { x: 0, y: 64, z: 0 }, {});
		expect(placed.map((entry) => `${entry.at.x},${entry.at.y},${entry.at.z}`)).toEqual(["0,64,0", "0,64,1", "1,66,0"]);
	});
});

describe("transformBlockState", () => {
	const stair = (properties: Record<string, string>) => ({ name: "oak_stairs", properties });

	test("facing 随旋转顺时针走一圈，up/down 不动", () => {
		expect(transformBlockState(stair({ facing: "north" }), { rotate: 90 })).toEqual(stair({ facing: "east" }));
		expect(transformBlockState(stair({ facing: "west" }), { rotate: 180 })).toEqual(stair({ facing: "east" }));
		expect(transformBlockState(stair({ facing: "up" }), { rotate: 90 })).toEqual(stair({ facing: "up" }));
	});

	test("mirror 只翻转对应轴上的朝向", () => {
		expect(transformBlockState(stair({ facing: "east" }), { mirror: "x" })).toEqual(stair({ facing: "west" }));
		expect(transformBlockState(stair({ facing: "north" }), { mirror: "x" })).toEqual(stair({ facing: "north" }));
		expect(transformBlockState(stair({ facing: "north" }), { mirror: "z" })).toEqual(stair({ facing: "south" }));
	});

	test("axis 只在 90/270 交换 x/z；mirror 不动它", () => {
		expect(transformBlockState({ name: "oak_log", properties: { axis: "x" } }, { rotate: 90 })).toEqual({
			name: "oak_log",
			properties: { axis: "z" },
		});
		expect(transformBlockState({ name: "oak_log", properties: { axis: "x" } }, { rotate: 180 })).toEqual({
			name: "oak_log",
			properties: { axis: "x" },
		});
		expect(transformBlockState({ name: "oak_log", properties: { axis: "z" } }, { mirror: "x" })).toEqual({
			name: "oak_log",
			properties: { axis: "z" },
		});
	});

	test("rotation（0-15）每 90° +4，镜像按顺时针角反射", () => {
		expect(transformBlockState({ name: "oak_sign", properties: { rotation: "0" } }, { rotate: 90 })).toEqual({
			name: "oak_sign",
			properties: { rotation: "4" },
		});
		expect(transformBlockState({ name: "oak_sign", properties: { rotation: "14" } }, { rotate: 90 })).toEqual({
			name: "oak_sign",
			properties: { rotation: "2" },
		});
		expect(transformBlockState({ name: "oak_sign", properties: { rotation: "4" } }, { mirror: "x" })).toEqual({
			name: "oak_sign",
			properties: { rotation: "12" },
		});
		expect(transformBlockState({ name: "oak_sign", properties: { rotation: "0" } }, { mirror: "z" })).toEqual({
			name: "oak_sign",
			properties: { rotation: "8" },
		});
	});

	test("hinge/shape 相对 facing 表达：旋转不动，镜像左右互换", () => {
		expect(transformBlockState(stair({ shape: "inner_left" }), { rotate: 90 })).toEqual(stair({ shape: "inner_left" }));
		expect(transformBlockState(stair({ shape: "inner_left" }), { mirror: "z" })).toEqual(
			stair({ shape: "inner_right" }),
		);
		expect(transformBlockState({ name: "oak_door", properties: { hinge: "left" } }, { mirror: "x" })).toEqual({
			name: "oak_door",
			properties: { hinge: "right" },
		});
	});

	test("未声明的属性原样复制；字符串声明不需要变换", () => {
		expect(transformBlockState({ name: "chest", properties: { waterlogged: "false" } }, { rotate: 90 })).toEqual({
			name: "chest",
			properties: { waterlogged: "false" },
		});
		expect(transformBlockState("oak_planks", { rotate: 90 })).toBe("oak_planks");
	});

	test("认不出的定向状态不猜，直接失败", () => {
		expect(() => transformBlockState(stair({ facing: "north_east" }), { rotate: 90 })).toThrow(
			/cannot transform facing/,
		);
		expect(() => transformBlockState({ name: "x", properties: { axis: "w" } }, { rotate: 90 })).toThrow(
			/cannot transform axis/,
		);
		expect(() => transformBlockState({ name: "x", properties: { rotation: "20" } }, { rotate: 90 })).toThrow(
			/cannot transform rotation/,
		);
	});
});

describe("声明匹配与可替换性", () => {
	test("只比较声明的属性", () => {
		const state = { name: "minecraft:oak_stairs", properties: { facing: "east", half: "bottom" } };
		expect(matchesDeclared("oak_stairs", state)).toBe(true);
		expect(matchesDeclared({ name: "oak_stairs", properties: { facing: "east" } }, state)).toBe(true);
		expect(matchesDeclared({ name: "oak_stairs", properties: { facing: "west" } }, state)).toBe(false);
		expect(matchesDeclared("oak_planks", state)).toBe(false);
		expect(matchesDeclared("oak_stairs", null)).toBe(false);
	});

	test("空气/流体/地表植物可直接替换，实心方块不可", () => {
		for (const name of ["air", "minecraft:cave_air", "water", "short_grass", "snow"]) {
			expect(isReplaceableName(name), name).toBe(true);
		}
		for (const name of ["oak_planks", "minecraft:stone", "chest"]) {
			expect(isReplaceableName(name), name).toBe(false);
		}
	});
});
