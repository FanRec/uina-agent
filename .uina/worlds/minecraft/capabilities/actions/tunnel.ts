/**
 * tunnel@1：挖一条到目标的通道（走廊 + 台阶 + 头顶防砂砾）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 tunnel。
 * 完成 = 通道连通且自己走过去了（每段腿真实位移）；dug 只计服务端确认的破坏格，
 * path 记已挖格与其原名。规划（L 形 + 台阶 + 竖井）在 shared/spatial.ts 纯函数层；
 * 这里只做执行：withBody 挖 ↔ navigate 走的顶层交替拍（fight 同模式，不嵌套租赁）。
 * 裁决（changelog 批13）：走廊遇流体 → UNREACHABLE；当前库存无法采收（基岩/缺工具）
 * → 返回 stopped:"unbreakable" 保留已挖部分；挖了未确认 → TARGET_NOT_MET 带效果。
 */

import type { SelfState } from "../../contracts/body.js";
import type { CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { GoalSummary, JsonValue, Progress, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import type { CapabilityDeps } from "../deps.js";
import { type GoalOutstanding, goalProgress, goalSummaryOf, sampleOutstanding } from "../shared/goal.js";
import { readValue } from "../shared/observe.js";
import { POS_SCHEMA, GOAL_SUMMARY_SCHEMA } from "../shared/schema.js";
import { isGravityBlock, planCorridor, type TunnelColumn, type TunnelProfile } from "../shared/spatial.js";
import { fail, resolveGrid, resolvePoint, stripNamespace } from "../shared/targets.js";
import { readBlockAt } from "../shared/views.js";
import { digCell, reachHint, stepTo, walkLeg } from "./dig-cycle.js";

/** 头顶重力方块延展探测上限：再多就让它掉，不无限向上挖。 */
const SUPPORT_PROBE_LIMIT = 4;
/** 单列步进预算：站不上去按 UNREACHABLE 结算，不空转烧会话预算。 */
const STEP_MAX_MS = 4000;
/** 挖拍前瞻的 ceiling 格 3D 距离上限（reach 4.5 留余量；升坡列按实际距离自动少挖）。 */
const DIG_REACH_LIMIT = 4.2;
/** 单段受控行走的段超时。 */
const LEG_TIMEOUT_MS = 20000;

const descriptor: CallableDescriptor = {
	ref: "tunnel@1",
	summary:
		"Dig a walkable corridor to the target (L-shape with 1:1 stairs, optional overhead gravel support); returns only server-confirmed digs",
	tags: ["body", "mining", "navigation"],
	input: {
		type: "object",
		properties: {
			to: POS_SCHEMA,
			size: {
				type: "string",
				enum: ["1x2", "1x3", "2x2", "3x3"],
				description: "corridor profile width x height (default 1x2)",
			},
			stairs: {
				type: "string",
				enum: ["auto", "never"],
				description: "carve 1:1 walkable stairs for height changes (default auto)",
			},
			support: {
				type: "boolean",
				description: "dig out gravel/sand above the ceiling before undermining it (default true)",
			},
			maxTimeMs: { type: "number", minimum: 1000, maximum: 600000, description: "wall-clock budget (default 180000)" },
		},
		required: ["to"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			dug: { type: "integer" },
			path: {
				type: "array",
				items: {
					type: "object",
					properties: { at: { type: "object" }, name: { type: "string" } },
					required: ["at", "name"],
					additionalProperties: false,
				},
			},
			goal: GOAL_SUMMARY_SCHEMA,
			stopped: {
				type: "string",
				enum: ["unbreakable"],
				description: "stopped early: no inventory tool can harvest a corridor cell",
			},
		},
		required: ["dug", "path", "goal"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"the corridor is connected and was walked through end to end; dug counts only server-confirmed breaks; stopped:'unbreakable' keeps the dug prefix",
	},
	errors: [
		{
			code: "UNREACHABLE",
			meaning:
				"corridor crosses fluid or unloaded chunks, a planned floor has no support (existing carve-out), or a leg could not advance",
		},
		{ code: "TARGET_NOT_MET", meaning: "a corridor cell was dispatched but the server did not confirm the break" },
		{ code: "MISSING_TOOL", meaning: "harvest requirements known but no inventory tool matches a requested tool" },
		{ code: "WRONG_STATE", meaning: "target in another dimension, or block harvest requirements unknown" },
		{ code: "TIMEOUT", meaning: "budget exhausted before the corridor was walked through (progress keeps dug)" },
		{ code: "INTERRUPTED", meaning: "the run was stopped or safety took over (progress keeps dug)" },
		{ code: "CONTROL_CONFLICT", meaning: "another controlled navigation holds the client" },
		{ code: "DISCONNECTED", meaning: "the connection ended during tunneling" },
	],
	requires: ["connection", "body"],
	examples: [
		{
			input: { to: { x: 24, y: 64, z: 0 } },
			output: {
				value: {
					dug: 6,
					path: [{ at: { x: 12, y: 64, z: 0 }, name: "stone" }],
					goal: { state: "satisfied", completed: 7, remaining: 0, blocked: 0, uncertain: 0, total: 7 },
				},
			},
		},
	],
	implementation: "native",
};

interface TunnelInput {
	to: unknown;
	size?: TunnelProfile;
	stairs?: "auto" | "never";
	support?: boolean;
	maxTimeMs?: number;
}

/** 自上而下的本列挖除序列：support 的重力延展在前（先解除坠落的引发源），profile 次之。 */
async function columnDigList(
	scope: import("../../contracts/capabilities.js").BodyCallScope,
	column: TunnelColumn,
	support: boolean,
): Promise<Vec3[]> {
	const positions: Vec3[] = [];
	if (support) {
		// 下坡列的 ceiling 檐块本身要挖（在 cells 里），探测从再上一格起步。
		for (let i = 0, y = column.ceiling.y + (column.digCeiling ? 1 : 0); i < SUPPORT_PROBE_LIMIT; i++, y++) {
			const block = await readBlockAt(scope.world, { x: column.ceiling.x, y, z: column.ceiling.z });
			if (block == null || !isGravityBlock(stripNamespace(block.name))) break;
			positions.push({ x: column.ceiling.x, y, z: column.ceiling.z });
		}
	}
	positions.push(...[...column.cells].sort((a, b) => b.y - a.y));
	return positions;
}

/** 等待脚下结算：onGround 且两次采样位置稳定（≤2s）；悬空超时按现状继续。 */
async function settle(ctx: CallContext): Promise<void> {
	const deadline = Date.now() + 2000;
	let last: Vec3 | null = null;
	while (Date.now() < deadline && !ctx.signal.aborted) {
		const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
		const pos = self.place.position;
		if (self.onGround && last != null && Math.hypot(pos.x - last.x, pos.y - last.y, pos.z - last.z) < 0.01) return;
		last = pos;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

export const tunnelModule: MinecraftCapabilityModule = {
	id: "tunnel",
	definitions: [
		{
			kind: "action",
			descriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as TunnelInput;
					const deadline = Date.now() + (raw.maxTimeMs ?? 180000);
					const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
					const target = resolvePoint(raw.to, self);
					if (target.dimension !== self.place.dimension) {
						fail("WRONG_STATE", `target is in ${target.dimension}, current dimension is ${self.place.dimension}`);
					}
					const to = resolveGrid(raw.to, self);
					const from = {
						x: Math.floor(self.place.position.x),
						y: Math.floor(self.place.position.y),
						z: Math.floor(self.place.position.z),
					};
					const columns = planCorridor(from, to, raw.size ?? "1x2", raw.stairs ?? "auto");
					const support = raw.support !== false;
					const owner = { kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId } as const;
					let dug = 0;
					const path: { at: Vec3; name: string }[] = [];
					let stopped: "unbreakable" | null = null;

					// 目标对账（capabilities §2.15）：通道目标是"这些格变成空气 + 真的走通"。
					// 计划在开工时固定；支撑探测格在执行中才发现，注册时一并计入总量。
					// 完成/阻碍/未知三态按格记账，剩余 = 计划内还没轮到的格。
					const keyOf = (at: Vec3): string => `${at.x},${at.y},${at.z}`;
					const plan = new Map<string, { at: Vec3; target: string }>();
					const opened = new Set<string>();
					const held = new Map<string, GoalOutstanding & { kind: "blocked" | "uncertain" }>();
					const WALK_KEY = "walk";
					const register = (at: Vec3): string => {
						const key = keyOf(at);
						if (!plan.has(key)) plan.set(key, { at, target: "air" });
						return key;
					};
					for (const column of columns) for (const cell of column.cells) register(cell);
					let walked = false;

					/** 目标对账快照：progress 与返回值里的 goal 出自同一次计算。 */
					const snapshot = (phase: string): { progress: Progress; goal: GoalSummary } => {
						const blocked = [...held.values()].filter((entry) => entry.kind === "blocked");
						const uncertain = [...held.values()].filter((entry) => entry.kind === "uncertain");
						const pending: GoalOutstanding[] = [];
						for (const [key, entry] of plan) {
							if (opened.has(key) || held.has(key)) continue;
							pending.push({ at: entry.at, target: entry.target, reason: "not attempted yet" });
						}
						if (!walked && !held.has(WALK_KEY))
							pending.push({ target: "walk to the corridor end", reason: "not attempted yet" });
						const reasons: Record<string, number> = {};
						for (const entry of [...blocked, ...uncertain])
							reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
						if (pending.length > 0) reasons["not attempted yet"] = pending.length;
						const input = {
							total: plan.size + 1,
							completed: opened.size + (walked ? 1 : 0),
							blocked: blocked.length,
							uncertain: uncertain.length,
						};
						return {
							progress: goalProgress({
								phase,
								...input,
								outstanding: sampleOutstanding([...blocked, ...uncertain, ...pending]),
								reasons,
								extra: { dug, columns: { walked: stoodIndex + 1, total: columns.length } },
							}),
							goal: goalSummaryOf(input),
						};
					};
					const progressOf = (phase: string): Progress => snapshot(phase).progress;

					// 执行节拍：挖 ahead 列（reach 内）→ goto 走到已挖到的最远列（≥2 格走寻路，
					// 经验 22：近距 1-2 格寻路不可靠，尾巴短腿用 drive 步进）。挖与走不嵌套租赁。
					let cursor = 0;
					let stoodIndex = -1;
					for (;;) {
						if (ctx.signal.aborted) {
							fail("INTERRUPTED", "tunnel was interrupted by run stop or safety", {
								dispatch: "sent",
								progress: progressOf("digging"),
								recoverable: true,
							});
						}
						if (Date.now() >= deadline) {
							fail("TIMEOUT", `tunnel budget exhausted after ${dug} digs`, {
								dispatch: "sent",
								progress: progressOf("digging"),
								recoverable: true,
							});
						}
						// 挖拍：从当前站位向前挖 reach 内的列（ ceiling 格 3D 距离超界即停）。
						await ctx.withBody(async (scope) => {
							const selfNow = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
							const eye = {
								x: selfNow.place.position.x,
								y: selfNow.place.position.y + 1.62,
								z: selfNow.place.position.z,
							};
							while (cursor < columns.length) {
								const column = columns[cursor]!;
								// 降坡列最远格是 floor（在下方），升坡列是 ceiling（在上方）——取两者最大。
								const spanOf = (at: Vec3): number =>
									Math.hypot(at.x + 0.5 - eye.x, at.y + 0.5 - eye.y, at.z + 0.5 - eye.z);
								const span = Math.max(spanOf(column.floor), spanOf(column.ceiling));
								if (cursor > stoodIndex + 1 && span > DIG_REACH_LIMIT) break;
								for (const position of await columnDigList(scope, column, support)) {
									const key = register(position);
									if (opened.has(key)) continue;
									const result = await digCell(deps, scope, selfNow, position);
									switch (result.kind) {
										case "dug":
											dug += 1;
											opened.add(key);
											held.delete(key);
											path.push({ at: position, name: result.name });
											break;
										case "open":
											opened.add(key);
											held.delete(key);
											break;
										case "not_loaded":
											held.set(key, {
												kind: "uncertain",
												at: position,
												target: "air",
												reason: "chunk is not loaded",
											});
											fail("UNREACHABLE", `corridor cell ${position.x},${position.y},${position.z} is not loaded`, {
												hint: "tunnel does not guess across unloaded chunks; goto@1 closer to load them first",
												dispatch: "sent",
												progress: progressOf("digging"),
												recoverable: true,
											});
										case "liquid":
											held.set(key, {
												kind: "blocked",
												at: position,
												target: "air",
												reason: "holds water/lava",
											});
											fail("UNREACHABLE", `corridor cell ${position.x},${position.y},${position.z} holds water/lava`, {
												hint: "tunnel cannot cross fluids without a bucket; route around or drain first",
												dispatch: "sent",
												progress: progressOf("digging"),
												recoverable: true,
											});
										case "unbreakable":
											held.set(key, {
												kind: "blocked",
												at: position,
												target: "air",
												reason: "cannot harvest with the current inventory",
											});
											stopped = "unbreakable";
											break;
										case "unreachable":
											held.set(key, {
												kind: "blocked",
												at: position,
												target: "air",
												reason: "out of reach from the current station",
											});
											fail("UNREACHABLE", reachHint(result.distance, position), {
												hint: "the corridor cell is out of reach from the current station",
												dispatch: "sent",
												progress: progressOf("digging"),
												recoverable: true,
											});
										case "not_met":
											held.set(key, {
												kind: "uncertain",
												at: position,
												target: "air",
												reason: "server did not confirm the break",
											});
											fail("TARGET_NOT_MET", "the server did not confirm a corridor cell was broken", {
												dispatch: result.dispatch,
												effects: [result.effect],
												progress: progressOf("digging"),
												recoverable: true,
											});
									}
									if (stopped != null) return;
								}
								if (stopped != null) return;
								cursor += 1;
							}
						});
						if (stopped != null) break;
						// 走拍：目标 = 已挖到的最远列脚位。goto 先行（会爬台阶/转弯），但
						// "空路径假成功"（经验 19/22）与 NoPath 都要用实际落点复核，未到位再 drive 步进。
						// 目标至少跨 2 列（有余量时）：GoalNear 的 range-1 邻域包含"目标正下方一格"，
						// 只跨 1 列的上坡腿会在目标正下方被当成已到达，寻路不爬台阶。
						const targetIndex = Math.min(
							Math.max(Math.min(cursor, columns.length) - 1, stoodIndex + 2),
							columns.length - 1,
						);
						if (targetIndex <= stoodIndex) break;
						const legTo = columns[targetIndex]!.floor;
						// 走拍前核验目标脚位可站立：planCorridor 的地板落在既有挖空上时（G30 缺陷 c
						// 的形态——重入与既有阶梯错位一格，脚位/支撑格恰是既有走廊的空气），bot
						// 永远站不上去，走位只能烧满预算再给出"卡住"这种无归因结局。先读支撑格，
						// 空气即如实快速失败；未加载（null）不猜，交给既有走位归因。
						const floorSupport = await readValue<{ block: { name: string } | null }>(
							ctx.world,
							"block@1",
							{ at: { x: legTo.x, y: legTo.y - 1, z: legTo.z } },
							ctx.signal,
							"corridor floor support",
						);
						if (floorSupport?.block?.name === "air") {
							held.set(WALK_KEY, {
								kind: "blocked",
								at: legTo,
								target: "walk to the corridor end",
								reason: "corridor floor has no support (plan intersects an existing carve-out)",
							});
							fail(
								"UNREACHABLE",
								`corridor floor ${legTo.x},${legTo.y},${legTo.z} has no support (air below): the plan intersects an existing carve-out`,
								{
									hint: "re-enter the existing corridor from a station aligned with it (stepTo) or tunnel from its bottom node",
									dispatch: "not_sent",
									progress: progressOf("walking"),
									recoverable: true,
								},
							);
						}
						const trace: string[] = [];
						try {
							// digThrough:true（surface@1 同款，真服已验证）：让寻路消化客户端/服务端
							// 方块状态的细微不一致——走廊本体已由挖拍挖开，这里只是兜底。
							await walkLeg(deps, ctx, owner, legTo, {
								tolerance: 1,
								timeoutMs: Math.min(LEG_TIMEOUT_MS, Math.max(1000, deadline - Date.now())),
								digThrough: true,
							});
						} catch (error) {
							if (ctx.signal.aborted) {
								fail("INTERRUPTED", "tunnel was interrupted by run stop or safety", {
									dispatch: "sent",
									progress: progressOf("walking"),
									recoverable: true,
								});
							}
							const code = (error as { code?: string }).code;
							if (code !== "TIMEOUT" && code !== "UNREACHABLE") throw error;
						}
						// 等落定（onGround 且位置稳定）：悬空状态下挖下一拍会用错站位。
						await settle(ctx);
						const arrived = await (async (): Promise<boolean> => {
							const selfNow = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
							const here = selfNow.place.position;
							// 到位 = 站在目标列且脚在目标层；GoalNear 的邻域含"正下方一格"，
							// 3D 距离会把"贴在走廊底下"误判为到达（上坡腿的假到达陷阱）。
							const flat = Math.hypot(Math.floor(here.x) - legTo.x, Math.floor(here.z) - legTo.z);
							if (flat <= 1 && Math.floor(here.y) === legTo.y) return true;
							return await ctx.withBody((scope) => stepTo(ctx, scope, legTo, { maxMs: STEP_MAX_MS, trace }));
						})();
						if (!arrived) {
							const stuck = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
							const stuckAt = stuck.place.position;
							if (ctx.signal.aborted) {
								fail("INTERRUPTED", "tunnel was interrupted by run stop or safety", {
									dispatch: "sent",
									progress: progressOf("walking"),
									recoverable: true,
								});
							}
							held.set(WALK_KEY, {
								kind: "blocked",
								at: legTo,
								target: "walk to the corridor end",
								reason: `did not reach ${legTo.x},${legTo.y},${legTo.z} by walking`,
							});
							fail(
								"UNREACHABLE",
								`could not advance: stuck at ${stuckAt.x.toFixed(2)},${stuckAt.y.toFixed(2)},${stuckAt.z.toFixed(2)}, want ${legTo.x},${legTo.y},${legTo.z} (dug=${dug}) path=[${trace.join(" -> ")}]`,
								{
									hint: "the bot did not reach the next station by walking; the corridor may be blocked",
									dispatch: "sent",
									progress: progressOf("walking"),
									recoverable: true,
								},
							);
						}
						stoodIndex = targetIndex;
						if (stoodIndex >= columns.length - 1) walked = true;
						await ctx.progress(progressOf(walked ? "done" : "walking"));
						if (walked) break;
					}
					return plain({
						dug,
						path,
						goal: snapshot("done").goal,
						...(stopped != null ? { stopped } : {}),
					});
				},
		},
	],
};
