/**
 * ride@1 / lead@1 的确定性测试：派发前失败面、上下车与拴绳的证据窗口、
 * 驾驶到达判定（客户端权威读载具/服务端权威读骑手）、牵引行程与系绳复核。
 * 真实骑乘/牵引由真服场景验收。
 */
import { describe, expect, test } from "vitest";
import { failureOf, makeHarness, type EntityFixture, type HarnessState } from "./mc-capability-harness.js";

let nextId = 100;

function entity(name: string, kind: string, x: number, z: number, y = 64): EntityFixture {
	nextId += 1;
	return {
		ref: { connection: "conn:t", incarnation: "inc:t", appearance: "ap:t", networkId: nextId },
		name,
		kind,
		position: { x, y, z },
		distance: Math.hypot(x - 10, y - 64, z - 10),
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

describe("ride@1", () => {
	test("16 格内没有可骑实体 → NOT_FOUND（派发前）", async () => {
		const h = makeHarness(baseState([]));
		const err = await failureOf(h.callable("ride@1").invoke(h.ctx, {}));
		expect(err.code).toBe("NOT_FOUND");
		expect(err.dispatch).toBe("not_sent");
		expect(h.bodyAcquired()).toBe(0);
	});

	test("指名目标不是坐骑 → WRONG_STATE", async () => {
		const h = makeHarness(baseState([entity("cow", "passive", 12, 10)]));
		const err = await failureOf(h.callable("ride@1").invoke(h.ctx, { target: "cow" }));
		expect(err.code).toBe("WRONG_STATE");
		expect(h.bodyAcquired()).toBe(0);
	});

	test("坐骑超出交互射程 → UNREACHABLE（不自己走过去）", async () => {
		const h = makeHarness(baseState([entity("horse", "passive", 20, 10)]));
		const err = await failureOf(h.callable("ride@1").invoke(h.ctx, { target: "horse" }));
		expect(err.code).toBe("UNREACHABLE");
		expect(h.bodyAcquired()).toBe(0);
	});

	test("上车：set_passengers 证据 → riding/mount", async () => {
		const h = makeHarness(baseState([entity("horse", "passive", 12, 10)]), {
			bodyEvent: (kind) => (kind === "mount" ? { observed: true, vehicleId: 5 } : { observed: false }),
		});
		const result = (await h.callable("ride@1").invoke(h.ctx, { target: "horse" })) as {
			riding: boolean;
			mount: string;
		};
		expect(result.riding).toBe(true);
		expect(result.mount).toBe("horse");
		expect(h.calls).toContain("interact");
		expect(h.calls).toContain("bodyEvent:mount");
	});

	test("服务器拒绝上车（窗口无证据）→ WRONG_STATE（dispatch sent）", async () => {
		const h = makeHarness(baseState([entity("horse", "passive", 12, 10)]), {
			bodyEvent: () => ({ observed: false }),
		});
		const err = await failureOf(h.callable("ride@1").invoke(h.ctx, { target: "horse" }));
		expect(err.code).toBe("WRONG_STATE");
		expect(err.dispatch).toBe("sent");
	});

	test("驾驶（服务端权威马）：到达读载具实体位置（骑手位置骑乘态不回同步）", async () => {
		const state = baseState([entity("horse", "passive", 12, 10)]);
		const h = makeHarness(state, {
			bodyEvent: (kind) => (kind === "mount" ? { observed: true } : { observed: false }),
			onDrive: () => {
				state.entities![0]!.position = { x: 14, y: 64, z: 10 };
			},
		});
		const result = (await h.callable("ride@1").invoke(h.ctx, { target: "horse", to: { x: 14, y: 64, z: 10 } })) as {
			riding: boolean;
			at: { position: { x: number; z: number } };
		};
		expect(result.riding).toBe(true);
		expect(result.at.position.x).toBe(14);
		expect(h.calls).toContain("drive");
	});

	test("驾驶（客户端权威船）：到达读载具实体位置", async () => {
		const state = baseState([entity("oak_boat", "other", 10, 10)]);
		const h = makeHarness(state, {
			bodyEvent: (kind) => (kind === "mount" ? { observed: true } : { observed: false }),
			onDrive: () => {
				state.entities![0]!.position = { x: 20, y: 64, z: 10 };
			},
		});
		const result = (await h.callable("ride@1").invoke(h.ctx, { target: "oak_boat", to: { x: 20, y: 64, z: 10 } })) as {
			riding: boolean;
			mount: string;
			at: { position: { x: number; z: number } };
		};
		expect(result.riding).toBe(true);
		expect(result.mount).toBe("oak_boat");
		expect(result.at.position.x).toBe(20);
	});

	test("载具半路停摆 → UNREACHABLE，progress 带当前位置", async () => {
		const h = makeHarness(baseState([entity("horse", "passive", 12, 10)]), {
			bodyEvent: (kind) => (kind === "mount" ? { observed: true } : { observed: false }),
			onDrive: () => {}, // 显式声明驾驶不移动：马被挡住，原地不动
		});
		const err = await failureOf(h.callable("ride@1").invoke(h.ctx, { target: "horse", to: { x: 40, y: 64, z: 10 } }));
		expect(err.code).toBe("UNREACHABLE");
		expect(err.dispatch).toBe("sent");
		expect((err.progress as { vehicleAt: { x: number } }).vehicleAt).toBeDefined();
	});

	test("矿车不可转向：上车后驾驶请求 → 先下车再 WRONG_STATE", async () => {
		const h = makeHarness(baseState([entity("minecart", "other", 12, 10)]), {
			bodyEvent: (kind) => (kind === "mount" ? { observed: true } : { observed: false }),
		});
		const err = await failureOf(
			h.callable("ride@1").invoke(h.ctx, { target: "minecart", to: { x: 14, y: 64, z: 10 } }),
		);
		expect(err.code).toBe("WRONG_STATE");
		// drive 只出现一次 = 下车的 sneak 派发，没有驾驶拍
		expect(h.calls.filter((call) => call === "drive")).toHaveLength(1);
	});

	test("off:true：dismount 证据 → riding:false", async () => {
		const h = makeHarness(baseState([]), {
			bodyEvent: (kind) => (kind === "dismount" ? { observed: true } : { observed: false }),
		});
		const result = (await h.callable("ride@1").invoke(h.ctx, { off: true })) as { riding: boolean };
		expect(result.riding).toBe(false);
		expect(h.calls).toContain("bodyEvent:dismount");
	});

	test("off:true 但没在车上 → WRONG_STATE", async () => {
		const h = makeHarness(baseState([]), { bodyEvent: () => ({ observed: false }) });
		const err = await failureOf(h.callable("ride@1").invoke(h.ctx, { off: true }));
		expect(err.code).toBe("WRONG_STATE");
		expect(err.dispatch).toBe("sent");
	});
});

describe("lead@1", () => {
	test("目标超出交互射程 → UNREACHABLE（派发前）", async () => {
		const h = makeHarness(baseState([entity("cow", "passive", 20, 10)], { lead: 1 }));
		const err = await failureOf(h.callable("lead@1").invoke(h.ctx, { target: "cow" }));
		expect(err.code).toBe("UNREACHABLE");
		expect(h.bodyAcquired()).toBe(0);
	});

	test("没有拴绳 → MISSING_MATERIAL（派发前）", async () => {
		const h = makeHarness(baseState([entity("cow", "passive", 12, 10)]));
		const err = await failureOf(h.callable("lead@1").invoke(h.ctx, { target: "cow" }));
		expect(err.code).toBe("MISSING_MATERIAL");
		expect(h.bodyAcquired()).toBe(0);
	});

	test("拴住：attach_entity 证据（归属目标）→ leashed:true", async () => {
		const state = baseState([entity("cow", "passive", 12, 10)], { lead: 1 });
		const h = makeHarness(state, {
			bodyEvent: (kind, options) =>
				kind === "link" && options.passengerId === state.entities![0]!.ref.networkId
					? { observed: true, vehicleId: 9 }
					: { observed: false },
		});
		const result = (await h.callable("lead@1").invoke(h.ctx, { target: "cow" })) as { leashed: boolean };
		expect(result.leashed).toBe(true);
		expect(h.calls).toContain("equip:hand");
		expect(h.calls).toContain("bodyEvent:link");
	});

	test("拴绳交互无证据 → TARGET_NOT_MET", async () => {
		const h = makeHarness(baseState([entity("cow", "passive", 12, 10)], { lead: 1 }), {
			bodyEvent: () => ({ observed: false }),
		});
		const err = await failureOf(h.callable("lead@1").invoke(h.ctx, { target: "cow" }));
		expect(err.code).toBe("TARGET_NOT_MET");
		expect(err.dispatch).toBe("sent");
	});

	test("release：空手 use_entity + 解除证据 → leashed:false", async () => {
		const state = baseState([entity("cow", "passive", 12, 10)], { lead: 1 });
		state.inventory.held = { name: "lead", count: 1 }; // 手持拴绳 → 需要先腾空
		const h = makeHarness(state, {
			bodyEvent: (kind, options) =>
				kind === "link" && options.detached === true ? { observed: true, vehicleId: 0 } : { observed: false },
		});
		const result = (await h.callable("lead@1").invoke(h.ctx, { target: "cow", release: true })) as {
			leashed: boolean;
		};
		expect(result.leashed).toBe(false);
		expect(h.calls).toContain("equip:hand");
		expect(h.calls).toContain("bodyEvent:link");
	});

	test("release 无证据 → TARGET_NOT_MET", async () => {
		const h = makeHarness(baseState([entity("cow", "passive", 12, 10)], { lead: 1 }), {
			bodyEvent: () => ({ observed: false }),
		});
		const err = await failureOf(h.callable("lead@1").invoke(h.ctx, { target: "cow", release: true }));
		expect(err.code).toBe("TARGET_NOT_MET");
	});

	test("牵引到 to：goto 后目标仍在链接且到位 → leashed:true", async () => {
		const state = baseState([entity("cow", "passive", 12, 10)], { lead: 1 });
		const h = makeHarness(state, {
			bodyEvent: (kind) => (kind === "link" ? { observed: true, vehicleId: 9 } : { observed: false }),
			onGoto: () => {
				// 牛跟人走：人和牛一起到 to
				state.entities![0]!.position = { x: 10, y: 64, z: 19 };
			},
		});
		const result = (await h.callable("lead@1").invoke(h.ctx, { target: "cow", to: { x: 10, y: 64, z: 20 } })) as {
			leashed: boolean;
			at: { position: { x: number; z: number } };
		};
		expect(result.leashed).toBe(true);
		expect(result.at.position.z).toBe(19);
		expect(h.calls.some((call) => call.startsWith("goto:"))).toBe(true);
	});

	test("牵引途中拴绳断了（目标消失）→ UNREACHABLE", async () => {
		const state = baseState([entity("cow", "passive", 12, 10)], { lead: 1 });
		const h = makeHarness(state, {
			bodyEvent: (kind) => (kind === "link" ? { observed: true, vehicleId: 9 } : { observed: false }),
			onGoto: () => {
				state.entities = []; // 牛消失 = 链接已断
			},
		});
		const err = await failureOf(h.callable("lead@1").invoke(h.ctx, { target: "cow", to: { x: 10, y: 64, z: 20 } }));
		expect(err.code).toBe("UNREACHABLE");
		expect(err.dispatch).toBe("sent");
	});

	test("牵引到位但牛没跟上 → UNREACHABLE（progress 带牛位置）", async () => {
		const state = baseState([entity("cow", "passive", 12, 10)], { lead: 1 });
		const h = makeHarness(state, {
			bodyEvent: (kind) => (kind === "link" ? { observed: true, vehicleId: 9 } : { observed: false }),
			onGoto: () => {
				// 人到了，牛留在原地
			},
		});
		const err = await failureOf(h.callable("lead@1").invoke(h.ctx, { target: "cow", to: { x: 10, y: 64, z: 20 } }));
		expect(err.code).toBe("UNREACHABLE");
		expect((err.progress as { mobAt: { z: number } }).mobAt.z).toBe(10);
	});

	test("tie：栅栏 interact 后 leash_knot 实体出现 → leashed:true 且 at=结", async () => {
		const state = baseState([entity("cow", "passive", 12, 10)], { lead: 1 });
		state.blocks.set("12,64,20", { name: "oak_fence", properties: {} });
		const h = makeHarness(state, {
			bodyEvent: (kind) => (kind === "link" ? { observed: true, vehicleId: 9 } : { observed: false }),
			onGoto: () => {
				state.entities![0]!.position = { x: 12, y: 64, z: 19 };
			},
			onInteract: () => {
				// 系绳成功：栅栏旁出现 leash_knot
				state.entities!.push(entity("leash_knot", "other", 12, 20));
			},
		});
		const result = (await h.callable("lead@1").invoke(h.ctx, {
			target: "cow",
			to: { x: 12, y: 64, z: 20 },
			tie: true,
		})) as { leashed: boolean; at: { position: { x: number; z: number } } };
		expect(result.leashed).toBe(true);
		expect(result.at.position.x).toBe(12);
		expect(result.at.position.z).toBe(20);
	});

	test("tie：附近没有栅栏 → UNREACHABLE（拴绳已拴，dispatch sent）", async () => {
		const state = baseState([entity("cow", "passive", 12, 10)], { lead: 1 });
		const h = makeHarness(state, {
			bodyEvent: (kind) => (kind === "link" ? { observed: true, vehicleId: 9 } : { observed: false }),
			onGoto: () => {
				state.entities![0]!.position = { x: 12, y: 64, z: 19 };
			},
		});
		const err = await failureOf(
			h.callable("lead@1").invoke(h.ctx, { target: "cow", to: { x: 12, y: 64, z: 20 }, tie: true }),
		);
		expect(err.code).toBe("UNREACHABLE");
		expect(err.dispatch).toBe("sent");
	});
});
