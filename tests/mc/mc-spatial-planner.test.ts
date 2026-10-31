/**
 * 空间作业纯函数层的确定性测试（capabilities §4 tunnel/excavate 规划语义）。
 *
 * 走廊：L 形两轴水平段 + 台阶 1:1（auto）/ 恒高（never）+ 段尾竖井；
 * 台阶列的"踏步块"不在挖除集（可走的前提），profile/支撑探测位置随列给出。
 * 清空：层自上而下、层内就近序、闭区间归一化与体素上限。
 */

import { describe, expect, test } from "vitest";
import {
	DEFAULT_EXCAVATE_KEEP,
	EXCAVATE_MAX_VOXELS,
	expandProfile,
	isContainerBlock,
	isGravityBlock,
	isLiquidBlock,
	normalizeBox,
	orderNear,
	planCorridor,
	planExcavation,
} from "../../.uina/worlds/minecraft/capabilities/shared/spatial.js";

const at = (x: number, y: number, z: number) => ({ x, y, z });

describe("tunnel corridor planning", () => {
	test("flat corridor keeps the floor level and exposes profile cells per column", () => {
		const columns = planCorridor(at(0, 64, 0), at(5, 64, 0), "1x2", "auto");
		expect(columns).toHaveLength(6);
		expect(columns.map((column) => column.floor)).toEqual([
			at(0, 64, 0),
			at(1, 64, 0),
			at(2, 64, 0),
			at(3, 64, 0),
			at(4, 64, 0),
			at(5, 64, 0),
		]);
		for (const column of columns) {
			expect(column.cells).toEqual([at(column.floor.x, 64, column.floor.z), at(column.floor.x, 65, column.floor.z)]);
			expect(column.ceiling).toEqual(at(column.floor.x, 66, column.floor.z));
		}
	});

	test("stairs auto ramps the floor 1:1 across horizontal steps", () => {
		const columns = planCorridor(at(0, 64, 0), at(4, 66, 0), "1x2", "auto");
		expect(columns.map((column) => column.floor.y)).toEqual([64, 65, 66, 66, 66]);
		// 台阶列的地板格不挖（那是踏步块）；挖除集从新地板起向上展开。
		const stepColumn = columns[1]!;
		expect(stepColumn.cells).toContainEqual(at(1, 65, 0));
		expect(stepColumn.cells).toContainEqual(at(1, 66, 0));
		expect(stepColumn.cells).not.toContainEqual(at(1, 64, 0));
	});

	test("ascending columns open jump headroom in the previous column", () => {
		const columns = planCorridor(at(0, 64, 0), at(4, 66, 0), "1x2", "auto");
		// 上坡列（64→65→66）：前一位列的 ceiling 格进挖除集（跳跃净空）。
		expect(columns[0]!.digCeiling).toBe(true);
		expect(columns[0]!.cells).toContainEqual(at(0, 66, 0));
		expect(columns[1]!.digCeiling).toBe(true);
		expect(columns[1]!.cells).toContainEqual(at(1, 67, 0));
		// 平地段（66 保持）不再挖净空。
		expect(columns[3]!.digCeiling).toBe(false);
	});

	test("descending columns also open the lintel above the tunnel mouth", () => {
		const columns = planCorridor(at(0, 64, 0), at(4, 62, 0), "1x2", "auto");
		// 下坡列（y 63 与 62）：机器人从高层走近，头顶 1.8 会撞过渡檐——檐块必须挖。
		expect(columns[1]!.digCeiling).toBe(true);
		expect(columns[1]!.cells).toContainEqual(at(1, 65, 0));
		expect(columns[2]!.cells).toContainEqual(at(2, 64, 0));
		// 平地列不挖檐。
		expect(columns[0]!.digCeiling).toBe(false);
		const flat = planCorridor(at(0, 64, 0), at(3, 64, 0), "1x2", "auto");
		for (const column of flat) expect(column.digCeiling).toBe(false);
	});

	test("stairs auto falls back to a shaft when horizontal steps run out", () => {
		const columns = planCorridor(at(0, 64, 0), at(1, 68, 0), "1x2", "auto");
		const ys = columns.map((column) => column.floor.y);
		expect(ys).toEqual([64, 65, 66, 67, 68]);
		expect(columns.at(-1)!.floor).toEqual(at(1, 68, 0));
	});

	test("stairs never keeps horizontal floors level and joins levels with a shaft", () => {
		const columns = planCorridor(at(0, 64, 0), at(3, 67, 0), "1x2", "never");
		const horizontals = columns.slice(0, 4);
		expect(horizontals.map((column) => column.floor.y)).toEqual([64, 64, 64, 64]);
		expect(columns.map((column) => column.floor.y)).toEqual([64, 64, 64, 64, 65, 66, 67]);
		expect(columns.at(-1)!.floor).toEqual(at(3, 67, 0));
	});

	test("L-shape takes the longer axis first", () => {
		const columns = planCorridor(at(0, 64, 0), at(2, 64, 3), "1x2", "auto");
		expect(columns.map((column) => column.floor)).toEqual([
			at(0, 64, 0),
			at(0, 64, 1),
			at(0, 64, 2),
			at(0, 64, 3),
			at(1, 64, 3),
			at(2, 64, 3),
		]);
	});

	test("wider profiles spread perpendicular to travel with deduplicated cells", () => {
		const { width, height } = expandProfile("3x3");
		expect({ width, height }).toEqual({ width: 3, height: 3 });
		const columns = planCorridor(at(0, 64, 0), at(2, 64, 0), "3x3", "auto");
		for (const column of columns) {
			expect(column.cells).toHaveLength(9);
			expect(new Set(column.cells.map((cell) => `${cell.x},${cell.y},${cell.z}`)).size).toBe(9);
			// x 向行进：宽度沿 z 展开（0..2）。
			expect(column.cells.map((cell) => cell.z)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
			expect(column.cells.map((cell) => cell.y)).toEqual([64, 65, 66, 64, 65, 66, 64, 65, 66]);
		}
	});

	test("zero-distance tunnel plans a single already-open column", () => {
		const columns = planCorridor(at(7, 64, 7), at(7, 64, 7), "1x2", "auto");
		expect(columns).toHaveLength(1);
		expect(columns[0]!.cells).toEqual([at(7, 64, 7), at(7, 65, 7)]);
	});
});

describe("excavation planning", () => {
	test("normalizeBox accepts closed intervals in either corner order", () => {
		const box = normalizeBox(at(3, 70, 5), at(0, 68, 2));
		expect(box.min).toEqual(at(0, 68, 2));
		expect(box.max).toEqual(at(3, 70, 5));
		expect(box.voxels).toBe(4 * 3 * 4);
	});

	test("layers come top-down so the head opens before the feet", () => {
		const layers = planExcavation(at(0, 66, 0), at(1, 68, 1));
		expect(layers.map((layer) => layer[0]!.y)).toEqual([68, 67, 66]);
		expect(layers).toHaveLength(3);
		for (const layer of layers) expect(layer).toHaveLength(4);
	});

	test("orderNear sorts a layer by manhattan distance to the current position", () => {
		const layer = [at(5, 67, 0), at(0, 67, 0), at(2, 67, 4), at(2, 67, 0)];
		expect(orderNear(layer, at(2, 67, 0))).toEqual([at(2, 67, 0), at(0, 67, 0), at(5, 67, 0), at(2, 67, 4)]);
	});

	test("defaults and limits follow the capability contract", () => {
		expect([...DEFAULT_EXCAVATE_KEEP]).toEqual(["bedrock", "chest", "furnace", "spawner"]);
		expect(EXCAVATE_MAX_VOXELS).toBe(4096);
	});
});

describe("block classification", () => {
	test("gravity blocks are exactly the falling ones", () => {
		for (const name of ["sand", "red_sand", "gravel"]) expect(isGravityBlock(name)).toBe(true);
		for (const name of ["stone", "sandstone", "suspicious_sand", "dirt"]) expect(isGravityBlock(name)).toBe(false);
	});

	test("fluids and containers classify for tunnel/excavate verdicts", () => {
		expect(isLiquidBlock("water")).toBe(true);
		expect(isLiquidBlock("lava")).toBe(true);
		expect(isLiquidBlock("bubble_column")).toBe(true);
		expect(isLiquidBlock("glass")).toBe(false);
		for (const name of [
			"chest",
			"trapped_chest",
			"barrel",
			"white_shulker_box",
			"furnace",
			"hopper",
			"dispenser",
			"dropper",
		]) {
			expect(isContainerBlock(name)).toBe(true);
		}
		for (const name of ["chest_boat", "ender_chest_boat", "crafting_table", "stone"]) {
			expect(isContainerBlock(name)).toBe(false);
		}
	});
});
