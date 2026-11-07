/**
 * build@1：按目标（cells 或库中蓝图）施工并核验。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 build、§4「共用目标与差异处理」、
 * §2.11（计划与执行共用目标）。
 *
 * 三个不显眼但必须成立的约定：
 * 1. **开局只读一次计划**。build 用同一份输入去读 `build.plan@1`（去掉 maxTimeMs），
 *    拿到规范化目标、材料缺口与冲突；之后不再读盘。这满足"在途使用本次固定设计字节，
 *    不重读变更文件"，也保证计划与执行算的是同一份目标。
 * 2. **能在派发前失败的全部提前失败**：蓝图不存在、expectDigest 不符（CONFLICT）、
 *    现场冲突（CONFLICT）、缺料（MISSING_MATERIAL）。缺料可能发生在部分施工之后，
 *    所以这条只在开工前拦一次；途中材料变化按 remaining 如实结算。
 * 3. **先清后放，放自下而上**。clear 按高度降序（先卸上面的）、set 按高度升序
 *    （下层先放，上层才有支撑面）；同层按当前位置就近。执行前仍按现场逐格复核。
 *
 * 结束判据是"所有 set/clear 目标经实际核验"，不是"派发都成功"：收尾对未完成格再读一次
 * 世界，已达成（确认窗边界竞态、路径挖掘的顺带）计入完成，其余进 remaining 并抛 TARGET_NOT_MET。
 *
 * 身体按"一格一次"取放：格间需要走位，而 navigate 与持身体互斥（engine 的 CONTROL_CONFLICT），
 * 因此不能在整段施工里一直持有身体。
 */

