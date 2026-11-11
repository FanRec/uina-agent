/**
 * survey@1：无目标的自由侦察——在预算内扩大真实见闻，不找特定目标。
 *
 * 唯一定义来源：《Uina Minecraft World 实施规格》§6.7；会话机制与 explore@1 同源
 * （shared/explore.ts 的 ObservationMap / rankFrontiers / pickFrontier /
 * estimateRoute / observeAround），不复制 Pathfinder，不建第二世界数据库。
 * 见闻来源各自真实：方块发现取 region palette 的真实名字与格位（air/water/lava
 * 不算发现，solid 不推矿物）；群系取 world@1；实体取 entities@1。
 * endReason：预算到期 time_budget；覆盖内无前沿 no_frontier。两者都是正常结束，
 * 但诚实区分：一步没走成且没有有效新观察时按 UNREACHABLE 失败，不假装完成侦察。
 */

import type { ControlOwner, SelfState } from "../../contracts/body.js";
import type { CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import type { CapabilityDeps } from "../deps.js";
import {
	estimateRoute,
	LEG_MAX_TIME_MS,
	LEG_TOLERANCE,
	ObservationMap,
	observeAround as observeAroundBox,
	pickFrontier,
	type RegionSample,
	ROUTE_CHECK_TOP,
	rankFrontiers,
} from "../shared/explore.js";
import { readValue } from "../shared/observe.js";
import { distance, fail, stripNamespace } from "../shared/targets.js";

const descriptor: CallableDescriptor = {
	ref: "survey@1",
	summary:
		"Frontier-to-frontier free scouting within a budget: real movement, real new observations, honest discoveries (blocks from the region palette, biome from world facts, entities from live scans)",
	tags: ["body", "navigation"],
	input: {
		type: "object",
		properties: {
			direction: {
				type: "string",
				enum: ["n", "e", "s", "w", "any"],
				description: "preferred direction (default any; a preference, not a boundary)",
			},
			maxTimeMs: {
				type: "number",
				minimum: 1000,
				maximum: 300000,
				description: "wall-clock budget (default 90000)",
			},
		},
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			at: { type: "object" },
			traveled: { type: "number" },
			scanned: { type: "integer" },
			endReason: { type: "string", enum: ["time_budget", "no_frontier"] },
			discoveries: {
				type: "array",
				items: {
					type: "object",
					properties: {
						kind: { type: "string", enum: ["block", "biome", "entity"] },
						name: { type: "string" },
						at: { type: "object" },
					},
					required: ["kind", "name", "at"],
					additionalProperties: false,
				},
			},
		},
		required: ["at", "traveled", "scanned", "endReason", "discoveries"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"normal ends are time_budget or no_frontier with real traveled/scanned counts and real discoveries; a survey that could neither move nor observe anything new fails UNREACHABLE instead of pretending success",
	},
	errors: [
		{
			code: "UNREACHABLE",
			meaning: "no frontier exists in observed coverage and no effective new observation was made (no survey happened)",
		},
		{
			code: "WRONG_STATE",
			meaning: "the survey crossed into another dimension mid-run (the coverage map covers one dimension)",
		},
		{ code: "INTERRUPTED", meaning: "the run was stopped mid-survey (progress keeps traveled/scanned)" },
		{ code: "CONTROL_CONFLICT", meaning: "another controlled navigation holds the client" },
		{ code: "DISCONNECTED", meaning: "the connection ended during the survey" },
	],
	requires: ["connection"],
	examples: [
		{
			input: { direction: "n", maxTimeMs: 60000 },
			output: {
				at: { position: { x: 12, y: 64, z: -31 }, dimension: "overworld" },
				traveled: 40.5,
				scanned: 3,
				endReason: "time_budget",
				discoveries: [
					{ kind: "block", name: "iron_ore", at: { position: { x: 9, y: 61, z: -28 }, dimension: "overworld" } },
				],
			},
		},
	],
	implementation: "native",
};

const DEFAULT_MAX_TIME_MS = 90000;
/** 发现列表上限（§6.7 有界；去重后按 kind+name 记新）。 */
const DISCOVERY_LIMIT = 10;

interface SurveyDiscovery {
	kind: "block" | "biome" | "entity";
	name: string;
	at: { position: Vec3; dimension: string };
}

/** 从 region 切片提取本站真实方块发现：palette 名字 + 实际格位，排除空气/水/岩浆。 */
function blockDiscoveries(sample: RegionSample, dimension: string): SurveyDiscovery[] {
	const out: SurveyDiscovery[] = [];
	const [nx, , nz] = sample.shape;
	for (let index = 0; index < sample.palette.length; index++) {
		const name = stripNamespace(sample.palette[index]!.name);
		if (name === "air" || name === "water" || name === "lava" || name === "cave_air" || name === "void_air") continue;
		// 该名字在切片里的第一个真实格位（palette 是名字→索引，cells 反查首格）。
		let at: Vec3 | null = null;
		for (let i = 0; i < sample.cells.length; i++) {
			if (sample.cells[i] !== index) continue;
			const dy = Math.floor(i / (nx * nz));
			const rem = i - dy * nx * nz;
			const dz = Math.floor(rem / nx);
			const dx = rem - dz * nx;
			at = { x: sample.origin.x + dx, y: sample.origin.y + dy, z: sample.origin.z + dz };
			break;
		}
		if (at != null) out.push({ kind: "block", name, at: { position: at, dimension } });
	}
	return out;
}

export const surveyModule: MinecraftCapabilityModule = {
	id: "survey",
	definitions: [
		{
			kind: "action",
			descriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as { direction?: "n" | "e" | "s" | "w" | "any"; maxTimeMs?: number };
					const deadline = Date.now() + (raw.maxTimeMs ?? DEFAULT_MAX_TIME_MS);
					const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
					const map = new ObservationMap(self.place.dimension);
					const start = self.place.position;
					let traveled = 0;
					let scanned = 0;
					let previous = start;
					let endReason: "time_budget" | "no_frontier" = "time_budget";
					const discoveries: SurveyDiscovery[] = [];
					const seenDiscovery = new Set<string>();
					const recordDiscovery = (items: SurveyDiscovery[]): void => {
						for (const item of items) {
							const key = `${item.kind}:${item.name}`;
							if (seenDiscovery.has(key) || discoveries.length >= DISCOVERY_LIMIT) continue;
							seenDiscovery.add(key);
							discoveries.push(item);
						}
					};
					const owner: ControlOwner = { kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId };
					let lastObservedCell: string | null = null;
					const cellOf = (at: Vec3): string => `${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}`;
					const failureProgress = (): { traveled: number; scanned: number } => ({
						traveled: Math.round(traveled * 100) / 100,
						scanned,
					});
					const final = await deps.runtime().navigate(owner, async (): Promise<SelfState> => {
						for (;;) {
							if (ctx.signal.aborted) {
								fail("INTERRUPTED", "survey was interrupted by run stop or safety", {
									dispatch: "sent",
									progress: failureProgress(),
									recoverable: true,
								});
							}
							const remaining = deadline - Date.now();
							if (remaining <= 0) {
								endReason = "time_budget";
								return await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
							}
							const here = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
							if (here.place.dimension !== map.dimension) {
								// 与 explore@1 同口径：覆盖图只属于一个维度，穿越即状态不再可判。
								fail(
									"WRONG_STATE",
									`survey crossed into ${here.place.dimension} mid-run (coverage map covers ${map.dimension})`,
									{
										dispatch: "sent",
										progress: failureProgress(),
										recoverable: true,
									},
								);
							}
							map.markVisited(here.place.position);
							const cell = cellOf(here.place.position);
							if (cell !== lastObservedCell) {
								lastObservedCell = cell;
								const sample = await observeAroundBox(ctx.world, here);
								map.ingest(sample);
								scanned += 1;
								recordDiscovery(blockDiscoveries(sample, here.place.dimension));
								const world = await readValue<{ biome: string | null }>(
									ctx.world,
									"world@1",
									{},
									ctx.signal,
									"world facts",
								);
								if (world.biome != null) {
									recordDiscovery([
										{
											kind: "biome",
											name: stripNamespace(world.biome),
											at: { position: here.place.position, dimension: here.place.dimension },
										},
									]);
								}
								const entities = await readValue<{ entities: { name: string; position: Vec3 }[] }>(
									ctx.world,
									"entities@1",
									{ radius: 32, kind: "all", limit: 64 },
									ctx.signal,
									"entity scan",
								);
								recordDiscovery(
									entities.entities.slice(0, 4).map((entity) => ({
										kind: "entity" as const,
										name: stripNamespace(entity.name),
										at: { position: entity.position, dimension: here.place.dimension },
									})),
								);
								await ctx.progress({
									traveled: Math.round(traveled * 100) / 100,
									scanned,
									discovered: discoveries.length,
								});
							}
							const ranked = rankFrontiers(here.place.position, map.frontiers(), map, raw.direction ?? "any");
							if (ranked.length === 0) {
								endReason = "no_frontier";
								// §6.7：一步没走成且没有任何有效新观察——这不是侦察完成，如实失败。
								if (traveled <= 0 && scanned <= 1) {
									fail(
										"UNREACHABLE",
										`no frontier within observed coverage from the start (${scanned} scan, no movement); there is nothing to survey`,
										{
											dispatch: "sent",
											progress: failureProgress(),
											recoverable: true,
										},
									);
								}
								return here;
							}
							const top = ranked.slice(0, ROUTE_CHECK_TOP);
							const estimates: (number | "unreachable" | null)[] = [];
							for (const candidate of top) {
								estimates.push(await estimateRoute(ctx.world, candidate.at));
							}
							const target = pickFrontier(top, estimates);
							if (target == null) {
								for (let i = 0; i < top.length; i++) {
									if (estimates[i] === "unreachable") map.markFailed(top[i]!.at, "plan");
								}
								continue;
							}
							try {
								// 非破坏性行走：不挖、不垫（§6.7）。
								await deps.gotoDirector.goto(
									{
										at: target,
										tolerance: LEG_TOLERANCE,
										sprint: true,
										digThrough: false,
										placeToReach: false,
										timeoutMs: Math.min(LEG_MAX_TIME_MS, remaining),
									},
									ctx.signal,
								);
							} catch (err) {
								if (ctx.signal.aborted) {
									fail("INTERRUPTED", "survey was interrupted by run stop or safety", {
										dispatch: "sent",
										progress: failureProgress(),
										recoverable: true,
									});
								}
								const code = (err as { code?: string }).code;
								if (code === "UNREACHABLE") map.markFailed(target, "unreachable");
								else if (code === "TIMEOUT") map.markFailed(target, "timeout");
								else throw err;
							}
							const stop = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
							traveled += distance(previous, stop.place.position);
							previous = stop.place.position;
						}
					});
					return plain({
						at: { position: final.place.position, dimension: final.place.dimension },
						traveled: Math.round(traveled * 100) / 100,
						scanned,
						endReason,
						discoveries,
					});
				},
		},
	],
};
