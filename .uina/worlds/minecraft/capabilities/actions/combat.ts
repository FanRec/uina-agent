/**
 * attack@1 / fight@1：一次攻击与一场战斗会话。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 attack、§4 fight。
 * attack@1 低层只承诺派发；hit 来自 Driver 的受击/死亡证据窗口：
 * true=观察到受击，false=窗口内没观察到，null=窗口未走完（中止/断线）。
 * 不把"没看到"写成"打中了"，也不把 miss 当失败——攻击确实执行过。
 *
 * fight@1（批 12，批29 近身拍重构，批33 feedback 流迁移）是一次战斗会话：
 * 选目标 → 换最好武器/盾 → 追击 → 近身段（一次 withBody 持有 + feedback 流
 * 连续物理拍：键位每拍重装、扫描/决策不再造成键位空档，占空比 ~100%）→
 * 按 stance 决定进退。近身段与导航顶层交替（withBody 段 ↔ navigate 追击），
 * 不嵌套租赁；safety 介入经同一队列优先，会话抛 INTERRUPTED 并保留 kills/hp。
 * 击杀只认 Driver 的死亡观察（连接级 entityDead 累积）+ 目标缺席结算；
 * 目标失踪（无死亡观察、连续缺席）不算击杀；掉落只记死亡位置附近新出现的
 * 可确认掉落物。会话结束用明确 ended（targets_cleared/retreated/
 * retreat_failed/target_lost/timeout）：retreated 是经核验的成功撤退（拉开到清除
 * 距离且威胁没有跟到贴身）；retreat_failed 如实报告撤离未脱险，不冒充成功。
 * 苦力怕 fuse 感知（批33）：entities@1 的 ignited 事实进硬危险判定——
 * 引燃即拉开并持续续锁，不等 fuse 半径内的下一次接触。
 */

import type { ControlInput, ControlOwner, EntityRef, PointTarget, SelfState } from "../../contracts/body.js";
import type { BodyCallScope, CallableDescriptor, CallContext } from "../../contracts/capabilities.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { MinecraftCapabilityModule } from "../catalog.js";
import type { CapabilityDeps } from "../deps.js";
import { DEFAULT_STEER_PARAMS, dirToKeys, fightSteering, type SlotMap } from "../shared/combat-steering.js";
import { resolveEntity } from "../shared/entities.js";
import {
	ATTACK_COOLDOWN_MS,
	bestMeleeWeapon,
	effectiveRetreatHealth,
	type FightStance,
	FLEE_BEARING_OFFSETS,
	fleeLegTarget,
	matchFollowTarget,
	NO_PROGRESS_MS_VALUE,
	RANGED_DRAW_MS,
	RANGED_HOSTILES,
	RETREAT_CLEARANCE,
	sleepAbortable,
	stanceParams,
} from "../shared/mobility.js";
import { readValue } from "../shared/observe.js";
import { ENTITY_REACH } from "../shared/reach.js";
import { distance, fail } from "../shared/targets.js";
import { type EntityEntryView, type InventorySnapshot, readInventory } from "../shared/views.js";
import { scanEntities } from "./navigation.js";
import { escapeToSurface } from "./surface.js";

const EVIDENCE_MS = 600;
/** 目标跟踪扫描在声明半径外再加的余量。 */
const FIGHT_SCAN_MARGIN = 8;
/** 弩的装填时间略长于弓的拉满。 */
const CROSSBOW_LOAD_MS = 1300;
/** 远程交战距离带：保持在这个区间射击。 */
const RANGED_STANDOFF_MIN = 5;
const RANGED_STANDOFF_MAX = 14;
/** 远程命中/击杀证据窗口：箭飞行需要时间。 */
const RANGED_EVIDENCE_MS = 1500;
/** 击杀掉落归属半径。 */
const KILL_DROP_RADIUS = 4;
/** 撤退结算的"贴近威胁"判据：结算扫描里活跃敌对实体在这个半径内就不算脱险。 */
const RETREAT_NEAR_RADIUS = 8;
/**
 * 近身段（批33）段内重扫间隔：击杀/缺席/撤退/进度按这个节奏结算，帧间走位
 * 用最近一次扫描的目标位置（≤300ms 陈旧，与批29 每拍决策同量级）。
 */
const NEAR_SCAN_INTERVAL_MS = 300;
/**
 * 近身拍出手间距：原版实体交互有效距离 3 格（合同 ENTITY_REACH=4 是 attack@1
 * 的派发上限，超 3 的挥击会被服务端静默拒绝）——出手门限收紧到 3.2。
 */
const BEAT_SWING_REACH = 3.2;
/** 追击→近身拍的交接间距：goto 在这里停，交棒后第一拍即接管出手/走位。 */
const CHASE_HANDOVER = 3;
/** 绕走侧翻转周期：单侧绕行足够久才换向，形成可预测的 orbit。 */
const STRAFE_PERIOD_MS = 2000;
/** 无死亡观察的目标连续缺席这么多次扫描才判 target_lost（给死亡事件留到达窗）。 */
const TARGET_LOST_SCANS = 2;
/**
 * 苦力怕锁定期：一旦进过 fuse 触发半径，这么长时间内始终按硬危险拉开——
 * swell 计量的衰减要好几秒，期间重新靠近会让引爆均值持续上升（真服实测）。
 */
