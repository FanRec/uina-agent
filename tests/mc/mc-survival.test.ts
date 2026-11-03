import { describe, expect, test, vi } from "vitest";
import {
	escapeInput,
	nextEscapeWaypoint,
	survivalTrigger,
	startSurvival,
} from "../../.uina/worlds/minecraft/capabilities/survival.js";
import type { BodySession, SelfState } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { SafetyInterventionRecord } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import type { SafetyTrigger } from "../../.uina/worlds/minecraft/runtime/safety.js";
import { makeBot, makeFactsHarness, type FakeBot } from "./mc-fake.js";
import {
	escapeGoalBias,
	escapeThreatClearance,
	escapeWaypoints,
} from "../../.uina/worlds/minecraft/driver/mineflayer/pathfinder.js";

test("only observed hazards trigger preservation; low health alone and unknown immunity do not", () => {
	const self = {
		health: 6,
		maxHealth: 20,
		inLava: false,
		inWater: false,
		oxygen: null,
		effects: [],
	} as unknown as SelfState;
	expect(survivalTrigger(self, null, 1000)).toBeNull();
	expect(survivalTrigger(self, 500, 1000)).toBe("low_health_damage");
	expect(survivalTrigger(self, 0, 3000)).toBeNull();
	expect(survivalTrigger({ ...self, inWater: true, oxygen: 4 }, null, 1000)).toBe("drowning");
	expect(survivalTrigger({ ...self, inWater: true, oxygen: 4, effects: null }, null, 1000)).toBeNull();
	expect(
		survivalTrigger(
			{ ...self, inWater: true, oxygen: 4, effects: [{ name: "water_breathing", amplifier: 0, seconds: 1 }] },
			null,
			1000,
		),
	).toBeNull();
	expect(survivalTrigger({ ...self, inLava: true }, null, 1000)).toBe("lava");
	expect(survivalTrigger({ ...self, health: null, inLava: true }, null, 1000)).toBe("lava");
	expect(survivalTrigger({ ...self, health: 0, inLava: true }, null, 1000)).toBeNull();
});

test("escape keeps moving until the body is clear of the adjacent lava cell", () => {
	const route = [{ x: 16009.5, y: 200, z: 16000.5 }];
	expect(nextEscapeWaypoint(route, { x: 16009.806, y: 200, z: 16000.5 })).toEqual(route[0]);
	expect(nextEscapeWaypoint(route, { x: 16009.6, y: 200, z: 16000.5 })).toBeUndefined();
});

test("empty node path still centers the body when its trailing edge touches lava", () => {
	expect(escapeWaypoints([], { x: 16027.069, y: 200, z: 16000.5 })).toEqual([{ x: 16027.5, y: 200, z: 16000.5 }]);
});

test("escape does not brake in the gap between steering and waypoint arrival tolerances", () => {
	const self = { place: { position: { x: 16009.67, y: 200, z: 16000.5 } }, inLava: true } as SelfState;
	expect(escapeInput(self, { x: 16009.5, y: 200, z: 16000.5 }).keys.forward).toBe(true);
});

test("equidistant grid exits prefer the closer side of the actual moving body", () => {
	const position = { x: 16026.808, y: 200, z: 16000.5 };
	expect(escapeGoalBias({ x: 16027, y: 200, z: 16000 }, position)).toBeLessThan(
		escapeGoalBias({ x: 16025, y: 200, z: 16000 }, position),
	);
});

test("threat goal includes the waypoint center and arrival tolerance", () => {
	const threats = [{ x: 16014.5, y: 200, z: 16000.5 }];
	expect(escapeThreatClearance({ x: 16006, y: 200, z: 16000 }, threats)).toBe(false);
	expect(escapeThreatClearance({ x: 16005, y: 200, z: 16000 }, threats)).toBe(true);
});

// ---- 介入锁存（批22 P0-1）：失败后允许重试，成功锁存到危险消失 ----

