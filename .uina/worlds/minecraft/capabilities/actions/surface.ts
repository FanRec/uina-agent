/**
 * surface@1：从洞穴/水下回到露天且可站立的位置。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 surface、§10 阶段 B。
 * 会话是单一 navigate 作用域（explore 同模式），全部移动走受控寻路：
 * 水下找露天岸柱游过去、找不到就向上游；陆地下找露天出口走过去（可挖），
 * 找不到就同柱竖井上升（受控寻路的挖顶+垫柱，placeToReach 供给 dirt/cobblestone）。
 * 不嵌套 withBody——身体租赁与导航互斥，surface 没有需要手的动作。
 * 判据来自注入的 SurfaceProbe（G3）：standable+skyOpen+onGround 才算 escaped；
 * 未加载区块是未知不是空气，宁可继续找，不猜出口。
 */

import type { ControlOwner, SelfState } from "../../contracts/body.js";
import type { CallableDescriptor, CallContext, NativeCallable } from "../../contracts/capabilities.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import { sleepAbortable } from "../shared/mobility.js";
import { readValue } from "../shared/observe.js";
import { distance, fail } from "../shared/targets.js";
import { readInventory } from "../shared/views.js";

/** 露天出口查找半径：水下（视野好）比地下用得更大。 */
const SWIM_ACCESS_RADIUS = 24;
const LAND_ACCESS_RADIUS = 16;
/** 竖井上升拍的段高与向上游的段高。 */
const SHAFT_RISE = 4;
const SWIM_RISE = 6;
/** 连续失败段数上限：超过按 UNREACHABLE 结算（地形/材料判断不了出口）。 */
const MAX_CONSECUTIVE_LEG_FAILURES = 4;

const descriptor: CallableDescriptor = {
	ref: "surface@1",
	summary:
		"Escape an underwater or underground position to a sky-open standable spot; swims toward openings or digs/towers a shaft",
	tags: ["body", "navigation"],
	input: {
		type: "object",
		properties: {
			maxTimeMs: { type: "number", minimum: 1000, maximum: 600000, description: "wall-clock budget (default 120000)" },
		},
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			at: { type: "object" },
			escaped: { type: "boolean" },
			reason: {
				type: ["string", "null"],
				description: "escape route taken: swam_to_shore/swam_up/walked_to_opening/dug_shaft",
			},
		},
		required: ["at", "escaped"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"escaped=true requires the standable+skyOpen+onGround probe at the final spot; budget exhaustion raises TIMEOUT and dead ends raise UNREACHABLE, both keeping attempts/dug progress",
	},
	errors: [
		{
			code: "TIMEOUT",
			meaning: "budget exhausted before reaching a sky-open standable spot (progress keeps attempts/dug)",
		},
		{ code: "UNREACHABLE", meaning: "legs keep failing (no sky access, blocked shaft, or no placeable blocks)" },
		{ code: "INTERRUPTED", meaning: "the run was stopped or safety took over (progress keeps attempts/dug)" },
		{ code: "CONTROL_CONFLICT", meaning: "another controlled navigation holds the client" },
		{ code: "DISCONNECTED", meaning: "the connection ended during the escape" },
	],
	requires: ["connection"],
	examples: [
		{
			input: { maxTimeMs: 60000 },
			output: {
				at: { position: { x: 12, y: 199, z: -4 }, dimension: "overworld" },
				escaped: true,
				reason: "dug_shaft",
			},
		},
	],
	implementation: "native",
};

interface SurfaceInput {
	maxTimeMs?: number;
}

interface LegRequest {
	at: Vec3;
	tolerance: number;
	sprint: boolean;
	digThrough: boolean;
	placeToReach: boolean;
}

interface LegPlan {
	request: LegRequest;
	reason: string;
}

