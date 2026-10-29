import { describe, expect, test } from "vitest";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { callFailure } from "../../.uina/worlds/minecraft/contracts/values.js";
import { type EntityFixture, failureOf, type HarnessState, makeHarness } from "./mc-capability-harness.js";

/**
 * collect@1 / pickup@1 / drop@1 的行为（capabilities §4）。
 *
 * 三件事各自只信一种证据：collect 信"本次新增入包"，pickup 信"库存增量"，
 * drop 信"地面出现掉落物实体"（本地库存是乐观预测，不能当服务端确认）。
 * 失败面一律在移动/取身体之前判定——这是这组动作唯一值得死守的顺序。
 */

function give(state: HarnessState, name: string, count: number, slot = 36): void {
	const existing = state.inventory.slots.find((entry) => entry.slot === slot);
	if (existing == null) {
		state.inventory.slots.push({ slot, name, count });
	} else {
		existing.count += count;
	}
	state.inventory.counts[name] = (state.inventory.counts[name] ?? 0) + count;
}

function itemEntity(
	networkId: number,
	name: string,
	count: number,
	position: { x: number; y: number; z: number },
): EntityFixture {
	return {
		ref: { connection: "c", incarnation: "i", appearance: `ap:${networkId}`, networkId },
		name: "item",
		kind: "other",
		position,
		distance: Math.hypot(position.x - 10, position.y - 64, position.z - 10),
		item: { name, count },
	};
}

describe("collect@1", () => {
	test("挖够数量即停；acquired 只算本次新增入包", async () => {
		const state: HarnessState = {
			blocks: new Map([
				["10,64,11", { name: "dirt", properties: {} }],
				["10,64,12", { name: "dirt", properties: {} }],
			]),
			inventory: { slots: [], counts: {} },
		};
		const harness = makeHarness(state, {
			onDig: (target) => {
				state.blocks.set(`${target.block.x},${target.block.y},${target.block.z}`, { name: "air", properties: {} });
				give(state, "dirt", 1);
			},
		});
		const result = (await harness.callable("collect@1").invoke(harness.ctx, {
			item: "dirt",
			count: 2,
		} as JsonValue)) as {
			mined: number;
			acquired: number;
			collected: Record<string, number>;
			remaining: number;
			toolsUsed: string[];
		};
		expect(result).toEqual({ mined: 2, acquired: 2, collected: { dirt: 2 }, remaining: 0, toolsUsed: [] });
		// 两格都在 3 格内：不该为了够得着而先走一趟。
		expect(harness.calls).toEqual(["dig", "dig"]);
	});

	test("候选耗尽但数量不够 → NOT_FOUND，progress 带已得与剩余", async () => {
		const state: HarnessState = {
			blocks: new Map([["10,64,11", { name: "dirt", properties: {} }]]),
			inventory: { slots: [], counts: {} },
		};
		const harness = makeHarness(state, {
			onDig: (target) => {
				state.blocks.set(`${target.block.x},${target.block.y},${target.block.z}`, { name: "air", properties: {} });
				give(state, "dirt", 1);
			},
		});
		const err = await failureOf(
			harness.callable("collect@1").invoke(harness.ctx, { item: "dirt", count: 3 } as JsonValue),
		);
		expect(err.code).toBe("NOT_FOUND");
		expect(err.progress).toMatchObject({ mined: 1, acquired: 1, remaining: 2 });
	});

	test("没有能采的工具 → MISSING_TOOL，且不移动、不取身体", async () => {
		const state: HarnessState = {
			blocks: new Map([["10,64,11", { name: "stone", properties: {} }]]),
			inventory: { slots: [], counts: {} },
		};
		const harness = makeHarness(state);
		const err = await failureOf(
			harness.callable("collect@1").invoke(harness.ctx, { item: "cobblestone", count: 1 } as JsonValue),
		);
		expect(err.code).toBe("MISSING_TOOL");
		expect(err.hint).toContain("wooden_pickaxe");
		expect(harness.calls).toEqual([]);
		expect(harness.bodyAcquired()).toBe(0);
	});

	test("背包满 → INVENTORY_FULL，且在挖第一格之前", async () => {
		const slots = [];
		for (let i = 9; i <= 44; i++) slots.push({ slot: i, name: "stone", count: 64 });
		const state: HarnessState = {
			blocks: new Map([["10,64,11", { name: "dirt", properties: {} }]]),
			inventory: { slots, counts: { stone: 36 * 64 } },
		};
		const harness = makeHarness(state);
		const err = await failureOf(
			harness.callable("collect@1").invoke(harness.ctx, { item: "dirt", count: 1 } as JsonValue),
		);
		expect(err.code).toBe("INVENTORY_FULL");
		expect(harness.calls).toEqual([]);
	});

	test("未知物品、或物品没有方块来源 → NOT_FOUND（两种原因分开说）", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: { slots: [], counts: {} } };
		const harness = makeHarness(state);
		const unknown = await failureOf(
			harness.callable("collect@1").invoke(harness.ctx, { item: "unobtainium" } as JsonValue),
		);
		expect(unknown.code).toBe("NOT_FOUND");
		expect(unknown.message).toContain("unknown item");
		const noSource = await failureOf(harness.callable("collect@1").invoke(harness.ctx, { item: "bread" } as JsonValue));
		expect(noSource.code).toBe("NOT_FOUND");
		expect(noSource.message).toContain("no block source");
	});

	test("够不着时先走位再挖，工具按需装备", async () => {
		const state: HarnessState = {
			blocks: new Map([["10,64,15", { name: "stone", properties: {} }]]),
			inventory: { slots: [{ slot: 36, name: "wooden_pickaxe", count: 1 }], counts: { wooden_pickaxe: 1 } },
		};
		const harness = makeHarness(state, {
			onDig: (target) => {
				state.blocks.set(`${target.block.x},${target.block.y},${target.block.z}`, { name: "air", properties: {} });
				give(state, "cobblestone", 1);
			},
		});
		const result = (await harness.callable("collect@1").invoke(harness.ctx, {
			item: "cobblestone",
			count: 1,
		} as JsonValue)) as { mined: number; toolsUsed: string[] };
		expect(result.mined).toBe(1);
		expect(result.toolsUsed).toEqual(["wooden_pickaxe"]);
		expect(harness.calls[0]).toMatch(/^goto:/);
		expect(harness.calls).toContain("equip:hand");
	});
});