function baseSelf(override: Partial<SelfState> = {}): SelfState {
	return {
		place: { position: { x: 0, y: 64, z: 0 }, dimension: "overworld" },
		velocity: { x: 0, y: 0, z: 0 },
		health: 20,
		food: 20,
		onGround: false,
		maxHealth: 20,
		saturation: 5,
		oxygen: 20,
		inWater: false,
		inLava: true,
		effects: [],
		xpLevel: 0,
		look: { yaw: 0, pitch: 0 },
		...override,
	} as SelfState;
}

function survivalBot(overrides: Record<string, unknown> = {}): FakeBot {
	return makeBot({
		game: { dimension: "overworld" },
		entities: {},
		entity: {
			id: 1,
			position: { x: 0, y: 64, z: 0 },
			velocity: { x: 0, y: 0, z: 0 },
			yaw: 0,
			pitch: 0,
			isInLava: true,
			isInWater: false,
			attributes: { "generic.max_health": { value: 20 } },
		},
		health: 20,
		food: 20,
		oxygenLevel: 20,
		foodSaturation: 5,
		experience: { level: 0 },
		...overrides,
	});
}

/** 反馈流替身：self 帧按序列展开，尾帧保持；work 的循环与真实实现一致。 */
function fakeBody(selfFrames: Partial<SelfState>[]): BodySession {
	let seq = 0;
	const stream = {
		async next(after: number | null) {
			seq = Math.max(seq, (after ?? 0) + 1);
			const override = selfFrames[Math.min(seq - 1, selfFrames.length - 1)] ?? {};
			return {
				stream: "fb:t:1",
				sequence: seq,
				body: "body:t:1",
				operation: "op:t:1",
				step: { id: seq },
				sampledAt: seq,
				validUntil: seq + 100,
				connection: "conn:t:1",
				incarnation: "inc:t:1",
				self: {
					value: baseSelf(override),
					observedAt: "t",
					coverage: "complete",
					unknown: [],
					evidence: [],
					source: "client",
				},
				sensors: {},
			};
		},
		async apply() {
			return { receipt: {}, appliedStep: { id: 0 } };
		},
		async close() {},
	};
	return { feedback: async () => stream, close: async () => {} } as unknown as BodySession;
}

interface SurvivalHarness {
	interventions: number;
	failWith: Error | null;
	planRoute: { x: number; y: number; z: number }[] | null;
	/** 介入期间反馈流展开的 self 帧序列；默认全帧保持危险态。 */
	workFrames: Partial<SelfState>[];
	faults: string[];
}

function start(h: ReturnType<typeof makeFactsHarness>) {
	const state: SurvivalHarness = {
		interventions: 0,
		failWith: null,
		planRoute: null,
		workFrames: [],
		faults: [],
	};
	const survival = startSurvival({
		facts: h.facts,
		world: { read: async () => ({ value: { entities: [] } }) } as never,
		runtime: {
			assertActionAllowed() {},
			async intervene(
				trigger: SafetyTrigger,
				work: (body: BodySession, signal: AbortSignal) => Promise<"safe" | "blocked" | "invalidated">,
			): Promise<SafetyInterventionRecord> {
				state.interventions++;
				if (state.failWith) throw state.failWith;
				const ended = await work(fakeBody(state.workFrames), new AbortController().signal);
				return {
					intervention: `int:t:${state.interventions}`,
					record: `rec:t:${state.interventions}`,
					policy: "survival@1",
					trigger,
					thresholds: { oxygen: 4, healthRatio: 0.3, maxTimeMs: 10000 },
					interruptedRun: null,
					startedAt: "t",
					effects: [],
					unknownEffects: [],
					finishedAt: "t",
					ended,
					outcome: ended === "safe" ? "succeeded" : "failed",
				};
			},
		},
		plan: async () => state.planRoute,
		breathable: () => true,
		onFault: (error) => state.faults.push(String(error)),
	});
	return { state, survival };
}

