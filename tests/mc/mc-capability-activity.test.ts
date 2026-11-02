/**
 * sleep@1 / fish@1 的确定性测试：派发前失败面、证据窗口成败、
 * 取消/超时的收尾语义（睡必醒、竿必收）。真实睡眠/捕鱼由真服场景验收。
 */
import { describe, expect, test } from "vitest";
import { failureOf, makeHarness, type HarnessState } from "./mc-capability-harness.js";

function baseState(world: { ticks: number; weather: string }, counts: Record<string, number> = {}): HarnessState {
	return {
		blocks: new Map(),
		inventory: { slots: [], counts },
		world,
	};
}

describe("sleep@1", () => {
	test("非夜间拒绝发生在派发前", async () => {
		const h = makeHarness(baseState({ ticks: 1000, weather: "clear" }));
		const err = await failureOf(h.callable("sleep@1").invoke(h.ctx, {}));
		expect(err.code).toBe("WRONG_STATE");
		expect(err.dispatch).toBe("not_sent");
		expect(h.bodyAcquired()).toBe(0);
	});

	test("雷暴白天可睡（协议上限，偏差登记项）", async () => {
		const state = baseState({ ticks: 1000, weather: "thunder" });
		state.blocks.set("10,64,8", { name: "red_bed", properties: {} });
		const h = makeHarness(state, {
			bodyEvent: (kind) => {
				if (kind === "sleep") {
					state.world!.ticks = 0;
					return { observed: true };
				}
				return { observed: false };
			},
		});
		const result = (await h.callable("sleep@1").invoke(h.ctx, {})) as { slept: boolean; until: string };
		expect(result.slept).toBe(true);
		expect(result.until).toBe("morning");
		expect(h.calls).toContain("endSleep");
	});

	test("没有床 → NOT_FOUND（就近搜索）", async () => {
		const h = makeHarness(baseState({ ticks: 13000, weather: "clear" }));
		const err = await failureOf(h.callable("sleep@1").invoke(h.ctx, {}));
		expect(err.code).toBe("NOT_FOUND");
		expect(h.bodyAcquired()).toBe(0);
	});

	test("指定位置不是床 → NOT_FOUND", async () => {
		const state = baseState({ ticks: 13000, weather: "clear" });
		state.blocks.set("10,64,8", { name: "stone", properties: {} });
		const h = makeHarness(state);
		const err = await failureOf(h.callable("sleep@1").invoke(h.ctx, { at: { x: 10, y: 64, z: 8 } }));
		expect(err.code).toBe("NOT_FOUND");
	});

	test("床被占 → TARGET_NOT_MET", async () => {
		const state = baseState({ ticks: 13000, weather: "clear" });
		state.blocks.set("10,64,8", { name: "red_bed", properties: { occupied: "true" } });
		const h = makeHarness(state);
		const err = await failureOf(h.callable("sleep@1").invoke(h.ctx, { at: { x: 10, y: 64, z: 8 } }));
		expect(err.code).toBe("TARGET_NOT_MET");
		expect(h.bodyAcquired()).toBe(0);
	});

	test("床边有敌对生物 → WRONG_STATE", async () => {
		const state = baseState({ ticks: 13000, weather: "clear" });
		state.blocks.set("10,64,8", { name: "red_bed", properties: {} });
		state.entities = [
			{
				ref: { connection: "c", incarnation: "i", appearance: "a", networkId: 11 },
				name: "zombie",
				kind: "hostile",
				position: { x: 12, y: 64, z: 9 },
				distance: 2.2,
				item: null,
			},
		];
		const h = makeHarness(state);
		const err = await failureOf(h.callable("sleep@1").invoke(h.ctx, { at: { x: 10, y: 64, z: 8 } }));
		expect(err.code).toBe("WRONG_STATE");
		expect(h.bodyAcquired()).toBe(0);
	});

	test("床超出交互射程 → UNREACHABLE（不自己走过去）", async () => {
		const state = baseState({ ticks: 13000, weather: "clear" });
		state.blocks.set("20,64,10", { name: "red_bed", properties: {} });
		const h = makeHarness(state);
		const err = await failureOf(h.callable("sleep@1").invoke(h.ctx, { at: { x: 20, y: 64, z: 10 } }));
		expect(err.code).toBe("UNREACHABLE");
		expect(h.bodyAcquired()).toBe(0);
	});

	test("成功：入睡证据 + 时间跳回白天 → slept/until，finally 醒来", async () => {
		const state = baseState({ ticks: 13000, weather: "clear" });
		state.blocks.set("10,64,8", { name: "red_bed", properties: {} });
		const h = makeHarness(state, {
			bodyEvent: (kind) => {
				if (kind === "sleep") {
					state.world!.ticks = 0; // 服务端跳时间到清晨
					return { observed: true };
				}
				return { observed: false };
			},
		});
		const result = (await h.callable("sleep@1").invoke(h.ctx, {})) as {
			slept: boolean;
			at: { position: { x: number; y: number; z: number }; dimension: string };
			until: string;
		};
		expect(result.slept).toBe(true);
		expect(result.until).toBe("morning");
		expect(result.at.position).toEqual({ x: 10, y: 64, z: 8 });
		expect(result.at.dimension).toBe("overworld");
		expect(h.calls).toContain("interact");
		expect(h.calls).toContain("bodyEvent:sleep");
		expect(h.calls).toContain("endSleep");
		expect(h.bodyAcquired()).toBe(1);
	});

	test("服务端拒绝入睡（窗口无证据）→ TARGET_NOT_MET，仍醒来", async () => {
		const state = baseState({ ticks: 13000, weather: "clear" });
		state.blocks.set("10,64,8", { name: "red_bed", properties: {} });
		const h = makeHarness(state, { bodyEvent: () => ({ observed: false }) });
		const err = await failureOf(h.callable("sleep@1").invoke(h.ctx, {}));
		expect(err.code).toBe("TARGET_NOT_MET");
		expect(err.dispatch).toBe("sent");
		expect(h.calls).toContain("endSleep");
	});

	test("窗口未走完（中止/断线）→ INTERRUPTED，仍醒来", async () => {
		const state = baseState({ ticks: 13000, weather: "clear" });
		state.blocks.set("10,64,8", { name: "red_bed", properties: {} });
		const h = makeHarness(state, { bodyEvent: () => ({ observed: null }) });
		const err = await failureOf(h.callable("sleep@1").invoke(h.ctx, {}));
		expect(err.code).toBe("INTERRUPTED");
		expect(h.calls).toContain("endSleep");
	});
});

