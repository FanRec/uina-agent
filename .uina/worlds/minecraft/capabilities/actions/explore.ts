/**
 * explore@1：基于前沿覆盖的探索——每站读观察盒更新稀疏覆盖图，走向信息增益
 * 最大的可达前沿，命中 until 即停。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md#explore、§2.10。
 * 完成语义：先检查当前覆盖（不入导航资格），再在 navigate 作用域内循环
 * 观察→选前沿→goto→再观察；命中即返回（ref 只在实体命中且跟踪引用仍有效时给，
 * 来自 entities@1 的稳定引用）。失败映射（冻结）：预算耗尽仍有前沿 → TIMEOUT；
 * 已知覆盖内无可达前沿且真实移动过 → NOT_FOUND；从起步就无前沿 → UNREACHABLE；
 * 控制被夺/断线如实上抛；全局取消 → INTERRUPTED。progress 全程保留
 * traveled/scanned，不把目标未找到报告成已完成。复杂组合条件由程序组织多次短
 * 探索，不加表达式 DSL。玩家目标只认 tracked 实体（players 名单属 K6，名字出现
 * 不冒认位置）。单格失败只判死该格（UNREACHABLE 立即；TIMEOUT 与 route.plan
 * 判不可达为软记账，两次判死），不封方向——前沿来自观察事实，不来自方向猜测
 * （01-DESIGN §6）。全部候选被计划判不可达时不派发导航，软记账换一批。
 */