const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe("介入失败后的重试（P0-1）", () => {
	test("blocked 后冷却期内不重复介入；冷却经过后重试", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		try {
			const h = makeFactsHarness({ bot: survivalBot() });
			const { state, survival } = start(h);
			state.planRoute = null; // 无可达逃生点 → work 返回 blocked
			h.bot().emit("move");
			await flush();
			expect(state.interventions).toBe(1);
			h.bot().emit("move");
			await flush();
			expect(state.interventions).toBe(1); // 冷却期内
			await vi.advanceTimersByTimeAsync(1000);
			h.bot().emit("move");
			await flush();
			expect(state.interventions).toBe(2); // 冷却后重试
			await survival.close();
		} finally {
			vi.useRealTimers();
		}
	});

	test("确认安全后锁存到危险消失；危险重新出现时新一轮触发", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		try {
			const h = makeFactsHarness({ bot: survivalBot() });
			const { state, survival } = start(h);
			state.planRoute = [{ x: 1, y: 64, z: 0 }];
			state.workFrames = [{}, { inLava: false, onGround: true }];
			h.bot().emit("move");
			await flush();
			expect(state.interventions).toBe(1);
			// 事实源仍报 inLava=true 的窗口内：成功锁存挡住重复介入
			h.bot().emit("move");
			await flush();
			expect(state.interventions).toBe(1);
			// 危险事实消失 → 锁存清零；重新进入 → 新一轮介入
			(h.bot().entity as { isInLava: boolean }).isInLava = false;
			h.bot().emit("move");
			await flush();
			(h.bot().entity as { isInLava: boolean }).isInLava = true;
			h.bot().emit("move");
			await flush();
			expect(state.interventions).toBe(2);
			await survival.close();
		} finally {
			vi.useRealTimers();
		}
	});

	test("介入抛错进入同一冷却并记录故障，冷却后重试", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		try {
			const h = makeFactsHarness({ bot: survivalBot() });
			const { state, survival } = start(h);
			state.failWith = new Error("boom");
			h.bot().emit("move");
			await flush();
			expect(state.interventions).toBe(1);
			expect(state.faults).toHaveLength(1);
			h.bot().emit("move");
			await flush();
			expect(state.interventions).toBe(1);
			await vi.advanceTimersByTimeAsync(1000);
			h.bot().emit("move");
			await flush();
			expect(state.interventions).toBe(2);
			await survival.close();
		} finally {
			vi.useRealTimers();
		}
	});

	test("新伤害证据生成新 key，不受上一失败的冷却抑制", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		try {
			// 不在岩浆/水中，让 survivalTrigger 落到低血量分支
			const h = makeFactsHarness({
				bot: survivalBot({
					health: 5,
					entity: {
						id: 1,
						position: { x: 0, y: 64, z: 0 },
						velocity: { x: 0, y: 0, z: 0 },
						yaw: 0,
						pitch: 0,
						isInLava: false,
						isInWater: false,
						attributes: { "generic.max_health": { value: 20 } },
					},
				}),
			});
			const { state, survival } = start(h);
			state.planRoute = null;
			const hurt = () => h.bot().emit("entityHurt", { id: 1 }, { id: 2 });
			hurt();
			await flush();
			expect(state.interventions).toBe(1);
			hurt(); // 新伤害证据 → 新 ref → 新 key：立即重试，不等冷却
			await flush();
			expect(state.interventions).toBe(2);
			h.bot().emit("move"); // 同一 key 冷却期内：不再触发
			await flush();
			expect(state.interventions).toBe(2);
			await survival.close();
		} finally {
			vi.useRealTimers();
		}
	});

	test("源重置清空成功锁存：换代后同一危险立即重新介入", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		try {
			const h = makeFactsHarness({ bot: survivalBot() });
			const { state, survival } = start(h);
			state.planRoute = [{ x: 1, y: 64, z: 0 }];
			state.workFrames = [{}, { inLava: false, onGround: true }];
			h.bot().emit("move");
			await flush();
			expect(state.interventions).toBe(1);
			h.reconnect(); // reset 通知 → 锁存清零
			h.bot().emit("move");
			await flush();
			expect(state.interventions).toBe(2);
			await survival.close();
		} finally {
			vi.useRealTimers();
		}
	});
});
