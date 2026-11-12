/**
 * build@1 的动作层行为（capabilities §4 build）。
 *
 * 只替换两处外部边界：世界读数（harness 的 WorldReadPort，含 scripted 的 build.plan@1）
 * 与身体调用（dig/interact 的真实副作用由 hook 提供）。计划语义本身在
 * mc-construction-plan.test.ts 用真实实现验证，这里验证 build 的编排：
 * 派发前的拒绝、先清后放、已匹配跳过、收尾 remaining 与取消。
 */

import { describe, expect, test } from "vitest";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { BuildPlanValue, ConstructionTargetCell } from "../../.uina/worlds/minecraft/contracts/world.js";
import { failureOf, type HarnessState, makeHarness } from "./mc-capability-harness.js";

/** self 在 10,64,10：把目标放在相邻列，射程与支撑都好安排。 */
const FLOOR = "11,63,10";

function planOf(targets: ConstructionTargetCell[], extra: Partial<BuildPlanValue> = {}): BuildPlanValue {
	return {
		targets,
		need: {},
		missing: {},
		blocked: [],
		unreachable: [],
		estTicks: 0,
		...extra,
	};
}

function setAt(x: number, y: number, z: number, block = "oak_planks"): ConstructionTargetCell {
	return { at: { x, y, z }, kind: "set", block };
}

/**
 * interact 只带"被点的支撑面 + 面法向"，不带落点——落点由法向推出（客户端也是这么预测的）。
 * 替身照同一口径算，测试才不会把支撑面当成目标格。
 */
function placedAt(support: { x: number; y: number; z: number }, normal: { x: number; y: number; z: number }): string {
	return `${support.x + normal.x},${support.y + normal.y},${support.z + normal.z}`;
}

function inventoryOf(name: string, count: number): HarnessState["inventory"] {
	return {
		slots: [{ slot: 36, name, count }],
		counts: { [name]: count },
		held: { name, count },
	};
}

describe("build@1 派发前的拒绝", () => {
	test("计划报告现场冲突：CONFLICT，且一格都不动、不取身体", async () => {
		const state: HarnessState = {
			blocks: new Map([[FLOOR, { name: "stone", properties: {} }]]),
			inventory: inventoryOf("oak_planks", 4),
		};
		const harness = makeHarness(state, {
			buildPlan: () => planOf([setAt(11, 64, 10)], { blocked: [{ at: { x: 11, y: 64, z: 10 }, by: "stone" }] }),
		});
		const error = await failureOf(
			harness.callable("build@1").invoke(harness.ctx, {
				cells: [{ at: { x: 11, y: 64, z: 10 }, block: "oak_planks" }],
			} as JsonValue),
		);
		expect(error.code).toBe("CONFLICT");
		expect(error.hint).toContain("replace=true");
		expect(harness.bodyAcquired()).toBe(0);
		expect(harness.calls).toEqual([]);
	});

	test("计划报告缺料：MISSING_MATERIAL 且 progress 带缺口，不取身体", async () => {
		const state: HarnessState = {
			blocks: new Map([[FLOOR, { name: "stone", properties: {} }]]),
			inventory: { slots: [], counts: {} },
		};
		const harness = makeHarness(state, {
			buildPlan: () => planOf([setAt(11, 64, 10)], { need: { oak_planks: 2 }, missing: { oak_planks: 2 } }),
		});
		const error = await failureOf(
			harness.callable("build@1").invoke(harness.ctx, {
				cells: [{ at: { x: 11, y: 64, z: 10 }, block: "oak_planks" }],
			} as JsonValue),
		);
		expect(error.code).toBe("MISSING_MATERIAL");
		expect(error.progress).toEqual({ missing: { oak_planks: 2 }, need: { oak_planks: 2 } });
		expect(harness.bodyAcquired()).toBe(0);
	});

	test("蓝图不存在时把 build.plan 的失败原样上抛（NOT_FOUND）", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: { slots: [], counts: {} } };
		const harness = makeHarness(state, {
			buildPlan: () => {
				throw Object.assign(new Error('blueprint "house" is not in the library'), {
					code: "NOT_FOUND",
					name: "CallFailure",
				});
			},
		});
		const error = await failureOf(
			harness.callable("build@1").invoke(harness.ctx, {
				from: { kind: "blueprint", name: "house" },
				at: { x: 11, y: 64, z: 10 },
			} as JsonValue),
		);
		expect(error.code ?? error.message).toMatch(/NOT_FOUND|not in the library/);
	});
});