import { isReplaceableName, matchesDeclared, specBlockName } from "../../construction/target.js";
import type { BlockSpec, ControlOwner, SelfState } from "../../contracts/body.js";
import type { BodyCallScope, CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { ExactRef, JsonValue, Progress, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { BuildPlanValue, ConstructionTargetCell } from "../../contracts/world.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import type { CapabilityDeps } from "../deps.js";
import { readValue } from "../shared/observe.js";
import { BLOCK_REACH, EYE_HEIGHT } from "../shared/reach.js";
import { buildTargetSchema } from "../shared/schema.js";
import { fail } from "../shared/targets.js";
import { readBlockAt } from "../shared/views.js";
import { digCell, reachHint, stepTo, walkLeg } from "./dig-cycle.js";
import { commitPlacement, inspectPlacement } from "./place-cell.js";

/** build 的执行期限缺省值（§2.4）。 */
const DEFAULT_MAX_TIME_MS = 300_000;
/** 一格走位预算：不够就如实 remaining，不无限重试。 */
const LEG_TIMEOUT_MS = 8_000;
/** remaining 明细的截断上限：progress 超 2048 字节会被 runtime 清空（runtime/rows.ts）。 */
const REMAINING_DETAIL_LIMIT = 128;
const PROGRESS_EVERY = 8;
/**
 * 放置阶段的轮数上限（安全网）：真实终止条件是"一轮零建成即停"。支撑链深度
 * （悬挑、门顶要等邻格）决定真实轮数——固定 4 轮会让深链结构如实的 remaining
 * 变成猜测（批30 放开）。
 */
const MAX_PASSES = 16;

const BUILD_PLAN_REF: ExactRef = "build.plan@1";

const descriptor: CallableDescriptor = {
	ref: "build@1",
	summary:
		"Build a design (explicit cells or a library blueprint) by clearing first then placing bottom-up, verifying every declared set/clear cell against the world; re-running only fixes the real differences",
	tags: ["body", "building", "construction"],
	input: buildTargetSchema({
		maxTimeMs: { type: "integer", minimum: 1000, description: "execution budget in ms (default 300000)" },
	}),
	output: {
		type: "object",
		properties: {
			placed: { type: "integer" },
			cleared: { type: "integer" },
			skipped: { type: "integer" },
			remaining: { type: "array" },
			blueprint: { type: "object" },
		},
		required: ["placed", "cleared", "skipped", "remaining"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"Every declared set/clear target matches the world; preserve targets are untouched and unknown ones are never demolished",
	},
	errors: [
		{ code: "MISSING_MATERIAL", meaning: "the design needs blocks the inventory cannot supply" },
		{ code: "UNREACHABLE", meaning: "a target cell could not be reached or has no support face" },
		{ code: "CONFLICT", meaning: "the design changed, or a cell is occupied and replace is false" },
		{ code: "TARGET_NOT_MET", meaning: "some declared cells still do not match after the run" },
		{ code: "TIMEOUT", meaning: "the execution budget ran out with targets left" },
		{ code: "INTERRUPTED", meaning: "the run was stopped; the counts are what actually happened" },
		{ code: "INVALID_INPUT", meaning: "the target is malformed, or a raw blueprint needs an airPolicy" },
		{ code: "NOT_FOUND", meaning: "the blueprint is not in the library" },
	],
	requires: ["connection", "body"],
	examples: [
		{
			input: { from: { kind: "blueprint", name: "oak_hut" }, at: { x: 100, y: 64, z: 100 }, airPolicy: "preserve" },
			output: {
				placed: 26,
				cleared: 0,
				skipped: 74,
				remaining: [],
				blueprint: { ref: "blueprint:oak_hut", digest: "9f2c…" },
			},
		},
	],
	implementation: "native",
};

interface BuildInput {
	replace?: boolean;
	maxTimeMs?: number;
	cells?: { at: unknown; block: BlockSpec }[];
	from?: { kind: string; name: string };
	at?: unknown;
	mirror?: "none" | "x" | "z";
	rotate?: 0 | 90 | 180 | 270;
	airPolicy?: "set_air" | "preserve";
	expectDigest?: string;
}

interface Box {
	min: Vec3;
	max: Vec3;
}

/** 设计盒（含 clear 格）：站位要在它外面选。 */
function boxOf(cells: ConstructionTargetCell[]): Box {
	let min = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY };
	let max = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY };
	for (const cell of cells) {
		min = { x: Math.min(min.x, cell.at.x), y: Math.min(min.y, cell.at.y), z: Math.min(min.z, cell.at.z) };
		max = { x: Math.max(max.x, cell.at.x), y: Math.max(max.y, cell.at.y), z: Math.max(max.z, cell.at.z) };
	}
	return { min, max };
}

interface Unfinished {
	at: Vec3;
	target: string;
	reason: string;
}

type CellResult = { kind: "done"; counted: "placed" | "cleared" | "skipped" } | { kind: "failed"; reason: string };

function targetLabel(cell: ConstructionTargetCell): string {
	if (cell.kind === "clear") return "air";
	if (cell.block == null) return cell.kind;
	return specBlockName(cell.block);
}

function cellKey(at: Vec3): string {
	return `${at.x},${at.y},${at.z}`;
}

/** 挖掉一格；走不过去就先走近一次，再如实结算。 */
async function clearCell(deps: CapabilityDeps, ctx: CallContext, owner: ControlOwner, at: Vec3): Promise<CellResult> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = await ctx.withBody(async (scope: BodyCallScope) => {
			const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			return await digCell(deps, scope, self, at);
		});
		switch (result.kind) {
			case "dug":
				return { kind: "done", counted: "cleared" };
			case "open":
				return { kind: "done", counted: "skipped" };
			case "not_loaded":
				return { kind: "failed", reason: "chunk is not loaded" };
			case "liquid":
				return { kind: "failed", reason: "cell holds a fluid" };
			case "unbreakable":
				return { kind: "failed", reason: "cannot harvest with the current inventory" };
			case "not_met": {
				// 确认窗边界的竞态：以世界读数复核一次，真的挖开了就记账（批13 经验 28）。
				const after = await readBlockAt(ctx.world, at);
				if (after != null && after.name === "air") return { kind: "done", counted: "cleared" };
				return { kind: "failed", reason: `dig was not confirmed (${result.dispatch})` };
			}
			case "unreachable": {
				if (attempt > 0) return { kind: "failed", reason: `unreachable (${reachHint(result.distance, at)})` };
				const walkError = await walkToward(deps, ctx, owner, at);
				if (walkError != null)
					return { kind: "failed", reason: `unreachable and could not walk closer (${walkError})` };
				break;
			}
		}
	}
	return { kind: "failed", reason: "unreachable" };
}

