import { describe, expect, test } from "vitest";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { failureOf, makeHarness, type HarnessState } from "./mc-capability-harness.js";

/**
 * 动作层行为（capabilities §4）：先查证再动手、拿身体前失败、完成按观察结算。
 *
 * 替身见 mc-capability-harness.ts：只替换世界读数与身体调用，不建第二套玩法。
 * - mine：派发后只认客户端空气；未加载不算 air；
 * - place：目标已占用且 replace=false 在取身体之前 CONFLICT；
 * - eat/attack/use：可预判的失败不占身体队列；
 * - 记录实际调用顺序，证明"没做多余的事"。
 */

describe("mine@1", () => {
	// self 在 10,64,10；相邻格才在射程内（mine 不寻路）。
	const NEAR = { x: 10, y: 64, z: 11 };
	const NEAR_KEY = "10,64,11";

	test("派发后客户端变空气即完成；掉落只报观察到的增量", async () => {
		const state: HarnessState = {
			blocks: new Map([[NEAR_KEY, { name: "oak_log", properties: {} }]]),
			inventory: {
				slots: [{ slot: 36, name: "wooden_pickaxe", count: 1 }],
				counts: { wooden_pickaxe: 1 },
				held: { name: "wooden_pickaxe", count: 1 },
			},
		};
		const harness = makeHarness(state, {
			onDig: () => {
				state.blocks.set(NEAR_KEY, { name: "air", properties: {} });
				state.inventory.counts.oak_log = 1;
				state.inventory.slots.push({ slot: 37, name: "oak_log", count: 1 });
			},
		});
		const result = (await harness.callable("mine@1").invoke(harness.ctx, {
			at: NEAR,
		} as JsonValue)) as { broken: boolean; dropped?: { name: string; count: number } };
		expect(result.broken).toBe(true);
		expect(result.dropped).toEqual({ name: "oak_log", count: 1 });
	});

	test("够不着的格子 → UNREACHABLE，且不取身体", async () => {
		const state: HarnessState = {
			blocks: new Map([["1,64,0", { name: "stone", properties: {} }]]),
			inventory: {
				slots: [{ slot: 36, name: "wooden_pickaxe", count: 1 }],
				counts: { wooden_pickaxe: 1 },
				held: { name: "wooden_pickaxe", count: 1 },
			},
		};
		const harness = makeHarness(state);
		const err = await failureOf(
			harness.callable("mine@1").invoke(harness.ctx, { at: { x: 1, y: 64, z: 0 } } as JsonValue),
		);
		expect(err.code).toBe("UNREACHABLE");
		expect(err.hint).toContain("goto@1");
		expect(err.dispatch).toBe("not_sent");
		expect(harness.bodyAcquired()).toBe(0);
	});

	test("服务端没确认（仍是原方块）→ TARGET_NOT_MET，不谎报 broken", async () => {
		const state: HarnessState = {
			blocks: new Map([[NEAR_KEY, { name: "stone", properties: {} }]]),
			inventory: {
				slots: [{ slot: 36, name: "wooden_pickaxe", count: 1 }],
				counts: { wooden_pickaxe: 1 },
				held: { name: "wooden_pickaxe", count: 1 },
			},
		};
		const harness = makeHarness(state);
		const err = await failureOf(harness.callable("mine@1").invoke(harness.ctx, { at: NEAR } as JsonValue));
		expect(err.code).toBe("TARGET_NOT_MET");
		expect(err.dispatch).toBe("sent");
		expect((err.progress as { broken: boolean }).broken).toBe(false);
	});

	test("没有能采这个方块的工具 → MISSING_TOOL（hint 带 required）", async () => {
		const state: HarnessState = {
			blocks: new Map([[NEAR_KEY, { name: "stone", properties: {} }]]),
			inventory: {
				slots: [{ slot: 36, name: "apple", count: 3 }],
				counts: { apple: 3 },
				held: { name: "apple", count: 3 },
			},
		};
		const harness = makeHarness(state);
		const err = await failureOf(harness.callable("mine@1").invoke(harness.ctx, { at: NEAR } as JsonValue));
		expect(err.code).toBe("MISSING_TOOL");
		expect(err.hint).toContain("wooden_pickaxe");
	});
});

describe("place@1", () => {
	test("目标已被占用且 replace=false：取身体之前 CONFLICT", async () => {
		const state: HarnessState = {
			blocks: new Map([["1,64,0", { name: "stone", properties: {} }]]),
			inventory: {
				slots: [{ slot: 36, name: "cobblestone", count: 5 }],
				counts: { cobblestone: 5 },
				held: { name: "cobblestone", count: 5 },
			},
		};
		const harness = makeHarness(state);
		const err = await failureOf(
			harness.callable("place@1").invoke(harness.ctx, { block: "cobblestone", at: { x: 1, y: 64, z: 0 } } as JsonValue),
		);
		expect(err.code).toBe("CONFLICT");
		expect(harness.bodyAcquired()).toBe(0);
	});

	test("缺材料：取身体之前 MISSING_MATERIAL", async () => {
		const state: HarnessState = {
			blocks: new Map([["1,64,0", null]]),
			inventory: { slots: [], counts: {} },
		};
		const harness = makeHarness(state);
		const err = await failureOf(
			harness.callable("place@1").invoke(harness.ctx, { block: "cobblestone", at: { x: 1, y: 64, z: 0 } } as JsonValue),
		);
		expect(err.code).toBe("MISSING_MATERIAL");
		expect(harness.bodyAcquired()).toBe(0);
	});
});

describe("eat@1 / attack@1 / use@1 的前置失败", () => {
	test("背包没有食物 → NOT_FOUND，且不取身体", async () => {
		const state: HarnessState = {
			blocks: new Map(),
			inventory: { slots: [{ slot: 36, name: "stone", count: 4 }], counts: { stone: 4 } },
		};
		// 不饿也不是这个用例要证明的事：先把 food 压到 14。
		const harness = makeHarness(state, { self: { food: 14 } });
		const err = await failureOf(harness.callable("eat@1").invoke(harness.ctx, {} as JsonValue));
		expect(err.code).toBe("NOT_FOUND");
		expect(harness.bodyAcquired()).toBe(0);
	});

	test("目标超出攻击距离 → UNREACHABLE", async () => {
		const state: HarnessState = {
			blocks: new Map(),
			inventory: { slots: [], counts: {} },
			entities: [
				{
					ref: { connection: "c", incarnation: "i", appearance: "a", networkId: 7 },
					name: "zombie",
					kind: "hostile",
					position: { x: 20, y: 64, z: 10 },
					distance: 10,
					item: null,
				},
			],
		};
		const harness = makeHarness(state);
		const err = await failureOf(harness.callable("attack@1").invoke(harness.ctx, { target: "zombie" } as JsonValue));
		expect(err.code).toBe("UNREACHABLE");
		expect(harness.bodyAcquired()).toBe(0);
	});

	test("对着箱子调 use → WRONG_STATE 并指向 container/craft/smelt", async () => {
		const state: HarnessState = {
			blocks: new Map([["11,64,10", { name: "chest", properties: {} }]]),
			inventory: { slots: [], counts: {} },
		};
		const harness = makeHarness(state);
		const err = await failureOf(
			harness.callable("use@1").invoke(harness.ctx, { at: { x: 11, y: 64, z: 10 } } as JsonValue),
		);
		expect(err.code).toBe("WRONG_STATE");
		expect(err.message).toContain("container@1");
	});
});
