/**
 * fight@1 会话语义的确定性测试：目标获取、击杀记账（只认死亡观察）、
 * 接战/撤退阈值与目标失踪口径。真实战斗行为由真服场景验收。
 */
import { describe, expect, test } from "vitest";
import { failureOf, makeHarness, type EntityFixture, type HarnessState } from "./mc-capability-harness.js";

let nextId = 100;

function entity(name: string, kind: string, x: number, z: number): EntityFixture {
	nextId += 1;
	return {
		ref: { connection: "conn:t", incarnation: "inc:t", appearance: "ap:t", networkId: nextId },
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

const FIGHT = { radius: 16, maxTimeMs: 6000 };

describe("fight@1 会话", () => {
	test("balanced：换最好武器 + 盾，击杀（死亡观察）→ targets_cleared", async () => {
		const zombie = entity("zombie", "hostile", 12.5, 10); // 距离 2.5 ≤ 接战距离拍内攻击
		const state = baseState([zombie], { iron_sword: 1, stone_axe: 1, shield: 1 });
		const h = makeHarness(state);
		const result = (await h.callable("fight@1").invoke(h.ctx, FIGHT)) as {
			ended: string;
			kills: { name: string; drops: Record<string, number> }[];
			hp: { before: number; after: number };
			stance: string;
			retreatHealth: number;
		};
		expect(result.ended).toBe("targets_cleared");
		expect(result.kills).toEqual([{ name: "zombie", drops: {} }]);
		expect(result.stance).toBe("balanced");
		expect(result.retreatHealth).toBe(8);
		expect(result.hp.before).toBe(20);
		// 最好近战 = stone_axe(9) > iron_sword(6)；盾在 balanced 下装到 offhand
		expect(h.calls).toContain("equip:hand");
		expect(h.calls).toContain("equip:offhand");
		expect(h.calls).toContain("attack");
	}, 15000);

	test("击杀掉落只记死亡位置附近新出现的 item 实体", async () => {
		const zombie = entity("zombie", "hostile", 12.5, 10);
		const state = baseState([zombie], {});
		const h = makeHarness(state, {
			onAttack: () => {
				const drop = entity("item", "other", 12.8, 10.2);
				drop.item = { name: "rotten_flesh", count: 2 };
				state.entities!.push(drop);
			},
		});
		const result = (await h.callable("fight@1").invoke(h.ctx, FIGHT)) as {
			kills: { name: string; drops: Record<string, number> }[];
		};
		expect(result.kills).toEqual([{ name: "zombie", drops: { rotten_flesh: 2 } }]);
	}, 15000);

	test("目标失踪不算击杀：无死亡证据的消失 → target_lost，kills 为空", async () => {
		const zombie = entity("zombie", "hostile", 12.5, 10);
		const state = baseState([zombie], {});
		const h = makeHarness(state, {
			attackDead: false,
			onAttack: () => {
				state.entities = []; // 目标在受击后从跟踪集合消失，但没有死亡观察
			},
		});
		const result = (await h.callable("fight@1").invoke(h.ctx, FIGHT)) as {
			ended: string;
			kills: unknown[];
		};
		expect(result.ended).toBe("target_lost");
		expect(result.kills).toEqual([]);
	}, 15000);

	test("开场血量低于接战线 → 不接战，按血量撤退结算", async () => {
		const zombie = entity("zombie", "hostile", 12.5, 10);
		const state = baseState([zombie], {});
		const h = makeHarness(state, { self: { health: 5 } }); // balanced 接战线 12
		const result = (await h.callable("fight@1").invoke(h.ctx, FIGHT)) as {
			ended: string;
			retreated: string;
			kills: unknown[];
		};
		expect(result.ended).toBe("retreated");
		expect(result.retreated).toBe("low_health");
		expect(result.kills).toEqual([]);
		expect(h.calls.some((call) => call.startsWith("attack"))).toBe(false);
	}, 15000);

	test("retreatHealth 显式覆盖 stance 比例；血量跌破即撤", async () => {
		const zombie = entity("zombie", "hostile", 40, 10); // 远目标：先追击
		const state = baseState([zombie], { iron_sword: 1 });
		const h = makeHarness(state, { self: { health: 18 } });
		const result = (await h.callable("fight@1").invoke(h.ctx, {
			...FIGHT,
			retreatHealth: 19,
		})) as { ended: string; retreated: string; retreatHealth: number };
		expect(result.ended).toBe("retreated");
		expect(result.retreated).toBe("low_health");
		expect(result.retreatHealth).toBe(19);
	}, 15000);

	test("weapon:'ranged' 无弓/弩+箭 → WRONG_STATE；cautious auto 有弓则优先远程", async () => {
		const zombie = entity("zombie", "hostile", 12.5, 10);
		const noBow = makeHarness(baseState([zombie], {}));
		const wrong = await failureOf(noBow.callable("fight@1").invoke(noBow.ctx, { ...FIGHT, weapon: "ranged" }));
		expect(wrong.code).toBe("WRONG_STATE");

		const withBow = makeHarness(baseState([zombie], { bow: 1, arrow: 12 }));
		const result = (await withBow.callable("fight@1").invoke(withBow.ctx, FIGHT)) as { ended: string };
		// cautious 接战距离 3：目标 2.5 在 standoff 下限内 → 拉开 → 射击（1.1s 蓄力）→ 死亡观察
		expect(result.ended).toBe("targets_cleared");
		expect(withBow.calls).toContain("useItem");
		expect(withBow.calls).toContain("endUse");
		expect(withBow.calls).toContain("awaitEvidence");
	}, 20000);

	test("radius 内无敌对 → NOT_FOUND", async () => {
		const h = makeHarness(baseState([entity("cow", "passive", 12, 10)], {}));
		const notFound = await failureOf(h.callable("fight@1").invoke(h.ctx, FIGHT));
		expect(notFound.code).toBe("NOT_FOUND");
	}, 15000);
});