const CREEPER_LOCK_MS = 3000;

// ---- attack@1 ----

const descriptor: CallableDescriptor = {
	ref: "attack@1",
	summary: "Attack one tracked entity once and report whether a hit was observed",
	tags: ["body", "combat"],
	input: {
		type: "object",
		properties: {
			target: { oneOf: [{ type: "string", minLength: 1 }, { type: "object" }] },
		},
		required: ["target"],
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			hit: { type: ["boolean", "null"] },
			target: {
				type: "object",
				properties: { name: { type: "string" }, health: { type: ["number", "null"] } },
				required: ["name"],
				additionalProperties: false,
			},
		},
		required: ["hit", "target"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"One attack was dispatched; hit reports observed damage/death evidence within the window (null = unobserved)",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "no tracked entity matches the target within 16 blocks" },
		{ code: "UNREACHABLE", meaning: "the target is beyond attack range (walk there first)" },
		{ code: "REFERENCE_STALE", meaning: "the entity reference is no longer tracked" },
		{ code: "INTERRUPTED", meaning: "the run was stopped" },
	],
	requires: ["connection", "body"],
	examples: [{ input: { target: "zombie" }, output: { hit: true, target: { name: "zombie", health: null } } }],
	implementation: "native",
};

// ---- fight@1 ----

const fightDescriptor: CallableDescriptor = {
	ref: "fight@1",
	summary:
		"Combat session: pick targets, gear the best weapon/shield, chase and attack on cooldown; stance sets engage/retreat lines",
	tags: ["body", "combat"],
	input: {
		type: "object",
		properties: {
			target: { oneOf: [{ type: "string", minLength: 1 }, { type: "object" }] },
			radius: { type: "integer", minimum: 8, maximum: 32, description: "target acquisition radius (default 16)" },
			stance: { type: "string", enum: ["balanced", "cautious", "aggressive"], description: "default balanced" },
			weapon: { type: "string", enum: ["auto", "melee", "ranged"], description: "default auto" },
			retreatHealth: {
				type: "number",
				minimum: 0,
				description: "absolute health threshold overriding the stance retreat line; 0 disables health retreat",
			},
			maxTimeMs: { type: "number", minimum: 1000, maximum: 600000, description: "wall-clock budget (default 30000)" },
		},
		additionalProperties: false,
	},
	output: {
		type: "object",
		properties: {
			ended: {
				type: "string",
				enum: ["targets_cleared", "retreated", "retreat_failed", "target_lost", "timeout"],
			},
			kills: {
				type: "array",
				items: {
					type: "object",
					properties: {
						name: { type: "string" },
						drops: { type: "object", description: "item name -> observed count near the death position" },
					},
					required: ["name", "drops"],
					additionalProperties: false,
				},
			},
			hp: {
				type: "object",
				properties: { before: { type: ["number", "null"] }, after: { type: ["number", "null"] } },
				required: ["before", "after"],
				additionalProperties: false,
			},
			retreated: { type: "string", enum: ["low_health", "no_progress"] },
			stance: { type: "string", enum: ["balanced", "cautious", "aggressive"] },
			retreatHealth: { type: ["number", "null"] },
			at: { type: "object" },
		},
		required: ["ended", "kills", "hp", "stance", "retreatHealth", "at"],
		additionalProperties: false,
	},
	access: "act",
	completion: {
		scope: "capability",
		description:
			"Session end is explicit: targets_cleared counts only observed deaths (driver-level entityDead evidence, credited when the target stops scanning); a target absent repeatedly without death evidence ends target_lost, not a kill; retreated (low_health/no_progress) is a verified withdrawal (clear of the threat anchor and no hostile within 8 blocks); retreat_failed means the withdrawal could not get clear — the bot is still in danger; stop/safety raises INTERRUPTED keeping kills/hp",
	},
	errors: [
		{ code: "NOT_FOUND", meaning: "no target to fight: the name/ref is untracked, or no hostile within the radius" },
		{ code: "INVALID_INPUT", meaning: "the target name matches several distinct entity names" },
		{ code: "WRONG_STATE", meaning: "weapon:'ranged' requested but no bow/crossbow with arrows is available" },
		{ code: "INTERRUPTED", meaning: "the run was stopped or safety took over mid-session (progress keeps kills/hp)" },
		{ code: "CONTROL_CONFLICT", meaning: "another controlled navigation holds the client" },
		{ code: "DISCONNECTED", meaning: "the connection ended during the session" },
	],
	requires: ["connection", "body"],
	examples: [
		{
			input: { radius: 16, stance: "balanced" },
			output: {
				ended: "targets_cleared",
				kills: [{ name: "zombie", drops: { rotten_flesh: 2 } }],
				hp: { before: 20, after: 17 },
				stance: "balanced",
				retreatHealth: 8,
				at: { position: { x: 5, y: 64, z: 1 }, dimension: "overworld" },
			},
		},
	],
	implementation: "native",
};

interface FightInput {
	target?: string | EntityRef;
	radius?: number;
	stance?: FightStance;
	weapon?: "auto" | "melee" | "ranged";
	retreatHealth?: number;
	maxTimeMs?: number;
}

