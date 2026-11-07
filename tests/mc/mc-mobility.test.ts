/**
 * mobility 纯决策与 follow@1/flee@1 会话语义的确定性测试。
 * 会话测试用共享替身（世界读数/导航替身）；寻路与跟踪真值由真服场景验收。
 */
import { describe, expect, test } from "vitest";
import {
	bestMeleeWeapon,
	effectiveRetreatHealth,
	FOLLOW_LOST_SCANS,
	fleeLegTarget,
	matchFollowTarget,
	stanceParams,
} from "../../.uina/worlds/minecraft/capabilities/shared/mobility.js";
import type { EntityEntryView } from "../../.uina/worlds/minecraft/capabilities/shared/views.js";
import type { SurfaceProbe } from "../../.uina/worlds/minecraft/contracts/world.js";
import { type EntityFixture, failureOf, type HarnessState, key, makeHarness } from "./mc-capability-harness.js";

type TestEntity = EntityEntryView;

function entity(name: string, kind: TestEntity["kind"], x: number, z: number, networkId = 1): TestEntity {
	return {
		ref: { connection: "conn:t", incarnation: "inc:t", appearance: "ap:t", networkId },
		name,
		kind,
		position: { x, y: 64, z },
		distance: 0,
		item: null,
	};
}

function baseState(entities: EntityFixture[], counts: Record<string, number> = {}): HarnessState {
	return {
		blocks: new Map(),
		inventory: { slots: [], counts },
		entities,
	};
}

describe("纯决策", () => {
	test("matchFollowTarget：ref 按 networkId；名字后缀匹配；同名多个取最近；跨名歧义给候选", () => {
		const entities = [
			entity("zombie", "hostile", 20, 20, 2),
			entity("cow", "passive", 12, 12, 3),
			entity("cow", "passive", 30, 30, 4),
		];
		const byRef = matchFollowTarget(entities, {
			connection: "conn:t",
			incarnation: "inc:t",
			appearance: "ap:t",
			networkId: 2,
		});
		expect(byRef).toEqual({ found: entities[0] });
		const byName = matchFollowTarget(entities, "cow");
		expect(byName).toEqual({ found: entities[1] });
		const mixed = [entity("cow", "passive", 5, 5, 1), entity("mod:cow", "passive", 6, 6, 2)];
		const ambiguous = matchFollowTarget(mixed, "cow");
		expect(ambiguous).toEqual({ ambiguous: mixed });
		expect(matchFollowTarget(entities, "sheep")).toBe(null);
	});

	test("fleeLegTarget：主方位背向威胁，180° 反转，步长取整", () => {
		const away = fleeLegTarget({ x: 0, y: 64, z: 0 }, { x: -10, y: 64, z: 0 }, 0, 12);
		expect(away.x).toBeGreaterThan(0); // 威胁在 -x，逃离朝 +x
		expect(away.y).toBe(64);
		const flipped = fleeLegTarget({ x: 0, y: 64, z: 0 }, { x: -10, y: 64, z: 0 }, 180, 12);
		expect(flipped.x).toBeLessThan(0);
	});

	test("stance 决策表照录合同（§4；初始阈值）", () => {
		expect(stanceParams("balanced")).toMatchObject({
			engageRatio: 0.6,
			retreatRatio: 0.4,
			maxTargets: 2,
		});
		expect(stanceParams("cautious")).toMatchObject({
			engageRatio: 0.85,
			retreatRatio: 0.6,
			maxTargets: 1,
			surfaceBeforeFlee: true,
		});
		expect(stanceParams("aggressive")).toMatchObject({
			engageRatio: 0.35,
			retreatRatio: 0.2,
			maxTargets: 4,
		});
	});

	test("effectiveRetreatHealth：显式覆盖；0=不撤；比例向下取整；maxHealth 未知不猜", () => {
		expect(effectiveRetreatHealth("balanced", 13, 20)).toBe(13);
		expect(effectiveRetreatHealth("balanced", 0, 20)).toBe(null);
		expect(effectiveRetreatHealth("balanced", undefined, 20)).toBe(8);
		expect(effectiveRetreatHealth("cautious", undefined, 20)).toBe(12);
		expect(effectiveRetreatHealth("balanced", undefined, null)).toBe(null);
	});

	test("bestMeleeWeapon：伤害最高者；没有武器 → 空手 null", () => {
		expect(bestMeleeWeapon({ wooden_sword: 1, diamond_axe: 1 })).toBe("diamond_axe");
		expect(bestMeleeWeapon({})).toBe(null);
	});
});

