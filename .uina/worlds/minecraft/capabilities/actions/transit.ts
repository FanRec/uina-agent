/**
 * transit@1：跨维度旅行的唯一入口（走 → 找/建门 → 点亮 → 进 → 落地）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 transit。
 *
 * 阶段必须**兄弟化**：goto 占导航槽、withBody 占身体槽，Runtime 在持有身体时
 * 拒绝独立导航（engine.runNavigation 见 frame.bodyLease 即 CONTROL_CONFLICT），
 * 所以每个阶段各自开合，绝不在 withBody 里调 goto。
 *
 * 完成判据是 `self.place.dimension === destination.dimension`（给了 at 还要到容差内），
 * 不是"动作都派发出去了"。交通方式不可用时如实失败，不静默退化成步行。
 */

import { isReplaceableName, resolvePoint } from "../../construction/target.js";
import type { ControlOwner, SelfState } from "../../contracts/body.js";
import type { CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import type { CapabilityDeps } from "../deps.js";
import { sleepAbortable } from "../shared/mobility.js";
import { readValue } from "../shared/observe.js";
import {
	bareDimension,
	LINKED_SITE_RADIUS,
	linkedCoordinates,
	PORTAL_IGNITER,
	PORTAL_OBSIDIAN_COST,
	type PortalFrame,
	type PortalSite,
	portalSite,
	portalSiteAccess,
	regionGrid,
	siteBounds,
	siteCandidates,
} from "../shared/portal.js";
import { distance, fail } from "../shared/targets.js";
import { itemCountOf, readBlockAt, readInventory } from "../shared/views.js";
import { commitPlacement, inspectPlacement, placeOf } from "./place-cell.js";

const KNOWN_DIMENSIONS = new Set(["overworld", "the_nether", "the_end"]);
/** 下界门只在主世界与下界之间成立；末地要走末地传送门框架，本能力不建。 */
const PORTAL_DIMENSIONS = new Set(["overworld", "the_nether"]);
const TRANSPORTS = ["portal", "minecart", "boat", "horse"] as const;
type Transport = (typeof TRANSPORTS)[number];

/** 找门的水平半径：64 是 blocks@1 的上限，也覆盖了下界门的实际链接范围。 */
const PORTAL_SEARCH_RADIUS = 64;
/** 选址的搜索半径（格）：先原地，再按环向外扩。 */
const SITE_SEARCH_RADIUS = 6;
/** 等维度切换的预算：首次进下界要生成地形，给足 60s。 */
const DIMENSION_WAIT_MS = 60000;
/** 进门/出门的推进拍数（4 拍 ≈ 200ms 一格）。 */
const WALK_OUT_TICKS = 14;
/** 进门那一小段：门面一格厚，一步走多了就穿过去了，按 2 拍一步推进并逐步复核。 */
const ENTER_STEP_TICKS = 2;
const ENTER_STEPS = 12;
/**
 * 站进门内后等传送的窗口。
 *
 * 两段计时叠在一起：站满 80 拍（实测 3.6s 传送）+ 刚用过门的 300 拍冷却（15s，冷却期内
 * 站进去什么都不发生）。取 20s 覆盖两者；正常情况 4s 内就返回，只有真卡住才用满。
 */
const PORTAL_WAIT_MS = 20000;

const descriptor: CallableDescriptor = {
	ref: "transit@1",
	summary:
		"Travel to another dimension through a nether portal: walk to a portal, build and light one when missing, enter it, then finish at the destination",
	tags: ["body", "navigation", "travel"],
	input: {
		type: "object",
		properties: {
			destination: {
				type: "object",
				properties: {
					dimension: { type: "string", description: "minecraft:overworld / minecraft:the_nether / minecraft:the_end" },
					at: { type: "object", description: "optional landing point, in the destination dimension" },
				},
				required: ["dimension"],
				additionalProperties: false,
			},
			allow: {
				type: "array",
				items: { enum: [...TRANSPORTS] },
				minItems: 1,
				maxItems: TRANSPORTS.length,
				description: "transport kinds the caller allows (default: portal only)",
			},
			maxTimeMs: { type: "number", minimum: 1000, maximum: 1800000, description: "wall-clock budget (default 600000)" },
		},
		required: ["destination"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			reached: { type: "boolean" },
			dimension: { type: "string" },
			at: { type: "object" },
			stages: { type: "array", items: { type: "object" } },
		},
		required: ["reached", "dimension", "at", "stages"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"reached=true requires self.place.dimension to equal destination.dimension (and, when at is given, standing within tolerance); stages reports what actually happened per leg",
	},
	errors: [
		{ code: "INVALID_INPUT", meaning: "unknown dimension, at outside that dimension, or an unknown allow entry" },
		{ code: "MISSING_MATERIAL", meaning: "not enough obsidian or no flint_and_steel to build and light a portal" },
		{
			code: "WRONG_STATE",
			meaning: "portal interior blocked, the frame did not light, or standing in it did not move the body",
		},
		{
			code: "UNREACHABLE",
			meaning: "a stage could not be completed (hint names the stage); never falls back to walking",
		},
		{ code: "TARGET_NOT_MET", meaning: "the server did not confirm a frame cell after the placement was dispatched" },
		{ code: "TIMEOUT", meaning: "the wall-clock budget ran out before the dimension changed" },
		{ code: "INTERRUPTED", meaning: "the run was stopped or safety took over" },
	],
	requires: ["connection"],
	examples: [
		{
			input: { destination: { dimension: "minecraft:the_nether", at: { x: 16, y: 70, z: 16 } } },
			output: {
				reached: true,
				dimension: "the_nether",
				at: { x: 16.5, y: 70, z: 16.5 },
				stages: [
					{ kind: "portal", ok: true, reason: "built (14 obsidian)" },
					{ kind: "enter", ok: true },
					{ kind: "leave", ok: true },
					{ kind: "goto", ok: true },
				],
			},
		},
	],
	implementation: "native",
};

interface TransitInput {
	destination: { dimension: string; at?: unknown };
	allow?: Transport[];
	maxTimeMs?: number;
}

interface Stage {
	kind: "goto" | "portal" | "enter" | "leave";
	ok: boolean;
	at?: Vec3;
	reason?: string;
}

interface PortalPlace {
	/** 门内一格（站着进门的那个格，也是进门前的朝向点）。 */
	entrance: Vec3;
	/** 进门那一拍要不要按 jump（门立在平地上时，门内比脚下高一格）。 */
	stepUp: boolean;
}

function report(self: SelfState, stages: Stage[]): JsonValue {
	return plain({
		reached: true,
		dimension: bareDimension(self.place.dimension),
		at: self.place.position,
		stages: stages.map((stage) => ({
			kind: stage.kind,
			ok: stage.ok,
			...(stage.at != null ? { at: stage.at } : {}),
			...(stage.reason != null ? { reason: stage.reason } : {}),
		})),
	});
}

async function readSelf(ctx: CallContext): Promise<SelfState> {
	return await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
}

/** `at` 属于目的维度：裸坐标按目的维度解释，显式 dimension 必须与 destination 一致。 */
function resolveDestinationAt(raw: unknown, target: string, self: SelfState): Vec3 | null {
	if (raw == null) return null;
	const point = resolvePoint(raw, self);
	if (typeof raw === "object" && "position" in raw) {
		const declared = bareDimension((raw as { dimension?: string }).dimension ?? "");
		if (declared !== target) {
			fail("INVALID_INPUT", `destination.at is in ${declared}, but destination.dimension is ${target}`, {
				hint: "either drop the explicit dimension or make the two agree",
			});
		}
	}
	return point.position;
}

/** 一段受控导航（独立开合导航槽，绝不在 withBody 内调用）。 */
async function leg(
	deps: CapabilityDeps,
	ctx: CallContext,
	at: Vec3,
	tolerance: number,
	deadline: number,
	stages: Stage[],
): Promise<void> {
	const budget = Math.min(deadline - Date.now(), 120000);
	if (budget <= 0) {
		fail("TIMEOUT", "transit budget ran out before the walking leg", {
			hint: "stage: goto — the wall-clock budget is exhausted",
			dispatch: "sent",
			progress: { stage: "goto", furthest: at },
		});
	}
	const owner: ControlOwner = { kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId };
	try {
		const outcome = await deps
			.runtime()
			.navigate(owner, () =>
				deps.gotoDirector.goto(
					{ at, tolerance, sprint: true, digThrough: false, placeToReach: false, timeoutMs: budget },
					ctx.signal,
				),
			);
		stages.push({ kind: "goto", ok: true, at: outcome.at });
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "UNREACHABLE" || code === "TIMEOUT") {
			fail(code, `could not walk to ${at.x},${at.y},${at.z}: ${(error as Error).message}`, {
				hint: "stage: goto — the walking leg did not reach its point",
				dispatch: "sent",
				progress: { stage: "goto", furthest: at, at },
			});
		}
		throw error;
	}
}

/** 找门或建门；返回可进的那一格。 */
async function ensurePortal(
	deps: CapabilityDeps,
	ctx: CallContext,
	self: SelfState,
	target: string,
	destinationAt: Vec3 | null,
	deadline: number,
	stages: Stage[],
): Promise<PortalPlace> {
	const existing = await findPortal(ctx, self);
	if (existing != null) {
		stages.push({ kind: "portal", ok: true, at: existing, reason: "found" });
		await leg(deps, ctx, existing, 1, deadline, stages);
		// 现成的门不知道门槛高度：一律带 jump，多跳一拍无害。
		return { entrance: existing, stepUp: true };
	}
	return await buildPortal(deps, ctx, self, target, destinationAt, deadline, stages);
}

/** 已加载区块里的现成传送门（最近的一格）。 */
async function findPortal(ctx: CallContext, self: SelfState): Promise<Vec3 | null> {
	const found = await readValue<{ blocks: { position: Vec3; name: string }[]; count: number }>(
		ctx.world,
		"blocks@1",
		{ name: "nether_portal", radius: PORTAL_SEARCH_RADIUS, limit: 16 },
		ctx.signal,
		"portal search",
	);
	const blocks = found.blocks ?? [];
	if (blocks.length === 0) return null;
	const here = self.place.position;
	const nearest = blocks.map((block) => ({ block, d: distance(here, block.position) })).sort((a, b) => a.d - b.d)[0]!;
	return nearest.block.position;
}

async function buildPortal(
	deps: CapabilityDeps,
	ctx: CallContext,
	self: SelfState,
	target: string,
	destinationAt: Vec3 | null,
	deadline: number,
	stages: Stage[],
): Promise<PortalPlace> {
	const inventory = await readInventory(ctx.world);
	const obsidian = itemCountOf(inventory, "obsidian");
	const igniters = itemCountOf(inventory, PORTAL_IGNITER);
	if (obsidian < PORTAL_OBSIDIAN_COST || igniters < 1) {
		fail(
			"MISSING_MATERIAL",
			`building a portal needs ${PORTAL_OBSIDIAN_COST} obsidian and 1 ${PORTAL_IGNITER}; inventory holds ${obsidian} and ${igniters}`,
			{
				hint: "bring the materials, or travel to a dimension that already has a portal",
				progress: { stage: "portal", obsidian, flint_and_steel: igniters },
			},
		);
	}
	const site = await chooseSite(ctx, self, target, destinationAt);
	// 走到门前站位再施工：放置与点火都要在射程内。
	await leg(deps, ctx, site.approach, 1, deadline, stages);

	const placed = await ctx.withBody(async (scope) => {
		const now = await readSelf(ctx);
		let count = 0;
		for (const cell of site.frame.obsidian) {
			const pre = await inspectPlacement(ctx.world, now, cell, "obsidian", { replace: false });
			if (pre.kind === "already") continue;
			if (pre.kind !== "ready") {
				fail("UNREACHABLE", `cannot place the portal frame at ${cell.x},${cell.y},${cell.z} (${pre.kind})`, {
					hint: "stage: portal — the frame cell cannot be reached or placed",
					dispatch: "sent",
					progress: { stage: "portal", furthest: cell, at: cell, reason: pre.kind },
				});
			}
			const outcome = await commitPlacement(ctx, scope, now, "obsidian", pre.aims, pre.heldName);
			if (outcome.kind === "unconfirmed") {
				fail(
					"TARGET_NOT_MET",
					`the server did not confirm obsidian at ${cell.x},${cell.y},${cell.z} (last ${outcome.last ?? "nothing"})`,
					{
						dispatch: "sent",
						effects: [outcome.effect],
						progress: { stage: "portal", at: cell, expected: outcome.expected, last: outcome.last },
					},
				);
			}
			count += 1;
		}
		return count;
	});

	const lit = await ctx.withBody(async (scope) => {
		const now = await readSelf(ctx);
		const ignite = site.frame.ignite;
		await scope.player.equip({ name: PORTAL_IGNITER }, "hand");
		await scope.player.interact({
			target: { place: placeOf(now, ignite), block: ignite },
			hand: "main",
			face: { x: 0, y: 1, z: 0 },
		});
		return await waitForPortalBlock(ctx, site.frame);
	});
	if (!lit) {
		fail("WRONG_STATE", "the frame did not light: no nether_portal appeared inside it", {
			hint: "the interior may be blocked, or the frame shape is wrong",
			dispatch: "sent",
			progress: { stage: "portal", at: site.frame.entrance, ignite: site.frame.ignite },
		});
	}
	stages.push({ kind: "portal", ok: true, at: site.frame.entrance, reason: `built (${placed} obsidian)` });
	return { entrance: site.frame.entrance, stepUp: site.stepUp };
}

/** 选址：先按目的地换算，超出步行范围就地建；一次 region 读回判定全部候选。 */
async function chooseSite(
	ctx: CallContext,
	self: SelfState,
	target: string,
	destinationAt: Vec3 | null,
): Promise<{ frame: PortalFrame; approach: Vec3; stepUp: boolean }> {
	const here = self.place.position;
	let anchor = here;
	if (destinationAt != null) {
		const linked = linkedCoordinates(self.place.dimension, target, destinationAt);
		if (distance(here, linked) <= LINKED_SITE_RADIUS) anchor = linked;
	}
	const candidates = siteCandidates(anchor, SITE_SEARCH_RADIUS);
	// 一次读回覆盖所有候选的并集，避免逐格 block@1。半径 6 的并集约 17×7×17 ≈ 2k 体素，
	// 远低于 region@1 的 8192 上限；要调大半径就得重新算这个盒子。
	let min = { x: anchor.x, y: anchor.y, z: anchor.z };
	let max = { x: anchor.x, y: anchor.y, z: anchor.z };
	const sites: PortalSite[] = [];
	for (const candidate of candidates) {
		const site = portalSite(candidate.origin, candidate.axis);
		const bounds = siteBounds(site);
		sites.push(site);
		min = { x: Math.min(min.x, bounds.from.x), y: Math.min(min.y, bounds.from.y), z: Math.min(min.z, bounds.from.z) };
		max = { x: Math.max(max.x, bounds.to.x), y: Math.max(max.y, bounds.to.y), z: Math.max(max.z, bounds.to.z) };
	}
	const grid = regionGrid(
		await readValue<unknown>(ctx.world, "region@1", { from: min, to: max }, ctx.signal, "portal site"),
	);
	if (grid == null) {
		fail("WRONG_STATE", "could not read the terrain around the portal site", {
			hint: "stage: portal — the terrain around the chosen spot is unreadable",
			progress: { stage: "portal", furthest: anchor },
		});
	}
	for (const site of sites) {
		const approach = portalSiteAccess(grid, site, isReplaceableName);
		if (approach == null) continue;
		return { frame: site.frame, approach: approach.feet, stepUp: approach.stepUp };
	}
	fail("UNREACHABLE", `no room for a 4x5 portal within ${SITE_SEARCH_RADIUS} blocks of the chosen spot`, {
		hint: "stage: portal — no flat 4-wide face with headroom nearby",
		progress: { stage: "portal", furthest: anchor, anchor, candidates: sites.length },
	});
}

/** 点火后的确认：内部任一格出现 nether_portal。 */
async function waitForPortalBlock(ctx: CallContext, frame: PortalFrame): Promise<boolean> {
	for (let attempt = 0; attempt < 10; attempt++) {
		for (const cell of frame.interior) {
			const block = await readBlockAt(ctx.world, cell);
			if (block != null && bareDimension(block.name) === "nether_portal") return true;
		}
		await sleepAbortable(200, ctx.signal);
	}
	return false;
}

/**
 * 走进门内并等服务器把身体送走。
 *
 * 两个真服事实决定了这里的形状（批19 实测）：
 * - 门面只有一格厚，闷头走会**穿门而过**——所以按 2 拍一步推进，每步都复核"身体是不是
 *   真的在门方块里"，进了就停；走过头了 `lookAt` 会把下一步转回来；
 * - 生存模式 `Player.getPortalWaitTime()` = 80 拍：实测站进去 3.6s 传送，这期间**不能
 *   继续按键**，否则又走出去了。
 */
async function enterPortal(
	deps: CapabilityDeps,
	ctx: CallContext,
	place: PortalPlace,
	origin: string,
	deadline: number,
	stages: Stage[],
): Promise<void> {
	// 先站到门前一格内；精确的"进那一格"由下面的闭环完成（GoalNear 判的是格角距离，
	// 四个相邻格中心都落在同一半径上，靠它进不了指定格）。
	await leg(deps, ctx, place.entrance, 1, deadline, stages);
	let inside = await standingInPortal(ctx);
	for (let step = 0; step < ENTER_STEPS && !inside; step++) {
		await ctx.withBody(async (scope) => {
			// drive 的 forward 是"当前朝向"：不对着门，走再多拍也进不去。
			await scope.player.drive(
				{ keys: { forward: true, jump: place.stepUp }, lookAt: place.entrance },
				ENTER_STEP_TICKS,
			);
		});
		inside = await standingInPortal(ctx);
	}
	if (!inside) {
		fail("UNREACHABLE", "could not get the body inside the portal", {
			hint: "stage: enter — the portal mouth is blocked or the walk-in was pushed back out",
			dispatch: "sent",
			progress: { stage: "enter", furthest: place.entrance },
		});
	}
	if (!(await awaitDimensionChange(ctx, origin, PORTAL_WAIT_MS))) {
		fail("WRONG_STATE", "standing in the portal did not move the body to another dimension", {
			hint: "the portal may be unlit, blocked, or the server denied the teleport",
			dispatch: "sent",
			progress: { stage: "enter", at: place.entrance, reason: "dimension did not change" },
		});
	}
	stages.push({ kind: "enter", ok: true });
}

/** 身体所在格是不是门方块（门内没有碰撞，站位由脚下黑曜石决定）。 */
async function standingInPortal(ctx: CallContext): Promise<boolean> {
	const self = await readSelf(ctx);
	const block = await readBlockAt(ctx.world, {
		x: Math.floor(self.place.position.x),
		y: Math.floor(self.place.position.y + 0.1),
		z: Math.floor(self.place.position.z),
	});
	return block != null && bareDimension(block.name) === "nether_portal";
}

/** 在窗口内轮询维度，变了返回 true；读失败按"还没好"处理。 */
async function awaitDimensionChange(ctx: CallContext, origin: string, windowMs: number): Promise<boolean> {
	const until = Date.now() + windowMs;
	for (;;) {
		try {
			if (bareDimension((await readSelf(ctx)).place.dimension) !== origin) return true;
		} catch {
			// 传送瞬间化身会重建，读不到不是失败。
		}
		if (Date.now() >= until) return false;
		await sleepAbortable(250, ctx.signal);
	}
}

/** 等维度切换（身体在传送瞬间会被换 incarnation，读失败按"还没好"处理）。 */
async function waitForDimension(ctx: CallContext, target: string, deadline: number): Promise<SelfState> {
	const until = Math.min(deadline, Date.now() + DIMENSION_WAIT_MS);
	for (;;) {
		try {
			const self = await readSelf(ctx);
			if (bareDimension(self.place.dimension) === target) return self;
		} catch {
			// 化身重建期读不到：继续等，不把过渡态当失败。
		}
		if (Date.now() >= until) {
			fail("TIMEOUT", `dimension did not become ${target} within the wait budget`, {
				hint: "stage: enter — the portal did not finish the transfer",
				dispatch: "sent",
				progress: { stage: "enter" },
			});
		}
		await sleepAbortable(250, ctx.signal);
	}
}

/**
 * 落地后先走出门，避免站在门里被立刻送回。
 *
 * 这一步是**收尾**：维度已经换过来了，走出去失败不该把一次成功的旅行判成失败，所以只把
 * 结论记进 stages。唯一的例外是取消——`INTERRUPTED` 必须上抛，否则停了还在继续跑。
 */
async function leavePortal(ctx: CallContext, stages: Stage[]): Promise<void> {
	try {
		await ctx.withBody(async (scope) => {
			await scope.player.drive({ keys: { forward: true } }, WALK_OUT_TICKS);
		});
		stages.push({ kind: "leave", ok: true });
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "INTERRUPTED") throw error;
		stages.push({ kind: "leave", ok: false, reason: code ?? "walk-out failed" });
	}
}

