/**
 * excavate@1：清空一块长方体区域（层自上而下，先收容器内容）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 excavate。
 * keep（默认 bedrock/chest/furnace/spawner）命中的格子保留；不在 keep 的容器先
 * transfer@1 {from,all} 收内容再挖。dug 只计服务端
 * 确认的破坏格，drops 聚合每次挖后短窗观察到的背包正增量；未能清理的目标留在
 * remaining 并抛 TARGET_NOT_MET（progress 不回滚）。
 * 裁决（changelog 批13）：层内按与当前位置就近排序；单格行走失败记入 remaining
 * 继续清其余，不空转烧预算；液体格同样保留为 remaining。
 */

import type { SelfState } from "../../contracts/body.js";
import type { CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { JsonValue, Progress, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import type { CapabilityDeps } from "../deps.js";
import { GOAL_SAMPLE_LIMIT, goalProgress, sampleOutstanding } from "../shared/goal.js";
import { pollUntil, readValue } from "../shared/observe.js";
import { BLOCK_REACH, blockReach } from "../shared/reach.js";
import { GOAL_SUMMARY_SCHEMA, GRID_POS_SCHEMA } from "../shared/schema.js";
import {
	DEFAULT_EXCAVATE_KEEP,
	EXCAVATE_MAX_VOXELS,
	isContainerBlock,
	normalizeBox,
	orderNear,
	planExcavation,
} from "../shared/spatial.js";
import { fail, resolveGrid, resolvePoint } from "../shared/targets.js";
import { type InventorySnapshot, positiveDelta, readBlockAt, readInventory } from "../shared/views.js";
import { digCell, stepTo, walkLeg } from "./dig-cycle.js";

/** 单次挖后等掉落入包的观察窗（短；等不到不计数量，不猜）。 */
const DROP_WINDOW_MS = 800;
const DROP_INTERVAL_MS = 150;

const descriptor: CallableDescriptor = {
	ref: "excavate@1",
	summary:
		"Clear a box layer by layer top-down, collecting container contents first; keeps kept blocks, counts server-confirmed digs and observed drops",
	tags: ["body", "mining", "navigation"],
	input: {
		type: "object",
		properties: {
			region: {
				type: "object",
				properties: { from: GRID_POS_SCHEMA, to: GRID_POS_SCHEMA },
				required: ["from", "to"],
				additionalProperties: false,
			},
			keep: {
				type: "array",
				items: { type: "string", minLength: 1 },
				description: "block names to preserve (default bedrock/chest/furnace/spawner)",
			},
			maxTimeMs: { type: "number", minimum: 1000, maximum: 600000, description: "wall-clock budget (default 300000)" },
		},
		required: ["region"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			dug: { type: "integer" },
			kept: {
				type: "array",
				items: {
					type: "object",
					properties: { at: { type: "object" }, name: { type: "string" } },
					required: ["at", "name"],
					additionalProperties: false,
				},
			},
			drops: { type: "object", description: "observed inventory gains aggregated per item" },
			remaining: {
				type: "array",
				items: {
					type: "object",
					properties: { at: { type: "object" }, reason: { type: "string" } },
					required: ["at", "reason"],
					additionalProperties: false,
				},
			},
			goal: GOAL_SUMMARY_SCHEMA,
		},
		required: ["dug", "kept", "drops", "remaining", "goal"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"every non-kept cell is server-confirmed air; cells that could not be cleared stay in remaining and raise TARGET_NOT_MET with progress",
	},
	errors: [
		{ code: "INVALID_INPUT", meaning: "region covers more than 4096 voxels" },
		{ code: "WRONG_STATE", meaning: "region in another dimension, or block harvest requirements unknown" },
		{ code: "MISSING_TOOL", meaning: "harvest requirements known but no inventory tool matches" },
		{ code: "TARGET_NOT_MET", meaning: "uncleared targets remain (progress keeps dug/drops/remaining)" },
		{ code: "TIMEOUT", meaning: "budget exhausted with cells left (progress keeps dug/drops/remaining)" },
		{ code: "INTERRUPTED", meaning: "the run was stopped or safety took over (progress keeps dug/drops/remaining)" },
		{ code: "CONTROL_CONFLICT", meaning: "another controlled navigation holds the client" },
		{ code: "DISCONNECTED", meaning: "the connection ended during excavation" },
	],
	requires: ["connection", "body"],
	examples: [
		{
			input: { region: { from: { x: 0, y: 63, z: 0 }, to: { x: 3, y: 64, z: 3 } } },
			output: {
				value: {
					dug: 32,
					kept: [{ at: { x: 1, y: 63, z: 1 }, name: "chest" }],
					drops: { cobblestone: 20 },
					remaining: [],
					goal: { state: "satisfied", completed: 64, remaining: 0, blocked: 0, uncertain: 0, total: 64 },
				},
			},
		},
	],
	implementation: "native",
};

interface ExcavateInput {
	region: { from: unknown; to: unknown };
	keep?: string[];
	maxTimeMs?: number;
}

interface ExcavateProgress {
	dug: number;
	opened: number;
	drops: Record<string, number>;
}

/**
 * 未清格按原因归入"已知阻碍"还是"证据不足"：
 * 液体/挖不动/够不着是已知原因；未加载/未确认是读不到证据。
 * 其余（not_attempted）算计划内剩余。
 */
const UNCERTAIN_REASONS = new Set(["not_loaded", "unconfirmed"]);
const BLOCKED_REASONS = new Set(["liquid", "unbreakable", "unreachable"]);

function reasonCounts(remaining: { at: Vec3; reason: string }[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const entry of remaining) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
	return counts;
}

function countBy(remaining: { reason: string }[], reasons: Set<string>): number {
	return remaining.reduce((total, entry) => total + (reasons.has(entry.reason) ? 1 : 0), 0);
}
/**
 * progress 快照：`goal` 是统一四态摘要（四者之和 = 计划总格数），
 * `outstanding` 是有界明细样本，`reasons` 是全量原因直方图。
 * 完整明细仍在本次 Call 记录里（`runs record`）。
 */
function progressSnapshot(
	progress: ExcavateProgress,
	remaining: { at: Vec3; reason: string }[],
	plannedTotal: number,
	keptCount: number,
	fullRemaining: boolean,
): Progress {
	return goalProgress({
		phase: "clearing",
		total: plannedTotal,
		completed: progress.dug + progress.opened + keptCount,
		blocked: countBy(remaining, BLOCKED_REASONS),
		uncertain: countBy(remaining, UNCERTAIN_REASONS),
		outstanding: sampleOutstanding(remaining.map((entry) => ({ at: entry.at, target: "air", reason: entry.reason }))),
		reasons: reasonCounts(remaining),
		extra: {
			dug: progress.dug,
			drops: progress.drops,
			...(fullRemaining ? { outstandingComplete: remaining.length <= GOAL_SAMPLE_LIMIT } : {}),
		},
	});
}

export const excavateModule: MinecraftCapabilityModule = {
	id: "excavate",
	definitions: [
		{
			kind: "action",
			descriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as ExcavateInput;
					const deadline = Date.now() + (raw.maxTimeMs ?? 300000);
					const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
					// 异维度区域如实拒绝（resolveGrid 会丢掉 dimension，必须在解析后核对）。
					const fromTarget = resolvePoint(raw.region.from, self);
					const toTarget = resolvePoint(raw.region.to, self);
					if (fromTarget.dimension !== self.place.dimension || toTarget.dimension !== self.place.dimension) {
						fail(
							"WRONG_STATE",
							`region is in ${fromTarget.dimension}/${toTarget.dimension}, current is ${self.place.dimension}`,
						);
					}
					const from = resolveGrid(raw.region.from, self);
					const to = resolveGrid(raw.region.to, self);
					const box = normalizeBox(from, to);
					if (box.voxels > EXCAVATE_MAX_VOXELS) {
						fail("INVALID_INPUT", `region covers ${box.voxels} voxels (limit ${EXCAVATE_MAX_VOXELS})`, {
							hint: "split the region into smaller boxes, e.g. one y-layer slab at a time",
							dispatch: "not_sent",
							recoverable: true,
						});
					}
					const keep = new Set(raw.keep ?? DEFAULT_EXCAVATE_KEEP);
					const layers = planExcavation(box.min, box.max);
					const owner = { kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId } as const;
					const progress: ExcavateProgress = { dug: 0, opened: 0, drops: {} };
					const kept: { at: Vec3; name: string }[] = [];
					const remaining: { at: Vec3; reason: string }[] = [];
					// 计划全集只构造一次：收尾/中断时用它补"从未轮到"的格，
					// 否则 remaining 只含尝试失败格，进度会把未访问量当成完成。
					const planned = layers.flat();
					const atKey = (at: Vec3): string => `${at.x},${at.y},${at.z}`;
					const processed = new Set<string>();
					const unvisited = (): { at: Vec3; reason: string }[] =>
						planned.filter((at) => !processed.has(atKey(at))).map((at) => ({ at, reason: "not_attempted" }));
					const outstanding = (): { at: Vec3; reason: string }[] => [...remaining, ...unvisited()];
					const snapshot = (full: boolean): Progress =>
						progressSnapshot(progress, outstanding(), planned.length, kept.length, full);
					const interrupt = (): never =>
						fail("INTERRUPTED", "excavate was interrupted by run stop or safety", {
							dispatch: "sent",
							progress: snapshot(false),
							recoverable: true,
						});

					const observeDrop = async (before: InventorySnapshot): Promise<void> => {
						try {
							const polled = await pollUntil(
								async () => await readInventory(ctx.world),
								(inv) => Object.keys(positiveDelta(before, inv)).length > 0,
								{ timeoutMs: DROP_WINDOW_MS, intervalMs: DROP_INTERVAL_MS, signal: ctx.signal },
							);
							const after = polled.ok && polled.last != null ? polled.last : await readInventory(ctx.world);
							for (const [name, delta] of Object.entries(positiveDelta(before, after))) {
								progress.drops[name] = (progress.drops[name] ?? 0) + delta;
							}
						} catch (error) {
							// 观察窗被停止打断时也要带守恒进度：不能丢掉"已挖多少、还剩多少"。
							if (ctx.signal.aborted) interrupt();
							throw error;
						}
					};

					for (const layer of layers) {
						const here = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
						for (const cell of orderNear(layer, here.place.position)) {
							if (ctx.signal.aborted) interrupt();
							if (Date.now() >= deadline) {
								const outstandingNow = outstanding();
								fail("TIMEOUT", `excavate budget exhausted with ${outstandingNow.length} uncleared cell(s)`, {
									dispatch: "sent",
									progress: progressSnapshot(progress, outstandingNow, planned.length, kept.length, false),
									recoverable: true,
								});
							}
							const block = await readBlockAt(ctx.world, cell);
							if (block == null) {
								processed.add(atKey(cell));
								remaining.push({ at: cell, reason: "not_loaded" });
								continue;
							}
							if (keep.has(block.name)) {
								processed.add(atKey(cell));
								kept.push({ at: cell, name: block.name });
								continue;
							}
							if (block.name === "air") {
								processed.add(atKey(cell));
								progress.opened += 1;
								continue;
							}
							// 读取抛错时这一格仍算"从未访问"，会进入 remainingCount；
							// 确认是可处理方块后，才记为已尝试。
							processed.add(atKey(cell));
							// 容器先收内容再挖（不在 keep 时）：transfer@1 自己完成开箱/搬运/关窗。
							// 不再先 container@1 再 transfer——连续开合同一窗口在真服上会搬不动（批13 实测）。
							if (isContainerBlock(block.name)) {
								await ctx.call("transfer@1", { from: { x: cell.x, y: cell.y, z: cell.z }, all: true });
							}
							// 站位管理（MC-WORLD.md 经验 22）：近距 drive 步进（持身体）优先，
							// 失败退回受控寻路（不持身体）；目标脚位 = 目标格上方一格。
							const vantage = { x: cell.x, y: cell.y + 1, z: cell.z };
							let inReach = false;
							await ctx.withBody(async (scope) => {
								const standing = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
								if (blockReach(standing, cell) <= BLOCK_REACH - 0.25) {
									inReach = true;
									return;
								}
								inReach = await stepTo(ctx, scope, vantage, { maxMs: 4000 });
							});
							if (!inReach) {
								if (ctx.signal.aborted) interrupt();
								try {
									await walkLeg(deps, ctx, owner, vantage, {
										tolerance: 1,
										timeoutMs: Math.min(10000, Math.max(1000, deadline - Date.now())),
										digThrough: true,
									});
								} catch (error) {
									if (ctx.signal.aborted) interrupt();
									const code = (error as { code?: string }).code;
									if (code === "UNREACHABLE" || code === "TIMEOUT") {
										// 走不到位不等于挖不到（如箱子正下方的格子：vantage 是箱子本身）。
										// 失败后的实际站位可能已进入射程，复核后再定。
										const landed = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
										if (blockReach(landed, cell) > BLOCK_REACH - 0.25) {
											remaining.push({ at: cell, reason: "unreachable" });
											continue;
										}
									} else {
										throw error;
									}
								}
							}
							const before = await readInventory(ctx.world);
							await ctx.withBody(async (scope) => {
								const selfNow = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
								const result = await digCell(deps, scope, selfNow, cell);
								switch (result.kind) {
									case "dug":
										progress.dug += 1;
										await observeDrop(before);
										break;
									case "open":
										break;
									case "not_loaded":
										remaining.push({ at: cell, reason: "not_loaded" });
										break;
									case "liquid":
										remaining.push({ at: cell, reason: "liquid" });
										break;
									case "unbreakable":
										remaining.push({ at: cell, reason: "unbreakable" });
										break;
									case "unreachable":
										remaining.push({ at: cell, reason: "unreachable" });
										break;
									case "not_met": {
										// 回执未确认（确认窗边界竞态）：以世界读数为准再核一次。
										const after = await readBlockAt(scope.world, cell);
										if (after != null && after.name === "air") {
											progress.dug += 1;
										} else {
											remaining.push({ at: cell, reason: "unconfirmed" });
										}
										break;
									}
								}
							});
						}
					}
					// 收尾复核：remaining + 从未轮到的格都要按世界读数再核一遍——
					// 行走腿（digThrough 兜底）可能顺带挖开；空气即计入 dug，其余如实保留。
					const outstandingNow = outstanding();
					if (outstandingNow.length > 0) {
						const still: { at: Vec3; reason: string }[] = [];
						for (const entry of outstandingNow) {
							const after = await readBlockAt(ctx.world, entry.at);
							if (after != null && after.name === "air") progress.dug += 1;
							else still.push(entry);
						}
						if (still.length > 0) {
							fail("TARGET_NOT_MET", `${still.length} target cell(s) could not be cleared`, {
								dispatch: "sent",
								effects: [],
								progress: progressSnapshot(progress, still, planned.length, kept.length, true),
								recoverable: true,
							});
						}
					}
					return plain({
						dug: progress.dug,
						kept,
						drops: progress.drops,
						remaining: [],
						goal: goalProgress({
							total: planned.length,
							completed: progress.dug + progress.opened + kept.length,
							blocked: 0,
							uncertain: 0,
						}).goal,
					});
				},
		},
	],
};