describe("follow@1 会话", () => {
	test("预算尽 → ended=timeout 且 moved 如实", async () => {
		const state = baseState([entity("cow", "passive", 18, 10)]);
		const h = makeHarness(state);
		const result = (await h.callable("follow@1").invoke(h.ctx, {
			target: "cow",
			distance: 3,
			maxTimeMs: 1500,
		})) as { ended: string; moved: boolean; target: { name: string } };
		expect(result.ended).toBe("timeout");
		expect(result.moved).toBe(true);
		expect(result.target.name).toBe("cow");
	}, 15000);

	test(`连续 ${FOLLOW_LOST_SCANS} 次失去跟踪 → ended=target_lost，不冒认到达`, async () => {
		const state = baseState([entity("cow", "passive", 18, 10)]);
		const h = makeHarness(state, {
			onGoto: () => {
				state.entities = []; // 第一段之后目标离开跟踪范围
			},
		});
		const result = (await h.callable("follow@1").invoke(h.ctx, {
			target: "cow",
			maxTimeMs: 10000,
		})) as { ended: string; moved: boolean };
		expect(result.ended).toBe("target_lost");
		expect(result.moved).toBe(true);
	}, 15000);

	test("起点解析：无跟踪 → NOT_FOUND；跨名歧义 → INVALID_INPUT", async () => {
		const empty = makeHarness(baseState([]));
		const notFound = await failureOf(empty.callable("follow@1").invoke(empty.ctx, { target: "cow", maxTimeMs: 2000 }));
		expect(notFound.code).toBe("NOT_FOUND");

		const ambiguous = makeHarness(
			baseState([entity("cow", "passive", 12, 10, 1), entity("mod:cow", "passive", 14, 10, 2)]),
		);
		const invalid = await failureOf(
			ambiguous.callable("follow@1").invoke(ambiguous.ctx, { target: "cow", maxTimeMs: 2000 }),
		);
		expect(invalid.code).toBe("INVALID_INPUT");
	}, 15000);
});

describe("flee@1 会话", () => {
	test("拉开到声明距离 → safe=true，moved=true，距离如实", async () => {
		const state = baseState([entity("zombie", "hostile", 10, 15)]); // 距离 5
		const h = makeHarness(state);
		const result = (await h.callable("flee@1").invoke(h.ctx, {
			from: "zombie",
			distance: 16,
			maxTimeMs: 10000,
		})) as { moved: boolean; distance: number; safe: boolean };
		expect(result.moved).toBe(true);
		expect(result.safe).toBe(true);
		expect(result.distance).toBeGreaterThanOrEqual(16);
	}, 15000);

	test("无 from 取最近敌对；没有敌对 → NOT_FOUND", async () => {
		const state = baseState([entity("zombie", "hostile", 12, 10), entity("cow", "passive", 11, 10)]);
		const h = makeHarness(state);
		const result = (await h.callable("flee@1").invoke(h.ctx, { distance: 16, maxTimeMs: 10000 })) as { safe: boolean };
		expect(result.safe).toBe(true);

		const none = makeHarness(baseState([entity("cow", "passive", 11, 10)]));
		const notFound = await failureOf(none.callable("flee@1").invoke(none.ctx, { maxTimeMs: 2000 }));
		expect(notFound.code).toBe("NOT_FOUND");
	}, 15000);
});

describe("surface@1 阶段机", () => {
	const outside: SurfaceProbe = {
		standable: async () => true,
		skyOpen: async () => true,
		findSkyAccess: async () => null,
	};

	function scriptedProbe(
		open: (at: { x: number; y: number; z: number }) => boolean,
		access: { x: number; y: number; z: number } | null,
	): SurfaceProbe {
		return { standable: async () => true, skyOpen: async (at) => open(at), findSkyAccess: async () => access };
	}

	test("已在露天可站 → escaped=true 立即返回", async () => {
		const state = baseState([]);
		const h = makeHarness(state, { surface: () => outside });
		const result = (await h.callable("surface@1").invoke(h.ctx, { maxTimeMs: 2000 })) as {
			escaped: boolean;
			reason: string | null;
		};
		expect(result.escaped).toBe(true);
		expect(result.reason).toBeNull();
	});

	test("有露天出口 → 走过去（可挖），reason=walked_to_opening", async () => {
		const state = baseState([], { dirt: 4 });
		const h = makeHarness(state, { surface: () => scriptedProbe((at) => at.x >= 20, { x: 22, y: 64, z: 10 }) });
		const result = (await h.callable("surface@1").invoke(h.ctx, { maxTimeMs: 4000 })) as {
			escaped: boolean;
			reason: string | null;
		};
		expect(result.escaped).toBe(true);
		expect(result.reason).toBe("walked_to_opening");
	});

	test("无出口但有垫料 → 同柱竖井上升，reason=dug_shaft", async () => {
		const state = baseState([], { dirt: 10 });
		const h = makeHarness(state, {
			surface: () => scriptedProbe((at) => at.y >= 72, null),
		});
		const result = (await h.callable("surface@1").invoke(h.ctx, { maxTimeMs: 8000 })) as {
			escaped: boolean;
			reason: string | null;
		};
		expect(result.escaped).toBe(true);
		expect(result.reason).toBe("dug_shaft");
	});

	test("无出口且无可垫材料 → UNREACHABLE", async () => {
		const state = baseState([], {});
		const h = makeHarness(state, { surface: () => scriptedProbe(() => false, null) });
		const failure = await failureOf(h.callable("surface@1").invoke(h.ctx, { maxTimeMs: 4000 }));
		expect(failure.code).toBe("UNREACHABLE");
	});

	test("probe 缺失（断线）→ DISCONNECTED", async () => {
		const h = makeHarness(baseState([]));
		const failure = await failureOf(h.callable("surface@1").invoke(h.ctx, { maxTimeMs: 2000 }));
		expect(failure.code).toBe("DISCONNECTED");
	});
});

describe("goto@1 回归锚点", () => {
	test("段移动仍走 gotoDirector 且落点回读", async () => {
		const state = baseState([]);
		const h = makeHarness(state);
		const result = (await h.callable("goto@1").invoke(h.ctx, { at: { x: 14, y: 64, z: 10 } })) as { at: { x: number } };
		expect(result.at.x).toBe(14);
		expect(h.calls.some((call) => call.startsWith("goto:"))).toBe(true);
		expect(key({ x: 14, y: 64, z: 10 })).toBe("14,64,10");
	});
});
