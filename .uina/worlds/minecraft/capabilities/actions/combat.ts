/**
 * attack@1 / fight@1：一次攻击与一场战斗会话。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 attack、§4 fight。
 * attack@1 低层只承诺派发；hit 来自 Driver 的受击/死亡证据窗口：
 * true=观察到受击，false=窗口内没观察到，null=窗口未走完（中止/断线）。
 * 不把"没看到"写成"打中了"，也不把 miss 当失败——攻击确实执行过。
 *
 * fight@1（批 12）是一次战斗会话：选目标 → 换最好武器/盾 → 追击 → 按冷却攻击 →
 * 按 stance 决定进退。身体与导航用顶层交替拍（withBody 攻击 ↔ navigate 追击），
 * 不嵌套租赁；safety 介入经同一队列优先，会话抛 INTERRUPTED 并保留 kills/hp。
 * 击杀只认 Driver 的 entityDead 观察（dead），目标失踪不算击杀；掉落只记死亡位置
 * 附近新出现的可确认掉落物。会话结束用明确 ended（targets_cleared/retreated/
 * target_lost/timeout），retreated 是成功返回值。
 */

import type { BodyCallScope, CallContext, CallableDescriptor, NativeCallable } from "../../contracts/capabilities.js";
import type { ControlOwner, EntityRef, SelfState } from "../../contracts/body.js";
import { plain } from "../../contracts/values.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import type { CapabilityDeps } from "../deps.js";
import {
	ATTACK_COOLDOWN_MS,
	FLEE_BEARING_OFFSETS,
	NO_PROGRESS_MS_VALUE,
	RANGED_DRAW_MS,
	RANGED_HOSTILES,
	RETREAT_CLEARANCE,
	bestMeleeWeapon,
	effectiveRetreatHealth,
	fleeLegTarget,
	matchFollowTarget,
	stanceParams,
	sleepAbortable,
	type FightStance,
} from "../shared/mobility.js";
import { resolveEntity } from "../shared/entities.js";
import { readValue } from "../shared/observe.js";
import { ENTITY_REACH } from "../shared/reach.js";
import { distance, fail } from "../shared/targets.js";
import { readInventory, type EntityEntryView, type InventorySnapshot } from "../shared/views.js";
import { escapeToSurface } from "./surface.js";
import { scanEntities } from "./navigation.js";

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

export function attackCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	void deps;
	return {
		descriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
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
	};
}

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
			ended: { type: "string", enum: ["targets_cleared", "retreated", "target_lost", "timeout"] },
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
			"Session end is explicit: targets_cleared counts only observed deaths; a vanished target ends target_lost, not a kill; retreated (low_health/no_progress) is a successful withdrawal; stop/safety raises INTERRUPTED keeping kills/hp",
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