export function surfaceCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
			const raw = input as unknown as SurfaceInput;
			const deadline = Date.now() + (raw.maxTimeMs ?? 120000);
			const outcome = await escapeToSurface(deps, ctx, deadline);
			const final = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			return plain({
				at: { position: outcome.at, dimension: final.place.dimension },
				escaped: true,
				reason: outcome.reason,
			});
		},
	};
}

/**
 * 脱困会话主体：surface@1 的 callable 与 fight 的 cautious 撤退共用。
 * 要求调用方当前持有 call frame 且未持身体（内部自开 navigate 作用域）；
 * 失败抛 TIMEOUT/UNREACHABLE/INTERRUPTED，由调用方决定是否继续。
 */
export async function escapeToSurface(
	deps: CapabilityDeps,
	ctx: CallContext,
	deadline: number,
): Promise<{ at: Vec3; reason: string | null }> {
	const probe = deps.surface();
	if (probe == null) {
		fail("DISCONNECTED", "surface needs the client connection for block probing", { recoverable: false });
	}
	const owner: ControlOwner = { kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId };
	return await deps.runtime().navigate(owner, async (): Promise<{ at: Vec3; reason: string | null }> => {
		let reason: string | null = null;
		let attempts = 0;
		let dug = 0;
		let consecutiveFailures = 0;
		let self: SelfState;
		for (;;) {
			if (ctx.signal.aborted) {
				fail("INTERRUPTED", "surface was interrupted by run stop or safety", {
					dispatch: "sent",
					progress: { attempts, dug },
					recoverable: true,
				});
			}
			if (Date.now() >= deadline) {
				fail("TIMEOUT", `surface budget exhausted after ${attempts} legs (${dug} dug)`, {
					dispatch: "sent",
					progress: { attempts, dug },
					recoverable: true,
				});
			}
			self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			const here = self.place.position;
			if (self.onGround && (await probe.standable(here)) === true && (await probe.skyOpen(here)) === true) {
				return { at: here, reason };
			}
			// 下界没有正常意义的"露天"（顶部基岩层）：跳过无意义的天空出口大扫描，
			// 直接走向上游/竖井上升的脱困腿。
			const skySearch = !(self.place.dimension ?? "").includes("nether");
			const remaining = deadline - Date.now();
			const plan: LegPlan | null =
				self.inWater === true
					? await waterLeg(probe, here, skySearch, ctx.signal)
					: await landLeg(ctx, probe, here, skySearch);
			if (plan == null) {
				// 已在出口近旁但判据未过：重查仍在同一拍发生，连续多次即视为死局，
				// 不允许"空转等待预算烧尽"。
				consecutiveFailures += 1;
				if (consecutiveFailures >= MAX_CONSECUTIVE_LEG_FAILURES) {
					fail("UNREACHABLE", `probe keeps pointing at the current spot but it does not satisfy the escape criteria`, {
						dispatch: "sent",
						progress: { attempts, dug },
						recoverable: true,
					});
				}
				await sleepAbortable(500, ctx.signal);
				continue;
			}
			consecutiveFailures = 0;
			reason = plan.reason;
			const legStart = { ...here };
			try {
				const legOutcome = await deps.gotoDirector.goto(
					{
						at: plan.request.at,
						tolerance: plan.request.tolerance,
						sprint: plan.request.sprint,
						digThrough: plan.request.digThrough,
						placeToReach: plan.request.placeToReach,
						timeoutMs: Math.min(20000, remaining),
					},
					ctx.signal,
				);
				dug += legOutcome.dug;
			} catch (error) {
				if (ctx.signal.aborted) {
					fail("INTERRUPTED", "surface was interrupted by run stop or safety", {
						dispatch: "sent",
						progress: { attempts, dug },
						recoverable: true,
					});
				}
				const code = (error as { code?: string }).code;
				if (code !== "UNREACHABLE" && code !== "TIMEOUT") {
					throw error;
				}
			}
			self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			// 循环破坏器：腿"成功"但实际没动（目标已在容差内、瞬时 met）与腿失败同样计一次
			// 停滞；只有真实位移才重置。四拍停滞如实 UNREACHABLE，不许原地烧预算。
			if (distance(legStart, self.place.position) > 0.5) {
				consecutiveFailures = 0;
			} else {
				consecutiveFailures += 1;
				if (consecutiveFailures >= MAX_CONSECUTIVE_LEG_FAILURES) {
					fail("UNREACHABLE", "legs stopped making progress toward a sky-open standable spot", {
						dispatch: "sent",
						progress: { attempts, dug },
						recoverable: true,
					});
				}
			}
			attempts += 1;
			await ctx.progress({ attempts, dug });
		}
	});
}