/**
 * 站位选择与放置调度（批30）：
 *
 * 旧实现"只试首站位 + 逐格走位"的两个真实代价：盒外 pad 候选永远轮不到
 * （v0=盒中心走过去仍然够不着就整格失败）；每个够不着的格都付一次完整 walk。
 * 新调度每轮做一次**站位分区**：盒中心 + 四侧 pad 的候选序里，每格取第一个
 * 几何射程满足的站位，同站位格批量执行——每站位一次走位，候选序列真实轮转。
 */

/** 眼位到方块中心的距离（合成 SelfState 只用 place.position，见 reach.blockReach）。 */
function reachFrom(vantage: Vec3, cell: Vec3): number {
	return Math.hypot(
		cell.x + 0.5 - (vantage.x + 0.5),
		cell.y + 0.5 - (vantage.y + EYE_HEIGHT),
		cell.z + 0.5 - (vantage.z + 0.5),
	);
}

function flatDist(from: Vec3, to: Vec3): number {
	return Math.hypot(from.x - (to.x + 0.5), from.z - (to.z + 0.5));
}

/** 全盒共享的站位候选（有序：盒中心，四侧 pad 1，四侧 pad 2）。y = 当前立足层。 */
export function boxVantages(box: Box, groundY: number): Vec3[] {
	const centerX = Math.round((box.min.x + box.max.x) / 2);
	const centerZ = Math.round((box.min.z + box.max.z) / 2);
	const sides: [number, number][] = [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
	];
	const candidates: Vec3[] = [{ x: centerX, y: groundY, z: centerZ }];
	for (const pad of [1, 2]) {
		for (const [dx, dz] of sides) {
			candidates.push({
				x: dx > 0 ? box.max.x + pad : dx < 0 ? box.min.x - pad : centerX,
				y: groundY,
				z: dz > 0 ? box.max.z + pad : dz < 0 ? box.min.z - pad : centerZ,
			});
		}
	}
	return candidates;
}

/**
 * 站位分区：每格取候选序里第一个几何射程满足的站位，同站位格归一组。
 * 谁都够不着的格进 orphans（调用方如实 defer——几何上无解，重轮也不会变）。
 */
export function assignVantageZones<T extends { at: Vec3 }>(
	cells: T[],
	vantages: Vec3[],
): { groups: { vantage: Vec3; cells: T[] }[]; orphans: T[] } {
	const groups = new Map<string, { vantage: Vec3; cells: T[] }>();
	const orphans: T[] = [];
	for (const cell of cells) {
		const serving = vantages.find((vantage) => reachFrom(vantage, cell.at) <= BLOCK_REACH);
		if (serving == null) {
			orphans.push(cell);
			continue;
		}
		const key = cellKey(serving);
		const group = groups.get(key);
		if (group == null) groups.set(key, { vantage: serving, cells: [cell] });
		else group.cells.push(cell);
	}
	return { groups: [...groups.values()], orphans };
}

/**
 * 放一格（批30：不再逐格走位——站位由分区批量安排）。
 * - `no-support` / 放置未落：defer 给下一轮（相邻格可能本轮稍后建成）；
 * - `out-of-reach`：defer 带因（下一轮按当前站位重新分区，可能就够着了）；
 * - 其余结局按事实结算。
 */
async function placeCellTarget(
	ctx: CallContext,
	at: Vec3,
	spec: BlockSpec,
	replace: boolean,
): Promise<CellResult | { kind: "defer"; reason: string }> {
	const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
	const pre = await inspectPlacement(ctx.world, self, at, spec, { replace });
	if (pre.kind === "already") return { kind: "done", counted: "skipped" };
	if (pre.kind === "conflict") return { kind: "failed", reason: `cell holds ${pre.by}` };
	if (pre.kind === "missing") return { kind: "failed", reason: `no ${pre.name} left in the inventory` };
	if (pre.kind === "no-support") return { kind: "defer", reason: "no clickable support face yet" };
	if (pre.kind === "out-of-reach") return { kind: "defer", reason: pre.detail };
	const outcome = await ctx.withBody(async (scope: BodyCallScope) =>
		commitPlacement(ctx, scope, self, spec, pre.aims, pre.heldName),
	);
	if (outcome.kind === "placed") return { kind: "done", counted: "placed" };
	const after = await readBlockAt(ctx.world, at);
	if (matchesDeclared(spec, after)) return { kind: "done", counted: "placed" };
	// 所有支撑面都没成：不是终局。可能只是相邻格还没放好（门顶、悬挑），
	// 交给下一轮再试；轮数上界与"这轮毫无进展就停"共同保证不会无限重试。
	const detail = outcome.kind === "not_met" ? `got ${outcome.actual ?? "nothing"}` : "outcome unknown";
	return { kind: "defer", reason: `placement not confirmed (${detail})` };
}

