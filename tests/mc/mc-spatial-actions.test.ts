/**
 * tunnel/excavate 动作层测试（替身世界 + 替身身体 + 替身导航）。
 *
 * 只替换真实环境边界（世界读数/挖掘确认/行走），完成判定与失败映射走真实实现：
 * 服务端确认口径（dig completion）、stopped/remaining/INTERRUPTED 映射、
 * 支撑延展先于 profile、drops 只累计正增量。容器收集的子调用路径在真服验收
 * （dev:mc:spatial）覆盖——窗口协议不属于本文件的替身范围。
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import type { CallContext } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import { key, makeHarness, type HarnessState } from "./mc-capability-harness.js";

afterEach(() => vi.useRealTimers());

const PICKAXE = { slots: [{ slot: 36, name: "wooden_pickaxe", count: 1 }], counts: { wooden_pickaxe: 1 } };

function solidBox(
	state: HarnessState,
	from: { x: number; y: number; z: number },
	to: { x: number; y: number; z: number },
): void {
	for (let x = from.x; x <= to.x; x++)
		for (let y = from.y; y <= to.y; y++)
			for (let z = from.z; z <= to.z; z++) state.blocks.set(key({ x, y, z }), { name: "stone", properties: {} });
}

describe("tunnel@1", () => {
	test("digs the corridor with server confirmation and walks to the far end", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: structuredClone(PICKAXE) };
		// 起点 1x2 是空气（自己站位），前方 1..4 列实心石；头顶支撑探测位在 y=66。
		state.blocks.set(key({ x: 10, y: 64, z: 10 }), { name: "air", properties: {} });
		state.blocks.set(key({ x: 10, y: 65, z: 10 }), { name: "air", properties: {} });
		state.blocks.set(key({ x: 11, y: 66, z: 10 }), { name: "gravel", properties: {} });
		state.blocks.set(key({ x: 12, y: 66, z: 10 }), { name: "stone", properties: {} });
		solidBox(state, { x: 11, y: 64, z: 10 }, { x: 14, y: 65, z: 10 });
		const h = makeHarness(state, {
			onDig: (target) => state.blocks.set(key(target.block), { name: "air", properties: {} }),
		});
		const value = await invoke<{ dug: number; stopped?: string; path: { name: string }[] }>(h, "tunnel@1", {
			to: { x: 14, y: 64, z: 10 },
		});
		expect(value.dug).toBe(9);
		expect(value.stopped).toBeUndefined();
		expect(value.path.every((entry: { name: string }) => entry.name === "stone" || entry.name === "gravel")).toBe(true);
		expect(value.path.filter((entry: { name: string }) => entry.name === "gravel")).toHaveLength(1);
		// 走廊与支撑位都成为空气；踏步/天花板不在挖除集。
		for (let x = 11; x <= 14; x++) {
			expect(state.blocks.get(key({ x, y: 64, z: 10 }))?.name).toBe("air");
			expect(state.blocks.get(key({ x, y: 65, z: 10 }))?.name).toBe("air");
		}
		expect(state.blocks.get(key({ x: 11, y: 66, z: 10 }))?.name).toBe("air");
		expect(state.blocks.get(key({ x: 12, y: 66, z: 10 }))?.name).toBe("stone");
		// 走拍推进到已挖到的最远列（本夹具 reach 内一次挖完，一条 goto 腿到位）。
		expect(h.calls.some((call) => call === "goto:14,64,10")).toBe(true);
	});

	test("corridor crossing a fluid fails UNREACHABLE before dispatching", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: structuredClone(PICKAXE) };
		state.blocks.set(key({ x: 10, y: 64, z: 10 }), { name: "air", properties: {} });
		state.blocks.set(key({ x: 10, y: 65, z: 10 }), { name: "air", properties: {} });
		solidBox(state, { x: 11, y: 64, z: 10 }, { x: 14, y: 65, z: 10 });
		state.blocks.set(key({ x: 12, y: 64, z: 10 }), { name: "water", properties: {} });
		const h = makeHarness(state, {
			onDig: (target) => state.blocks.set(key(target.block), { name: "air", properties: {} }),
		});
		await expect(invoke(h, "tunnel@1", { to: { x: 14, y: 64, z: 10 } })).rejects.toMatchObject({
			code: "UNREACHABLE",
			message: expect.stringContaining("water/lava"),
		});
	});

	test("corridor floor over an existing carve-out fails UNREACHABLE with support attribution", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: structuredClone(PICKAXE) };
		state.blocks.set(key({ x: 10, y: 64, z: 10 }), { name: "air", properties: {} });
		state.blocks.set(key({ x: 10, y: 65, z: 10 }), { name: "air", properties: {} });
		solidBox(state, { x: 11, y: 64, z: 10 }, { x: 14, y: 65, z: 10 });
		// G30 缺陷 c 形态：远端列的支撑格是既有走廊的空气——重入错位一格，脚位悬空。
		state.blocks.set(key({ x: 14, y: 63, z: 10 }), { name: "air", properties: {} });
		const h = makeHarness(state, {
			onDig: (target) => state.blocks.set(key(target.block), { name: "air", properties: {} }),
		});
		await expect(invoke(h, "tunnel@1", { to: { x: 14, y: 64, z: 10 } })).rejects.toMatchObject({
			code: "UNREACHABLE",
			message: expect.stringContaining("no support (air below)"),
		});
	});

	test("corridor crossing unloaded chunks fails UNREACHABLE, does not guess", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: structuredClone(PICKAXE) };
		state.blocks.set(key({ x: 10, y: 64, z: 10 }), { name: "air", properties: {} });
		state.blocks.set(key({ x: 10, y: 65, z: 10 }), { name: "air", properties: {} });
		solidBox(state, { x: 11, y: 64, z: 10 }, { x: 12, y: 65, z: 10 });
		// x=13 缺席地图 = 未加载。
		solidBox(state, { x: 14, y: 64, z: 10 }, { x: 14, y: 65, z: 10 });
		const h = makeHarness(state, {
			onDig: (target) => state.blocks.set(key(target.block), { name: "air", properties: {} }),
		});
		await expect(invoke(h, "tunnel@1", { to: { x: 14, y: 64, z: 10 } })).rejects.toMatchObject({
			code: "UNREACHABLE",
			message: expect.stringContaining("not loaded"),
		});
	});

	test("harvest-impossible blocks stop the tunnel with the dug prefix kept", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: { slots: [], counts: {} } };
		state.blocks.set(key({ x: 10, y: 64, z: 10 }), { name: "air", properties: {} });
		state.blocks.set(key({ x: 10, y: 65, z: 10 }), { name: "air", properties: {} });
		solidBox(state, { x: 11, y: 64, z: 10 }, { x: 14, y: 65, z: 10 });
		const h = makeHarness(state, {
			onDig: (target) => state.blocks.set(key(target.block), { name: "air", properties: {} }),
		});
		const value = await invoke<{ dug: number; stopped?: string }>(h, "tunnel@1", { to: { x: 14, y: 64, z: 10 } });
		expect(value).toMatchObject({ dug: 0, stopped: "unbreakable" });
		expect(h.calls).not.toContain("dig");
	});

	test("an aborted run maps to INTERRUPTED with dug progress", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: structuredClone(PICKAXE) };
		state.blocks.set(key({ x: 10, y: 64, z: 10 }), { name: "air", properties: {} });
		state.blocks.set(key({ x: 10, y: 65, z: 10 }), { name: "air", properties: {} });
		solidBox(state, { x: 11, y: 64, z: 10 }, { x: 14, y: 65, z: 10 });
		const h = makeHarness(state, {
			onDig: (target) => state.blocks.set(key(target.block), { name: "air", properties: {} }),
		});
		const controller = new AbortController();
		controller.abort();
		await expect(
			invoke(h, "tunnel@1", { to: { x: 14, y: 64, z: 10 } }, { ...h.ctx, signal: controller.signal } as CallContext),
		).rejects.toMatchObject({ code: "INTERRUPTED" });
	});
});

describe("excavate@1", () => {
	function pit(state: HarnessState, chestAt?: { x: number; y: number; z: number }): void {
		solidBox(state, { x: 10, y: 62, z: 10 }, { x: 13, y: 64, z: 13 });
		state.blocks.set(key({ x: 10, y: 64, z: 10 }), { name: "air", properties: {} });
		state.blocks.set(key({ x: 10, y: 65, z: 10 }), { name: "air", properties: {} });
		if (chestAt != null) state.blocks.set(key(chestAt), { name: "chest", properties: {} });
	}

	test("clears every non-kept cell, keeps the chest, and aggregates observed drops", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: structuredClone(PICKAXE) };
		pit(state, { x: 11, y: 63, z: 11 });
		const h = makeHarness(state, {
			onDig: (target) => {
				state.blocks.set(key(target.block), { name: "air", properties: {} });
				// 掉落入包：cobblestone 正增量（stone 的实际掉落）。
				state.inventory.counts.cobblestone = (state.inventory.counts.cobblestone ?? 0) + 1;
			},
		});
		const value = await invoke<{
			dug: number;
			remaining: unknown[];
			kept: { at: { x: number; y: number; z: number }; name: string }[];
			drops: Record<string, number>;
		}>(h, "excavate@1", { region: { from: { x: 10, y: 62, z: 10 }, to: { x: 13, y: 64, z: 13 } } });
		// 48 格 = 1 chest(kept) + 1 自身脚位(空气,open) + 46 挖除。
		expect(value).toMatchObject({ dug: 46, remaining: [] });
		expect(value.kept).toEqual([{ at: { x: 11, y: 63, z: 11 }, name: "chest" }]);
		expect(value.drops.cobblestone).toBe(46);
		expect(state.blocks.get(key({ x: 11, y: 63, z: 11 }))?.name).toBe("chest");
		expect(state.blocks.get(key({ x: 13, y: 62, z: 13 }))?.name).toBe("air");
	});

	test("kept blocks default to bedrock/chest/furnace/spawner and are never dug", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: structuredClone(PICKAXE) };
		pit(state, { x: 12, y: 62, z: 12 });
		state.blocks.set(key({ x: 12, y: 62, z: 12 }), { name: "spawner", properties: {} });
		const h = makeHarness(state, {
			onDig: (target) => {
				state.blocks.set(key(target.block), { name: "air", properties: {} });
				state.inventory.counts.cobblestone = (state.inventory.counts.cobblestone ?? 0) + 1;
			},
		});
		const value = await invoke<{ dug: number; kept: { name: string }[] }>(h, "excavate@1", {
			region: { from: { x: 10, y: 62, z: 10 }, to: { x: 13, y: 64, z: 13 } },
		});
		expect(value.dug).toBe(46);
		expect(value.kept).toEqual([{ at: { x: 12, y: 62, z: 12 }, name: "spawner" }]);
		expect(state.blocks.get(key({ x: 12, y: 62, z: 12 }))?.name).toBe("spawner");
	});

	test("unclearable cells stay in remaining and raise TARGET_NOT_MET with progress", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: { slots: [], counts: {} } };
		pit(state);
		const h = makeHarness(state, {
			onDig: (target) => state.blocks.set(key(target.block), { name: "air", properties: {} }),
		});
		const error = (await invoke(h, "excavate@1", {
			region: { from: { x: 10, y: 62, z: 10 }, to: { x: 13, y: 64, z: 13 } },
		}).catch((err: unknown) => err)) as {
			code?: string;
			progress?: { dug: number; goal: { remaining: number; blocked: number }; outstanding: unknown[] };
		};
		expect(error.code).toBe("TARGET_NOT_MET");
		expect(error.progress?.dug).toBe(0);
		// 空手挖不动石头：47 格都是已知阻碍（unbreakable），不是"剩余"也不是"未知"。
		expect(error.progress?.goal).toMatchObject({ remaining: 0, blocked: 47, uncertain: 0 });
		expect(error.progress?.outstanding).toHaveLength(16);
	});

	test("C11 an interrupted budget keeps never-visited cells in remainingCount (no double count)", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: structuredClone(PICKAXE) };
		// 4×4×4 = 64 格，全部实心；与 self(10,64,10) 不重叠。
		solidBox(state, { x: 20, y: 62, z: 20 }, { x: 23, y: 65, z: 23 });
		const controller = new AbortController();
		let digs = 0;
		const h = makeHarness(state, {
			onDig: (target) => {
				state.blocks.set(key(target.block), { name: "air", properties: {} });
				digs += 1;
				if (digs === 5) controller.abort();
			},
		});
		const error = (await invoke(
			h,
			"excavate@1",
			{ region: { from: { x: 20, y: 62, z: 20 }, to: { x: 23, y: 65, z: 23 } } },
			{ ...h.ctx, signal: controller.signal },
		).catch((err: unknown) => err)) as {
			code?: string;
			progress?: {
				dug: number;
				goal: { remaining: number; total: number; completed: number };
				reasons: Record<string, number>;
			};
		};
		expect(error.code).toBe("INTERRUPTED");
		expect(error.progress?.dug).toBe(5);
		// 旧实现只统计"尝试失败"格 → 这里会是 0；守恒后必须是 64 - 5 = 59。
		expect(error.progress?.goal).toMatchObject({ total: 64, completed: 5, remaining: 59 });
		expect(error.progress?.reasons).toMatchObject({ not_attempted: 59 });
	});

	test("regions above the voxel limit are rejected before any dig", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: structuredClone(PICKAXE) };
		pit(state);
		const h = makeHarness(state, {});
		await expect(
			invoke(h, "excavate@1", { region: { from: { x: 0, y: 0, z: 0 }, to: { x: 16, y: 16, z: 15 } } }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
	});
});

async function invoke<T = Record<string, unknown>>(
	h: ReturnType<typeof makeHarness>,
	ref: string,
	input: Record<string, unknown>,
	ctx: CallContext = h.ctx,
): Promise<T> {
	return (await h.callable(ref).invoke(ctx, input as never)) as T;
}
