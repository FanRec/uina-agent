/**
 * `.schem`（Sponge v2/v3）解码：针对入库的真实字节，不是内存里自己造的假对象。
 *
 * fixtures/house.schem 由 `scripts/make-mc-schem-fixture.mjs` 生成：5×4×5 木屋，
 * 墙 46（四面墙 16×3 减去门 2 格）+ 屋顶 25 = 71 木板，门 2 格，火把 1 格，
 * 其余 26 格空气。house-v2 在 (3,1,3) 多一块圆石。
 */

import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { decodeSchem, parseBlockState } from "../../.uina/worlds/minecraft/construction/schem.js";
import { ConstructionError, isAirName } from "../../.uina/worlds/minecraft/construction/target.js";
import type { TargetCell } from "../../.uina/worlds/minecraft/construction/target.js";

const house = new Uint8Array(readFileSync(new URL("./fixtures/house.schem", import.meta.url)));
const houseV2 = new Uint8Array(readFileSync(new URL("./fixtures/house-v2.schem", import.meta.url)));

function at(cells: TargetCell[], x: number, y: number, z: number): TargetCell | undefined {
	return cells.find((cell) => cell.at.x === x && cell.at.y === y && cell.at.z === z);
}

describe("decodeSchem", () => {
	test("尺寸、格数与四分类计数与夹具一致（airPolicy=preserve）", () => {
		const target = decodeSchem(house, { airPolicy: "preserve" });
		expect(target.size).toEqual({ x: 5, y: 4, z: 5 });
		expect(target.cells).toHaveLength(100);
		const kinds = target.cells.reduce<Record<string, number>>((counts, cell) => {
			counts[cell.kind] = (counts[cell.kind] ?? 0) + 1;
			return counts;
		}, {});
		expect(kinds).toEqual({ set: 74, preserve: 26 });
	});

	test("airPolicy=set_air 把空气变成 clear，而不是 preserve", () => {
		const target = decodeSchem(house, { airPolicy: "set_air" });
		const kinds = target.cells.reduce<Record<string, number>>((counts, cell) => {
			counts[cell.kind] = (counts[cell.kind] ?? 0) + 1;
			return counts;
		}, {});
		expect(kinds).toEqual({ set: 74, clear: 26 });
	});

	test("含空气却不给策略：INVALID_INPUT 且文案点名 airPolicy", () => {
		expect(() => decodeSchem(house)).toThrow(ConstructionError);
		expect(() => decodeSchem(house)).toThrow(/airPolicy/);
	});

	test("方块状态按 palette 原样解析（门只声明 half）", () => {
		const target = decodeSchem(house, { airPolicy: "preserve" });
		expect(at(target.cells, 2, 0, 0)?.block).toEqual({ name: "oak_door", properties: { half: "lower" } });
		expect(at(target.cells, 2, 1, 0)?.block).toEqual({ name: "oak_door", properties: { half: "upper" } });
		expect(at(target.cells, 1, 0, 1)?.block).toBe("torch");
		expect(at(target.cells, 0, 0, 0)?.block).toBe("oak_planks");
	});

	test("索引是 xzy：墙在 y=0..2 的环上、屋顶铺满 y=3", () => {
		const target = decodeSchem(house, { airPolicy: "preserve" });
		for (let y = 0; y <= 2; y++) {
			for (let x = 0; x < 5; x++) {
				for (let z = 0; z < 5; z++) {
					const edge = x === 0 || x === 4 || z === 0 || z === 4;
					// 室内唯一非空气格是贴在真服地面上的那支火把。
					const torch = x === 1 && y === 0 && z === 1;
					expect(at(target.cells, x, y, z)?.kind, `${x},${y},${z}`).toBe(edge || torch ? "set" : "preserve");
				}
			}
		}
		for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) expect(at(target.cells, x, 3, z)?.kind).toBe("set");
	});

	test("改版夹具多一块圆石：格数与目标都变，digest 输入因此不同", () => {
		const target = decodeSchem(houseV2, { airPolicy: "preserve" });
		expect(at(target.cells, 3, 1, 3)?.block).toBe("cobblestone");
		expect(target.cells.filter((cell) => cell.kind === "set")).toHaveLength(75);
		expect(houseV2.length).not.toBe(house.length);
	});
});

describe("decodeSchem 的失败面", () => {
	test("不是 NBT 的字节：WRONG_STATE 并点出支持范围", () => {
		const error = (() => {
			try {
				decodeSchem(new Uint8Array([1, 2, 3, 4]));
				return null;
			} catch (caught) {
				return caught as ConstructionError;
			}
		})();
		expect(error?.code).toBe("WRONG_STATE");
		expect(error?.message).toMatch(/not a readable schematic/);
		expect(error?.hint).toMatch(/supported formats: \.schem/);
	});

	test("root 名不是 Schematic 时拒绝，不返回空建筑", () => {
		const minimal = Buffer.concat([
			Buffer.from([10]),
			Buffer.from([0, 5]),
			Buffer.from("Level", "utf8"),
			Buffer.from([0]),
		]);
		expect(() => decodeSchem(new Uint8Array(minimal))).toThrow(/root is "Level"/);
	});

	test("Version 1 不支持", () => {
		const minimal = Buffer.concat([
			Buffer.from([10]),
			Buffer.from([0, 9]),
			Buffer.from("Schematic", "utf8"),
			Buffer.from([3, 0, 7]),
			Buffer.from("Version", "utf8"),
			Buffer.from([0, 0, 0, 1]),
			Buffer.from([0]),
		]);
		expect(() => decodeSchem(new Uint8Array(minimal))).toThrow(/Version 1 is not supported/);
	});

	test("截断的 BlockData 报缺失而不是当成空气补齐", () => {
		const truncated = decodeFragment(house, { dropTail: 40 });
		expect(() => decodeSchem(truncated, { airPolicy: "preserve" })).toThrow(/truncated|unexpected end/);
	});
});

/**
 * 把 gzip 体解开后截尾再压回去：模拟"文件被拷坏一半"。
 * 这是唯一一处测试侧对字节的加工——真实坏文件不可能手写出来。
 */
function decodeFragment(bytes: Uint8Array, options: { dropTail: number }): Uint8Array {
	const raw = gunzipSync(Buffer.from(bytes));
	const cut = raw.subarray(0, Math.max(0, raw.length - options.dropTail));
	return new Uint8Array(gzipSync(cut));
}

describe("parseBlockState", () => {
	test("带属性的状态解析成名称 + 属性表", () => {
		expect(parseBlockState("minecraft:oak_stairs[facing=east,half=top]")).toEqual({
			name: "oak_stairs",
			properties: { facing: "east", half: "top" },
		});
	});

	test("只有名字时属性为空，命名空间被去掉", () => {
		expect(parseBlockState("minecraft:stone")).toEqual({ name: "stone", properties: {} });
		expect(isAirName("minecraft:cave_air")).toBe(true);
	});

	test("畸形属性对拒绝", () => {
		expect(() => parseBlockState("minecraft:oak_stairs[facing]")).toThrow(/malformed property/);
	});
});