/**
 * 走近一格：受控导航作用域，不挖不垫（施工不该顺手改现场）。
 * 取消要如实上抛；走不过去把原因带回去——"还是够不着"和"根本没走到"是两件事，
 * 混成一句话会让 remaining 的解释变成猜测。
 */
async function walkToward(
	deps: CapabilityDeps,
	ctx: CallContext,
	owner: ControlOwner,
	at: Vec3,
): Promise<string | null> {
	const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
	const flat = Math.hypot(self.place.position.x - (at.x + 0.5), self.place.position.z - (at.z + 0.5));
	// 一两格的站间移动用 lookAt+drive：GoalNear 在近距会"已在容差内"直接结算，
	// 一步都不走（经验 19/22），看起来像走位成功其实原地没动。
	if (flat <= 2.4 && Math.abs(self.place.position.y - at.y) < 1.6) {
		const ok = await ctx.withBody(async (scope: BodyCallScope) => stepTo(ctx, scope, at, { maxMs: 4_000 }));
		return ok ? null : `STEP_FAILED: could not step to ${at.x},${at.y},${at.z}`;
	}
	try {
		await walkLeg(deps, ctx, owner, at, { tolerance: 2, timeoutMs: LEG_TIMEOUT_MS, digThrough: false });
		return null;
	} catch (error) {
		if (ctx.signal.aborted) throw error;
		const failure = error as { code?: string; message?: string };
		return `${failure.code ?? "WALK_FAILED"}: ${failure.message ?? String(error)}`;
	}
}