import type { ControlOwner, SelfState } from "../../contracts/body.js";
import type { CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import type { CapabilityDeps } from "../deps.js";
import {
	type Direction,
	estimateRoute,
	LEG_MAX_TIME_MS,
	LEG_TOLERANCE,
	matchesTargetName,
	ObservationMap,
	observeAround as observeAroundBox,
	pickFrontier,
	type RegionSample,
	ROUTE_CHECK_TOP,
	rankFrontiers,
	SCAN_RADIUS,
} from "../shared/explore.js";
import { readValue } from "../shared/observe.js";
import { distance, fail, stripNamespace } from "../shared/targets.js";

const descriptor: CallableDescriptor = {
	ref: "explore@1",
	summary:
		"Walk frontier-to-frontier through observed coverage and scan each stop until the target block/biome/player/entity appears; honest TIMEOUT/NOT_FOUND keep traveled/scanned",
	tags: ["body", "navigation"],
	input: {
		type: "object",
		properties: {
			until: {
				oneOf: [
					{
						type: "object",
						properties: { block: { type: "string", minLength: 1 } },
						required: ["block"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: { biome: { type: "string", minLength: 1 } },
						required: ["biome"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: { player: { type: "string", minLength: 1 } },
						required: ["player"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							entity: {
								oneOf: [
									{ type: "string", minLength: 1 },
									{
										type: "object",
										properties: { kind: { type: "string", enum: ["hostile", "passive"] } },
										required: ["kind"],
										additionalProperties: false,
									},
								],
							},
						},
						required: ["entity"],
						additionalProperties: false,
					},
				],
			},
			direction: {
				type: "string",
				enum: ["n", "e", "s", "w", "any"],
				description: "preferred direction (default any)",
			},
			maxTimeMs: {
				type: "number",
				minimum: 1000,
				maximum: 600000,
				description: "wall-clock budget (default 180000)",
			},
		},
		required: ["until"],
		additionalProperties: false,
	},
	output: { type: "object" },
	access: "act",
	completion: {
		scope: "capability",
		description: "hit returns the find with its position; NOT_FOUND/TIMEOUT carry traveled/scanned in progress",
	},
	errors: [
		{
			code: "TIMEOUT",
			meaning: "budget exhausted while reachable frontiers remain (progress keeps traveled/scanned)",
		},
		{
			code: "NOT_FOUND",
			meaning: "no reachable frontier remains within observed coverage (progress keeps traveled/scanned)",
		},
		{
			code: "UNREACHABLE",
			meaning: "no frontier exists from the starting position at all (progress keeps traveled/scanned)",
		},
		{ code: "INTERRUPTED", meaning: "the run was stopped mid-exploration (progress keeps traveled/scanned)" },
		{ code: "CONTROL_CONFLICT", meaning: "another controlled navigation holds the client" },
		{ code: "DISCONNECTED", meaning: "the connection ended during exploration" },
		{ code: "INVALID_INPUT", meaning: "until does not select exactly one target kind, or budget out of range" },
	],
	requires: ["connection"],
	examples: [
		{
			input: { until: { block: "diamond_ore" }, maxTimeMs: 60000 },
			output: {
				found: {
					kind: "block",
					at: { position: { x: 130, y: 12, z: -44 }, dimension: "overworld" },
					name: "diamond_ore",
				},
				traveled: 48,
				scanned: 3,
			},
		},
	],
	implementation: "native",
};

interface ExploreInput {
	until: { block?: string; biome?: string; player?: string; entity?: string | { kind: "hostile" | "passive" } };
	direction?: Direction;
	maxTimeMs?: number;
}

interface ExploreFound {
	kind: "block" | "biome" | "player" | "entity";
	at: { position: Vec3; dimension: string };
	name: string;
	ref?: unknown;
}

/** 扫描当前覆盖（blocks 按名搜 / world 群系 / tracked 实体）；命中构造 Found，未命中 null。 */
async function scanCurrent(
	ctx: CallContext,
	until: ExploreInput["until"],
	self: SelfState,
): Promise<ExploreFound | null> {
	if (until.block != null) {
		const value = await readValue<{ blocks: { position: Vec3; name: string }[] }>(
			ctx.world,
			"blocks@1",
			{ name: stripNamespace(until.block), radius: SCAN_RADIUS, limit: 1 },
			ctx.signal,
			"block scan",
		);
		const hit = value.blocks[0];
		if (hit == null) return null;
		return {
			kind: "block",
			at: { position: hit.position, dimension: self.place.dimension },
			name: stripNamespace(hit.name),
		};
	}
	if (until.biome != null) {
		const value = await readValue<{ biome: string | null }>(ctx.world, "world@1", {}, ctx.signal, "world facts");
		if (value.biome == null || !matchesTargetName(value.biome, until.biome)) return null;
		return {
			kind: "biome",
			at: { position: self.place.position, dimension: self.place.dimension },
			name: stripNamespace(value.biome),
		};
	}
	const kind =
		until.player != null
			? "player"
			: typeof until.entity === "object" && until.entity != null
				? until.entity.kind
				: "all";
	const value = await readValue<{ entities: { ref?: unknown; name: string; kind: string; position: Vec3 }[] }>(
		ctx.world,
		"entities@1",
		{ radius: SCAN_RADIUS, kind, limit: 128 },
		ctx.signal,
		"entity scan",
	);
	for (const entity of value.entities) {
		const wantedName = until.player ?? (typeof until.entity === "string" ? until.entity : null);
		if (wantedName != null && !matchesTargetName(entity.name, wantedName)) continue;
		if (until.player != null && entity.kind !== "player") continue;
		return {
			kind: until.player != null ? "player" : "entity",
			at: { position: entity.position, dimension: self.place.dimension },
			name: stripNamespace(entity.name),
			ref: entity.ref,
		};
	}
	return null;
}

/** 每站观察盒：以脚底格为原点的体素读，更新稀疏覆盖图（与 survey 同源的共享步骤）。 */
function observeAround(ctx: CallContext, self: SelfState): Promise<RegionSample> {
	return observeAroundBox(ctx.world, self);
}

function interrupted(traveled: number, scanned: number): never {
	fail("INTERRUPTED", "explore was interrupted by run stop", {
		dispatch: "sent",
		progress: { traveled, scanned },
		recoverable: true,
	});
}

export const exploreModule: MinecraftCapabilityModule = {
	id: "explore",
	definitions: [
		{
			kind: "action",
			descriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as ExploreInput;
					const until = raw.until;
					const maxTimeMs = raw.maxTimeMs ?? 180000;
					const deadline = Date.now() + maxTimeMs;
					const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
					let traveled = 0;
					let scanned = 1;
					let previous = self.place.position;
					const initial = await scanCurrent(ctx, until, self);
					if (initial != null) return plain({ found: initial, traveled: 0, scanned: 1 });
					const map = new ObservationMap(self.place.dimension);
					const owner: ControlOwner = { kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId };
					// 上一轮观察的整数格位置：原地迭代（软记账换批）不重复观察/扫描。
					let lastObservedCell: string | null = null;
					const cellOf = (at: Vec3): string => `${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}`;
					const outcome = await deps.runtime().navigate(owner, async (): Promise<ExploreFound> => {
						for (;;) {
							if (ctx.signal.aborted) interrupted(traveled, scanned);
							const remaining = deadline - Date.now();
							if (remaining <= 0) {
								fail("TIMEOUT", "explore budget exhausted with reachable frontiers remaining", {
									dispatch: "sent",
									progress: { traveled, scanned },
									recoverable: true,
								});
							}
							const here = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
							if (here.place.dimension !== map.dimension) {
								fail(
									"WRONG_STATE",
									`explore crossed into ${here.place.dimension} mid-run (map covers ${map.dimension})`,
									{
										dispatch: "sent",
										progress: { traveled, scanned },
										recoverable: true,
									},
								);
							}
							// 观察 → 扫描 → 选前沿 → 走；失败段只判死该格，其余前沿照常参选。
							// 原地软记账迭代（位置未变）不重复观察/扫描—— region 入图与
							// until 扫描在原地没有新信息，直到 bot 真的动了再做。
							map.markVisited(here.place.position);
							const cell = cellOf(here.place.position);
							if (cell !== lastObservedCell) {
								lastObservedCell = cell;
								map.ingest(await observeAround(ctx, here));
								scanned += 1;
								const hit = await scanCurrent(ctx, until, here);
								await ctx.progress({ traveled: Math.round(traveled * 100) / 100, scanned });
								if (hit != null) return hit;
							}
							const ranked = rankFrontiers(here.place.position, map.frontiers(), map, raw.direction ?? "any");
							if (ranked.length === 0) {
								// 失败映射（capabilities.md 冻结）：一步都没走成 = 起步无前沿 UNREACHABLE；
								// 真实移动过之后覆盖穷尽 = NOT_FOUND。progress 都保留 traveled/scanned。
								if (traveled <= 0) {
									fail(
										"UNREACHABLE",
										`no reachable frontier within observed coverage from the start (${scanned} scans)`,
										{
											dispatch: "sent",
											progress: { traveled, scanned },
											recoverable: true,
										},
									);
								}
								fail("NOT_FOUND", `no reachable frontier remains within observed coverage after ${scanned} scans`, {
									dispatch: "sent",
									progress: { traveled, scanned },
									recoverable: true,
								});
							}
							const top = ranked.slice(0, ROUTE_CHECK_TOP);
							const estimates: (number | "unreachable" | null)[] = [];
							for (const candidate of top) {
								estimates.push(await estimateRoute(ctx.world, candidate.at));
							}
							const target = pickFrontier(top, estimates);
							if (target == null) {
								// top-K 全部被 route.plan 判不可达：软记账后换一批，不向已知
								// 不可达处派发导航（两次记账判死，见 markFailed）。
								for (let i = 0; i < top.length; i++) {
									if (estimates[i] === "unreachable") map.markFailed(top[i]!.at, "plan");
								}
								continue;
							}
							try {
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
								if (ctx.signal.aborted) interrupted(traveled, scanned);
								const code = (err as { code?: string }).code;
								// 单格记账：UNREACHABLE 立即判死，段超时两次判死；控制/连接/内部
								// 失败不是覆盖信息，如实上抛。
								if (code === "UNREACHABLE") map.markFailed(target, "unreachable");
								else if (code === "TIMEOUT") map.markFailed(target, "timeout");
								else throw err;
							}
							const stop = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
							traveled += distance(previous, stop.place.position);
							previous = stop.place.position;
						}
					});
					return plain({ found: outcome, traveled: Math.round(traveled * 100) / 100, scanned });
				},
		},
	],
};