describe("fish@1", () => {
	test("没有鱼竿 → MISSING_MATERIAL（派发前）", async () => {
		const h = makeHarness(baseState({ ticks: 1000, weather: "clear" }));
		const err = await failureOf(h.callable("fish@1").invoke(h.ctx, {}));
		expect(err.code).toBe("MISSING_MATERIAL");
		expect(err.dispatch).toBe("not_sent");
		expect(h.bodyAcquired()).toBe(0);
	});

	test("成功：抛竿 → 咬钩 → 收竿 → 入包增量", async () => {
		const state = baseState({ ticks: 1000, weather: "clear" }, { fishing_rod: 1 });
		const h = makeHarness(state, {
			bodyEvent: (kind) => {
				if (kind === "bobber") return { observed: true, vehicleId: 77 };
				if (kind === "bite") {
					// 战利品在收竿后短时间内飞到背包：延迟入包，快照先于增量。
					setTimeout(() => {
						state.inventory.counts["salmon"] = (state.inventory.counts["salmon"] ?? 0) + 1;
					}, 300);
					return { observed: true };
				}
				return { observed: false };
			},
		});
		const result = (await h.callable("fish@1").invoke(h.ctx, {})) as {
			caught: { item: string; count: number }[];
			casts: number;
		};
		expect(result.caught).toEqual([{ item: "salmon", count: 1 }]);
		expect(result.casts).toBe(1);
		// 一抛一收：两次 use_item（1.21.11 收竿 = 再发一次 use_item）
		expect(h.calls.filter((call) => call === "useItem")).toHaveLength(2);
		expect(h.calls).toContain("bodyEvent:bobber");
		expect(h.calls).toContain("bodyEvent:bite");
	});

	test("捕获物落在地上：走近拾取兜底后入包", async () => {
		const state = baseState({ ticks: 1000, weather: "clear" }, { fishing_rod: 1 });
		state.entities = [
			{
				ref: { connection: "c", incarnation: "i", appearance: "a", networkId: 88 },
				name: "item",
				kind: "other",
				position: { x: 13, y: 64, z: 10 },
				distance: 3,
				item: { name: "salmon", count: 1 },
			},
		];
		const h = makeHarness(state, {
			bodyEvent: (kind) =>
				kind === "bobber" ? { observed: true } : kind === "bite" ? { observed: true } : { observed: false },
			onDrive: () => {
				// 走到掉落点并捡起
				state.entities![0]!.position = { x: 10, y: 64, z: 10 };
				state.inventory.counts["salmon"] = (state.inventory.counts["salmon"] ?? 0) + 1;
			},
		});
		const result = (await h.callable("fish@1").invoke(h.ctx, {})) as { caught: { item: string; count: number }[] };
		expect(result.caught).toEqual([{ item: "salmon", count: 1 }]);
		expect(h.calls).toContain("drive");
	});

	test("抛竿后没有鱼漂 → WRONG_STATE，无竿在外不补收竿", async () => {
		const state = baseState({ ticks: 1000, weather: "clear" }, { fishing_rod: 1 });
		const h = makeHarness(state, { bodyEvent: () => ({ observed: false }) });
		const err = await failureOf(h.callable("fish@1").invoke(h.ctx, {}));
		expect(err.code).toBe("WRONG_STATE");
		expect(err.dispatch).toBe("sent");
		// 只有抛竿那一次 use_item；没有鱼漂就没有可收的竿
		expect(h.calls.filter((call) => call === "useItem")).toHaveLength(1);
	});

	test("预算内无咬钩 → TIMEOUT，progress 保留 casts，收竿", async () => {
		const state = baseState({ ticks: 1000, weather: "clear" }, { fishing_rod: 1 });
		const h = makeHarness(state, {
			bodyEvent: async (kind) => {
				if (kind !== "bobber") return { observed: false };
				await new Promise((resolve) => setTimeout(resolve, 400)); // 让墙钟预算真的流动
				return { observed: true };
			},
		});
		const err = await failureOf(h.callable("fish@1").invoke(h.ctx, { maxTimeMs: 5000 }));
		expect(err.code).toBe("TIMEOUT");
		expect(err.dispatch).toBe("sent");
		expect((err.progress as { casts: number }).casts).toBeGreaterThanOrEqual(2);
		// 每一抛都有配对的收竿：use_item 数 = 抛竿数 + 每抛一次收竿
		expect(h.calls.filter((call) => call === "useItem").length).toBeGreaterThanOrEqual(4);
	}, 15000);

	test("咬钩窗口未走完 → INTERRUPTED，finally 收竿", async () => {
		const state = baseState({ ticks: 1000, weather: "clear" }, { fishing_rod: 1 });
		const h = makeHarness(state, {
			bodyEvent: (kind) => (kind === "bobber" ? { observed: true, vehicleId: 77 } : { observed: null }),
		});
		const err = await failureOf(h.callable("fish@1").invoke(h.ctx, {}));
		expect(err.code).toBe("INTERRUPTED");
		// 抛竿 + finally 的收竿（鱼漂 77 还在替身世界里）
		expect(h.calls.filter((call) => call === "useItem")).toHaveLength(2);
	});
});