interface TargetState {
	ref: EntityRef;
	name: string;
	lastPosition: Vec3;
	killed: boolean;
	lost: boolean;
	/** 连续缺席扫描计数（死亡观察到达窗；见 TARGET_LOST_SCANS）。 */
	absentScans: number;
	/** 苦力怕引燃状态（每轮扫描刷新；非苦力怕/未知为 null）。 */
	ignited: boolean | null;
}

interface KillRecord {
	name: string;
	drops: Record<string, number>;
}

function interrupted(kills: KillRecord[], hpBefore: number | null, hpAfter: number | null): never {
	fail("INTERRUPTED", "fight was interrupted by run stop or safety", {
		dispatch: "sent",
		progress: { kills, hp: { before: hpBefore, after: hpAfter } },
		recoverable: true,
	});
}

/** 死亡位置附近新出现的掉落物：与此前扫描见过的 item 实体求差，可确认才记账。 */
async function dropsNear(
	ctx: CallContext,
	at: Vec3,
	radius: number,
	seenItems: Set<number>,
): Promise<Record<string, number>> {
	const entries = await scanEntities(ctx, radius + FIGHT_SCAN_MARGIN);
	const drops: Record<string, number> = {};
	for (const entry of entries) {
		if (entry.item == null) continue;
		if (seenItems.has(entry.ref.networkId)) continue;
		if (distance(entry.position, at) > KILL_DROP_RADIUS) continue;
		seenItems.add(entry.ref.networkId);
		drops[entry.item.name] = (drops[entry.item.name] ?? 0) + entry.item.count;
	}
	return drops;
}

// ---- fight@1 会话内共享 ----

function toTarget(entry: EntityEntryView): TargetState {
	return {
		ref: {
			connection: entry.ref.connection,
			incarnation: entry.ref.incarnation,
			appearance: entry.ref.appearance,
			networkId: entry.ref.networkId,
		},
		name: entry.name,
		lastPosition: entry.position,
		killed: false,
		lost: false,
		absentScans: 0,
		ignited: entry.ignited,
	};
}

function nearestAnchor(targets: TargetState[], from: Vec3): Vec3 {
	let best: Vec3 | null = null;
	let bestGap = Number.POSITIVE_INFINITY;
	for (const target of targets) {
		if (target.killed || target.lost) continue;
		const gap = distance(from, target.lastPosition);
		if (gap < bestGap) {
			bestGap = gap;
			best = target.lastPosition;
		}
	}
	return best ?? from;
}

/** 远程资格：显式 ranged 必须有弓/弩+箭；auto 按 stance 偏好退化为近战。 */
function pickWeaponMode(
	mode: "auto" | "melee" | "ranged",
	preference: "priority" | "thick_only" | "ranged_mobs_only",
	inventory: InventorySnapshot,
	hpBefore: number | null,
	maxHealth: number | null,
	targets: TargetState[],
): "melee" | "ranged" {
	const rangedCapable =
		((inventory.counts.bow ?? 0) > 0 || (inventory.counts.crossbow ?? 0) > 0) && (inventory.counts.arrow ?? 0) > 0;
	if (mode === "ranged") {
		if (!rangedCapable) {
			fail("WRONG_STATE", "weapon:'ranged' requested but no bow/crossbow with arrows is available", {
				hint: "equip a bow and arrows, or use weapon:'melee'",
			});
		}
		return "ranged";
	}
	if (mode === "melee") return "melee";
	switch (preference) {
		case "priority":
			return rangedCapable ? "ranged" : "melee";
		case "thick_only":
			return rangedCapable && hpBefore != null && maxHealth != null && hpBefore >= maxHealth * 0.6 ? "ranged" : "melee";
		case "ranged_mobs_only":
			return rangedCapable && targets.some((target) => RANGED_HOSTILES.has(target.name)) ? "ranged" : "melee";
	}
}

/** 追击/走位段：顶层 navigate 作用域；UNREACHABLE/TIMEOUT 不是会话失败（no_progress 兜底）。 */
async function chaseLeg(
	deps: CapabilityDeps,
	ctx: CallContext,
	owner: ControlOwner,
	at: Vec3,
	tolerance: number,
	deadline: number,
	onInterrupted: () => never,
): Promise<void> {
	try {
		await deps.runtime().navigate(owner, () =>
			deps.gotoDirector.goto(
				{
					at,
					tolerance,
					sprint: true,
					digThrough: false,
					placeToReach: false,
					timeoutMs: Math.max(1000, Math.min(8000, deadline - Date.now())),
				},
				ctx.signal,
			),
		);
	} catch (error) {
		if (ctx.signal.aborted) onInterrupted();
		const code = (error as { code?: string }).code;
		if (code !== "UNREACHABLE" && code !== "TIMEOUT") throw error;
	}
}

