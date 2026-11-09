/**
 * goto@1：当前维度内受控寻路。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 goto、driver §7.2。
 * 能力层只做目标换算与默认值；寻路、停止、写入资格都归 Driver/Runtime。
 * 返回 dug 是实测挖掘次数；placed 无法归属到本次导航，如实 null。
 *
 * follow@1/flee@1（批 12，§4 follow/flee）：会话型移动，单一 navigate 作用域包多段
 * goto（explore 同模式）。会话正常结束用明确 ended/返回值（target_lost/timeout、
 * safe+distance）；stop/安全介入抛 INTERRUPTED 并保留已发生位移。段失败不是会话失败：
 * follow 段超时/不可达继续重试，flee 段不可达换方位。实体寻址按 §11.4：名字只在
 * 当前跟踪范围解析，多候选 INVALID_INPUT 给候选，不自动等待离线玩家。
 */

import type { ControlOwner, EntityRef, SelfState } from "../../contracts/body.js";
import type { CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { JsonValue } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import type { CapabilityDeps } from "../deps.js";
import {
	FLEE_BEARING_OFFSETS,
	FLEE_LEG_STEP,
	FLEE_LEG_TIMEOUT_MS,
	FLEE_SCAN_RADIUS,
	FOLLOW_IDLE_MS,
	FOLLOW_LEG_TIMEOUT_MS,
	FOLLOW_LOST_SCANS,
	FOLLOW_SCAN_RADIUS,
	fleeLegTarget,
	matchFollowTarget,
	sleepAbortable,
} from "../shared/mobility.js";
import { readValue } from "../shared/observe.js";
import { POS_SCHEMA } from "../shared/schema.js";
import { distance, fail, resolvePoint } from "../shared/targets.js";
import { type EntityEntryView } from "../shared/views.js";

const descriptor: CallableDescriptor = {
	ref: "goto@1",
	summary:
		"Walk to a position inside the current dimension (controlled exclusive navigation; mutually exclusive with body qualifications)",
	tags: ["body", "navigation"],
	input: {
		type: "object",
		properties: {
			at: POS_SCHEMA,
			tolerance: { type: "integer", minimum: 1, maximum: 8, description: "GoalNear radius in blocks (default 2)" },
			digThrough: { type: "boolean", description: "allow digging through obstacles (default false)" },
			placeToReach: {
				type: "boolean",
				description: "allow placing blocks to reach (default false; ordinary navigation must not modify terrain)",
			},
			sprint: { type: "boolean", description: "allow sprinting (default true)" },
			maxTimeMs: { type: "number", minimum: 1000, maximum: 600000, description: "wall-clock budget (default 120000)" },
		},
		required: ["at"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			at: { type: "object" },
			distance: { type: "number" },
			ticks: { type: "integer", minimum: 0 },
			dug: { type: "integer", minimum: 0 },
			placed: { type: ["integer", "null"], minimum: 0 },
		},
		required: ["at", "distance", "ticks", "dug"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "execution",
		description: "GoalNear proximity satisfied; standing-posture verification belongs to later capability work",
	},
	errors: [
		{ code: "UNREACHABLE", meaning: "pathfinder found no path or could not plan within its think budget" },
		{ code: "WRONG_STATE", meaning: "the target is in another dimension (portals are transit@1 work)" },
		{ code: "TIMEOUT", meaning: "wall-clock budget exhausted before arrival" },
		{ code: "CONTROL_CONFLICT", meaning: "a body qualification or another navigation holds the client" },
		{ code: "INTERRUPTED", meaning: "the run was stopped before arrival" },
		{ code: "DISCONNECTED", meaning: "the connection ended during navigation" },
		{ code: "INVALID_INPUT", meaning: "non-finite target, or tolerance/timeout out of range" },
	],
	requires: ["connection"],
	examples: [
		{
			input: { at: { x: 8, y: 64, z: 0 }, tolerance: 2 },
			output: { at: { x: 7.5, y: 64, z: 0 }, distance: 0.5, ticks: 24, dug: 0 },
		},
	],
	implementation: "native",
};

interface GotoInput {
	at: unknown;
	tolerance?: number;
	digThrough?: boolean;
	placeToReach?: boolean;
	sprint?: boolean;
	maxTimeMs?: number;
}

// ---- follow@1 / flee@1 共用 ----

interface EntitiesValue {
	entities: EntityEntryView[];
	scanned: { radius: number };
}

export async function scanEntities(
	ctx: CallContext,
	radius: number,
	kind: "all" | "hostile" = "all",
): Promise<EntityEntryView[]> {
	const value = await readValue<EntitiesValue>(
		ctx.world,
		"entities@1",
		{ radius, kind, limit: 128 },
		ctx.signal,
		"entity scan",
	);
	return value.entities;
}

/** 会话被 stop/安全介入打断：进度保留已发生位移。 */
function sessionInterrupted(what: string, progress: Record<string, unknown>): never {
	fail("INTERRUPTED", `${what} session was interrupted by run stop or safety`, {
		dispatch: "sent",
		progress,
		recoverable: true,
	});
}

function ambiguousFailure(selector: string, candidates: EntityEntryView[]): never {
	const names = [...new Set(candidates.map((entity) => entity.name))].join(", ");
	fail("INVALID_INPUT", `name ${selector} matches several distinct entity names: ${names}`, {
		hint: "pass the exact name or an EntityRef from entities@1",
	});
}

// ---- follow@1 ----

const followDescriptor: CallableDescriptor = {
	ref: "follow@1",
	summary:
		"Keep following a tracked entity and stop at `distance` when it stops; session ends honestly with target_lost/timeout",
	tags: ["body", "navigation"],
	input: {
		type: "object",
		properties: {
			target: { oneOf: [{ type: "string", minLength: 1 }, { type: "object" }] },
			distance: {
				type: "integer",
				minimum: 2,
				maximum: 8,
				description: "keep this many blocks from the target while it stands (default 3)",
			},
			maxTimeMs: { type: "number", minimum: 1000, maximum: 600000, description: "wall-clock budget (default 120000)" },
		},
		required: ["target"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			target: {
				type: "object",
				properties: { name: { type: "string" } },
				required: ["name"],
				additionalProperties: false,
			},
			moved: { type: "boolean" },
			ended: { type: "string", enum: ["target_lost", "timeout"] },
			at: { type: "object" },
		},
		required: ["target", "moved", "ended", "at"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"Session end is explicit: target_lost after repeated loss of tracking, timeout at budget end; neither claims arrival. stop/safety raises INTERRUPTED with moved progress",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "no tracked entity matches the name within the scan radius at session start" },
		{ code: "INVALID_INPUT", meaning: "the name matches several distinct entity names (candidates in the message)" },
		{ code: "REFERENCE_STALE", meaning: "the entity reference is not tracked at session start" },
		{ code: "INTERRUPTED", meaning: "the run was stopped or safety took over mid-session (progress keeps moved)" },
		{ code: "CONTROL_CONFLICT", meaning: "another controlled navigation holds the client" },
		{ code: "DISCONNECTED", meaning: "the connection ended during the session" },
	],
	requires: ["connection"],
	examples: [
		{
			input: { target: "cow", distance: 3 },
			output: {
				target: { name: "cow" },
				moved: true,
				ended: "target_lost",
				at: { position: { x: 10, y: 64, z: 2 }, dimension: "overworld" },
			},
		},
	],
	implementation: "native",
};

interface FollowInput {
	target: string | EntityRef;
	distance?: number;
	maxTimeMs?: number;
}

// ---- flee@1 ----

const fleeDescriptor: CallableDescriptor = {
	ref: "flee@1",
	summary: "Move away from a threat until the declared distance is reached; nearest hostile is the default threat",
	tags: ["body", "navigation"],
	input: {
		type: "object",
		properties: {
			from: { oneOf: [{ type: "string", minLength: 1 }, { type: "object" }] },
			distance: {
				type: "number",
				minimum: 16,
				maximum: 64,
				description: "reach this gap from the threat (default 24)",
			},
			maxTimeMs: { type: "number", minimum: 1000, maximum: 600000, description: "wall-clock budget (default 30000)" },
		},
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			moved: { type: "boolean" },
			distance: { type: "number" },
			safe: { type: "boolean" },
		},
		required: ["moved", "distance", "safe"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"safe=true means the verified gap reached `distance`; a threat lost mid-flight reports the last known gap without claiming a farther escape",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "no threat found (no `from` match, or no hostile within the scan radius)" },
		{ code: "INVALID_INPUT", meaning: "the `from` name matches several distinct entity names" },
		{ code: "UNREACHABLE", meaning: "every escape bearing is blocked (progress keeps moved)" },
		{ code: "TIMEOUT", meaning: "budget exhausted before the declared distance (progress keeps moved/distance)" },
		{ code: "INTERRUPTED", meaning: "the run was stopped or safety took over mid-session (progress keeps moved)" },
		{ code: "CONTROL_CONFLICT", meaning: "another controlled navigation holds the client" },
		{ code: "DISCONNECTED", meaning: "the connection ended during the session" },
	],
	requires: ["connection"],
	examples: [
		{
			input: { from: "zombie", distance: 24 },
			output: { moved: true, distance: 24.5, safe: true },
		},
	],
	implementation: "native",
};

interface FleeInput {
	from?: string | EntityRef;
	distance?: number;
	maxTimeMs?: number;
}

export const navigationModule: MinecraftCapabilityModule = {
	id: "navigation",
	definitions: [
		{
			kind: "action",
			descriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as GotoInput;
					const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
					const target = resolvePoint(raw.at, self);
					if (target.dimension !== self.place.dimension) {
						fail("WRONG_STATE", `target is in ${target.dimension}, current dimension is ${self.place.dimension}`, {
							hint: "goto stays inside the current dimension; transit@1 will handle portals",
						});
					}
					const owner: ControlOwner = { kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId };
					const outcome = await deps.runtime().navigate(owner, () =>
						deps.gotoDirector.goto(
							{
								at: target.position,
								tolerance: raw.tolerance ?? 2,
								sprint: raw.sprint ?? true,
								digThrough: raw.digThrough ?? false,
								// 普通导航不改世界；攀爬/搭桥类任务由调用方显式授权施工。
								placeToReach: raw.placeToReach ?? false,
								timeoutMs: raw.maxTimeMs ?? 120000,
							},
							ctx.signal,
						),
					);
					return plain({
						at: outcome.at,
						distance: Math.round(distance(outcome.at, target.position) * 100) / 100,
						ticks: outcome.ticks,
						dug: outcome.dug,
						placed: outcome.placed,
					});
				},
		},
		{
			kind: "action",
			descriptor: followDescriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as FollowInput;
					const keep = raw.distance ?? 3;
					const deadline = Date.now() + (raw.maxTimeMs ?? 120000);
					// 起点必须在跟踪范围内解析（§11.4：不自动等待离线玩家）。
					const initial = await matchFollowTarget(await scanEntities(ctx, FOLLOW_SCAN_RADIUS), raw.target);
					if (initial === null) {
						if (typeof raw.target === "string") {
							fail(
								"NOT_FOUND",
								`no tracked entity named ${raw.target.replace(/^minecraft:/, "")} within ${FOLLOW_SCAN_RADIUS} blocks`,
								{
									hint: "read entities@1 first; listing is not proof of absence beyond the radius",
								},
							);
						}
						fail(
							"REFERENCE_STALE",
							`entity ${raw.target.networkId} is not tracked within ${FOLLOW_SCAN_RADIUS} blocks`,
							{
								hint: "re-read entities@1; out of range is not proof of absence",
								recoverable: false,
							},
						);
					}
					if ("ambiguous" in initial) ambiguousFailure(String(raw.target), initial.ambiguous);
					const owner: ControlOwner = { kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId };
					const start = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
					// 起点取值快照：后续读数可能复用同一可变事实对象，比较必须对值。
					const startPosition = { ...start.place.position };
					let moved = false;
					let lastSelf = start;
					const ended = await deps.runtime().navigate(owner, async (): Promise<"target_lost" | "timeout"> => {
						let lost = 0;
						for (;;) {
							if (ctx.signal.aborted) sessionInterrupted("follow", { moved });
							if (Date.now() >= deadline) return "timeout";
							const match = matchFollowTarget(await scanEntities(ctx, FOLLOW_SCAN_RADIUS), raw.target);
							if (match === null) {
								lost += 1;
								if (lost >= FOLLOW_LOST_SCANS) return "target_lost";
							} else if ("ambiguous" in match) {
								ambiguousFailure(String(raw.target), match.ambiguous);
							} else {
								lost = 0;
								const gap = distance(lastSelf.place.position, match.found.position);
								if (gap > keep) {
									try {
										await deps.gotoDirector.goto(
											{
												at: match.found.position,
												tolerance: keep,
												sprint: true,
												digThrough: false,
												placeToReach: false,
												timeoutMs: Math.min(FOLLOW_LEG_TIMEOUT_MS, deadline - Date.now()),
											},
											ctx.signal,
										);
									} catch (error) {
										if (ctx.signal.aborted) sessionInterrupted("follow", { moved });
										const code = (error as { code?: string }).code;
										// 段失败不是会话失败：目标仍在跟踪范围，下一轮重新瞄准。
										if (code !== "TIMEOUT" && code !== "UNREACHABLE") throw error;
									}
								}
							}
							lastSelf = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
							if (distance(startPosition, lastSelf.place.position) > 0.75) moved = true;
							await sleepAbortable(FOLLOW_IDLE_MS, ctx.signal);
						}
					});
					return plain({
						target: { name: initial.found.name },
						moved,
						ended,
						at: { position: { ...lastSelf.place.position }, dimension: lastSelf.place.dimension },
					});
				},
		},
		{
			kind: "action",
			descriptor: fleeDescriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as FleeInput;
					const declared = raw.distance ?? 24;
					const deadline = Date.now() + (raw.maxTimeMs ?? 30000);
					// 威胁解析：显式 from（名字/ref），缺省取最近敌对生物。
					let threat: EntityEntryView;
					if (raw.from != null) {
						const match = matchFollowTarget(await scanEntities(ctx, FLEE_SCAN_RADIUS), raw.from);
						if (match === null) {
							if (typeof raw.from === "string") {
								fail(
									"NOT_FOUND",
									`no tracked entity named ${String(raw.from).replace(/^minecraft:/, "")} within ${FLEE_SCAN_RADIUS} blocks`,
									{
										hint: "read entities@1 first; listing is not proof of absence beyond the radius",
									},
								);
							}
							fail("REFERENCE_STALE", `entity ${raw.from.networkId} is not tracked within ${FLEE_SCAN_RADIUS} blocks`, {
								hint: "re-read entities@1; out of range is not proof of absence",
								recoverable: false,
							});
						}
						if ("ambiguous" in match) ambiguousFailure(String(raw.from), match.ambiguous);
						threat = match.found;
					} else {
						const hostiles = await scanEntities(ctx, FLEE_SCAN_RADIUS, "hostile");
						if (hostiles.length === 0) {
							fail("NOT_FOUND", `no hostile entity within ${FLEE_SCAN_RADIUS} blocks`, {
								hint: "nothing to flee from; listing is not proof of absence beyond the radius",
							});
						}
						threat = hostiles[0]!;
					}
					const owner: ControlOwner = { kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId };
					const start = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
					const startPosition = { ...start.place.position };
					let moved = false;
					let lastGap = distance(start.place.position, threat.position);
					const ended = await deps.runtime().navigate(owner, async (): Promise<{ safe: boolean; distance: number }> => {
						let bearingIdx = 0;
						let consecutiveBlocked = 0;
						for (;;) {
							if (ctx.signal.aborted) sessionInterrupted("flee", { moved });
							if (Date.now() >= deadline) {
								fail("TIMEOUT", `flee budget exhausted at ${Math.round(lastGap * 100) / 100} blocks from the threat`, {
									dispatch: "sent",
									progress: { moved, distance: Math.round(lastGap * 100) / 100 },
									recoverable: true,
								});
							}
							const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
							// 威胁按初始 EntityRef 跟踪（威胁是具体实体，名字会引入新歧义）；
							// 失联按最后已知差距结算，不冒认更远的逃离。
							const match = (await scanEntities(ctx, FLEE_SCAN_RADIUS)).find(
								(entity) => entity.ref.networkId === threat.ref.networkId,
							);
							if (match != null) {
								lastGap = distance(self.place.position, match.position);
								if (lastGap >= declared) return { safe: true, distance: lastGap };
							} else {
								return { safe: lastGap >= declared, distance: lastGap };
							}
							const target = fleeLegTarget(
								self.place.position,
								match.position,
								FLEE_BEARING_OFFSETS[bearingIdx % FLEE_BEARING_OFFSETS.length]!,
								FLEE_LEG_STEP,
							);
							try {
								await deps.gotoDirector.goto(
									{
										at: target,
										tolerance: 2,
										sprint: true,
										digThrough: false,
										placeToReach: false,
										timeoutMs: Math.min(FLEE_LEG_TIMEOUT_MS, deadline - Date.now()),
									},
									ctx.signal,
								);
								consecutiveBlocked = 0;
							} catch (error) {
								if (ctx.signal.aborted) sessionInterrupted("flee", { moved });
								const code = (error as { code?: string }).code;
								if (code === "UNREACHABLE") {
									bearingIdx += 1;
									consecutiveBlocked += 1;
									if (consecutiveBlocked >= FLEE_BEARING_OFFSETS.length) {
										fail("UNREACHABLE", "every escape bearing is blocked", {
											dispatch: "sent",
											progress: { moved },
											recoverable: true,
										});
									}
								} else if (code !== "TIMEOUT") {
									throw error;
								}
							}
							const stop = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
							if (distance(startPosition, stop.place.position) > 0.75) moved = true;
						}
					});
					return plain({
						moved,
						distance: Math.round(ended.distance * 100) / 100,
						safe: ended.safe,
					});
				},
		},
	],
};
