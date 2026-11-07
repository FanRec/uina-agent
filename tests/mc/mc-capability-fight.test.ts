/**
 * fight@1 会话语义的确定性测试：目标获取、击杀记账（只认死亡观察）、
 * 接战/撤退阈值与目标失踪口径。真实战斗行为由真服场景验收。
 */
import { describe, expect, test } from "vitest";
import { type EntityFixture, failureOf, type HarnessState, makeHarness } from "./mc-capability-harness.js";

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
		const zombie = entity("zombie", "hostile", 12.5, 10); // 距离 2.5 ≤ 出手门限，直接进近身段
		const state = baseState([zombie], { iron_sword: 1, stone_axe: 1, shield: 1 });
		const applied: { keys?: Record<string, boolean>; attack?: unknown; use?: unknown }[] = [];
		const h = makeHarness(state, {
			// 近身段（批33）：feedback 流连续拍派发攻击，死亡观察来自连接级累积；
			// 模型里死亡 = 目标从扫描集合消失 + 死亡观察已到达。
			deadEntities: new Set([zombie.ref.networkId]),
			onNearApply: (input) => {
				applied.push(input);
				state.entities = [];
			},
		});
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
		expect(h.calls).toContain("feedback:");
		// 出手门限内的第一拍随 apply 派发攻击（attack 走 ControlInput，不是证据窗）。
		expect(applied.some((input) => input.attack != null)).toBe(true);
	}, 15000);

	test("近身段连续拍派发攻击并保持单次身体持有", async () => {
		const zombie = entity("zombie", "hostile", 12.5, 10);
		const state = baseState([zombie], { iron_sword: 1, shield: 1 });
		const applied: { keys?: Record<string, boolean>; attack?: unknown; use?: unknown }[] = [];
		const h = makeHarness(state, {
			deadEntities: new Set<number>(),
			onNearApply: (input) => {
				applied.push(input);
				state.entities = [];
			},
			feedbackPaceMs: 5,
		});
		await h.callable("fight@1").invoke(h.ctx, { ...FIGHT, maxTimeMs: 3000 });
		// 近身段以 feedback 流持有身体（不是每拍 withBody + drive）。
		expect(h.calls).toContain("feedback:");
		expect(h.calls.filter((call) => call === "nearApply").length).toBeGreaterThan(1);
		// 出手门限内的拍随 apply 派发攻击；非攻击拍举盾（use hold）。
		expect(applied.some((input) => input.attack != null)).toBe(true);
		expect(applied.some((input) => input.use != null)).toBe(true);
		// 段内不反复获取身体：一个近身段 = 一次 feedback 流（缺席窗后 target_lost 退出）。
		expect(h.calls.filter((call) => call.startsWith("feedback:")).length).toBe(1);
	}, 15000);

	test("击杀掉落只记死亡位置附近新出现的 item 实体", async () => {
		const zombie = entity("zombie", "hostile", 12.5, 10);
		const state = baseState([zombie], {});
		const h = makeHarness(state, {
			deadEntities: new Set([zombie.ref.networkId]),
			onNearApply: () => {
				const drop = entity("item", "other", 12.8, 10.2);
				drop.item = { name: "rotten_flesh", count: 2 };
				state.entities = [drop];
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
			// 死亡观察为空（目标只是消失）；缺席到达窗后判 target_lost。
			deadEntities: new Set<number>(),
			onNearApply: () => {
				state.entities = [];
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

	test("逃跑腿全部被拒 → retreat_failed，不再虚报 retreated", async () => {
		const zombie = entity("zombie", "hostile", 12.5, 10);
		const state = baseState([zombie], {});
		const h = makeHarness(state, {
			self: { health: 5 },
			gotoFailure: () => Object.assign(new Error("every bearing blocked"), { code: "UNREACHABLE" }),
		});
		const result = (await h.callable("fight@1").invoke(h.ctx, FIGHT)) as {
			ended: string;
			retreated: string;
			at: { position: { x: number; y: number; z: number } };
		};
		expect(result.ended).toBe("retreat_failed");
		// retreated 字段是撤退原因，与成败正交：低血量触发了这次未遂撤退。
		expect(result.retreated).toBe("low_health");
		// 没有任何一条腿走出去：结算位置就是起点。
		expect(result.at.position).toEqual({ x: 10, y: 64, z: 10 });
	}, 15000);

	test("拉开距离但威胁跟到贴身 → retreat_failed", async () => {
		const zombie = entity("zombie", "hostile", 12.5, 10);
		const state = baseState([zombie], {});
		const h = makeHarness(state, {
			self: { health: 5 },
			onGoto: (request) => {
				// 僵尸每条腿都追到新位置 3 格内：距离核验过了，威胁仍贴身。
				state.entities![0]!.position = { x: request.at.x + 3, y: 64, z: request.at.z };
			},
		});
		const result = (await h.callable("fight@1").invoke(h.ctx, FIGHT)) as { ended: string };
		expect(result.ended).toBe("retreat_failed");
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

	test("引燃的苦力怕：fuse 感知 → 立即硬危险拉开，不进攻击节奏", async () => {
		const creeper = entity("creeper", "hostile", 13, 10); // gap 3 ≤ 出手门限
		creeper.ignited = true;
		const state = baseState([creeper], { iron_sword: 1 });
		const applied: { keys?: Record<string, boolean>; attack?: unknown; use?: unknown }[] = [];
		const h = makeHarness(state, {
			onNearApply: (input) => applied.push(input),
			feedbackPaceMs: 5,
		});
		const result = (await h.callable("fight@1").invoke(h.ctx, {
			...FIGHT,
			maxTimeMs: 2000,
		})) as { ended: string };
		// 有近身段输入（fuse 感知不等于站桩），且全部是转身冲刺拉开的逃离拍。
		expect(applied.length).toBeGreaterThan(0);
		expect(applied.some((input) => input.keys?.forward === true && input.keys?.sprint === true)).toBe(true);
		// 引燃期间零攻击派发：fuse 在烧，跑优先。
		expect(applied.every((input) => input.attack === undefined)).toBe(true);
		expect(result.ended).toBe("timeout");
	}, 15000);

	test("radius 内无敌对 → NOT_FOUND", async () => {
		const h = makeHarness(baseState([entity("cow", "passive", 12, 10)], {}));
		const notFound = await failureOf(h.callable("fight@1").invoke(h.ctx, FIGHT));
		expect(notFound.code).toBe("NOT_FOUND");
	}, 15000);
});