export function fightCallable(deps: CapabilityDeps): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: fightDescriptor,
		async invoke(ctx: CallContext, input: JsonValue): Promise<JsonValue> {
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
				const at = await withdraw(
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
					ended: "retreated",
					kills,
					hp: { before: hpBefore, after: finalSelf.health },
					retreated: "low_health",
					stance,
					retreatHealth,
					at,
				});
			}

			// 武器/盾装备拍：一次会话换装一次。
			const inventory = await readInventory(ctx.world);
			const weaponMode = pickWeaponMode(raw.weapon ?? "auto", params.ranged, inventory, hpBefore, maxHealth, targets);
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
					} catch {
						/* proceed without shield */
					}
				}
			});

			let ended: "targets_cleared" | "retreated" | "target_lost" | "timeout" = "timeout";
			let retreatedReason: "low_health" | "no_progress" | null = null;
			let lastProgressAt = Date.now();
			let bestGap = Number.POSITIVE_INFINITY;
			let nearestId = -1;
			for (;;) {
				if (ctx.signal.aborted) onInterrupted();
				if (Date.now() >= deadline) {
					ended = "timeout";
					break;
				}
				const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
				hpAfter = self.health;
				if (retreatHealth != null && self.health != null && self.health < retreatHealth) {
					await withdraw(
						deps,
						ctx,
						owner,
						probe,
						params.surfaceBeforeFlee,
						deadline,
						nearestAnchor(targets, self.place.position),
						onInterrupted,
					);
					ended = "retreated";
					retreatedReason = "low_health";
					break;
				}
				const scan = await scanEntities(ctx, radius + FIGHT_SCAN_MARGIN);
				for (const entry of scan) if (entry.item != null) seenItems.add(entry.ref.networkId);
				let liveCount = 0;
				let nearest: TargetState | null = null;
				let nearestGap = Number.POSITIVE_INFINITY;
				for (const target of targets) {
					if (target.killed || target.lost) continue;
					const found = scan.find((entry) => entry.ref.networkId === target.ref.networkId);
					if (found == null) {
						// 无死亡证据的消失：target_lost，不冒认击杀（§4）。
						target.lost = true;
						continue;
					}
					target.lastPosition = found.position;
					liveCount += 1;
					const gap = distance(self.place.position, found.position);
					if (gap < nearestGap) {
						nearestGap = gap;
						nearest = target;
					}
				}
				if (targets.every((target) => target.killed)) {
					ended = "targets_cleared";
					break;
				}
				if (liveCount === 0) {
					ended = "target_lost";
					break;
				}
				// no_progress：迟迟无法接近也无法命中，主动脱离（retreated 是成功返回值）。
				// bestGap 按目标身份跟踪：击杀后 nearest 换人，距离正常变大不是停滞。
				if (nearest!.ref.networkId !== nearestId) {
					nearestId = nearest!.ref.networkId;
					bestGap = Number.POSITIVE_INFINITY;
				}
				if (nearestGap < bestGap - 0.5) {
					bestGap = nearestGap;
					lastProgressAt = Date.now();
				} else if (Date.now() - lastProgressAt > NO_PROGRESS_MS_VALUE) {
					await withdraw(
						deps,
						ctx,
						owner,
						probe,
						params.surfaceBeforeFlee,
						deadline,
						nearest!.lastPosition,
						onInterrupted,
					);
					ended = "retreated";
					retreatedReason = "no_progress";
					break;
				}
				if (nearest == null) continue;
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
				} else {
					if (nearestGap > params.engageDistance + 0.6) {
						await chaseLeg(deps, ctx, owner, nearest.lastPosition, 1, deadline, onInterrupted);
					} else {
						await ctx.withBody(async (scope: BodyCallScope) => {
							let outcome: { dead: boolean | null; hit: boolean | null };
							try {
								outcome = await scope.player.attack(nearest!.ref, { evidenceMs: EVIDENCE_MS });
							} catch (error) {
								// 扫描与派发之间目标失联（被打落平台/被移走）：本拍放弃，
								// 下一轮扫描按事实结算——还在就继续打，不在就是 target_lost。
								if ((error as { code?: string }).code === "REFERENCE_STALE") return;
								throw error;
							}
							if (outcome.dead === true) {
								nearest!.killed = true;
								kills.push({
									name: nearest!.name,
									drops: await dropsNear(ctx, nearest!.lastPosition, radius, seenItems),
								});
							}
							// 冷却期举盾格挡（盾在 offhand、主手是武器时右键即举盾）：无格挡时
							// 3 僵尸的承伤速度会压过任何循环粒度的撤退检查（真服实测）。
							// 格挡是机会动作：目标恰好失联就跳过，不让它炸掉会话。
							if (stance !== "aggressive" && !nearest!.killed) {
								try {
									await scope.player.drive({ keys: {}, lookAt: nearest!.ref, use: { mode: "hold", hand: "off" } }, 13);
								} catch (error) {
									if ((error as { code?: string }).code !== "REFERENCE_STALE") throw error;
								}
							}
						});
						await sleepAbortable(ATTACK_COOLDOWN_MS, ctx.signal);
						// 攻击后的即时血量复查：循环顶的检查节奏 (~1.3s) 接不住
						// "撤退线 8 → 安全线 6" 的 2 格血窗，挨打后必须马上看一眼（真服实测）。
						const fresh = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
						hpAfter = fresh.health;
						if (retreatHealth != null && fresh.health != null && fresh.health < retreatHealth) {
							await withdraw(
								deps,
								ctx,
								owner,
								probe,
								params.surfaceBeforeFlee,
								deadline,
								nearestAnchor(targets, fresh.place.position),
								onInterrupted,
							);
							ended = "retreated";
							retreatedReason = "low_health";
							break;
						}
					}
				}
			}
			const final = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
			return plain({
				ended,
				kills,
				hp: { before: hpBefore, after: ended === "retreated" ? final.health : hpAfter },
				...(retreatedReason != null ? { retreated: retreatedReason } : {}),
				stance,
				retreatHealth,
				at: { position: final.place.position, dimension: final.place.dimension },
			});
		},
	};
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

/** 撤退拍：cautious 先回露天可站（surface 失败不阻断撤退），再背向 anchor 拉开到清除距离。 */
async function withdraw(
	deps: CapabilityDeps,
	ctx: CallContext,
	owner: ControlOwner,
	probe: ReturnType<CapabilityDeps["surface"]>,
	surfaceFirst: boolean,
	deadline: number,
	anchor: Vec3,
	onInterrupted: () => never,
): Promise<Vec3> {
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
		if (distance(self.place.position, anchor) >= RETREAT_CLEARANCE) return self.place.position;
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
	return final.place.position;
}
