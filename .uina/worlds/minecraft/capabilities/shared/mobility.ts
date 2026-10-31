/**
 * 移动鲁棒性与战斗的纯决策函数（follow/flee/fight 共享；surface 阶段机在 actions/surface.ts）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4（follow/flee/fight）、§11.4（实体寻址）。
 * 这里不做 I/O：输入全是已读取的事实值，输出是决策或结算所需数据；
 * 会话循环、身体/导航租赁、效果结算与失败抛出归各动作实现。
 */

import type { EntityRef } from "../../contracts/body.js";
import type { Vec3 } from "../../contracts/values.js";
import type { EntityEntryView } from "./views.js";

// ---- follow@1 ----

/** 扫描半径覆盖典型跟踪余量；目标出圈连续 FOLLOW_LOST_SCANS 次扫描才报 target_lost。 */
export const FOLLOW_SCAN_RADIUS = 48;
export const FOLLOW_LOST_SCANS = 2;
export const FOLLOW_IDLE_MS = 1000;
export const FOLLOW_LEG_TIMEOUT_MS = 8000;

/**
 * 可中止的等待：abort 时照常 resolve，让会话循环顶部的中止检查接管
 * （否则裸 AbortError 会绕过 INTERRUPTED 结算，漏成 INTERNAL）。
 */
