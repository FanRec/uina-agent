/**
 * region@1 读取器确定性测试：palette 去重、xzy 顺序、未加载 -1/missing、
 * 体素上限拒绝、跨区块 chunksLoaded。数据来自脚本化的 stub 事实视图
 * （与 block@1 同一形状：state null = 未加载）。
 */

import { describe, expect, test } from "vitest";
import type { ClientFactView } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { Fact, JsonValue, Vec3 } from "../../.uina/worlds/minecraft/contracts/values.js";
import { regionModule } from "../../.uina/worlds/minecraft/capabilities/queries/region.js";
import { self } from "./mc-capability-harness.js";

interface ScriptedBlock {
	name: string;
	properties?: Record<string, string>;
}

function viewWith(world: Map<string, ScriptedBlock | null>): ClientFactView {
	const factBase = {
		observedAt: "2026-01-01T00:00:00.000Z",
		source: "server",
		coverage: "complete",
		unknown: [],
		evidence: [],
	};
	return {
		self: () => ({ ...factBase, value: self, cursor: null }) as unknown as Fact<never>,
		block: (target: { block: Vec3 }) => {
			const key = `${target.block.x},${target.block.y},${target.block.z}`;
			const scripted = world.get(key) ?? null;
			const value =
				scripted == null
					? { target, state: null, sign: null }
					: {
							target,
							state: { name: `minecraft:${scripted.name}`, properties: scripted.properties ?? {} },
							sign: null,
						};
			return { ...factBase, value } as unknown as Fact<never>;
		},
	} as unknown as ClientFactView;
}

function read(view: ClientFactView, input: JsonValue) {
	const definition = regionModule.definitions.find((entry) => entry.descriptor.ref === "region@1");
	if (definition?.kind !== "query") throw new Error("missing region@1 query definition");
	const reader = definition.bind({} as never) as { read: (view: ClientFactView, input: JsonValue) => unknown };
	return reader.read(view, input) as {
		value: {
			origin: Vec3;
			shape: [number, number, number];
			palette: { name: string; properties: Record<string, string> }[];
			cells: number[];
			order: string;
			missing: number;
			scanned: { chunksLoaded: number };
		};
		unknown: string[];
	};
}

describe("region@1 reader", () => {
	test("decodes a closed box with palette dedup and air first", () => {
		const world = new Map<string, ScriptedBlock | null>();
		for (let x = 0; x < 4; x++)
			for (let y = 63; y <= 65; y++) for (let z = 0; z < 4; z++) world.set(`${x},${y},${z}`, { name: "stone" });
		world.set("1,64,1", { name: "oak_planks" });
		world.set("2,64,2", { name: "oak_planks" });
		world.set("3,65,3", { name: "air" });
		const result = read(viewWith(world), { from: { x: 0, y: 63, z: 0 }, to: { x: 3, y: 65, z: 3 } });
		expect(result.value.shape).toEqual([4, 3, 4]);
		expect(result.value.order).toBe("xzy");
		expect(result.value.missing).toBe(0);
		expect(result.value.palette[0]).toEqual({ name: "air", properties: {} });
		expect(result.value.palette.map((entry) => entry.name)).toEqual(["air", "stone", "oak_planks"]);
		// i = (y-oy)*nx*nz + (z-oz)*nx + (x-ox)：x 最快。
		const cellAt = (x: number, y: number, z: number): number =>
			result.value.cells[(y - 63) * 16 + (z - 0) * 4 + (x - 0)];
		expect(cellAt(0, 63, 0)).toBe(1);
		expect(cellAt(1, 64, 1)).toBe(2);
		expect(cellAt(2, 64, 2)).toBe(2);
		expect(cellAt(3, 65, 3)).toBe(0);
		expect(result.unknown).toEqual([]);
	});

	test("unloaded cells are -1 with missing count, never air", () => {
		const world = new Map<string, ScriptedBlock | null>();
		world.set("0,63,0", { name: "stone" });
		world.set("1,63,0", null); // 显式 null（未加载）与缺失同口径
		const result = read(viewWith(world), { at: { x: 0, y: 63, z: 0 }, size: { x: 4, y: 1, z: 1 } });
		expect(result.value.cells).toEqual([1, -1, -1, -1]);
		expect(result.value.missing).toBe(3);
		expect(result.unknown.some((note) => note.includes("3 cell(s) not loaded"))).toBe(true);
	});

	test("chunksLoaded counts distinct loaded columns across a chunk border", () => {
		const world = new Map<string, ScriptedBlock | null>();
		// x=15 在区块 0，x=16 在区块 1。
		for (const x of [15, 16]) world.set(`${x},63,0`, { name: "stone" });
		const result = read(viewWith(world), { from: { x: 15, y: 63, z: 0 }, to: { x: 16, y: 63, z: 0 } });
		expect(result.value.missing).toBe(0);
		expect(result.value.scanned.chunksLoaded).toBe(2);
	});

	test("more than 8192 voxels is rejected before any sampling", () => {
		const world = new Map<string, ScriptedBlock | null>();
		expect(() => read(viewWith(world), { from: { x: 0, y: 0, z: 0 }, to: { x: 16, y: 31, z: 15 } })).toThrowError(
			expect.objectContaining({ code: "INVALID_INPUT" }),
		);
	});

	test("size components must be positive integers", () => {
		const world = new Map<string, ScriptedBlock | null>();
		expect(() => read(viewWith(world), { at: { x: 0, y: 63, z: 0 }, size: { x: 0, y: 1, z: 1 } })).toThrowError(
			expect.objectContaining({ code: "INVALID_INPUT" }),
		);
	});

	test("exactly 8192 voxels is accepted at the contract limit", () => {
		const world = new Map<string, ScriptedBlock | null>();
		for (let y = 0; y < 32; y++)
			for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) world.set(`${x},${y},${z}`, { name: "stone" });
		const result = read(viewWith(world), { from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 31, z: 15 } });
		expect(result.value.cells).toHaveLength(8192);
		expect(result.value.missing).toBe(0);
	});
});