/** 远程射击拍：lookAt → hold 蓄力/装填 → 释放（弩再补一次击发）→ 证据窗口。 */
async function shootBeat(
	ctx: CallContext,
	target: TargetState,
	radius: number,
	seenItems: Set<number>,
): Promise<KillRecord | null> {
	return await ctx.withBody(async (scope: BodyCallScope) => {
		const inventory = await readInventory(ctx.world);
		const isCrossbow = inventory.held?.name === "crossbow";
		await scope.player.lookAt(target.ref);
		await scope.player.useItem("main");
		await sleepAbortable(isCrossbow ? CROSSBOW_LOAD_MS : RANGED_DRAW_MS, ctx.signal);
		await scope.player.endUse();
		if (isCrossbow) {
			await scope.player.useItem("main");
			await sleepAbortable(200, ctx.signal);
			await scope.player.endUse();
		}
		const evidence = await scope.player.awaitEvidence(target.ref, { evidenceMs: RANGED_EVIDENCE_MS });
		if (evidence.dead !== true) return null;
		return { name: target.name, drops: await dropsNear(ctx, target.lastPosition, radius, seenItems) };
	});
}

/**
 * 撤退拍：cautious 先回露天可站（surface 失败不阻断撤退），再背向 anchor 拉开到清除距离。
 * 结算是核验性的：真的拉开了（anchor ≥ RETREAT_CLEARANCE）且结算扫描里没有贴身（≤8 格）的
 * 活跃敌对实体才算 cleared——只返回终点会让调用方把"尝试过撤退"当成"已脱险"（批26 修正）。
 */
interface WithdrawOutcome {
	/** 确实脱险：拉开到清除距离且威胁没有跟到贴身。 */
	cleared: boolean;
	/** 结算时位置。 */
	at: Vec3;
}

async function withdraw(
	deps: CapabilityDeps,
	ctx: CallContext,
	owner: ControlOwner,
	probe: ReturnType<CapabilityDeps["surface"]>,
	surfaceFirst: boolean,
	deadline: number,
	anchor: Vec3,
	onInterrupted: () => never,
): Promise<WithdrawOutcome> {
	if (surfaceFirst && probe != null) {
		try {
			const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			const here = self.place.position;
			if (!((await probe.standable(here)) === true && (await probe.skyOpen(here)) === true)) {
				await escapeToSurface(deps, ctx, Math.min(deadline, Date.now() + 30000));
			}
		} catch {
			/* surface 失败（TIMEOUT/UNREACHABLE）按普通撤退继续，不掩盖撤退本身 */
		}
	}
	for (let bearing = 0; bearing < FLEE_BEARING_OFFSETS.length; bearing++) {
		if (ctx.signal.aborted) onInterrupted();
		if (Date.now() >= deadline) break;
		const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
		if (distance(self.place.position, anchor) >= RETREAT_CLEARANCE) break;
		const target = fleeLegTarget(
			self.place.position,
			anchor,
			FLEE_BEARING_OFFSETS[bearing % FLEE_BEARING_OFFSETS.length]!,
		);
		try {
			await deps.runtime().navigate(owner, () =>
				deps.gotoDirector.goto(
					{
						at: target,
						tolerance: 2,
						sprint: true,
						digThrough: false,
						placeToReach: false,
						timeoutMs: Math.min(6000, deadline - Date.now()),
					},
					ctx.signal,
				),
			);
		} catch (error) {
			if (ctx.signal.aborted) onInterrupted();
			const code = (error as { code?: string }).code;
			if (code !== "UNREACHABLE" && code !== "TIMEOUT") throw error;
		}
	}
	const final = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
	const at = final.place.position;
	const hostiles = await scanEntities(ctx, RETREAT_NEAR_RADIUS, "hostile");
	const threatNearby = hostiles.some((entry) => distance(entry.position, at) <= RETREAT_NEAR_RADIUS);
	return {
		cleared: distance(at, anchor) >= RETREAT_CLEARANCE && !threatNearby,
		at,
	};
}