export const transitModule: MinecraftCapabilityModule = {
	id: "transit",
	definitions: [
		{
			kind: "action",
			descriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as TransitInput;
					const deadline = Date.now() + (raw.maxTimeMs ?? 600000);
					const target = bareDimension(raw.destination.dimension);
					if (!KNOWN_DIMENSIONS.has(target)) {
						fail("INVALID_INPUT", `unknown dimension ${raw.destination.dimension}`, {
							hint: `expected one of ${[...KNOWN_DIMENSIONS].join(", ")}`,
						});
					}
					const allow = raw.allow ?? ["portal"];
					let self = await readSelf(ctx);
					const destinationAt = resolveDestinationAt(raw.destination.at, target, self);
					const stages: Stage[] = [];
					const current = bareDimension(self.place.dimension);

					if (current === target) {
						if (destinationAt != null) {
							await leg(deps, ctx, destinationAt, 2, deadline, stages);
							self = await readSelf(ctx);
						}
						return report(self, stages);
					}
					// 末地门是另一种结构：不在这里建，也不该先建一扇下界门再等 60s 超时。
					if (!PORTAL_DIMENSIONS.has(current) || !PORTAL_DIMENSIONS.has(target)) {
						fail("UNREACHABLE", `a nether portal cannot connect ${current} and ${target}`, {
							hint: "stage: plan — the_end needs an end portal frame, which transit@1 does not build",
							progress: { stage: "plan", from: current, to: target },
						});
					}
					if (!allow.includes("portal")) {
						fail(
							"UNREACHABLE",
							`crossing from ${current} to ${target} needs a portal, but allow is [${allow.join(", ")}]`,
							{
								hint: "stage: plan — no transport in allow can cross dimensions",
								progress: { stage: "plan", furthest: self.place.position, from: current, to: target, allow },
							},
						);
					}

					const place = await ensurePortal(deps, ctx, self, target, destinationAt, deadline, stages);
					await enterPortal(deps, ctx, place, current, deadline, stages);
					self = await waitForDimension(ctx, target, deadline);
					await leavePortal(ctx, stages);
					if (destinationAt != null) {
						await leg(deps, ctx, destinationAt, 2, deadline, stages);
						self = await readSelf(ctx);
					}
					// 只在走过 destinationAt 之后可达：那一段步行可能自己穿回另一扇门。
					if (bareDimension(self.place.dimension) !== target) {
						fail("WRONG_STATE", `still in ${self.place.dimension} after travelling to ${target}`, {
							hint: "the walking leg ended in another dimension; re-read self before retrying",
							dispatch: "sent",
							progress: { stage: "goto", at: self.place.position, dimension: bareDimension(self.place.dimension) },
						});
					}
					return report(self, stages);
				},
		},
	],
};