/** 水下阶段：找露天可站岸柱游过去；找不到就向上游一段换气。 */
async function waterLeg(
	probe: NonNullable<ReturnType<CapabilityDeps["surface"]>>,
	here: Vec3,
	skySearch: boolean,
	signal: AbortSignal,
): Promise<LegPlan | null> {
	const access = skySearch ? await probe.findSkyAccess(here, SWIM_ACCESS_RADIUS, signal) : null;
	if (access == null) {
		return {
			request: leg(
				{ x: Math.floor(here.x), y: Math.floor(here.y) + SWIM_RISE, z: Math.floor(here.z) },
				2,
				true,
				false,
				false,
			),
			reason: "swam_up",
		};
	}
	// 深水下先垂直上浮（快速回到水面换气，不给溺水自保打断的机会），到水面再上岸。
	// 目标锚在出口水面高度（access.y - 1）：GoalNear 在水里就可满足（浮到水面即 met），
	// 抬到水面之上的目标在开阔水中不可满足，寻路只会在水下空转到溺水（真服实测）。
	// 已在出口近旁时目标抬高 1 格：水面漂浮的脚位满足 GoalNear 容差但仍是"泡在水里"，
	// 不抬高的话腿会在井口反复"到达"而永远上不了岸（真服实测）。
	const deep = access.y - Math.floor(here.y) > 2;
	if (deep) {
		return {
			request: leg({ x: Math.floor(here.x), y: access.y - 1, z: Math.floor(here.z) }, 2, true, false, false),
			reason: "swam_up",
		};
	}
	const near = distance(here, access) <= 2;
	const at = near ? { x: access.x, y: access.y + 1, z: access.z } : access;
	return { request: leg(at, 1, true, false, true), reason: "swam_to_shore" };
}

/** 陆地阶段：找露天出口走过去（可挖）；找不到就同柱竖井上升（需要可垫材料）。 */
async function landLeg(
	ctx: CallContext,
	probe: NonNullable<ReturnType<CapabilityDeps["surface"]>>,
	here: Vec3,
	skySearch: boolean,
): Promise<LegPlan | null> {
	const access = skySearch ? await probe.findSkyAccess(here, LAND_ACCESS_RADIUS, ctx.signal) : null;
	if (access != null && distance(here, access) > 1.5) {
		return { request: leg(access, 1, true, true, true), reason: "walked_to_opening" };
	}
	if (access != null) return null; // 出口在近旁但判据未过（如还没站稳），主循环重查
	const inventory = await readInventory(ctx.world);
	if ((inventory.counts.dirt ?? 0) <= 0 && (inventory.counts.cobblestone ?? 0) <= 0) {
		fail("UNREACHABLE", "no sky access nearby and no placeable blocks (dirt/cobblestone) for a shaft", {
			hint: "bring dirt or cobblestone to tower up",
			progress: { counts: inventory.counts },
		});
	}
	return {
		request: leg(
			{ x: Math.floor(here.x), y: Math.floor(here.y) + SHAFT_RISE, z: Math.floor(here.z) },
			1,
			false,
			true,
			true,
		),
		reason: "dug_shaft",
	};
}

function leg(at: Vec3, tolerance: number, sprint: boolean, digThrough: boolean, placeToReach: boolean): LegRequest {
	return { at, tolerance, sprint, digThrough, placeToReach };
}
