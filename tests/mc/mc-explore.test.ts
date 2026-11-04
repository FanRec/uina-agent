/**
 * explore@1：纯游标逻辑 + 动作层（假导演 / 脚本化扫描）。
 * 覆盖：首扫命中不移动、多段后命中（段目标按方向与常量）、方向死亡轮换、
 * NOT_FOUND/TIMEOUT 带 progress、INTERRUPTED 透传、实体 ref 透传、玩家目标
 * 只匹配玩家实体。寻路与真实扫描的覆盖真值由真服场景验收。
 */

import { describe, expect, test } from "vitest";
import { builtinCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
import type { CallContext } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { EntityRef } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { JsonValue, Vec3 } from "../../.uina/worlds/minecraft/contracts/values.js";
import {
	ExploreCursor,
	LEG_DISTANCE,
	LEG_TOLERANCE,
} from "../../.uina/worlds/minecraft/capabilities/shared/explore.js";
import { fact, failureOf, self as baseSelf } from "./mc-capability-harness.js";

describe("ExploreCursor", () => {
	const origin = { x: 0, y: 64, z: 0 };

	test("rotates any through n/e/s/w, skips dead directions and visited cells", () => {
		const cursor = new ExploreCursor("any");
		expect(cursor.nextLeg(origin)).toEqual({ direction: "n", at: { x: 0, y: 64, z: -LEG_DISTANCE } });
		cursor.markDead("n");
		expect(cursor.nextLeg(origin)).toEqual({ direction: "e", at: { x: LEG_DISTANCE, y: 64, z: 0 } });
		cursor.markVisited({ x: LEG_DISTANCE, y: 64, z: 0 });
		expect(cursor.nextLeg(origin)).toMatchObject({ direction: "s" });
		cursor.markDead("s");
		cursor.markDead("w");
		expect(cursor.nextLeg(origin)).toBeNull();
	});

	test("a specified primary direction is tried first", () => {
		const cursor = new ExploreCursor("w");
		expect(cursor.nextLeg(origin)).toMatchObject({ direction: "w", at: { x: -LEG_DISTANCE, y: 64, z: 0 } });
	});
});

interface FakeState {
	position: Vec3;
	blockScans: { position: Vec3; name: string }[][];
	entities: { ref: EntityRef; name: string; kind: string; position: Vec3; distance: number; item: null }[];
	scanIndex: number;
	gotoCalls: { at: Vec3; tolerance: number }[];
}

function makeExplore(state: FakeState, behavior: string[]) {
	const gotoDirector = {
		async goto(request: { at: Vec3; tolerance: number; digThrough: boolean; placeToReach: boolean }) {
			state.gotoCalls.push({ at: request.at, tolerance: request.tolerance });
			const next = behavior.shift() ?? "ok";
			if (next === "unreachable") {
				throw Object.assign(new Error("no path"), { code: "UNREACHABLE", source: "world" });
			}
			state.position = { ...request.at };
			return {
				receipt: { effect: "eff:t", dispatch: "sent", completion: "met", evidence: [] },
				at: request.at,
				ticks: 0,
				dug: 0,
				placed: null,
			};
		},
	};
	const capabilities = builtinCatalog.bind({
		surface: () => null,
		runtime: () =>
			({
				chat: async () => {
					throw new Error("unused");
				},
				navigate: async (_owner: unknown, fn: () => Promise<unknown>) => fn(),
			}) as never,
		gotoDirector: gotoDirector as never,
		knowledge: () => null,
	});
	const explore = capabilities.callables.find((entry) => entry.descriptor.ref === "explore@1");
	if (explore == null) throw new Error("no callable explore@1");
	const progressCalls: unknown[] = [];
	const controller = new AbortController();
	const world = {
		async read<T>(query: { ref: string }): Promise<{ value: unknown } & T> {
			if (query.ref === "self@1")
				return fact({
					...baseSelf,
					place: { ...baseSelf.place, position: state.position },
				}) as never;
			if (query.ref === "blocks@1") {
				const hits = state.blockScans[Math.min(state.scanIndex, state.blockScans.length - 1)] ?? [];
				state.scanIndex += 1;
				return fact({ blocks: hits, count: hits.length, truncated: false, scanned: { radius: 32 } }) as never;
			}
			if (query.ref === "entities@1") return fact({ entities: state.entities, scanned: { radius: 32 } }) as never;
			throw new Error(`unexpected query ${query.ref}`);
		},
	} as never;
	const ctx = {
		run: "run:t:1",
		segment: "seg:t:1",
		callId: "call:t:1",
		signal: controller.signal,
		progress: async (value: unknown) => {
			progressCalls.push(value);
		},
		world,
	} as unknown as CallContext;
	const invoke = (input: JsonValue) => explore.invoke(ctx, input);
	return { invoke, progressCalls, controller, state };
}

function freshState(): FakeState {
	return { position: { x: 0, y: 64, z: 0 }, blockScans: [], entities: [], scanIndex: 0, gotoCalls: [] };
}

test("a first-scan hit returns immediately without moving", async () => {
	const state = freshState();
	state.blockScans = [[{ position: { x: 12, y: 60, z: 8 }, name: "diamond_ore" }]];
	const { invoke, state: s } = makeExplore(state, []);
	const value = (await invoke({ until: { block: "diamond_ore" } } as JsonValue)) as unknown as {
		found: { kind: string; name: string; at: { position: Vec3; dimension: string } };
		traveled: number;
		scanned: number;
	};
	expect(value.found).toEqual({
		kind: "block",
		at: { position: { x: 12, y: 60, z: 8 }, dimension: "overworld" },
		name: "diamond_ore",
	});
	expect(value).toMatchObject({ traveled: 0, scanned: 1 });
	expect(s.gotoCalls).toEqual([]);
});

test("legs extend in the first available direction and the hit reports real traveled/scanned", async () => {
	const state = freshState();
	state.blockScans = [[], [], [{ position: { x: 0, y: 64, z: -48 }, name: "diamond_ore" }]];
	const { invoke, progressCalls, state: s } = makeExplore(state, []);
	const value = (await invoke({ until: { block: "diamond_ore" } } as JsonValue)) as unknown as {
		traveled: number;
		scanned: number;
	};
	// 未死且未访问的方向连续延伸（先北后北）；段容差 LEG_TOLERANCE、不垫块。
	expect(s.gotoCalls).toEqual([
		{ at: { x: 0, y: 64, z: -LEG_DISTANCE }, tolerance: LEG_TOLERANCE },
		{ at: { x: 0, y: 64, z: -2 * LEG_DISTANCE }, tolerance: LEG_TOLERANCE },
	]);
	expect(value).toMatchObject({ traveled: 48, scanned: 3 });
	expect(progressCalls).toEqual([
		{ traveled: 24, scanned: 2 },
		{ traveled: 48, scanned: 3 },
	]);
});

test("boxed in at the start (traveled 0) is UNREACHABLE with progress", async () => {
	const state = freshState();
	state.blockScans = [[], [], [], [], []];
	const { invoke, state: s } = makeExplore(state, ["unreachable", "unreachable", "unreachable", "unreachable"]);
	const failure = await failureOf(invoke({ until: { block: "diamond_ore" } } as JsonValue));
	expect(failure).toMatchObject({ code: "UNREACHABLE" });
	expect(failure.progress).toMatchObject({ traveled: 0, scanned: 5 });
	// 四个方向各尝试一次（n/e/s/w），没有方向被重复派发。
	expect(s.gotoCalls).toHaveLength(4);
});

test("exhaustion after real movement is NOT_FOUND with progress", async () => {
	const state = freshState();
	state.blockScans = [[], [], [], [], [], []];
	// 第一段成功北移 24 格，之后四个方向全部 UNREACHABLE（死巷）：traveled>0 → NOT_FOUND。
	const { invoke } = makeExplore(state, ["ok", "unreachable", "unreachable", "unreachable", "unreachable"]);
	const failure = await failureOf(invoke({ until: { block: "diamond_ore" } } as JsonValue));
	expect(failure).toMatchObject({ code: "NOT_FOUND" });
	expect(failure.progress).toMatchObject({ traveled: LEG_DISTANCE, scanned: 6 });
});

test("budget exhausted at entry is TIMEOUT with the coverage so far", async () => {
	const state = freshState();
	state.blockScans = [[]];
	const { invoke, state: s } = makeExplore(state, []);
	const failure = await failureOf(invoke({ until: { block: "diamond_ore" }, maxTimeMs: 0 } as JsonValue));
	expect(failure).toMatchObject({ code: "TIMEOUT" });
	expect(failure.progress).toMatchObject({ traveled: 0, scanned: 1 });
	expect(s.gotoCalls).toEqual([]);
});

test("a pre-aborted signal surfaces INTERRUPTED with progress", async () => {
	const state = freshState();
	state.blockScans = [[]];
	const { invoke, controller } = makeExplore(state, []);
	controller.abort();
	const failure = await failureOf(invoke({ until: { block: "diamond_ore" }, maxTimeMs: 1000 } as JsonValue));
	expect(failure).toMatchObject({ code: "INTERRUPTED" });
	expect(failure.progress).toMatchObject({ traveled: 0, scanned: 1 });
});

test("entity hits carry the stable ref; player targets match only player entities", async () => {
	const state = freshState();
	const cowRef: EntityRef = { connection: "c:1", incarnation: "i:1", appearance: "a:1", networkId: 7 };
	const steveRef: EntityRef = { connection: "c:1", incarnation: "i:1", appearance: "a:2", networkId: 9 };
	state.entities = [
		{ ref: cowRef, name: "cow", kind: "passive", position: { x: 8, y: 64, z: 2 }, distance: 8, item: null },
		{ ref: steveRef, name: "Steve", kind: "player", position: { x: -6, y: 64, z: 4 }, distance: 7, item: null },
	];
	const { invoke } = makeExplore(state, []);
	const entity = (await invoke({ until: { entity: "cow" } } as JsonValue)) as unknown as {
		found: Record<string, unknown>;
	};
	expect(entity.found).toEqual({
		kind: "entity",
		at: { position: { x: 8, y: 64, z: 2 }, dimension: "overworld" },
		name: "cow",
		ref: cowRef,
	});

	const state2 = freshState();
	state2.entities = state.entities;
	const { invoke: invoke2 } = makeExplore(state2, []);
	const player = (await invoke2({ until: { player: "Steve" } } as JsonValue)) as unknown as {
		found: Record<string, unknown>;
	};
	expect(player.found).toMatchObject({ kind: "player", name: "Steve", ref: steveRef });
	// 玩家名字匹配到非玩家实体时不算找到（tracked 实体才是位置证据）。
	const state3 = freshState();
	state3.entities = [{ ...state.entities[0]!, name: "Steve", kind: "passive" }];
	const { invoke: invoke3 } = makeExplore(state3, ["unreachable", "unreachable", "unreachable", "unreachable"]);
	const miss = await failureOf(invoke3({ until: { player: "Steve" }, maxTimeMs: 1000 } as JsonValue));
	// 未发生任何真实移动（起步即四面不可达），失败映射为 UNREACHABLE；关键是没有伪命中。
	expect(miss).toMatchObject({ code: "UNREACHABLE" });
});
