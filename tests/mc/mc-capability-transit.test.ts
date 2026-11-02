/**
 * transit@1 的确定性测试：维度换算、选址几何、派发前的失败面、找门/建门两条路径、
 * 进门后维度切换的完成判据。真实传送由 dev/transit.ts 在 Paper 上验收。
 */
import { describe, expect, test } from "vitest";
import {
	bareDimension,
	linkedCoordinates,
	portalFrame,
	portalSite,
	siteUsable,
	regionGrid,
} from "../../.uina/worlds/minecraft/capabilities/shared/portal.js";
import { failureOf, makeHarness, type HarnessState } from "./mc-capability-harness.js";

function state(counts: Record<string, number> = {}, blocks: HarnessState["blocks"] = new Map()): HarnessState {
	return { blocks, inventory: { slots: [], counts } };
}

function at(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

function stone(state: HarnessState, cells: { x: number; y: number; z: number }[]): void {
	for (const cell of cells) state.blocks.set(at(cell.x, cell.y, cell.z), { name: "stone", properties: {} });
}

/** 交互放置的落点：被点的支撑面 + 面的法线。 */
function placedAt(support: { x: number; y: number; z: number }, normal: { x: number; y: number; z: number }): string {
	return at(support.x + normal.x, support.y + normal.y, support.z + normal.z);
}

describe("portal geometry", () => {
	test("4x5 框 = 14 格黑曜石 + 6 格内部，轴 x 与轴 z 只换宽高方向", () => {
		const frame = portalFrame({ x: 10, y: 64, z: 10 }, "x");
		expect(frame.obsidian).toHaveLength(14);
		expect(frame.interior).toHaveLength(6);
		// 底排 4 格沿 x 展开
		expect(frame.obsidian.slice(0, 4)).toEqual([
			{ x: 10, y: 64, z: 10 },
			{ x: 11, y: 64, z: 10 },
			{ x: 12, y: 64, z: 10 },
			{ x: 13, y: 64, z: 10 },
		]);
		// 顶排在第 5 层
		expect(frame.obsidian.slice(-4).every((cell) => cell.y === 68)).toBe(true);
		expect(frame.entrance).toEqual({ x: 11, y: 65, z: 10 });
		// 点火格是底排中间那格：正上方就是门内空气（点角上的话火会指向柱子）
		expect(frame.ignite).toEqual({ x: 11, y: 64, z: 10 });
		expect(frame.interior).toContainEqual({ x: 11, y: 65, z: 10 });

		const alongZ = portalFrame({ x: 10, y: 64, z: 10 }, "z");
		expect(alongZ.obsidian[1]).toEqual({ x: 10, y: 64, z: 11 });
		expect(alongZ.entrance).toEqual({ x: 10, y: 65, z: 11 });
	});

	test("门内 6 格全在框内（不越界到框上）", () => {
		const frame = portalFrame({ x: 0, y: 0, z: 0 }, "x");
		for (const cell of frame.interior) {
			expect(cell.x).toBeGreaterThanOrEqual(1);
			expect(cell.x).toBeLessThanOrEqual(2);
			expect(cell.y).toBeGreaterThanOrEqual(1);
			expect(cell.y).toBeLessThanOrEqual(3);
			expect(cell.z).toBe(0);
		}
	});

	test("下界按 1:8 换算，末地不缩放", () => {
		expect(linkedCoordinates("overworld", "the_nether", { x: 80, y: 64, z: -160 })).toEqual({ x: 10, y: 64, z: -20 });
		expect(linkedCoordinates("the_nether", "overworld", { x: 10, y: 64, z: -20 })).toEqual({ x: 80, y: 64, z: -160 });
		expect(linkedCoordinates("overworld", "the_end", { x: 5, y: 64, z: 5 })).toEqual({ x: 5, y: 64, z: 5 });
		expect(bareDimension("minecraft:the_nether")).toBe("the_nether");
	});

	test("选址：内部与框都要空、底排要实地、至少一侧能站人", () => {
		const site = portalSite({ x: 10, y: 64, z: 10 }, "x");
		const blocks = new Map<string, { name: string; properties: Record<string, string> }>();
		for (const support of site.supports)
			blocks.set(at(support.x, support.y, support.z), { name: "stone", properties: {} });
		blocks.set(at(11, 63, 11), { name: "stone", properties: {} });
		const grid = regionGrid({
			origin: { x: 0, y: 0, z: 0 },
			shape: [32, 96, 32],
			palette: [
				{ name: "air", properties: {} },
				{ name: "stone", properties: {} },
			],
			cells: buildCells(32, 96, 32, blocks),
		});
		expect(grid).not.toBeNull();
		expect(siteUsable(grid!, site, (name) => name === "air")).toBe(true);
		// 抽掉一侧支撑就不可建
		blocks.delete(at(12, 63, 10));
		const broken = regionGrid({
			origin: { x: 0, y: 0, z: 0 },
			shape: [32, 96, 32],
			palette: [
				{ name: "air", properties: {} },
				{ name: "stone", properties: {} },
			],
			cells: buildCells(32, 96, 32, blocks),
		});
		expect(siteUsable(broken!, site, (name) => name === "air")).toBe(false);
	});
});

function buildCells(nx: number, ny: number, nz: number, blocks: Map<string, { name: string }>): number[] {
	const cells = new Array(nx * ny * nz).fill(0);
	for (const [key, block] of blocks) {
		const [x, y, z] = key.split(",").map(Number) as [number, number, number];
		cells[y * nx * nz + z * nx + x] = block.name === "stone" ? 1 : 0;
	}
	return cells;
}

/** 站在点亮的门里 → 服务端把身体送走（不是任何动作的副作用）。 */
function teleportsWhenInPortal(
	blocks: HarnessState["blocks"],
): (self: { place: { position: { x: number; y: number; z: number }; dimension: string } }) => void {
	return (self) => {
		const block = blocks.get(
			at(Math.floor(self.place.position.x), Math.floor(self.place.position.y), Math.floor(self.place.position.z)),
		);
		if (block?.name === "nether_portal") self.place = { ...self.place, dimension: "the_nether" };
	};
}

describe("transit@1", () => {
	test("未知维度 → INVALID_INPUT（不取身体）", async () => {
		const h = makeHarness(state());
		const err = await failureOf(
			h.callable("transit@1").invoke(h.ctx, { destination: { dimension: "minecraft:moon" } }),
		);
		expect(err.code).toBe("INVALID_INPUT");
		expect(h.bodyAcquired()).toBe(0);
	});

	test("destination.at 的显式维度与 destination.dimension 冲突 → INVALID_INPUT", async () => {
		const h = makeHarness(state());
		const err = await failureOf(
			h.callable("transit@1").invoke(h.ctx, {
				destination: {
					dimension: "minecraft:the_nether",
					at: { position: { x: 1, y: 2, z: 3 }, dimension: "overworld" },
				},
			}),
		);
		expect(err.code).toBe("INVALID_INPUT");
		expect(h.bodyAcquired()).toBe(0);
	});

	test("同维度不给 at → 直接完成，不派发任何动作", async () => {
		const h = makeHarness(state());
		const value = (await h.callable("transit@1").invoke(h.ctx, {
			destination: { dimension: "minecraft:overworld" },
		})) as { reached: boolean; dimension: string; stages: unknown[] };
		expect(value.reached).toBe(true);
		expect(value.dimension).toBe("overworld");
		expect(value.stages).toEqual([]);
		expect(h.calls).toEqual([]);
		expect(h.bodyAcquired()).toBe(0);
	});

	test("同维度给 at → 一段 goto", async () => {
		const h = makeHarness(state());
		const value = (await h.callable("transit@1").invoke(h.ctx, {
			destination: { dimension: "minecraft:overworld", at: { x: 20, y: 64, z: 10 } },
		})) as { stages: { kind: string; ok: boolean }[] };
		expect(value.stages).toEqual([{ kind: "goto", ok: true, at: { x: 20, y: 64, z: 10 } }]);
		expect(h.calls.some((call) => call.startsWith("goto:"))).toBe(true);
	});

	test("跨维度但 allow 只有 ride 方式 → UNREACHABLE（不静默退化步行）", async () => {
		const h = makeHarness(state());
		const err = await failureOf(
			h.callable("transit@1").invoke(h.ctx, {
				destination: { dimension: "minecraft:the_nether" },
				allow: ["horse"],
			}),
		);
		expect(err.code).toBe("UNREACHABLE");
		expect(err.dispatch).toBe("not_sent");
		expect(h.calls).toEqual([]);
		expect(h.bodyAcquired()).toBe(0);
	});

	test("没有门也没有材料 → MISSING_MATERIAL（取身体之前）", async () => {
		const h = makeHarness(state({ obsidian: 4 }));
		const err = await failureOf(
			h.callable("transit@1").invoke(h.ctx, { destination: { dimension: "minecraft:the_nether" } }),
		);
		expect(err.code).toBe("MISSING_MATERIAL");
		expect(String(err.message)).toContain("14");
		expect(h.bodyAcquired()).toBe(0);
	});

	test("已有门 → 复用（stages.portal.reason=found）并走进去", async () => {
		const blocks = new Map<string, { name: string; properties: Record<string, string> }>();
		blocks.set(at(14, 64, 10), { name: "nether_portal", properties: { axis: "x" } });
		const h = makeHarness(state({}, blocks), { onSelf: teleportsWhenInPortal(blocks) });
		const value = (await h.callable("transit@1").invoke(h.ctx, {
			destination: { dimension: "minecraft:the_nether" },
		})) as { reached: boolean; dimension: string; stages: { kind: string; ok: boolean; reason?: string }[] };
		expect(value.reached).toBe(true);
		expect(value.dimension).toBe("the_nether");
		expect(value.stages[0]).toMatchObject({ kind: "portal", ok: true, reason: "found" });
		expect(value.stages.some((stage) => stage.kind === "enter" && stage.ok)).toBe(true);
	});

	test("没有门但材料齐 → 建 14 格黑曜石、点亮、进门", async () => {
		const s = state({ obsidian: 14, flint_and_steel: 1 });
		stone(s, [
			{ x: 10, y: 63, z: 10 },
			{ x: 11, y: 63, z: 10 },
			{ x: 12, y: 63, z: 10 },
			{ x: 13, y: 63, z: 10 },
			{ x: 11, y: 63, z: 11 },
		]);
		let holding = "";
		/** 火被放进了哪一格（点火必须落在门内，点在角上什么都不会发生）。 */
		let igniteAt = "";
		const interior = new Set<string>();
		for (let y = 65; y <= 67; y++) for (let x = 11; x <= 12; x++) interior.add(at(x, y, 10));
		const h = makeHarness(s, {
			onEquip: (_slot, item) => {
				holding = item?.name ?? "";
			},
			onInteract: (target, face) => {
				if (holding === "flint_and_steel") {
					igniteAt = placedAt(target.block, face);
					// 只有"正上方是门内空气"的底排块才能点亮：其余落点服务端会拒绝。
					if (!interior.has(igniteAt)) return;
					for (const cell of interior) s.blocks.set(cell, { name: "nether_portal", properties: { axis: "x" } });
					return;
				}
				// 放下的格子 = 被点的支撑面 + 面的法线（不是支撑面本身）
				s.blocks.set(placedAt(target.block, face), { name: "obsidian", properties: {} });
			},
			onSelf: teleportsWhenInPortal(s.blocks),
		});
		const value = (await h.callable("transit@1").invoke(h.ctx, {
			destination: { dimension: "minecraft:the_nether" },
		})) as { reached: boolean; stages: { kind: string; reason?: string }[] };
		expect(value.reached).toBe(true);
		expect(igniteAt).toBe("11,65,10");
		const portal = value.stages.find((stage) => stage.kind === "portal");
		expect(portal?.reason).toContain("built");
		expect(portal?.reason).toContain("14");
		expect(h.calls.filter((call) => call === "interact").length).toBeGreaterThanOrEqual(15);
	});
});
