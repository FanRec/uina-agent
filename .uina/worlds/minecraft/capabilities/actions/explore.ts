/**
 * explore@1：朝未访问过的方向逐段走、每站扫描，命中 until 即停。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md#explore、§2.10。
 * 完成语义：先检查当前覆盖，再逐段移动+扫描；命中即返回（ref 只在实体命中且
 * 跟踪引用仍有效时给，来自 entities@1 的稳定引用）。失败映射（冻结）：
 * 预算耗尽仍有方向 → TIMEOUT；可达空间穷尽 → NOT_FOUND；起步不可达/控制被夺/
 * 断线 → 如实上抛；全局取消 → INTERRUPTED。progress 全程保留 traveled/scanned，
 * 不把目标未找到报告成已完成。复杂组合条件由程序组织多次短探索，不加表达式 DSL。
 * 玩家目标只认 tracked 实体（players 名单属 K6，名字出现不冒认位置）。
 */

import type { ControlOwner, SelfState } from "../../contracts/body.js";
import type { CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import type { CapabilityDeps } from "../deps.js";
import {
	type Direction,
	ExploreCursor,
	LEG_MAX_TIME_MS,
	LEG_TOLERANCE,
	matchesTargetName,
	SCAN_RADIUS,
} from "../shared/explore.js";
import { readValue } from "../shared/observe.js";
import { distance, fail, stripNamespace } from "../shared/targets.js";

const descriptor: CallableDescriptor = {
	ref: "explore@1",
	summary:
		"Walk outward through unvisited directions and scan each stop until the target block/biome/player/entity appears; honest TIMEOUT/NOT_FOUND keep traveled/scanned",
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
			direction: { type: "string", enum: ["n", "e", "s", "w", "any"], description: "primary direction (default any)" },
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
			meaning: "budget exhausted while unvisited directions remain (progress keeps traveled/scanned)",
		},
		{ code: "NOT_FOUND", meaning: "reachable exploration space is exhausted without a hit" },
		{ code: "UNREACHABLE", meaning: "no walkable direction exists at all (progress keeps traveled/scanned)" },
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
				value: {
					found: {
						kind: "block",
						at: { position: { x: 130, y: 12, z: -44 }, dimension: "overworld" },
						name: "diamond_ore",
					},
					traveled: 48,
					scanned: 3,
				},
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
					const cursor = new ExploreCursor(raw.direction ?? "any");
					const owner: ControlOwner = { kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId };
					const outcome = await deps.runtime().navigate(owner, async (): Promise<ExploreFound> => {
						for (;;) {
							if (ctx.signal.aborted) interrupted(traveled, scanned);
							const remaining = deadline - Date.now();
							if (remaining <= 0) {
								fail("TIMEOUT", "explore budget exhausted while unvisited directions remain", {
									dispatch: "sent",
									progress: { traveled, scanned },
									recoverable: true,
								});
							}
							const here = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
							const leg = cursor.nextLeg(here.place.position);
							if (leg == null) {
								// 失败映射（capabilities.md 冻结）：一步都没走成 = 起步不可达 UNREACHABLE；
								// 真实移动过之后空间穷尽 = NOT_FOUND。progress 都保留 traveled/scanned。
								if (traveled <= 0) {
									fail("UNREACHABLE", `no walkable direction exists from the starting position (${scanned} scans)`, {
										dispatch: "sent",
										progress: { traveled, scanned },
										recoverable: true,
									});
								}
								fail("NOT_FOUND", `no unvisited walkable direction remains after ${scanned} scans`, {
									dispatch: "sent",
									progress: { traveled, scanned },
									recoverable: true,
								});
							}
							try {
								await deps.gotoDirector.goto(
									{
										at: leg.at,
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
								// 方向性失败：UNREACHABLE 标死该方向；段超时换向续跑（预算由外层统一结算）。
								// 控制/连接/内部失败不是方向信息，如实上抛。
								if (code === "UNREACHABLE") cursor.markDead(leg.direction);
								else if (code !== "TIMEOUT") throw err;
							}
							const stop = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
							traveled += distance(previous, stop.place.position);
							previous = stop.place.position;
							cursor.markVisited(stop.place.position);
							scanned += 1;
							await ctx.progress({ traveled: Math.round(traveled * 100) / 100, scanned });
							const hit = await scanCurrent(ctx, until, stop);
							if (hit != null) return hit;
						}
					});
					return plain({ found: outcome, traveled: Math.round(traveled * 100) / 100, scanned });
				},
		},
	],
};