describe("pickup@1", () => {
	test("走到掉落物并捡起，picked 只报观察到的增量", async () => {
		const state: HarnessState = {
			blocks: new Map(),
			inventory: { slots: [], counts: {} },
			entities: [itemEntity(31, "dirt", 2, { x: 10.5, y: 64, z: 12 })],
		};
		const harness = makeHarness(state, {
			onDrive: () => {
				state.entities = [];
				give(state, "dirt", 2);
			},
		});
		const result = (await harness.callable("pickup@1").invoke(harness.ctx, {
			item: "dirt",
			radius: 8,
		} as JsonValue)) as { picked: Record<string, number> };
		expect(result.picked).toEqual({ dirt: 2 });
		// 2 格内不规划路径：先看向掉落物，再靠身体步进。
		expect(harness.calls[0]).toBe("lookAt");
		expect(harness.calls).toContain("drive");
	});

	test("地面没有匹配的掉落物 → NOT_FOUND", async () => {
		const state: HarnessState = {
			blocks: new Map(),
			inventory: { slots: [], counts: {} },
			entities: [itemEntity(31, "oak_log", 1, { x: 10.5, y: 64, z: 12 })],
		};
		const harness = makeHarness(state);
		const err = await failureOf(
			harness.callable("pickup@1").invoke(harness.ctx, { item: "dirt", radius: 8 } as JsonValue),
		);
		expect(err.code).toBe("NOT_FOUND");
		expect(harness.calls).toEqual([]);
	});

	test("背包满 → INVENTORY_FULL，且不移动", async () => {
		const slots = [];
		for (let i = 9; i <= 44; i++) slots.push({ slot: i, name: "stone", count: 64 });
		const state: HarnessState = {
			blocks: new Map(),
			inventory: { slots, counts: { stone: 36 * 64 } },
			entities: [itemEntity(31, "dirt", 2, { x: 10.5, y: 64, z: 12 })],
		};
		const harness = makeHarness(state);
		const err = await failureOf(harness.callable("pickup@1").invoke(harness.ctx, { radius: 8 } as JsonValue));
		expect(err.code).toBe("INVENTORY_FULL");
		expect(harness.calls).toEqual([]);
	});

	test("够不着的候选跳过，继续下一个", async () => {
		const state: HarnessState = {
			blocks: new Map(),
			inventory: { slots: [], counts: {} },
			entities: [
				itemEntity(31, "dirt", 1, { x: 10.5, y: 64, z: 16 }),
				itemEntity(32, "dirt", 2, { x: 10.5, y: 64, z: 20 }),
			],
		};
		const harness = makeHarness(state, {
			onGoto: (request) => {
				// 远的那个（6 格）走不过去（被墙挡住），应该跳过而不是整次失败。
				if (request.at.z === 16) {
					throw callFailure({
						code: "UNREACHABLE",
						source: "capability",
						message: "no path",
						dispatch: "not_sent",
						effects: [],
						recoverable: true,
					});
				}
			},
			onDrive: () => {
				state.entities = [];
				give(state, "dirt", 2);
			},
		});
		const result = (await harness.callable("pickup@1").invoke(harness.ctx, {
			item: "dirt",
			radius: 16,
		} as JsonValue)) as { picked: Record<string, number> };
		expect(result.picked).toEqual({ dirt: 2 });
		expect(harness.calls).toEqual(["goto:10.5,64,16", "goto:10.5,64,20", "lookAt", "drive"]);
	});
});

