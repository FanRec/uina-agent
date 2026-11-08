/**
 * explore@1：前沿覆盖纯逻辑 + 动作层（假 region / 假导演 / 脚本化扫描）。
 * 覆盖：观察图 ingest 与 -1 未知语义、前沿提取（含竖直连接与水面列排除）、
 * 判死记账（UNREACHABLE 立即 / TIMEOUT 两次）、评分确定性（增益/距离/危险/
 * 失败记账/方向偏置）、pickFrontier 尊重 route.plan 不可达证据；动作层：首扫
 * 命中不移动、前沿驱动多站命中（goto 目标 = 观察盒边界环）、起步无前沿
 * UNREACHABLE、真实移动后穷尽 NOT_FOUND、TIMEOUT 记账不封路、TIMEOUT/
 * INTERRUPTED 带 progress、实体 ref 透传、玩家目标只匹配玩家实体、维度穿越
 * WRONG_STATE。寻路与真实扫描的覆盖真值由真服场景验收。
 */

import { describe, expect, test } from "vitest";
import { createCapabilityCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
import type { CallContext } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { EntityRef } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { JsonValue, Vec3 } from "../../.uina/worlds/minecraft/contracts/values.js";
import {
	ATTEMPTS_BEFORE_DEAD,
	classifyCell,
	LEG_TOLERANCE,
	ObservationMap,
	OBSERVE_HALF,
	OBSERVE_VERTICAL,
	pickFrontier,
	rankFrontiers,
	type RegionSample,
} from "../../.uina/worlds/minecraft/capabilities/shared/explore.js";
import { fact, failureOf, self as baseSelf } from "./mc-capability-harness.js";

describe("ObservationMap", () => {
	const CHAR: Record<string, number> = { ".": 0, "#": 1, w: 2, l: 3, " ": -1 };

	/** layers[y] 为 z 行 × x 字符的网格；' ' 表示未加载（region -1）。 */
	function regionOf(layers: string[][], origin: Vec3 = { x: 0, y: 0, z: 0 }): RegionSample {
		const palette = [{ name: "air" }, { name: "stone" }, { name: "water" }, { name: "lava" }];
		const cells: number[] = [];
		for (const layer of layers) {
			for (const row of layer) {
				for (const ch of row) cells.push(CHAR[ch] ?? -1);
			}
		}
		return {
			origin,
			shape: [layers[0]![0]!.length, layers.length, layers[0]!.length],
			palette,
			cells,
		};
	}

	test("classifyCell maps palette names; anything else is solid", () => {
		expect(classifyCell("air")).toBe("air");
		expect(classifyCell("water")).toBe("water");
		expect(classifyCell("lava")).toBe("lava");
		expect(classifyCell("oak_planks")).toBe("solid");
	});

	test("ingest records cells, keeps -1 unknown, counts only new cells", () => {
		const map = new ObservationMap("overworld");
		const added = map.ingest(regionOf([["###"], [". "]]));
		expect(added).toBe(4);
		expect(map.cellAt({ x: 0, y: 0, z: 0 })).toBe("solid");
		expect(map.cellAt({ x: 0, y: 1, z: 0 })).toBe("air");
		expect(map.cellAt({ x: 1, y: 1, z: 0 })).toBeNull();
		// 重复入图不重复计数。
		expect(map.ingest(regionOf([["###"], [". "]]))).toBe(0);
	});

	test("frontiers are standable cells with unknown neighbors; interior observed cells are not", () => {
		const map = new ObservationMap("overworld");
		// 3×3×3：底面 stone，上面两层 air；边界外全部未知。
		map.ingest(
			regionOf([
				["###", "###", "###"],
				["...", "...", "..."],
				["...", "...", "..."],
			]),
		);
		const frontiers = map.frontiers();
		// 四角有两个水平未知邻（gain 2），边中格一个。
		expect(frontiers).toContainEqual({ x: 0, y: 1, z: 0 });
		expect(frontiers).toContainEqual({ x: 2, y: 1, z: 2 });
		expect(frontiers).toContainEqual({ x: 1, y: 1, z: 0 });
		// 中心格六邻全部已观测，不是前沿。
		expect(frontiers).not.toContainEqual({ x: 1, y: 1, z: 1 });
		// 顶层面格头顶是未知格，不满足可站立列。
		expect(frontiers).not.toContainEqual({ x: 1, y: 2, z: 1 });
	});

	test("a shaft mouth in the floor is not a phantom frontier", () => {
		const map = new ObservationMap("overworld");
		// 3×3×4：地板层 y2，y1/y0 中心竖井向下延伸出观察箱（下方未知）。
		map.ingest(
			regionOf([
				["###", "# #", "###"],
				["###", "# #", "###"],
				["...", "...", "..."],
				["...", "...", "..."],
			]),
		);
		const frontiers = map.frontiers();
		// 竖井口正上方不是可站立格（脚下是空气），不得成为伪前沿目标。
		expect(frontiers).not.toContainEqual({ x: 1, y: 2, z: 1 });
		// 井口邻格正常成前沿（箱外水平未知）。
		expect(frontiers).toContainEqual({ x: 0, y: 2, z: 1 });
	});

	test("water ground is not standable; lava marks hazard", () => {
		const map = new ObservationMap("overworld");
		map.ingest(
			regionOf([
				["www", "www", "www"],
				["...", "...", "..."],
				["l..", "...", "..."],
			]),
		);
		// 脚下是水：可通行列不成立，边界格全不是前沿。
		expect(map.frontiers()).toEqual([]);
		expect(map.hazardNear({ x: 0, y: 1, z: 0 })).toBe(true);
		expect(map.hazardNear({ x: 2, y: 1, z: 2 })).toBe(false);
	});

	test("markFailed: UNREACHABLE kills at once, TIMEOUT and plan need two strikes", () => {
		const map = new ObservationMap("overworld");
		map.ingest(
			regionOf([
				["###", "###", "###"],
				["...", "...", "..."],
				["...", "...", "..."],
			]),
		);
		const edge = { x: 0, y: 1, z: 0 };
		map.markFailed(edge, "timeout");
		expect(map.frontiers()).toContainEqual(edge);
		map.markFailed(edge, "timeout");
		expect(map.frontiers()).not.toContainEqual(edge);
		expect(map.attemptCount(edge)).toBe(ATTEMPTS_BEFORE_DEAD);
		const other = { x: 2, y: 1, z: 0 };
		map.markFailed(other, "unreachable");
		expect(map.frontiers()).not.toContainEqual(other);
		const planned = { x: 2, y: 1, z: 2 };
		map.markFailed(planned, "plan");
		expect(map.frontiers()).toContainEqual(planned);
		map.markFailed(planned, "plan");
		expect(map.frontiers()).not.toContainEqual(planned);
	});

	test("visited cells are not candidates: standing somewhere again yields no new observation", () => {
		const map = new ObservationMap("overworld");
		map.ingest(
			regionOf([
				["###", "###", "###"],
				["...", "...", "..."],
				["...", "...", "..."],
			]),
		);
		const edge = { x: 0, y: 1, z: 0 };
		map.markVisited(edge);
		expect(map.frontiers()).not.toContainEqual(edge);
	});
});

describe("rankFrontiers / pickFrontier", () => {
	function map3x3(): ObservationMap {
		const map = new ObservationMap("overworld");
		map.ingest({
			origin: { x: 0, y: 0, z: 0 },
			shape: [3, 3, 3],
			palette: [{ name: "air" }, { name: "stone" }],
			cells: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
		});
		return map;
	}

	test("gain dominates distance; ties break by straight then coordinates", () => {
		const map = map3x3();
		const ranked = rankFrontiers({ x: 1, y: 1, z: 1 }, map.frontiers(), map, "any");
		// 四角 gain=2 优先（并列按坐标升序），边中格 gain=1 在后。
		expect(ranked.map((c) => c.at)).toEqual([
			{ x: 0, y: 1, z: 0 },
			{ x: 0, y: 1, z: 2 },
			{ x: 2, y: 1, z: 0 },
			{ x: 2, y: 1, z: 2 },
			{ x: 0, y: 1, z: 1 },
			{ x: 1, y: 1, z: 0 },
			{ x: 1, y: 1, z: 2 },
			{ x: 2, y: 1, z: 1 },
		]);
	});

	test("direction bias reorders equal-gain candidates toward the preferred cardinal", () => {
		const map = map3x3();
		const ranked = rankFrontiers({ x: 1, y: 1, z: 1 }, map.frontiers(), map, "e");
		// 东侧两角并列最高，坐标升序取 z 小者。
		expect(ranked[0]!.at).toEqual({ x: 2, y: 1, z: 0 });
	});

	test("attempts push candidates behind untouched ones", () => {
		const map = map3x3();
		map.markFailed({ x: 0, y: 1, z: 0 }, "timeout");
		const ranked = rankFrontiers({ x: 1, y: 1, z: 1 }, map.frontiers(), map, "any");
		// 角格 19 − 15 = 4 落到边中格（9）之后，垫底。
		expect(ranked.at(-1)!.at).toEqual({ x: 0, y: 1, z: 0 });
	});

	test("pickFrontier prefers route-ok candidates; all-unreachable refuses to dispatch", () => {
		const map = map3x3();
		const ranked = rankFrontiers({ x: 1, y: 1, z: 1 }, map.frontiers(), map, "any");
		// 前三个候选里只有第三个估价可达：只在实际可达者间挑选。
		const target = pickFrontier(ranked.slice(0, 3), ["unreachable", "unreachable", 1]);
		expect(target).toEqual({ x: 2, y: 1, z: 0 });
		// 全部被计划判不可达：返回 null（调用方软记账，不派发）。
		expect(pickFrontier(ranked.slice(0, 3), ["unreachable", "unreachable", "unreachable"])).toBeNull();
		// 全部无证据（估价读取失败）：回退启发式最优。
		expect(pickFrontier(ranked.slice(0, 3), [null, null, null])).toEqual({ x: 0, y: 1, z: 0 });
	});
});

interface FakeState {
	position: Vec3;
	dimension: string;
	blockScans: { position: Vec3; name: string }[][];
	entities: { ref: EntityRef; name: string; kind: string; position: Vec3; distance: number; item: null }[];
	scanIndex: number;
	/** 每次 region@1 读取按序取一个世界函数；耗尽后重复最后一个。 */
	regionFns: ((x: number, y: number, z: number) => FakeCell)[];
	regionIndex: number;
	routePlan: (at: Vec3) => { ok: boolean; distance: number };
	gotoCalls: { at: Vec3; tolerance: number; timeoutMs: number }[];
	gotoBehavior: string[];
	dimensionFlipAfterGoto: number;
}

type FakeCell = "air" | "stone" | "water" | "lava" | null;

const GROUND_Y = 63;
/** 无限平坦世界：≤63 stone、以上 air，观察盒内全部已加载（前沿 = 盒边界环）。 */
const flatWorld = (_x: number, y: number, _z: number): FakeCell => (y <= GROUND_Y ? "stone" : "air");
/** 以 center 为中心的 5×5 全观测石室（y 64–65 air）：无未知 → 无前沿。 */
const sealedRoom =
	(center: Vec3) =>
	(x: number, y: number, z: number): FakeCell =>
		Math.abs(x - Math.floor(center.x)) <= 2 && Math.abs(z - Math.floor(center.z)) <= 2 && (y === 64 || y === 65)
			? "air"
			: "stone";
/**
 * 5×5 有限岛（中心 center）：岛内 y64–65 air、其余地面 stone；岛外 y≥64 一律未加载。
 * 世界函数与调用次序无关（一致世界）：前沿只可能是 16 个岛缘格，全部站过后穷尽。
 */
const islandWorld =
	(center: Vec3) =>
	(x: number, y: number, z: number): FakeCell => {
		if (y <= GROUND_Y) return "stone";
		const inside = Math.abs(x - Math.floor(center.x)) <= 2 && Math.abs(z - Math.floor(center.z)) <= 2;
		return inside && (y === 64 || y === 65) ? "air" : null;
	};

function buildRegion(
	input: { at: Vec3; size: { x: number; y: number; z: number } },
	cellAt: (x: number, y: number, z: number) => FakeCell,
): RegionSample {
	const names: string[] = ["air", "stone", "water", "lava"];
	const cells: number[] = [];
	for (let dy = 0; dy < input.size.y; dy++) {
		for (let dz = 0; dz < input.size.z; dz++) {
			for (let dx = 0; dx < input.size.x; dx++) {
				const cell = cellAt(input.at.x + dx, input.at.y + dy, input.at.z + dz);
				cells.push(cell == null ? -1 : names.indexOf(cell));
			}
		}
	}
	return {
		origin: input.at,
		shape: [input.size.x, input.size.y, input.size.z],
		palette: names.map((name) => ({ name })),
		cells,
	};
}

function makeExplore(state: FakeState, behavior: string[]) {
	state.gotoBehavior = behavior;
	const gotoDirector = {
		async goto(request: { at: Vec3; tolerance: number; timeoutMs: number }) {
			state.gotoCalls.push({ at: request.at, tolerance: request.tolerance, timeoutMs: request.timeoutMs });
			const next = state.gotoBehavior.shift() ?? "ok";
			if (next === "unreachable") {
				throw Object.assign(new Error("no path"), { code: "UNREACHABLE", source: "world" });
			}
			if (next === "timeout") {
				throw Object.assign(new Error("slow terrain"), { code: "TIMEOUT", source: "world" });
			}
			state.position = { ...request.at };
			if (state.dimensionFlipAfterGoto > 0 && state.gotoCalls.length >= state.dimensionFlipAfterGoto) {
				state.dimension = "the_nether";
			}
			return {
				receipt: { effect: "eff:t", dispatch: "sent", completion: "met", evidence: [] },
				at: request.at,
				ticks: 0,
				dug: 0,
				placed: null,
			};
		},
	};
	const capabilities = createCapabilityCatalog().bind({
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
		async read<T>(query: { ref: string; input: JsonValue }): Promise<{ value: unknown } & T> {
			if (query.ref === "self@1")
				return fact({
					...baseSelf,
					place: { ...baseSelf.place, position: state.position, dimension: state.dimension },
				}) as never;
			if (query.ref === "blocks@1") {
				const hits = state.blockScans[Math.min(state.scanIndex, state.blockScans.length - 1)] ?? [];
				state.scanIndex += 1;
				return fact({ blocks: hits, count: hits.length, truncated: false, scanned: { radius: 32 } }) as never;
			}
			if (query.ref === "entities@1") return fact({ entities: state.entities, scanned: { radius: 32 } }) as never;
			if (query.ref === "world@1") return fact({ biome: "plains" }) as never;
			if (query.ref === "region@1") {
				const fn = state.regionFns[Math.min(state.regionIndex, state.regionFns.length - 1)]!;
				state.regionIndex += 1;
				return fact(
					buildRegion(query.input as unknown as { at: Vec3; size: { x: number; y: number; z: number } }, fn),
				) as never;
			}
			if (query.ref === "route.plan@1") {
				const at = (query.input as unknown as { at: Vec3 }).at;
				const estimate = state.routePlan(at);
				return fact({
					ok: estimate.ok,
					distance: estimate.distance,
					steps: [],
					needs: { dig: 0, place: 0 },
					blockers: [],
					estTimeSec: null,
				}) as never;
			}
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

function freshState(regionFns: ((x: number, y: number, z: number) => FakeCell)[]): FakeState {
	const state: FakeState = {
		position: { x: 10, y: 64, z: 10 },
		dimension: "overworld",
		blockScans: [],
		entities: [],
		scanIndex: 0,
		regionFns,
		regionIndex: 0,
		routePlan: () => ({ ok: true, distance: 0 }),
		gotoCalls: [],
		gotoBehavior: [],
		dimensionFlipAfterGoto: 0,
	};
	// 默认估价 = 从当前机器人位置的直线距离（真 route.plan 从现场算）。
	state.routePlan = (at: Vec3) => ({
		ok: true,
		distance: Math.hypot(at.x - state.position.x, at.y - state.position.y, at.z - state.position.z),
	});
	return state;
}

test("a first-scan hit returns immediately without moving", async () => {
	const state = freshState([flatWorld]);
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

test("frontier hops walk the observation-box edge until the hit", async () => {
	const state = freshState([flatWorld]);
	state.blockScans = [[], [], [{ position: { x: 0, y: 64, z: -48 }, name: "diamond_ore" }]];
	const { invoke, progressCalls, state: s } = makeExplore(state, []);
	const value = (await invoke({ until: { block: "diamond_ore" } } as JsonValue)) as unknown as {
		traveled: number;
		scanned: number;
	};
	// 平坦世界上前沿 = 观察盒边界环；四角 gain=2 最优，并列按坐标升序 → 西北角先行。
	expect(s.gotoCalls).toEqual([{ at: { x: -6, y: 64, z: -6 }, tolerance: LEG_TOLERANCE, timeoutMs: 45000 }]);
	expect(value).toMatchObject({ scanned: 3 });
	expect(value.traveled).toBeCloseTo(Math.hypot(16, 16), 1);
	expect(progressCalls).toEqual([
		{ traveled: 0, scanned: 2 },
		{ traveled: Math.round(Math.hypot(16, 16) * 100) / 100, scanned: 3 },
	]);
});

test("observation box re-centers on the bot; coverage grows instead of rotating directions", async () => {
	const state = freshState([flatWorld]);
	state.blockScans = [[], [], [], [{ position: { x: 0, y: 64, z: -48 }, name: "diamond_ore" }]];
	const { invoke, state: s } = makeExplore(state, []);
	await invoke({ until: { block: "diamond_ore" } } as JsonValue);
	// 第二站从新位置重新提前沿（西北角 -22,-22），不是四向轮换的固定 24 格腿。
	expect(s.gotoCalls).toEqual([
		{ at: { x: -6, y: 64, z: -6 }, tolerance: LEG_TOLERANCE, timeoutMs: 45000 },
		{ at: { x: -22, y: 64, z: -22 }, tolerance: LEG_TOLERANCE, timeoutMs: 45000 },
	]);
});

test("route.plan unreachable evidence is respected: only ok-estimated candidates get dispatched", async () => {
	const state = freshState([flatWorld]);
	state.blockScans = [[], [], [{ position: { x: 0, y: 64, z: -48 }, name: "diamond_ore" }]];
	// 四角（直线 22.6）计划不可达；边界直格（16）可达：目标必须是直格而非四角。
	state.routePlan = (at: Vec3) => ({ ok: Math.hypot(at.x - 10, at.z - 10) <= 20, distance: 16 });
	const { invoke, state: s } = makeExplore(state, []);
	await invoke({ until: { block: "diamond_ore" } } as JsonValue);
	expect(s.gotoCalls[0]!.at).toEqual({ x: -6, y: 64, z: 10 });
});

test("direction bias steers the first hop toward the preferred cardinal", async () => {
	const state = freshState([flatWorld]);
	state.blockScans = [[], [], [{ position: { x: 0, y: 64, z: -48 }, name: "diamond_ore" }]];
	const { invoke, state: s } = makeExplore(state, []);
	await invoke({ until: { block: "diamond_ore" }, direction: "e" } as JsonValue);
	// 东向偏置把东侧两角并列提到最前，坐标升序取 z 小者。
	expect(s.gotoCalls[0]!.at).toEqual({ x: 26, y: 64, z: -6 });
});

test("boxed in at the start (traveled 0) is UNREACHABLE with progress", async () => {
	const state = freshState([sealedRoom({ x: 10, y: 64, z: 10 })]);
	state.blockScans = [[]];
	const { invoke, progressCalls, state: s } = makeExplore(state, []);
	const failure = await failureOf(invoke({ until: { block: "diamond_ore" } } as JsonValue));
	expect(failure).toMatchObject({ code: "UNREACHABLE" });
	expect(failure.progress).toMatchObject({ traveled: 0, scanned: 2 });
	expect(s.gotoCalls).toEqual([]);
	expect(progressCalls).toEqual([{ traveled: 0, scanned: 2 }]);
});

test("exhaustion after real movement is NOT_FOUND with progress", async () => {
	// 有限岛：站遍 16 个岛缘格后前沿穷尽（世界函数与次序无关，无过时观察）。
	const state = freshState([islandWorld({ x: 10, y: 64, z: 10 })]);
	state.blockScans = [];
	const { invoke, state: s } = makeExplore(state, []);
	const failure = await failureOf(invoke({ until: { block: "diamond_ore" } } as JsonValue));
	expect(failure).toMatchObject({ code: "NOT_FOUND" });
	expect(failure.progress).toMatchObject({ scanned: 18 });
	expect(failure.progress?.traveled).toBeGreaterThan(0);
	expect(s.gotoCalls).toHaveLength(16);
});

test("plan-unreachable evidence avoids blind dispatch: soft-fail then honest exhaustion", async () => {
	// 有限岛 + route.plan 全判不可达：不派发任何导航，软记账耗尽候选后如实 UNREACHABLE。
	const state = freshState([islandWorld({ x: 10, y: 64, z: 10 })]);
	state.blockScans = [];
	state.routePlan = () => ({ ok: false, distance: 0 });
	const { invoke, state: s } = makeExplore(state, []);
	const failure = await failureOf(invoke({ until: { block: "diamond_ore" } } as JsonValue));
	expect(failure).toMatchObject({ code: "UNREACHABLE" });
	expect(failure.progress).toMatchObject({ traveled: 0 });
	expect(s.gotoCalls).toEqual([]);
});

test("a failed hop is dead but the loop keeps trying remaining frontiers", async () => {
	// 有限岛 + 每次派发都 UNREACHABLE：16 个岛缘格逐格判死，一步未成 → UNREACHABLE。
	const state = freshState([islandWorld({ x: 10, y: 64, z: 10 })]);
	state.blockScans = [];
	state.routePlan = () => ({ ok: true, distance: 3 });
	const { invoke, state: s } = makeExplore(
		state,
		Array.from({ length: 16 }, () => "unreachable"),
	);
	const failure = await failureOf(invoke({ until: { block: "diamond_ore" } } as JsonValue));
	expect(failure).toMatchObject({ code: "UNREACHABLE" });
	// 原地软记账迭代不重复观察/扫描（位置未变没有新信息）：scanned 只计真实扫描。
	expect(failure.progress).toMatchObject({ traveled: 0, scanned: 2 });
	expect(s.gotoCalls).toHaveLength(16);
	// 判死的是具体格：16 个目标互不相同，同一格不重复派发。
	const targets = new Set(s.gotoCalls.map((call) => `${call.at.x},${call.at.y},${call.at.z}`));
	expect(targets.size).toBe(16);
});

test("a timed-out hop is not dead: next hop retries a cheaper frontier", async () => {
	const state = freshState([flatWorld]);
	state.blockScans = [[], [], [], [{ position: { x: 0, y: 64, z: -48 }, name: "diamond_ore" }]];
	const { invoke, state: s } = makeExplore(state, ["timeout", "ok"]);
	await invoke({ until: { block: "diamond_ore" } } as JsonValue);
	// 首目标 TIMEOUT（记账一次未死）；下一轮因记账惩罚改选下一角，而不是原地重试。
	expect(s.gotoCalls[0]!.at).toEqual({ x: -6, y: 64, z: -6 });
	expect(s.gotoCalls[1]!.at).toEqual({ x: -6, y: 64, z: 26 });
});

test("budget exhausted at entry is TIMEOUT with the coverage so far", async () => {
	const state = freshState([flatWorld]);
	state.blockScans = [[]];
	const { invoke, state: s } = makeExplore(state, []);
	const failure = await failureOf(invoke({ until: { block: "diamond_ore" }, maxTimeMs: 0 } as JsonValue));
	expect(failure).toMatchObject({ code: "TIMEOUT" });
	expect(failure.progress).toMatchObject({ traveled: 0, scanned: 1 });
	expect(s.gotoCalls).toEqual([]);
});

test("a pre-aborted signal surfaces INTERRUPTED with progress", async () => {
	const state = freshState([flatWorld]);
	state.blockScans = [[]];
	const { invoke, controller } = makeExplore(state, []);
	controller.abort();
	const failure = await failureOf(invoke({ until: { block: "diamond_ore" }, maxTimeMs: 1000 } as JsonValue));
	expect(failure).toMatchObject({ code: "INTERRUPTED" });
	expect(failure.progress).toMatchObject({ traveled: 0, scanned: 1 });
});

test("crossing dimensions mid-run is WRONG_STATE, not silent map corruption", async () => {
	const state = freshState([flatWorld]);
	state.blockScans = [[], [], []];
	state.dimensionFlipAfterGoto = 1;
	const { invoke } = makeExplore(state, ["ok"]);
	const failure = await failureOf(invoke({ until: { block: "diamond_ore" } } as JsonValue));
	expect(failure).toMatchObject({ code: "WRONG_STATE" });
});

test("entity hits carry the stable ref; player targets match only player entities", async () => {
	const state = freshState([flatWorld]);
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

	const state2 = freshState([flatWorld]);
	state2.entities = state.entities;
	const { invoke: invoke2 } = makeExplore(state2, []);
	const player = (await invoke2({ until: { player: "Steve" } } as JsonValue)) as unknown as {
		found: Record<string, unknown>;
	};
	expect(player.found).toMatchObject({ kind: "player", name: "Steve", ref: steveRef });
	// 玩家名字匹配到非玩家实体时不算找到（tracked 实体才是位置证据）。
	const state3 = freshState([islandWorld({ x: 10, y: 64, z: 10 })]);
	state3.entities = [{ ...state.entities[0]!, name: "Steve", kind: "passive" }];
	const { invoke: invoke3 } = makeExplore(state3, []);
	const miss = await failureOf(invoke3({ until: { player: "Steve" } } as JsonValue));
	// 站遍有限岛后覆盖穷尽，如实 NOT_FOUND；关键是没有伪命中。
	expect(miss).toMatchObject({ code: "NOT_FOUND" });
});

// 引用确保常量契约不被无声改动（观察盒必须 ≤ region 8192 上限）。
test("observation box fits the region voxel budget", () => {
	const voxels = (OBSERVE_HALF * 2 + 1) ** 2 * (OBSERVE_VERTICAL * 2 + 1);
	expect(voxels).toBe(7623);
	expect(voxels).toBeLessThanOrEqual(8192);
});
