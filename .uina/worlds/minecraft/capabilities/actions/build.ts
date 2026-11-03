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
import type { BodyCallScope, CallableDescriptor, CallContext, NativeCallable } from "../../contracts/capabilities.js";
import type { ExactRef, JsonValue, Progress, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { BuildPlanValue, ConstructionTargetCell } from "../../contracts/world.js";
import type { CapabilityDeps } from "../deps.js";
import { readValue } from "../shared/observe.js";
import { BLOCK_REACH, blockReach } from "../shared/reach.js";
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
/** 放置阶段的轮数上限：每轮至少建成一格才会继续，所以真实轮数远小于这个数。 */
const MAX_PASSES = 4;

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

export function buildCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
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

			// 4. 放置阶段：**按列自下而上**，多轮。
			//
			//    两件事必须一起做，否则真服上根本建不完：
			//    a) 上层的格子常常要等邻居先放好才有可点的面（屋顶内圈、悬挑），一轮到底必然漏格；
			//    b) 列内自下而上，任何已完成的列都是 ≥3 高的墙，寻路只能绕行。
			//       按层铺会让"1 格高的成品面"连成片，寻路会尝试跨上去，而 1 格上坡在
			//       本机是已知未修的 Driver 缺口（G21 贴面起跳楔死）——整批走位都会 TIMEOUT。
			//
			//    某一轮什么都没建成即停：剩下的确实是当前做不了的。
			const box = boxOf(plan.targets);
			const boxCenter = {
				x: (box.min.x + box.max.x) / 2,
				z: (box.min.z + box.max.z) / 2,
			};
			const walked = new Set<string>();
			let queue = sets;
			for (let pass = 0; pass < MAX_PASSES && queue.length > 0; pass++) {
				const deferred: ConstructionTargetCell[] = [];
				const columns = new Map<string, ConstructionTargetCell[]>();
				for (const cell of queue) {
					const key = `${cell.at.x},${cell.at.z}`;
					const column = columns.get(key);
					if (column == null) columns.set(key, [cell]);
					else column.push(cell);
				}
				// 由盒中心向外：先把智能体送进空盒，再一圈一圈往外建。
				// 按"离玩家远近"排序会把外墙先立起来，随后中心就被自己封死——
				// 真服实测：走进去的最后一次机会在墙合拢之前，之后每一次 goto 都是 TIMEOUT。
				const anchors = [...columns.values()]
					.map((column) => column[0]!.at)
					.sort(
						(a, b) =>
							Math.abs(a.x - boxCenter.x) +
								Math.abs(a.z - boxCenter.z) -
								(Math.abs(b.x - boxCenter.x) + Math.abs(b.z - boxCenter.z)) ||
							a.y - b.y ||
							a.x - b.x ||
							a.z - b.z,
					);
				let builtThisPass = 0;
				for (const anchor of anchors) {
					const column = columns.get(`${anchor.x},${anchor.z}`)!;
					column.sort((a, b) => a.at.y - b.at.y);
					for (const cell of column) {
						stopIfDone("building");
						const result = await placeCellTarget(
							deps,
							ctx,
							owner,
							cell.at,
							cell.block as BlockSpec,
							raw.replace === true,
							box,
							walked,
						);
						if (result.kind === "defer") deferred.push(cell);
						else {
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
					reason: "no clickable support face appeared after several passes",
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
				fail("TARGET_NOT_MET", `${remaining.length} of ${plan.targets.length} target cell(s) do not match the design`, {
					hint: remaining
						.slice(0, 4)
						.map((entry) => `${entry.at.x},${entry.at.y},${entry.at.z} ${entry.target}: ${entry.reason}`)
						.join("; "),
					dispatch: "sent",
					progress: progress(),
				});
			}

			return plain({
				placed,
				cleared,
				skipped,
				remaining: [],
				...(blueprint != null ? { blueprint } : {}),
			});
		},
	};
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
 * 站位候选，按优先级：**盒中心**，其次盒外靠近目标那一侧的地面格。
 *
 * 盒中心先试是实测结论：一个 5×5×4 的小屋，站在中心时**全部 74 个目标格都在 4.5 射程内**
 * （墙最远 2 格、屋顶最高 4 格），于是整栋房子不需要任何横向走位。反过来，站在盒外
 * 就只有同侧够得着，另一侧必须绕行——而绕行需要跨过 1 格高的成品面，这在本机是已知
 * 未修的 Driver 缺口（G21 贴面起跳楔死，真服实测 goto 必然 TIMEOUT）。
 * 中心进不去（墙已经立起来）才退回盒外站位。
 *
 * 候选按序尝试：走失败就换下一个，全都不行才如实报拿不到。
 */
async function vantageCandidates(ctx: CallContext, cell: Vec3, box: Box, self: SelfState): Promise<Vec3[]> {
	const y = Math.floor(self.place.position.y);
	const centerX = Math.round((box.min.x + box.max.x) / 2);
	const centerZ = Math.round((box.min.z + box.max.z) / 2);
	const east = cell.x >= centerX;
	const south = cell.z >= centerZ;
	const candidates: Vec3[] = [{ x: centerX, y, z: centerZ }];
	// 再多一个"朝目标挪一格"的候选，但只在**一步之内**（≤2.2 格，走 stepTo 而不是 goto）。
	// 5×5 小屋的远角从盒中心量是 4.76，刚好超出 4.5；挪一格就落到 2.5。
	// 不限距离地挑"最近的盒内格"会把每次放置都变成一次横向赶路，实测反而全面 TIMEOUT。
	const stepped = { x: cell.x + Math.sign(centerX - cell.x), y, z: cell.z + Math.sign(centerZ - cell.z) };
	const stepFlat = Math.hypot(self.place.position.x - (stepped.x + 0.5), self.place.position.z - (stepped.z + 0.5));
	if (stepFlat <= 2.2 && (stepped.x !== cell.x || stepped.z !== cell.z)) candidates.push(stepped);
	for (const pad of [1, 2]) {
		candidates.push(
			{ x: east ? box.max.x + pad : box.min.x - pad, y, z: cell.z },
			{ x: cell.x, y, z: south ? box.max.z + pad : box.min.z - pad },
		);
	}
	const standable: Vec3[] = [];
	for (const at of candidates) {
		const here = await readBlockAt(ctx.world, at);
		// 未加载不当成可站（null），只认空气/可替换。
		if (here != null && here.name !== "air" && !isReplaceableName(here.name)) continue;
		const below = await readBlockAt(ctx.world, { x: at.x, y: at.y - 1, z: at.z });
		if (below == null || isReplaceableName(below.name)) continue;
		standable.push(at);
	}
	return standable;
}

/**
 * 放一格。
 * - `no-support`（还没有可点的面）不是失败：交给调用方下一轮再来，绝不为此走位；
 * - `out-of-reach` 走到盒外的一个站位再判，同一格只走一次（`walked` 记着）；
 * - 其余结局按事实结算。
 */
async function placeCellTarget(
	deps: CapabilityDeps,
	ctx: CallContext,
	owner: ControlOwner,
	at: Vec3,
	spec: BlockSpec,
	replace: boolean,
	box: Box,
	walked: Set<string>,
): Promise<CellResult | { kind: "defer" }> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
		const pre = await inspectPlacement(ctx.world, self, at, spec, { replace });
		if (pre.kind === "already") return { kind: "done", counted: "skipped" };
		if (pre.kind === "conflict") return { kind: "failed", reason: `cell holds ${pre.by}` };
		if (pre.kind === "missing") return { kind: "failed", reason: `no ${pre.name} left in the inventory` };
		if (pre.kind === "no-support") return { kind: "defer" };
		if (pre.kind === "out-of-reach") {
			const key = cellKey(at);
			if (attempt > 0 || walked.has(key)) return { kind: "failed", reason: `unreachable (${pre.detail})` };
			walked.add(key);
			const vantages = await vantageCandidates(ctx, at, box, self);
			if (vantages.length === 0) return { kind: "failed", reason: `no standable spot to build from for ${pre.detail}` };
			// 走位预算只花一次：走到第一个可行站位就用它重判射程；走失败立刻如实报，
			// 不把整批预算耗在反复尝试上（每次失败都是整整一个 walk 超时）。
			const walkError = await walkToward(deps, ctx, owner, vantages[0]!);
			if (walkError != null) {
				return {
					kind: "failed",
					reason: `walk to ${vantages[0]!.x},${vantages[0]!.y},${vantages[0]!.z} failed (${walkError})`,
				};
			}
			const reached = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			if (blockReach(reached, at) > BLOCK_REACH) {
				return { kind: "failed", reason: `still out of reach after walking (${pre.detail})` };
			}
			continue;
		}
		const outcome = await ctx.withBody(async (scope: BodyCallScope) =>
			commitPlacement(ctx, scope, self, spec, pre.aims, pre.heldName),
		);
		if (outcome.kind === "placed") return { kind: "done", counted: "placed" };
		const after = await readBlockAt(ctx.world, at);
		if (matchesDeclared(spec, after)) return { kind: "done", counted: "placed" };
		// 所有支撑面都没成：不是终局。可能只是相邻格还没放好（门顶、悬挑），
		// 交给下一轮再试；轮数上界与"这轮毫无进展就停"共同保证不会无限重试。
		return { kind: "defer" };
	}
	return { kind: "failed", reason: "unreachable" };
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