export const buildModule: MinecraftCapabilityModule = {
	id: "build",
	definitions: [
		{
			kind: "action",
			descriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as BuildInput;
					const budget = raw.maxTimeMs ?? DEFAULT_MAX_TIME_MS;
					const deadline = Date.now() + budget;
					const owner: ControlOwner = { kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId };

					// 1. 读一次计划（同一份输入，去掉执行期限）。蓝图缺失 / digest 不符 / airPolicy 缺失
					//    都在这里抛出，不消耗任何游戏动作。
					const { maxTimeMs: _ignored, ...planInput } = raw as BuildInput & Record<string, JsonValue>;
					void _ignored;
					const observation = await ctx.world.read<BuildPlanValue>({
						ref: BUILD_PLAN_REF,
						input: planInput as JsonValue,
					});
					const plan = observation.value;
					if (plan == null) {
						fail("NOT_FOUND", "build.plan@1 returned no design", { hint: observation.unknown.join("; ") });
					}
					const blueprint = plan.blueprint != null ? { ref: plan.blueprint.ref, digest: plan.blueprint.digest } : null;

					// 2. 派发前的全部拒绝。
					if (plan.blocked.length > 0) {
						const first = plan.blocked[0]!;
						fail(
							"CONFLICT",
							`${plan.blocked.length} target cell(s) are occupied, first at ${first.at.x},${first.at.y},${first.at.z} by ${first.by}`,
							{
								hint: "pass replace=true only when the design explicitly allows clearing that cell",
								progress: { blocked: plan.blocked.length },
							},
						);
					}
					const shortNames = Object.keys(plan.missing);
					if (shortNames.length > 0) {
						fail("MISSING_MATERIAL", `the design is short ${shortNames.length} material(s)`, {
							hint: shortNames.map((name) => `${name}+${plan.missing[name]}`).join(", "),
							progress: { missing: plan.missing, need: plan.need },
						});
					}

					const clears = plan.targets.filter((cell) => cell.kind === "clear").sort((a, b) => b.at.y - a.at.y);
					const sets = plan.targets.filter((cell) => cell.kind === "set");
					const byKey = new Map(plan.targets.map((cell) => [cellKey(cell.at), cell]));

					let placed = 0;
					let cleared = 0;
					let skipped = plan.targets.length - clears.length - sets.length;
					let processed = 0;
					/** 试过但没成：带原因。 */
					const unfinished = new Map<string, Unfinished>();
					/** 已结算（placed/cleared/skipped），不再出现在 remaining 里。 */
					const accounted = new Set<string>();
					/** 真正要动的格，按设计顺序——remaining 的补全按它的顺序走，读数才稳定。 */
					const actionable = [...clears, ...sets];

					const progress = (): Progress => {
						// remaining 必须包含**从没轮到过**的格：预算耗尽时队列只走了一小段，
						// 只报 unfinished 会让"还剩 67 格"说成"什么都不剩"（真服踩过）。
						const remaining = [...unfinished.values()];
						for (const cell of actionable) {
							const key = cellKey(cell.at);
							if (accounted.has(key) || unfinished.has(key)) continue;
							remaining.push({ at: cell.at, target: targetLabel(cell), reason: "not attempted yet" });
						}
						return {
							placed,
							cleared,
							skipped,
							remainingCount: remaining.length,
							remaining: remaining.slice(0, REMAINING_DETAIL_LIMIT) as unknown as JsonValue,
							...(blueprint != null ? { blueprint } : {}),
						};
					};
					const stopIfDone = (what: string): void => {
						if (ctx.signal.aborted) {
							fail("INTERRUPTED", `${what} was interrupted`, { progress: progress(), recoverable: true });
						}
						if (Date.now() >= deadline) {
							fail("TIMEOUT", `build budget of ${budget}ms ran out`, { progress: progress(), recoverable: true });
						}
					};
					const account = (cell: ConstructionTargetCell, result: CellResult): void => {
						processed += 1;
						const key = cellKey(cell.at);
						if (result.kind === "done") {
							accounted.add(key);
							if (result.counted === "placed") placed += 1;
							else if (result.counted === "cleared") cleared += 1;
							else skipped += 1;
							return;
						}
						unfinished.set(key, { at: cell.at, target: targetLabel(cell), reason: result.reason });
					};

					// 3. 清空阶段：自上而下。
					for (const cell of clears) {
						stopIfDone("clearing");
						account(cell, await clearCell(deps, ctx, owner, cell.at));
						if (processed % PROGRESS_EVERY === 0) await ctx.progress(progress());
					}

					// 4. 放置阶段：**站位分区批量**，多轮收敛。
					//
					//    三件事必须一起做，否则真服上建不完或走位浪费：
					//    a) 上层的格子常常要等邻居先放好才有可点的面（屋顶内圈、悬挑）——
					//       一轮到底必然漏格，靠"defer → 下一轮"收敛，一轮零建成即停；
					//    b) 站位分区：每格按候选序（盒中心 → 四侧 pad）取第一个几何射程
					//       满足的站位，同站位格一批执行——每站位一次走位，而不是每格一次；
					//    c) 组内按列自下而上，任何已完成的列都是 ≥3 高的墙，寻路只能绕行；
					//       组序先"当前就站在该站位"（零走位），再按平距从近到远。
					const box = boxOf(plan.targets);
					/** defer 原因跟格走（最后一轮的分区/执行结论）。 */
					const deferReasons = new Map<string, string>();
					let queue = sets;
					for (let pass = 0; pass < MAX_PASSES && queue.length > 0; pass++) {
						const selfNow = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
						const herePos = selfNow.place.position;
						// 当前脚位是第一候选：站着的地方不需要可站性核验，射程内的格
						// 零走位直接进"这里"组（相邻格 already/skip 不付任何动作）。
						const hereCandidate = { x: Math.floor(herePos.x), y: Math.floor(herePos.y), z: Math.floor(herePos.z) };
						const vantageY = Math.floor(herePos.y);
						// 其余站位候选世界核验（一次/候选/轮）：只认空气/可替换 + 下方实心。
						const vantages: Vec3[] = [hereCandidate];
						for (const candidate of boxVantages(box, vantageY)) {
							if (cellKey(candidate) === cellKey(hereCandidate)) continue;
							const here = await readBlockAt(ctx.world, candidate);
							if (here != null && here.name !== "air" && !isReplaceableName(here.name)) continue;
							const below = await readBlockAt(ctx.world, { x: candidate.x, y: candidate.y - 1, z: candidate.z });
							if (below == null || isReplaceableName(below.name)) continue;
							vantages.push(candidate);
						}
						// 分区：每格取第一个射程满足的站位；没有的如实 defer（几何上无解）。
						const { groups: groupList, orphans } = assignVantageZones(queue, vantages);
						const groups = new Map(groupList.map((group) => [cellKey(group.vantage), group]));
						const deferred: ConstructionTargetCell[] = [];
						for (const cell of orphans) {
							deferred.push(cell);
							deferReasons.set(cellKey(cell.at), "no candidate vantage within reach");
						}
						// 组序：当前就站在该站位（零走位）优先，其余按平距从近到远。
						const ordered = [...groups.values()].sort(
							(a, b) =>
								(flatDist(herePos, a.vantage) <= 2 ? 0 : 1) - (flatDist(herePos, b.vantage) <= 2 ? 0 : 1) ||
								flatDist(herePos, a.vantage) - flatDist(herePos, b.vantage),
						);
						let builtThisPass = 0;
						for (const group of ordered) {
							stopIfDone("building");
							// 每站位一走：走失败整组如实 defer（下一轮重分区，可能换到别的站位）。
							if (flatDist(herePos, group.vantage) > 2) {
								const walkError = await walkToward(deps, ctx, owner, group.vantage);
								if (walkError != null) {
									for (const cell of group.cells) {
										deferred.push(cell);
										deferReasons.set(
											cellKey(cell.at),
											`walk to vantage ${cellKey(group.vantage)} failed (${walkError})`,
										);
									}
									continue;
								}
							}
							// 组内按列自下而上（y 升序，同列从地面往屋顶）。
							group.cells.sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x || a.at.z - b.at.z);
							for (const cell of group.cells) {
								stopIfDone("building");
								const result = await placeCellTarget(ctx, cell.at, cell.block as BlockSpec, raw.replace === true);
								if (result.kind === "defer") {
									deferred.push(cell);
									deferReasons.set(cellKey(cell.at), result.reason);
								} else {
									account(cell, result);
									if (result.kind === "done") builtThisPass += 1;
								}
								if (processed % PROGRESS_EVERY === 0) await ctx.progress(progress());
							}
						}
						queue = deferred;
						if (builtThisPass === 0) break;
					}
					for (const cell of queue) {
						unfinished.set(cellKey(cell.at), {
							at: cell.at,
							target: targetLabel(cell),
							reason: deferReasons.get(cellKey(cell.at)) ?? "no clickable support face appeared after several passes",
						});
					}

					// 5. 收尾核验：未完成格按世界读数再判一次。
					for (const [key, pending] of [...unfinished.entries()]) {
						const cell = byKey.get(key)!;
						const current = await readBlockAt(ctx.world, pending.at);
						if (cell.kind === "clear") {
							if (current != null && current.name === "air") {
								cleared += 1;
								unfinished.delete(key);
								accounted.add(key);
							}
						} else if (matchesDeclared(cell.block as BlockSpec, current)) {
							placed += 1;
							unfinished.delete(key);
							accounted.add(key);
						}
					}

					if (unfinished.size > 0) {
						const remaining = [...unfinished.values()];
						fail(
							"TARGET_NOT_MET",
							`${remaining.length} of ${plan.targets.length} target cell(s) do not match the design`,
							{
								hint: remaining
									.slice(0, 4)
									.map((entry) => `${entry.at.x},${entry.at.y},${entry.at.z} ${entry.target}: ${entry.reason}`)
									.join("; "),
								dispatch: "sent",
								progress: progress(),
							},
						);
					}

					return plain({
						placed,
						cleared,
						skipped,
						remaining: [],
						...(blueprint != null ? { blueprint } : {}),
					});
				},
		},
	],
};