export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		if (signal.aborted) {
			clearTimeout(timer);
			resolve();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 在跟踪集合中解析 follow 目标：EntityRef 按 networkId；名字按全名/命名空间后缀。
 * 多个不同名字命中 → 返回 ambiguous 候选（动作转 INVALID_INPUT，§11.4）；
 * 同名多个取最近（entities@1 已按距离排序）。未命中 → null（动作转 NOT_FOUND/REFERENCE_STALE）。
 */
export function matchFollowTarget(
	entities: EntityEntryView[],
	target: string | EntityRef,
): { found: EntityEntryView } | { ambiguous: EntityEntryView[] } | null {
	if (typeof target !== "string") {
		const found = entities.find((entity) => entity.ref.networkId === target.networkId);
		return found ? { found } : null;
	}
	const name = target.replace(/^minecraft:/, "");
	const matches = entities.filter((entity) => entity.name === name || entity.name.endsWith(`:${name}`));
	if (matches.length === 0) return null;
	if (new Set(matches.map((entity) => entity.name)).size > 1) return { ambiguous: matches };
	return { found: matches[0]! };
}

// ---- flee@1 ----

export const FLEE_SCAN_RADIUS = 48;
export const FLEE_LEG_STEP = 12;
export const FLEE_LEG_TIMEOUT_MS = 6000;
export const FLEE_BEARING_OFFSETS = [0, 45, -45, 90, -90, 135, -135, 180];

/** 逃离腿目标：从当前位沿"背向威胁"方位偏转 offsetDeg 后走 step 格（水平整数格）。 */
export function fleeLegTarget(self: Vec3, threat: Vec3, offsetDeg: number, step = FLEE_LEG_STEP): Vec3 {
	const away = { x: self.x - threat.x, z: self.z - threat.z };
	const len = Math.hypot(away.x, away.z);
	const base = len > 1e-6 ? { x: away.x / len, z: away.z / len } : { x: 1, z: 0 };
	const rad = (offsetDeg * Math.PI) / 180;
	const dir = {
		x: base.x * Math.cos(rad) - base.z * Math.sin(rad),
		z: base.x * Math.sin(rad) + base.z * Math.cos(rad),
	};
	return { x: Math.round(self.x + dir.x * step), y: Math.round(self.y), z: Math.round(self.z + dir.z * step) };
}

// ---- fight@1 ----

export type FightStance = "balanced" | "cautious" | "aggressive";

/** 近战攻击冷却节拍（1.21 攻速 1.6 的满冷却）。 */
export const ATTACK_COOLDOWN_MS = 650;
/** 弓拉满时间；弩装填略长（CROSSBOW 由动作侧覆盖）。 */
export const RANGED_DRAW_MS = 1100;
/** no_progress 判定：持续这么久既没接近也没命中就主动脱离。 */
export const NO_PROGRESS_MS_VALUE = 8000;
/** 撤退清除距离：撤离到距威胁这个距离以外。 */
export const RETREAT_CLEARANCE = 16;

export interface StanceParams {
	/** 接战血量比例下限：低于它不获取新目标（已接战的当前目标继续打完）。 */
	engageRatio: number;
	/** 撤退血量比例：低于它主动撤退。 */
	retreatRatio: number;
	maxTargets: number;
	engageDistance: number;
	/** ranged 偏好：cautious 优先；balanced 有弓且血厚才用；aggressive 只对远程怪。 */
	ranged: "priority" | "thick_only" | "ranged_mobs_only";
	/** cautious 的逃跑方向：先回到露天可站（surface）再撤。 */
	surfaceBeforeFlee: boolean;
}

/** stance 决策表（capabilities.md §4；§11.9：阈值为初始值，真实战斗校准后更新）。 */
export function stanceParams(stance: FightStance): StanceParams {
	switch (stance) {
		case "cautious":
			return {
				engageRatio: 0.85,
				retreatRatio: 0.6,
				maxTargets: 1,
				engageDistance: 3,
				ranged: "priority",
				surfaceBeforeFlee: true,
			};
		case "aggressive":
			return {
				engageRatio: 0.35,
				retreatRatio: 0.2,
				maxTargets: 4,
				engageDistance: 1,
				ranged: "ranged_mobs_only",
				surfaceBeforeFlee: false,
			};
		default:
			return {
				engageRatio: 0.6,
				retreatRatio: 0.4,
				maxTargets: 2,
				engageDistance: 2,
				ranged: "thick_only",
				surfaceBeforeFlee: false,
			};
	}
}

/**
 * 有效撤退血量（绝对值）：显式 retreatHealth 覆盖 stance 比例；0 = 不因血量撤退（返回 null）。
 * 比例换算向下取整；maxHealth 未知且未显式给出 → null（判不了就不按血量撤，不猜）。
 */
export function effectiveRetreatHealth(
	stance: FightStance,
	retreatHealth: number | undefined,
	maxHealth: number | null,
): number | null {
	if (retreatHealth != null) return retreatHealth === 0 ? null : retreatHealth;
	if (maxHealth == null) return null;
	return Math.floor(maxHealth * stanceParams(stance).retreatRatio);
}

/**
 * 近战攻击力小表（1.21.11 固定值，vanilla 攻击伤害属性；知识注册表无攻击力数据时的确定性选择）。
 * 空手 1。平局按名字字典序，同一背包的选择稳定。
 */
export const MELEE_DAMAGE: Record<string, number> = {
	netherite_axe: 10,
	diamond_axe: 9,
	iron_axe: 9,
	stone_axe: 9,
	trident: 9,
	netherite_sword: 8,
	diamond_sword: 7,
	iron_sword: 6,
	mace: 6,
	stone_sword: 5,
	wooden_axe: 7,
	wooden_sword: 4,
	golden_axe: 7,
	golden_sword: 4,
};

/** 远程怪名单：aggressive 的 ranged_mobs_only 只对这些名字用弓（1.21.11 常见）。 */
export const RANGED_HOSTILES = new Set(["skeleton", "stray", "bogged", "pillager", "witch", "piglin"]);

/** 从背包 counts 选最好近战武器；没有 → null（空手，不失败）。 */
export function bestMeleeWeapon(counts: Record<string, number>): string | null {
	let best: string | null = null;
	let bestDamage = 1;
	for (const [name, damage] of Object.entries(MELEE_DAMAGE)) {
		if ((counts[name] ?? 0) <= 0) continue;
		if (damage > bestDamage || (damage === bestDamage && best != null && name < best)) {
			best = name;
			bestDamage = damage;
		}
	}
	return best;
}