export const combatModule: MinecraftCapabilityModule = {
	id: "combat",
	definitions: [
		{
			kind: "action",
			descriptor,
			bind:
				() =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as { target: string | EntityRef };
					await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
					const entity = await resolveEntity(ctx.world, raw.target);
					if (entity.distance > ENTITY_REACH) {
						fail("UNREACHABLE", `${entity.name} is ${entity.distance} blocks away`, {
							hint: "goto@1 closer first; attack does not path",
						});
					}
					return await ctx.withBody(async (scope: BodyCallScope) => {
						const outcome = await scope.player.attack(entity.ref, { evidenceMs: EVIDENCE_MS });
						return plain({
							hit: outcome.hit,
							target: { name: entity.name, health: null },
						});
					});
				},
		},
		{
			kind: "action",
			descriptor: fightDescriptor,
			bind:
				(deps: CapabilityDeps) =>
				async (ctx: CallContext, input: JsonValue): Promise<JsonValue> => {
					const raw = input as unknown as FightInput;
					const stance = raw.stance ?? "balanced";
					const params = stanceParams(stance);
					const radius = raw.radius ?? 16;
					const deadline = Date.now() + (raw.maxTimeMs ?? 30000);
					const probe = deps.surface();
					const owner: ControlOwner = { kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId };
					// 掉落物身份差集基线：会话内见过的 item 实体不归属给后续击杀。
					const seenItems = new Set<number>();

					const first = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
					const hpBefore = first.health;
					const maxHealth = first.maxHealth;
					const retreatHealth = effectiveRetreatHealth(stance, raw.retreatHealth, maxHealth);
					// 接战门（§4 stance 接战血量）：低于接战线不获取目标；血量/maxHealth 未知不猜，放行接战。
					const engageFloor = maxHealth != null ? Math.floor(maxHealth * params.engageRatio) : null;
					const canAcquire = hpBefore == null || engageFloor == null || hpBefore >= engageFloor;

					const scan0 = await scanEntities(ctx, radius + FIGHT_SCAN_MARGIN);
					for (const entry of scan0) if (entry.item != null) seenItems.add(entry.ref.networkId);
					const targets: TargetState[] = [];
					let retreatAnchor: Vec3 = first.place.position;
					if (raw.target != null) {
						const match = matchFollowTarget(scan0, raw.target);
						if (match === null) {
							if (typeof raw.target === "string") {
								fail(
									"NOT_FOUND",
									`no tracked entity named ${String(raw.target).replace(/^minecraft:/, "")} within ${radius + FIGHT_SCAN_MARGIN} blocks`,
									{
										hint: "read entities@1 first; listing is not proof of absence beyond the radius",
									},
								);
							}
							fail(
								"REFERENCE_STALE",
								`entity ${raw.target.networkId} is not tracked within ${radius + FIGHT_SCAN_MARGIN} blocks`,
								{
									hint: "re-read entities@1; out of range is not proof of absence",
									recoverable: false,
								},
							);
						}
						if ("ambiguous" in match) {
							const names = [...new Set(match.ambiguous.map((entity) => entity.name))].join(", ");
							fail("INVALID_INPUT", `name ${String(raw.target)} matches several distinct entity names: ${names}`, {
								hint: "pass the exact name or an EntityRef from entities@1",
							});
						}
						retreatAnchor = match.found.position;
						if (canAcquire && match.found.distance <= radius) targets.push(toTarget(match.found));
					} else {
						// 获取按声明 radius；扫描面带 FIGHT_SCAN_MARGIN 只为会话内的跟踪余量。
						const hostiles = scan0.filter((entry) => entry.kind === "hostile" && entry.distance <= radius);
						if (hostiles.length === 0) {
							fail("NOT_FOUND", `no hostile entity within ${radius} blocks`, {
								hint: "read entities@1 first; listing is not proof of absence beyond the radius",
							});
						}
						retreatAnchor = hostiles[0]!.position;
						if (canAcquire) {
							for (const entry of hostiles.slice(0, params.maxTargets)) targets.push(toTarget(entry));
						}
					}

					const kills: KillRecord[] = [];
					let hpAfter = hpBefore;
					// 会话中断统一走这里：INTERRUPTED 必须带 kills/hp（§2.7 中断保留已发生的事）。
					const onInterrupted = (): never => interrupted(kills, hpBefore, hpAfter);
					// 开场血量低于接战线：不接战，按血量撤退结算（有 anchor 就背向它拉开）。
					if (targets.length === 0) {
						const retreat = await withdraw(
							deps,
							ctx,
							owner,
							probe,
							params.surfaceBeforeFlee,
							deadline,
							retreatAnchor,
							onInterrupted,
						);
						const finalSelf = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
						return plain({
							ended: retreat.cleared ? "retreated" : "retreat_failed",
							kills,
							hp: { before: hpBefore, after: finalSelf.health },
							retreated: "low_health",
							stance,
							retreatHealth,
							// 与会话结束路径同形：{position, dimension}（descriptor 示例口径）。
							at: { position: retreat.at, dimension: finalSelf.place.dimension },
						});
					}

					// 武器/盾装备拍：一次会话换装一次。
					const inventory = await readInventory(ctx.world);
					const weaponMode = pickWeaponMode(
						raw.weapon ?? "auto",
						params.ranged,
						inventory,
						hpBefore,
						maxHealth,
						targets,
					);
					let shieldEquipped = false;
					await ctx.withBody(async (scope: BodyCallScope) => {
						if (weaponMode === "ranged") {
							const bowName = (inventory.counts.bow ?? 0) > 0 ? "bow" : "crossbow";
							await scope.player.equip({ name: bowName }, "hand");
						} else {
							const weapon = bestMeleeWeapon(inventory.counts);
							if (weapon != null) await scope.player.equip({ name: weapon }, "hand");
						}
						if (stance !== "aggressive" && (inventory.counts.shield ?? 0) > 0) {
							// 盾是机会装备：装备失败不阻止战斗（背包/资格态可经 inventory@1 观察）。
							try {
								await scope.player.equip({ name: "shield" }, "offhand");
								shieldEquipped = true;
							} catch {
								/* proceed without shield */
							}
						}
					});

					let ended: "targets_cleared" | "retreated" | "retreat_failed" | "target_lost" | "timeout" = "timeout";
					let retreatedReason: "low_health" | "no_progress" | null = null;
					let lastProgressAt = Date.now();
					let bestGap = Number.POSITIVE_INFINITY;
					let nearestId = -1;
					let lastSwingAt = 0;
					// 苦力怕硬危险锁（networkId → 解锁时刻）；会话内有效。引燃事实会持续续锁。
					const creeperLocks = new Map<number, number>();
					// 最近一次硬危险拍时刻（no_progress 时钟在其后一个窗口内冻结）。
					let lastHardAt = 0;
					// 近身段状态：绕走侧与迟滞场；目标切换时场重置。
					let strafeSide: 1 | -1 = 1;
					let strafeFlipAt = Date.now() + STRAFE_PERIOD_MS;
					let prevInterest: SlotMap | null = null;
					// 连接级死亡观察的本地镜像：每轮扫描在持身体期间合并。
					const deadSeen = new Set<number>();

					// 目标跟踪/击杀结算（外层与近身段共用）：死亡观察命中 = 击杀；连续
					// TARGET_LOST_SCANS 次缺席且无死亡观察 = target_lost（§4）。
					const assess = async (
						selfPos: Vec3,
					): Promise<{
						scan: EntityEntryView[];
						nearest: TargetState | null;
						nearestGap: number;
						liveCount: number;
						anyAbsent: boolean;
					}> => {
						const scan = await scanEntities(ctx, radius + FIGHT_SCAN_MARGIN);
						let liveCount = 0;
						let nearest: TargetState | null = null;
						let nearestGap = Number.POSITIVE_INFINITY;
						let anyAbsent = false;
						for (const target of targets) {
							if (target.killed || target.lost) continue;
							const found = scan.find((entry) => entry.ref.networkId === target.ref.networkId);
							if (found == null) {
								// 缺席先给死亡观察一个到达窗（deadSeen 是连接级累积）。
								if (deadSeen.has(target.ref.networkId)) {
									target.killed = true;
									kills.push({
										name: target.name,
										drops: await dropsNear(ctx, target.lastPosition, radius, seenItems),
									});
									continue;
								}
								target.absentScans += 1;
								anyAbsent = true;
								if (target.absentScans >= TARGET_LOST_SCANS) target.lost = true;
								continue;
							}
							target.absentScans = 0;
							target.lastPosition = found.position;
							target.ignited = found.ignited;
							liveCount += 1;
							const gap = distance(selfPos, found.position);
							if (gap < nearestGap) {
								nearestGap = gap;
								nearest = target;
							}
						}
						// 见过的 item 实体进差集基线——必须在击杀归属之后。
						for (const entry of scan) if (entry.item != null) seenItems.add(entry.ref.networkId);
						return { scan, nearest, nearestGap, liveCount, anyAbsent };
					};

					// 撤退结算（三处共用）：核验性 withdraw 按 cleared 落 retreated/retreat_failed。
					// 返回结算值由调用点赋给 ended——闭包内赋值对 TS 控制流不可见。
					const runRetreat = async (
						reason: "low_health" | "no_progress",
						anchor: Vec3,
					): Promise<"retreated" | "retreat_failed"> => {
						retreatedReason = reason;
						const retreat = await withdraw(
							deps,
							ctx,
							owner,
							probe,
							params.surfaceBeforeFlee,
							deadline,
							anchor,
							onInterrupted,
						);
						return retreat.cleared ? "retreated" : "retreat_failed";
					};

					for (;;) {
						if (ctx.signal.aborted) onInterrupted();
						if (Date.now() >= deadline) {
							ended = "timeout";
							break;
						}
						const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
						hpAfter = self.health;
						if (retreatHealth != null && self.health != null && self.health < retreatHealth) {
							ended = await runRetreat("low_health", nearestAnchor(targets, self.place.position));
							break;
						}
						const { nearest, nearestGap, liveCount, anyAbsent } = await assess(self.place.position);
						if (targets.every((target) => target.killed)) {
							ended = "targets_cleared";
							break;
						}
						if (liveCount === 0) {
							// 有缺席目标但还没到判失联的次数：给死亡事件留一个到达窗再扫。
							if (anyAbsent && !targets.some((target) => target.lost)) {
								await sleepAbortable(200, ctx.signal);
								continue;
							}
							ended = "target_lost";
							break;
						}
						if (nearest == null) continue;
						// no_progress：迟迟无法接近也无法命中，主动脱离（cleared 才结算 retreated）。
						// bestGap 按目标身份跟踪：击杀后 nearest 换人，距离正常变大不是停滞。
						if (nearest.ref.networkId !== nearestId) {
							nearestId = nearest.ref.networkId;
							bestGap = Number.POSITIVE_INFINITY;
							prevInterest = null; // 目标切换：方向迟滞场作废
						}
						if (nearestGap < bestGap - 0.5) {
							bestGap = nearestGap;
							lastProgressAt = Date.now();
						} else if (Date.now() - lastHardAt < NO_PROGRESS_MS_VALUE) {
							// 硬危险（苦力怕 fuse 半径/引燃）的进退节奏是策略不是卡死。
							lastProgressAt = Date.now();
						} else if (Date.now() - lastProgressAt > NO_PROGRESS_MS_VALUE) {
							ended = await runRetreat("no_progress", nearest.lastPosition);
							break;
						}
						if (weaponMode === "ranged") {
							if (nearestGap > RANGED_STANDOFF_MAX) {
								await chaseLeg(deps, ctx, owner, nearest.lastPosition, 2, deadline, onInterrupted);
							} else if (nearestGap < RANGED_STANDOFF_MIN) {
								// 拉开半段：背向目标小步退。
								const away = fleeLegTarget(self.place.position, nearest.lastPosition, 0, 6);
								await chaseLeg(deps, ctx, owner, away, 2, deadline, onInterrupted);
							} else {
								const kill = await shootBeat(ctx, nearest, radius, seenItems);
								if (kill != null) {
									nearest.killed = true;
									kills.push(kill);
								}
								await sleepAbortable(ATTACK_COOLDOWN_MS, ctx.signal);
							}
							continue;
						}
						if (nearestGap > BEAT_SWING_REACH) {
							// 引燃/锁定期内的苦力怕不追（creeper-probe 实证：近身段在出手圈
							// 外退出后，不认识 fuse 状态的追击会把 bot 送回爆炸半径——逃离/
							// 追击振荡净拉开 ≈0）。背向拉开一条腿；引燃会在玩家出 3 格后
							// 自行衰减，锁定期过后恢复正常追击。
							const lockedCreeper =
								nearest.name === "creeper" &&
								(nearest.ignited === true || (creeperLocks.get(nearest.ref.networkId) ?? 0) > Date.now());
							if (lockedCreeper) {
								const away = fleeLegTarget(self.place.position, nearest.lastPosition, 0, 8);
								await chaseLeg(deps, ctx, owner, away, 2, deadline, onInterrupted);
								lastHardAt = Date.now();
								continue;
							}
							// 追击判定 = 能否出手（3.2）。交接间距 = 3：交棒后第一拍立即接管
							// 出手/走位；交棒更深（2 格）会在引燃半径内留下键位空档的站立窗
							// （苦力怕对拍实证被追到 1 格炸），更浅则第一拍够不着。
							// 交棒点落在出手门限之外时，"已在容差内秒完成"的追击会空转
							// 到 no_progress（真服实证）。
							await chaseLeg(deps, ctx, owner, nearest.lastPosition, CHASE_HANDOVER, deadline, onInterrupted);
							continue;
						}

						// ---- 近身段（批33）：一次 withBody 持有 + feedback 流连续物理拍 ----
						// 键位每物理拍重装，扫描/决策不再造成键位空档（占空比 ~100%）；
						// 段内每 NEAR_SCAN_INTERVAL_MS 重扫结算击杀/缺席/撤退/进度。
						let segmentExit: "cleared" | "lost" | "low_health" | "no_progress" | "deadline" | "out_of_reach" | null =
							null;
						while (segmentExit == null) {
							try {
								await ctx.withBody(async (scope: BodyCallScope) => {
									const stream = await scope.player.feedback({});
									let after: number | null = null;
									let lastScanAt = 0;
									let scan: EntityEntryView[] = [];
									try {
										while (segmentExit == null) {
											if (ctx.signal.aborted) onInterrupted();
											const now = Date.now();
											if (now >= deadline) {
												segmentExit = "deadline";
												break;
											}
											if (now - lastScanAt >= NEAR_SCAN_INTERVAL_MS) {
												const scanSelf = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
												hpAfter = scanSelf.health;
												if (retreatHealth != null && scanSelf.health != null && scanSelf.health < retreatHealth) {
													segmentExit = "low_health";
													break;
												}
												const assessed = await assess(scanSelf.place.position);
												scan = assessed.scan;
												lastScanAt = now;
												if (targets.every((target) => target.killed)) {
													segmentExit = "cleared";
													break;
												}
												if (assessed.liveCount === 0) {
													if (!assessed.anyAbsent || targets.some((target) => target.lost)) {
														segmentExit = "lost";
														break;
													}
													// 缺席等待窗：不导航不攻击，等死亡观察到达（下轮扫描结算）。
												} else if (assessed.nearest != null) {
													if (assessed.nearest.ref.networkId !== nearestId) {
														nearestId = assessed.nearest.ref.networkId;
														bestGap = Number.POSITIVE_INFINITY;
														prevInterest = null;
													}
													if (assessed.nearestGap < bestGap - 0.5) {
														bestGap = assessed.nearestGap;
														lastProgressAt = now;
													} else if (now - lastHardAt < NO_PROGRESS_MS_VALUE) {
														lastProgressAt = now;
													} else if (now - lastProgressAt > NO_PROGRESS_MS_VALUE) {
														segmentExit = "no_progress";
														break;
													}
												}
											}
											if (segmentExit != null) break;
											// 目标全部处于缺席等待窗时没有可打目标：中性拍保持输入新鲜。
											const nearest = targets.find(
												(target) => !target.killed && !target.lost && target.ref.networkId === nearestId,
											);
											if (nearest == null) {
												const frame = await stream.next(after, ctx.signal);
												after = frame.sequence;
												try {
													await stream.apply(frame, { keys: {} });
												} catch {
													/* 中性拍失败无后果，下一帧重来 */
												}
												continue;
											}
											const frame = await stream.next(after, ctx.signal);
											after = frame.sequence;
											const frameSelf = frame.self.value;
											if (frameSelf == null) continue; // 自事实缺失帧：下一帧再应用
											hpAfter = frameSelf.health;
											if (Date.now() >= strafeFlipAt) {
												strafeSide = strafeSide === 1 ? -1 : 1;
												strafeFlipAt = Date.now() + STRAFE_PERIOD_MS;
											}
											const gap = distance(frameSelf.place.position, nearest.lastPosition);
											if (gap > BEAT_SWING_REACH) {
												segmentExit = "out_of_reach";
												break;
											}
											const steer = fightSteering(
												frameSelf.place.position,
												nearest.lastPosition,
												scan
													.filter(
														(entry) =>
															entry.kind === "hostile" &&
															distance(frameSelf.place.position, entry.position) <= DEFAULT_STEER_PARAMS.dangerRadius,
													)
													.map((entry) => {
														const hostileGap = distance(frameSelf.place.position, entry.position);
														if (
															entry.name === "creeper" &&
															(hostileGap <= DEFAULT_STEER_PARAMS.creeperHardRadius || entry.ignited === true)
														) {
															creeperLocks.set(entry.ref.networkId, Date.now() + CREEPER_LOCK_MS);
														}
														const locked = (creeperLocks.get(entry.ref.networkId) ?? 0) > Date.now();
														return {
															x: entry.position.x,
															z: entry.position.z,
															name: entry.name,
															hard:
																entry.name === "creeper" &&
																(hostileGap <= DEFAULT_STEER_PARAMS.creeperHardRadius ||
																	entry.ignited === true ||
																	locked),
														};
													}),
												strafeSide,
												prevInterest,
											);
											prevInterest = steer.cur;
											if (steer.hardRetreat) lastHardAt = Date.now();
											// 引燃的苦力怕不进攻击节奏（fuse 在烧，跑优先）；
											// 其余目标冷却好且够得着就随拍派发攻击。
											const swing =
												nearest.ignited !== true &&
												Date.now() - lastSwingAt >= ATTACK_COOLDOWN_MS &&
												gap <= BEAT_SWING_REACH;
											if (swing) lastSwingAt = Date.now();
											// 硬危险拍：转身背向威胁前跑——原版后退不能 sprint，面朝威胁
											// 的"后退拉开"与苦力怕同速，永远跑不出 fuse 半径（真服实测）。
											// 本拍因此放弃瞄准/攻击/举盾，拉开速度优先。
											const fleeing =
												steer.hardRetreat &&
												steer.hardAt != null &&
												!swing &&
												(!steer.dir ||
													steer.dir.x * (steer.hardAt.x - frameSelf.place.position.x) +
														steer.dir.z * (steer.hardAt.z - frameSelf.place.position.z) <=
														0);
											let lookTarget: PointTarget | EntityRef = nearest.ref;
											let keys: ControlInput["keys"];
											if (fleeing && steer.hardAt != null) {
												const away = {
													x: frameSelf.place.position.x - steer.hardAt.x,
													z: frameSelf.place.position.z - steer.hardAt.z,
												};
												const len = Math.hypot(away.x, away.z) || 1;
												lookTarget = {
													x: frameSelf.place.position.x + (away.x / len) * 5,
													y: frameSelf.place.position.y,
													z: frameSelf.place.position.z + (away.z / len) * 5,
												};
												keys = { forward: true, sprint: true };
											} else {
												keys =
													steer.dir == null
														? { back: true }
														: { ...dirToKeys(steer.dir, nearest.lastPosition, frameSelf.place.position) };
											}
											const input: ControlInput = {
												keys,
												lookAt: lookTarget,
												...(swing ? { attack: nearest.ref } : {}),
												...(shieldEquipped && !swing && !fleeing
													? { use: { mode: "hold" as const, hand: "off" as const } }
													: {}),
											};
											try {
												await stream.apply(frame, input);
											} catch (error) {
												const code = (error as { code?: string }).code;
												if (code === "FRAME_EXPIRED") continue;
												if (code === "REFERENCE_STALE") {
													// 目标在扫描与应用之间失联：本帧只保持走位，
													// 击杀/缺席由下轮扫描按事实结算。
													try {
														await stream.apply(frame, { keys, lookAt: lookTarget });
													} catch {
														/* 下一帧重来 */
													}
													continue;
												}
												throw error;
											}
											for (const id of scope.player.deadEntities()) deadSeen.add(id);
										}
									} finally {
										await stream.close();
									}
								});
							} catch (error) {
								if (ctx.signal.aborted) onInterrupted();
								const code = (error as { code?: string }).code;
								// 段内流死亡（目标在应用与安装之间失联等）：退段重扫，
								// 外层按最新事实重新分流；其余控制/连接失败如实上抛。
								if (code === "REFERENCE_STALE" || code === "CONTROL_INVALID") continue;
								throw error;
							}
						}
						if (segmentExit === "cleared") {
							ended = "targets_cleared";
							break;
						}
						if (segmentExit === "lost") {
							ended = "target_lost";
							break;
						}
						if (segmentExit === "deadline") {
							ended = "timeout";
							break;
						}
						if (segmentExit === "low_health" || segmentExit === "no_progress") {
							const self2 = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
							hpAfter = self2.health;
							ended = await runRetreat(
								segmentExit,
								segmentExit === "low_health"
									? nearestAnchor(targets, self2.place.position)
									: (targets.find((target) => !target.killed && !target.lost)?.lastPosition ?? self2.place.position),
							);
							break;
						}
						// out_of_reach：回到外层重新扫描分流（追击或再接战）。
					}
					const final = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
					return plain({
						ended,
						kills,
						hp: {
							before: hpBefore,
							after: ended === "retreated" || ended === "retreat_failed" ? final.health : hpAfter,
						},
						...(retreatedReason != null ? { retreated: retreatedReason } : {}),
						stance,
						retreatHealth,
						at: { position: final.place.position, dimension: final.place.dimension },
					});
				},
		},
	],
};