describe("drop@1", () => {
	test("a proven component match is selected after an unknown stack and passed intact to Driver", async () => {
		const components = { added: [], removed: [] };
		const state: HarnessState = {
			blocks: new Map(),
			inventory: {
				slots: [
					{ slot: 36, name: "dirt", count: 5, components: null },
					{ slot: 37, name: "dirt", count: 2, components },
				],
				counts: { dirt: 7 },
			},
			entities: [],
		};
		let selected: unknown;
		const h = makeHarness(state, {
			onToss: (name, count, selector) => {
				selected = selector;
				state.entities?.push(itemEntity(52, name, count, { x: 10, y: 64, z: 10 }));
			},
		});
		expect(await h.callable("drop@1").invoke(h.ctx, { item: { name: "minecraft:dirt", components } })).toMatchObject({
			dropped: { dirt: 2 },
			remaining: 0,
		});
		expect(selected).toEqual({ name: "dirt", components, substitutions: [] });
	});
	test("substitutions retain per-name removal progress when a later toss fails", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: { slots: [], counts: {} }, entities: [] };
		give(state, "dirt", 1, 36);
		give(state, "stone", 2, 37);
		const selectors: unknown[] = [];
		const h = makeHarness(state, {
			onToss: (name, count, selector) => {
				selectors.push(selector);
				if (name === "stone")
					throw callFailure({
						code: "INTERRUPTED",
						source: "environment",
						message: "cancelled after one confirmed item",
						dispatch: "sent",
						effects: ["eff:partial"],
						recoverable: false,
						progress: { removed: { stone: 1 }, remaining: 1 },
					});
				state.entities?.push(itemEntity(50, name, count, { x: 10, y: 64, z: 10 }));
			},
		});
		const error = await failureOf(
			h.callable("drop@1").invoke(h.ctx, { item: { name: "dirt", substitutions: ["stone"] }, count: 3 }),
		);
		expect(error.progress).toMatchObject({ removed: { dirt: 1, stone: 1 }, dropped: { dirt: 1 }, remaining: 1 });
		expect(selectors).toEqual([
			{ name: "dirt", substitutions: [] },
			{ name: "stone", substitutions: [] },
		]);
	});
	test("ground confirmation must cover each removed name", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: { slots: [], counts: {} }, entities: [] };
		give(state, "dirt", 1, 36);
		give(state, "stone", 1, 37);
		const h = makeHarness(state, {
			onToss: (name) => {
				if (name === "dirt") state.entities?.push(itemEntity(51, "dirt", 2, { x: 10, y: 64, z: 10 }));
			},
		});
		const error = await failureOf(
			h.callable("drop@1").invoke(h.ctx, { item: { name: "dirt", substitutions: ["stone"] }, count: 2 }),
		);
		expect(error.code).toBe("TARGET_NOT_MET");
		expect(error.progress).toMatchObject({ removed: { dirt: 1, stone: 1 }, dropped: { dirt: 1 }, remaining: 0 });
	});
	test("unknown components do not authorize tossing a same-name stack", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: { slots: [], counts: {} }, entities: [] };
		give(state, "dirt", 2);
		const h = makeHarness(state, {
			onToss: (name, count) => state.entities?.push(itemEntity(41, name, count, { x: 10, y: 64, z: 10 })),
		});
		const error = await failureOf(
			h.callable("drop@1").invoke(h.ctx, { item: { name: "dirt", components: { added: [], removed: [] } }, count: 1 }),
		);
		expect(error.code).toBe("NOT_FOUND");
		expect(h.calls).toEqual([]);
	});
	test("丢出声明数量：本地库存是预测，完成要看到地面掉落物", async () => {
		const state: HarnessState = {
			blocks: new Map(),
			inventory: { slots: [], counts: {} },
			entities: [],
		};
		give(state, "dirt", 5);
		const harness = makeHarness(state, {
			onToss: (name, count) => {
				const slot = state.inventory.slots.find((entry) => entry.name === name);
				if (slot != null) slot.count -= count;
				state.inventory.counts[name] = (state.inventory.counts[name] ?? 0) - count;
				state.entities?.push(itemEntity(40, name, count, { x: 10.5, y: 64, z: 11 }));
			},
		});
		const result = (await harness.callable("drop@1").invoke(harness.ctx, {
			item: "dirt",
			count: 2,
		} as JsonValue)) as { dropped: Record<string, number>; remaining: number };
		expect(result).toMatchObject({ dropped: { dirt: 2 }, remaining: 0 });
		expect(harness.calls).toEqual(["toss:dirtx2"]);
		expect(harness.bodyAcquired()).toBe(1);
	});

	test("数量不足 → MISSING_MATERIAL（hint 带 available），不派发", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: { slots: [], counts: {} } };
		give(state, "dirt", 1);
		const harness = makeHarness(state);
		const err = await failureOf(
			harness.callable("drop@1").invoke(harness.ctx, { item: "dirt", count: 2 } as JsonValue),
		);
		expect(err.code).toBe("MISSING_MATERIAL");
		expect(err.hint).toContain("available: 1");
		expect(harness.calls).toEqual([]);
	});

	test("包里没有 → NOT_FOUND", async () => {
		const state: HarnessState = { blocks: new Map(), inventory: { slots: [], counts: {} } };
		const harness = makeHarness(state);
		const err = await failureOf(harness.callable("drop@1").invoke(harness.ctx, { item: "bread" } as JsonValue));
		expect(err.code).toBe("NOT_FOUND");
	});

	test("toward 实体：先走位、再朝向、最后丢", async () => {
		const state: HarnessState = {
			blocks: new Map(),
			inventory: { slots: [], counts: {} },
			entities: [
				{
					ref: { connection: "c", incarnation: "i", appearance: "ap:7", networkId: 7 },
					name: "zombie",
					kind: "hostile",
					position: { x: 16, y: 64, z: 10 },
					distance: 6,
					item: null,
				},
			],
		};
		give(state, "dirt", 1);
		const harness = makeHarness(state, {
			onToss: (name, count) => {
				state.entities?.push(itemEntity(41, name, count, { x: 10.5, y: 64, z: 11 }));
			},
		});
		await harness.callable("drop@1").invoke(harness.ctx, { item: "dirt", toward: "zombie" } as JsonValue);
		expect(harness.calls).toEqual(["goto:16,64,10", "lookAt", "toss:dirtx1"]);
	});

	test("地面没有掉落物实体 → TARGET_NOT_MET，不拿本地库存当成功", async () => {
		const state: HarnessState = {
			blocks: new Map(),
			inventory: { slots: [], counts: {} },
			entities: [],
		};
		give(state, "dirt", 1);
		const harness = makeHarness(state, {
			onToss: (name, count) => {
				state.inventory.counts[name] = (state.inventory.counts[name] ?? 0) - count;
			},
		});
		const err = await failureOf(
			harness.callable("drop@1").invoke(harness.ctx, { item: "dirt", count: 1 } as JsonValue),
		);
		expect(err.code).toBe("TARGET_NOT_MET");
		expect(err.dispatch).toBe("sent");
		expect(err.progress).toMatchObject({ removed: { dirt: 1 }, dropped: {}, remaining: 0 });
	});
});