describe("build@1 施工执行", () => {
	test("自下而上放置，两格都完成；输出的格子与计划一致", async () => {
		const state: HarnessState = {
			blocks: new Map([[FLOOR, { name: "stone", properties: {} }]]),
			inventory: inventoryOf("oak_planks", 8),
		};
		const harness = makeHarness(state, {
			buildPlan: () => planOf([setAt(11, 64, 10), setAt(11, 65, 10)]),
			onInteract: (target, face) => {
				state.blocks.set(placedAt(target.block, face), { name: "oak_planks", properties: {} });
			},
		});
		const result = (await harness.callable("build@1").invoke(harness.ctx, {
			cells: [
				{ at: { x: 11, y: 65, z: 10 }, block: "oak_planks" },
				{ at: { x: 11, y: 64, z: 10 }, block: "oak_planks" },
			],
		} as JsonValue)) as { placed: number; cleared: number; skipped: number; remaining: unknown[] };

		expect(result.placed).toBe(2);
		expect(result.cleared).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.remaining).toEqual([]);
		expect(state.blocks.get("11,64,10")?.name).toBe("oak_planks");
		expect(state.blocks.get("11,65,10")?.name).toBe("oak_planks");
	});

	test("同层外圈先、中心后：3×3 平层的中心格最后放", async () => {
		const blocks = new Map<string, { name: string; properties: Record<string, string> }>();
		for (let x = 11; x <= 13; x++) {
			for (let z = 10; z <= 12; z++) blocks.set(`${x},63,${z}`, { name: "stone", properties: {} });
		}
		const state: HarnessState = { blocks, inventory: inventoryOf("oak_planks", 16) };
		const order: string[] = [];
		const cells: { at: { x: number; y: number; z: number }; block: string }[] = [];
		for (let x = 11; x <= 13; x++) {
			for (let z = 10; z <= 12; z++) cells.push({ at: { x, y: 64, z }, block: "oak_planks" });
		}
		const harness = makeHarness(state, {
			buildPlan: () => planOf(cells.map((cell) => ({ at: cell.at, kind: "set" as const, block: "oak_planks" }))),
			onInteract: (target, face) => {
				const at = placedAt(target.block, face);
				order.push(at);
				state.blocks.set(at, { name: "oak_planks", properties: {} });
			},
		});
		const result = (await harness.callable("build@1").invoke(harness.ctx, {
			cells,
		} as JsonValue)) as { placed: number; remaining: unknown[] };
		expect(result.placed).toBe(9);
		expect(result.remaining).toEqual([]);
		// 中心格 (12,64,11) 的支撑面是四邻的内侧面，必须留到最后。
		// 重试会让个别外圈格排到中心之后，但中心必须排在外圈之后（旧排序里它第 5 个）。
		expect(order.indexOf("12,64,11")).toBeGreaterThanOrEqual(6);
	});

	test("高于眼位的格先起跳再交互（上表面在眼位之上）", async () => {
		// self 在 10,64,10（眼位 65.62），目标格 11,66,10 的支撑面顶面在 66.0：
		// 从地面看不到，必须先起跳（drive jump）再派发。
		const state: HarnessState = {
			blocks: new Map([["11,65,10", { name: "stone", properties: {} }]]),
			inventory: inventoryOf("oak_planks", 4),
		};
		const harness = makeHarness(state, {
			buildPlan: () => planOf([setAt(11, 66, 10)]),
			onInteract: (target, face) => {
				state.blocks.set(placedAt(target.block, face), { name: "oak_planks", properties: {} });
			},
		});
		const result = (await harness.callable("build@1").invoke(harness.ctx, {
			cells: [{ at: { x: 11, y: 66, z: 10 }, block: "oak_planks" }],
		} as JsonValue)) as { placed: number };
		expect(result.placed).toBe(1);
		expect(harness.calls.indexOf("drive")).toBeGreaterThanOrEqual(0);
		expect(harness.calls.indexOf("drive")).toBeLessThan(harness.calls.indexOf("interact"));
	});

	test("先清后放：dig 在 interact 之前", async () => {
		const state: HarnessState = {
			blocks: new Map([
				[FLOOR, { name: "stone", properties: {} }],
				["12,64,10", { name: "stone", properties: {} }],
			]),
			inventory: {
				slots: [
					{ slot: 36, name: "wooden_pickaxe", count: 1 },
					{ slot: 37, name: "oak_planks", count: 8 },
				],
				counts: { wooden_pickaxe: 1, oak_planks: 8 },
				held: { name: "wooden_pickaxe", count: 1 },
			},
		};
		const harness = makeHarness(state, {
			buildPlan: () => planOf([{ at: { x: 12, y: 64, z: 10 }, kind: "clear" }, setAt(11, 64, 10)]),
			onDig: (target) => {
				state.blocks.set(`${target.block.x},${target.block.y},${target.block.z}`, { name: "air", properties: {} });
			},
			onInteract: (target, face) => {
				state.blocks.set(placedAt(target.block, face), { name: "oak_planks", properties: {} });
			},
		});
		const result = (await harness.callable("build@1").invoke(harness.ctx, {
			cells: [{ at: { x: 11, y: 64, z: 10 }, block: "oak_planks" }],
		} as JsonValue)) as { placed: number; cleared: number; skipped: number };

		expect(result.cleared).toBe(1);
		expect(result.placed).toBe(1);
		expect(result.skipped).toBe(0);
		expect(harness.calls.indexOf("dig")).toBeGreaterThanOrEqual(0);
		expect(harness.calls.indexOf("dig")).toBeLessThan(harness.calls.indexOf("interact"));
		expect(state.blocks.get("12,64,10")?.name).toBe("air");
	});

	test("已匹配的格跳过，不重复消耗、不取身体", async () => {
		const state: HarnessState = {
			blocks: new Map([
				[FLOOR, { name: "stone", properties: {} }],
				["11,64,10", { name: "oak_planks", properties: {} }],
			]),
			inventory: inventoryOf("oak_planks", 1),
		};
		const harness = makeHarness(state, { buildPlan: () => planOf([setAt(11, 64, 10)]) });
		const result = (await harness.callable("build@1").invoke(harness.ctx, {
			cells: [{ at: { x: 11, y: 64, z: 10 }, block: "oak_planks" }],
		} as JsonValue)) as { placed: number; skipped: number };

		expect(result).toMatchObject({ placed: 0, cleared: 0, skipped: 1 });
		expect(harness.bodyAcquired()).toBe(0);
		expect(harness.calls).toEqual([]);
	});

	test("preserve 与 unknown 不计入完成、也不去动它们", async () => {
		const state: HarnessState = {
			blocks: new Map([
				[FLOOR, { name: "stone", properties: {} }],
				["11,64,10", { name: "chest", properties: {} }],
			]),
			inventory: { slots: [], counts: {} },
		};
		const harness = makeHarness(state, {
			buildPlan: () =>
				planOf([
					{ at: { x: 11, y: 64, z: 10 }, kind: "preserve" },
					{ at: { x: 11, y: 65, z: 10 }, kind: "unknown", reason: "来源不明" },
				]),
		});
		const result = (await harness.callable("build@1").invoke(harness.ctx, { cells: [] } as unknown as JsonValue)) as {
			skipped: number;
			placed: number;
			cleared: number;
		};
		// preserve 算已满足（按设计不动），unknown 来源格无法核验 → 单独计入 uncertain。
		expect(result).toMatchObject({
			placed: 0,
			cleared: 0,
			skipped: 1,
			goal: { state: "unsatisfied", completed: 1, remaining: 0, blocked: 0, uncertain: 1, total: 2 },
		});
		expect(harness.calls).toEqual([]);
		expect(state.blocks.get("11,64,10")?.name).toBe("chest");
	});

	test("逐格冲突收尾进 remaining 并抛 TARGET_NOT_MET", async () => {
		const state: HarnessState = {
			blocks: new Map([
				[FLOOR, { name: "stone", properties: {} }],
				["11,64,10", { name: "stone", properties: {} }],
			]),
			inventory: inventoryOf("oak_planks", 4),
		};
		// 计划说没冲突（模拟"计划之后现场变了"），执行时逐格复核才发现。
		const harness = makeHarness(state, { buildPlan: () => planOf([setAt(11, 64, 10)]) });
		const error = await failureOf(
			harness.callable("build@1").invoke(harness.ctx, {
				cells: [{ at: { x: 11, y: 64, z: 10 }, block: "oak_planks" }],
			} as JsonValue),
		);
		expect(error.code).toBe("TARGET_NOT_MET");
		expect(error.progress).toMatchObject({
			goal: { state: "unsatisfied", completed: 0, remaining: 0, blocked: 1, uncertain: 0, total: 1 },
			outstanding: [{ at: { x: 11, y: 64, z: 10 }, target: "oak_planks", reason: "cell holds stone" }],
			reasons: { "cell holds stone": 1 },
		});
		expect(error.dispatch).toBe("sent");
	});

	test("第二轮补上缺支撑的格（多层施工的固有依赖）", async () => {
		// 两层：第二层的下方是空中的第一层格。第一轮先放地面层，第二轮才有面可点。
		const state: HarnessState = {
			blocks: new Map([[FLOOR, { name: "stone", properties: {} }]]),
			inventory: inventoryOf("oak_planks", 8),
		};
		const harness = makeHarness(state, {
			buildPlan: () => planOf([setAt(11, 64, 10), setAt(11, 65, 10)]),
			onInteract: (target, face) => {
				state.blocks.set(placedAt(target.block, face), { name: "oak_planks", properties: {} });
			},
		});
		const result = (await harness.callable("build@1").invoke(harness.ctx, {
			cells: [
				{ at: { x: 11, y: 64, z: 10 }, block: "oak_planks" },
				{ at: { x: 11, y: 65, z: 10 }, block: "oak_planks" },
			],
		} as JsonValue)) as { placed: number; skipped: number };
		expect(result).toMatchObject({ placed: 2, skipped: 0 });
		expect(state.blocks.get("11,65,10")?.name).toBe("oak_planks");
	});

	test("始终没有支撑面的格进 remaining，且不为它反复走位", async () => {
		const state: HarnessState = {
			blocks: new Map([[FLOOR, { name: "stone", properties: {} }]]),
			inventory: inventoryOf("oak_planks", 8),
		};
		const harness = makeHarness(state, { buildPlan: () => planOf([setAt(11, 70, 10)]) });
		const error = await failureOf(
			harness.callable("build@1").invoke(harness.ctx, {
				cells: [{ at: { x: 11, y: 70, z: 10 }, block: "oak_planks" }],
			} as JsonValue),
		);
		expect(error.code).toBe("TARGET_NOT_MET");
		expect(error.progress).toMatchObject({
			outstanding: [{ at: { x: 11, y: 70, z: 10 }, target: "oak_planks" }],
		});
		// 批30 起原因按真实结局记：6 格高的格没有任何候选站位够得着（几何无解），
		// 而不是"有站位但没支撑面"——两种失败在 remaining 里可分辨。
		expect(JSON.stringify(error.progress)).toContain("no candidate vantage within reach");
		expect(harness.calls.filter((call) => call.startsWith("goto:"))).toEqual([]);
	});

	test("预算耗尽：还没轮到的格也必须出现在 remaining 里", async () => {
		// 真服踩过：1s 预算下建了 6 格就超时，progress 却报 remainingCount=0——
		// 因为清单只收"试过但没成"的格，队列里没轮到的格一条都没算进去。
		//
		// 预算用 0（直接调 handler 不过 Ajv，这里刻意走边界值）：deadline === now，
		// 第一次 stopIfDone 就成立。不能依赖 maxTimeMs:1——桌面时钟粒度约 15ms，
		// 三格可能在同一个刻度里做完，超时根本不触发（并行全量下真红过一次）。
		const state: HarnessState = {
			blocks: new Map([[FLOOR, { name: "stone", properties: {} }]]),
			inventory: inventoryOf("oak_planks", 8),
		};
		const cells = [64, 65, 66].map((y) => ({ at: { x: 11, y, z: 10 }, block: "oak_planks" }));
		const harness = makeHarness(state, {
			buildPlan: () => planOf([setAt(11, 64, 10), setAt(11, 65, 10), setAt(11, 66, 10)]),
			onInteract: (target, face) => {
				state.blocks.set(placedAt(target.block, face), { name: "oak_planks", properties: {} });
			},
		});
		const error = await failureOf(
			harness.callable("build@1").invoke(harness.ctx, { cells, maxTimeMs: 0 } as JsonValue),
		);
		expect(error.code).toBe("TIMEOUT");
		// 总量守恒才是"如实交代"的判据：已结算 + 剩下必须等于设计格数。
		const progress = error.progress as {
			placed: number;
			cleared: number;
			skipped: number;
			goal: { completed: number; remaining: number; blocked: number; uncertain: number; total: number };
		};
		// 四态之和恒等于 total：这是"如实交代"的判据。
		expect(progress.goal.completed + progress.goal.remaining + progress.goal.blocked + progress.goal.uncertain).toBe(
			progress.goal.total,
		);
		expect(progress.goal.remaining).toBe(3);
		expect(JSON.stringify(error.progress)).toContain("not attempted yet");
	});

	test("运行被取消：INTERRUPTED 且 progress 保留已完成的量", async () => {
		const state: HarnessState = {
			blocks: new Map([[FLOOR, { name: "stone", properties: {} }]]),
			inventory: inventoryOf("oak_planks", 8),
		};
		const harness = makeHarness(state, {
			buildPlan: () => planOf([setAt(11, 64, 10), setAt(12, 64, 10)]),
		});
		const controller = new AbortController();
		controller.abort();
		const error = await failureOf(
			harness.callable("build@1").invoke({ ...harness.ctx, signal: controller.signal }, {
				cells: [{ at: { x: 11, y: 64, z: 10 }, block: "oak_planks" }],
			} as JsonValue),
		);
		expect(error.code).toBe("INTERRUPTED");
		expect(error.progress).toMatchObject({ placed: 0, cleared: 0 });
	});
});
