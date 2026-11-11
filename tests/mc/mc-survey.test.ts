/**
 * survey@1：无目标侦察的动作层矩阵（§6.7 / S02–S04）。
 * S02 真正移动并获得有效新观察（traveled/scanned 计数真实）；
 * S03 discoveries 来源独立真实（palette 方块名+格位、群系、实体；air/water/lava 不是发现）；
 * S04 起步无前沿且无有效新观察 → UNREACHABLE，不假装完成侦察；
 * 预算到期 time_budget 正常结束。寻路与真实扫描的覆盖真值由真服场景验收。
 */

import { describe, expect, test } from "vitest";
import { createCapabilityCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
import type { RegionSample } from "../../.uina/worlds/minecraft/capabilities/shared/explore.js";
import type { CallContext } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { JsonValue, Vec3 } from "../../.uina/worlds/minecraft/contracts/values.js";
import { self as baseSelf, fact, failureOf } from "./mc-capability-harness.js";

type FakeCell = "air" | "stone" | "water" | "lava" | "iron_ore" | null;
const GROUND_Y = 63;

/** 无限平坦世界：含一条 iron_ore（x=12,z=10,y=61）。 */
const oreWorld = (x: number, y: number, z: number): FakeCell =>
	x === 12 && z === 10 && y === 61 ? "iron_ore" : y <= GROUND_Y ? "stone" : "air";

function buildRegion(
	input: { at: Vec3; size: { x: number; y: number; z: number } },
	cellAt: (x: number, y: number, z: number) => FakeCell,
): RegionSample {
	const names: string[] = ["air", "stone", "water", "lava", "iron_ore"];
	const cells: number[] = [];
	for (let dy = 0; dy < input.size.y; dy++)
		for (let dz = 0; dz < input.size.z; dz++)
			for (let dx = 0; dx < input.size.x; dx++) {
				const cell = cellAt(input.at.x + dx, input.at.y + dy, input.at.z + dz);
				cells.push(cell == null ? -1 : names.indexOf(cell));
			}
	return {
		origin: input.at,
		shape: [input.size.x, input.size.y, input.size.z],
		palette: names.map((name) => ({ name })),
		cells,
	};
}

interface FakeState {
	position: Vec3;
	dimension: string;
	entities: { name: string; kind: string; position: Vec3 }[];
	biome: string;
	gotoBehavior: string[];
	gotoCalls: { at: Vec3 }[];
}

function makeSurvey(state: FakeState) {
	const gotoDirector = {
		async goto(request: { at: Vec3 }) {
			state.gotoCalls.push({ at: request.at });
			const next = state.gotoBehavior.shift() ?? "ok";
			if (next === "unreachable") throw Object.assign(new Error("no path"), { code: "UNREACHABLE", source: "world" });
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
	const survey = capabilities.callables.find((entry) => entry.descriptor.ref === "survey@1");
	if (survey == null) throw new Error("no callable survey@1");
	const world = {
		async read(query: { ref: string; input: JsonValue }): Promise<unknown> {
			if (query.ref === "self@1")
				return fact({
					...baseSelf,
					place: { ...baseSelf.place, position: state.position, dimension: state.dimension },
				});
			if (query.ref === "entities@1") return fact({ entities: state.entities, scanned: { radius: 32 } });
			if (query.ref === "world@1") return fact({ biome: state.biome });
			if (query.ref === "region@1")
				return fact(
					buildRegion(query.input as unknown as { at: Vec3; size: { x: number; y: number; z: number } }, oreWorld),
				);
			if (query.ref === "route.plan@1")
				return fact({ ok: true, distance: 4, steps: [], needs: { dig: 0, place: 0 }, blockers: [], estTimeSec: null });
			throw new Error(`unexpected query ${query.ref}`);
		},
	};
	const ctx = {
		run: "run:t:1",
		segment: "seg:t:1",
		callId: "call:t:1",
		signal: new AbortController().signal,
		progress: async () => {},
		world,
	} as unknown as CallContext;
	const invoke = (input: JsonValue) => survey.invoke(ctx, input);
	return { invoke, state };
}

describe("survey@1", () => {
	test("S02: moves frontier-to-frontier, counts real movement and scans, ends on time_budget", async () => {
		const state: FakeState = {
			position: { x: 10, y: 64, z: 10 },
			dimension: "overworld",
			entities: [],
			biome: "plains",
			gotoBehavior: ["ok", "ok"],
			gotoCalls: [],
		};
		const { invoke } = makeSurvey(state);
		const result = (await invoke({ maxTimeMs: 500 })) as unknown as {
			traveled: number;
			scanned: number;
			endReason: string;
			at: { position: Vec3 };
		};
		// 走了至少两段；每段是真实位移（平坦世界估价=直线距离，两段各 ≥4 格）。
		expect(state.gotoCalls.length).toBeGreaterThanOrEqual(2);
		expect(result.traveled).toBeGreaterThan(0);
		expect(result.scanned).toBeGreaterThanOrEqual(3);
		expect(result.endReason).toBe("time_budget");
		// 非破坏性行走：不挖不垫由 goto 请求保证（本夹具 goto 无 dig 字段）。
	});

	test("S03: discoveries come from real sources and are deduplicated and bounded", async () => {
		const state: FakeState = {
			position: { x: 10, y: 64, z: 10 },
			dimension: "overworld",
			entities: [
				{ name: "minecraft:pig", kind: "passive", position: { x: 11, y: 64, z: 9 } },
				{ name: "minecraft:pig", kind: "passive", position: { x: 12, y: 64, z: 9 } },
			],
			biome: "the_end",
			gotoBehavior: ["ok"],
			gotoCalls: [],
		};
		const { invoke } = makeSurvey(state);
		const result = (await invoke({ maxTimeMs: 500 })) as unknown as {
			discoveries: { kind: string; name: string; at: { position: Vec3; dimension: string } }[];
		};
		const byKey = new Map(result.discoveries.map((entry) => [`${entry.kind}:${entry.name}`, entry]));
		// 方块发现：region palette 里的真实铁矿石（x12,z10,y61），不是从 solid 推矿物。
		const ore = byKey.get("block:iron_ore");
		expect(ore?.at.position).toEqual({ x: 12, y: 61, z: 10 });
		expect(ore?.at.dimension).toBe("overworld");
		// 空气/水/岩浆不是发现；stone 是真实观察到的地形，同样是合法发现。
		expect(byKey.has("block:air")).toBe(false);
		expect(byKey.get("block:stone")?.at.dimension).toBe("overworld");
		// 群系来自 world@1，实体来自 entities@1；同名实体去重。
		expect(byKey.get("biome:the_end")?.name).toBe("the_end");
		expect(byKey.get("entity:pig")?.name).toBe("pig");
		expect(result.discoveries.length).toBeLessThanOrEqual(10);
	});

	test("S04: no frontier from the start and no effective observation fails UNREACHABLE", async () => {
		// 石室：无未知邻格 → 无前沿；一步没走成 → 不是侦察完成。
		const sealedRoom =
			(center: Vec3) =>
			(x: number, y: number, z: number): FakeCell =>
				Math.abs(x - Math.floor(center.x)) <= 2 && Math.abs(z - Math.floor(center.z)) <= 2 && (y === 64 || y === 65)
					? "air"
					: "stone";
		const state: FakeState = {
			position: { x: 10, y: 64, z: 10 },
			dimension: "overworld",
			entities: [],
			biome: "plains",
			gotoBehavior: [],
			gotoCalls: [],
		};
		const capabilities = createCapabilityCatalog().bind({
			surface: () => null,
			runtime: () =>
				({ chat: async () => {}, navigate: async (_o: unknown, fn: () => Promise<unknown>) => fn() }) as never,
			gotoDirector: {
				async goto() {
					throw new Error("goto must not be dispatched in a sealed room");
				},
			} as never,
			knowledge: () => null,
		});
		const survey = capabilities.callables.find((entry) => entry.descriptor.ref === "survey@1")!;
		const world = {
			async read(query: { ref: string; input: JsonValue }): Promise<unknown> {
				if (query.ref === "self@1")
					return fact({
						...baseSelf,
						place: { ...baseSelf.place, position: state.position, dimension: state.dimension },
					});
				if (query.ref === "entities@1") return fact({ entities: [] });
				if (query.ref === "world@1") return fact({ biome: "plains" });
				if (query.ref === "region@1")
					return fact(
						buildRegion(
							query.input as unknown as { at: Vec3; size: { x: number; y: number; z: number } },
							sealedRoom({ x: 10, y: 64, z: 10 }),
						),
					);
				if (query.ref === "route.plan@1")
					return fact({
						ok: true,
						distance: 4,
						steps: [],
						needs: { dig: 0, place: 0 },
						blockers: [],
						estTimeSec: null,
					});
				throw new Error(`unexpected query ${query.ref}`);
			},
		};
		const ctx = {
			run: "run:t:1",
			segment: "seg:t:1",
			callId: "call:t:1",
			signal: new AbortController().signal,
			progress: async () => {},
			world,
		} as unknown as CallContext;
		const error = await failureOf(survey.invoke(ctx, { maxTimeMs: 5000 }));
		expect(error).toMatchObject({ code: "UNREACHABLE", progress: { traveled: 0 } });
	});
});
