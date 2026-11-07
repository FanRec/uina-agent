/**
 * 近战走位的方向选择：16 槽 context steering（批29）。
 *
 * 算法来源：Andrew Fray, Game AI Pro 2 第 18 章；核心实现对照 Cortico
 * `combat-context.ts`（MIT，E:/Uina/Research/Cortico）。interest 与 danger
 * 分场合成：各方向强度取 max、1-2-1 环形平滑、与上一拍混合成迟滞；硬危险
 * 槽直接遮罩，不参与平滑与选择。纯函数，无 I/O——消费方（fight@1 近身拍）
 * 每拍用已扫描的实体事实重建输入，输出世界系方向再分解成键位。
 *
 * 为什么不用简单的距离带+换向：围攻（B02）里"背向最近目标"经常正好撞进第二
 * 只的怀抱；苦力怕（B04）需要"绝不朝它走"的硬约束。方向场把这两件事变成
 * 数据（多源 danger 叠加、硬遮罩），键位只做分解。
 */

import type { Vec3 } from "../../contracts/values.js";

export const SLOTS = 16;
/** 硬危险槽直接排除，不参与最低危险与容差比较。 */
export const HARD = 1e6;

export type SlotMap = Float64Array;

export function newSlotMap(): SlotMap {
	return new Float64Array(SLOTS);
}

export function slotDir(i: number): { x: number; z: number } {
	const a = (i / SLOTS) * Math.PI * 2;
	return { x: Math.cos(a), z: Math.sin(a) };
}

/** 各方向强度取 max。sharpness 控制余弦瓣宽度，1 约为 180°，4 更窄。 */
export function writeSlot(map: SlotMap, dx: number, dz: number, strength: number, sharpness = 1): void {
	const len = Math.hypot(dx, dz);
	if (len < 1e-9 || strength <= 0) return;
	const ux = dx / len;
	const uz = dz / len;
	for (let i = 0; i < SLOTS; i++) {
		const d = slotDir(i);
		const dot = d.x * ux + d.z * uz;
		if (dot <= 0) continue;
		const v = strength * dot ** sharpness;
		if (v > map[i]) map[i] = v;
	}
}

/** 直接写某槽（硬遮罩用）。 */
export function writeSlotIndex(map: SlotMap, i: number, v: number): void {
	const k = ((i % SLOTS) + SLOTS) % SLOTS;
	if (v > map[k]) map[k] = v;
}

/** 1-2-1 环形平滑；硬危险槽不参与平滑（自身保留，邻槽用原值代替它）。 */
export function blurSlots(map: SlotMap): void {
	const src = Float64Array.from(map);
	for (let i = 0; i < SLOTS; i++) {
		const b = src[i]!;
		if (b >= HARD) continue;
		const a = src[(i - 1 + SLOTS) % SLOTS]!;
		const c = src[(i + 1) % SLOTS]!;
		const av = a >= HARD ? b : a;
		const cv = c >= HARD ? b : c;
		map[i] = (av + 2 * b + cv) / 4;
	}
}

/** 与上一拍混合，形成方向迟滞（硬槽取 max 不混合）。 */
export function blendSlots(prev: SlotMap, cur: SlotMap, alpha: number): void {
	for (let i = 0; i < SLOTS; i++) {
		if (cur[i] >= HARD || prev[i] >= HARD) {
			if (prev[i] >= HARD) writeSlotIndex(cur, i, HARD);
			continue;
		}
		cur[i] = alpha * cur[i]! + (1 - alpha) * prev[i]!;
	}
}

export interface SteerChoice {
	x: number;
	z: number;
	strength: number;
	slot: number;
}

/**
 * 排除硬危险和高于"最低危险+容差"的槽，选 interest 最大值；相邻未排除槽做
 * 抛物线插值。全部硬遮罩时返回 null（消费方走背向威胁的兜底）。
 */
export function decideSlot(interest: SlotMap, danger: SlotMap, tol = 0.2): SteerChoice | null {
	let min = Number.POSITIVE_INFINITY;
	for (let i = 0; i < SLOTS; i++) {
		if (danger[i]! < HARD && danger[i]! < min) min = danger[i]!;
	}
	if (!Number.isFinite(min)) return null;
	const cut = min + tol;
	let best = -1;
	let bestV = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < SLOTS; i++) {
		if (danger[i]! >= HARD || danger[i]! > cut) continue;
		if (interest[i]! > bestV) {
			bestV = interest[i]!;
			best = i;
		}
	}
	if (best < 0) return null;
	const li = (best - 1 + SLOTS) % SLOTS;
	const ri = (best + 1) % SLOTS;
	const ok = (i: number): boolean => danger[i]! < HARD && danger[i]! <= cut;
	const a = ok(li) ? interest[li]! : bestV;
	const c = ok(ri) ? interest[ri]! : bestV;
	const denom = a - 2 * bestV + c;
	let off = 0;
	if (Math.abs(denom) > 1e-9) off = (0.5 * (a - c)) / denom;
	if (!Number.isFinite(off) || Math.abs(off) > 1) off = 0;
	const ang = ((best + off) / SLOTS) * Math.PI * 2;
	return { x: Math.cos(ang), z: Math.sin(ang), strength: bestV, slot: best };
}

// ---- fight@1 近战域组装 ----

/** 近身拍的威胁读数：由扫描事实直接给出（pos 为实体位置）。 */
export interface ThreatView {
	x: number;
	z: number;
	name: string;
	/** 消费方判定的硬危险（如 fuse 半径内的苦力怕、锁定期的点燃苦力怕）。 */
	hard?: boolean;
}

/** 近身拍参数：engagement 距离带与迟滞。数值为初始值，真服校准后更新（§11.9）。 */
export interface SteerParams {
	/** 低于这个间距不再向目标推进（原版近战臂距内保持站桩输出会被围殴）。 */
	closeBand: number;
	/** 各敌对的接近 danger 强度系数（gap 按此半径归一）。 */
	dangerRadius: number;
	/** 苦力怕 fuse 风险半径：进入即硬遮罩"朝向它"的槽。 */
	creeperHardRadius: number;
	/** 切向绕走（orbit）兴趣强度：0 关闭。 */
	strafeStrength: number;
	/** 迟滞混合系数（上一拍方向图的保留比例）。 */
	hysteresis: number;
}

export const DEFAULT_STEER_PARAMS: SteerParams = {
	closeBand: 1.8,
	dangerRadius: 4,
	/** 苦力怕 fuse 风险半径：略大于原版起爆触发距离（3 格），盖过出手间距 3.2。 */
	creeperHardRadius: 3.4,
	strafeStrength: 0.35,
	hysteresis: 0.5,
};

/**
 * 合成近战走位的 interest/danger 场并选出世界系方向。
 *
 * - interest：向目标推进，强度随 gap 超出 closeBand 增长（0.4..1）；切向绕走
 *   侧（side=+1 左 / -1 右）给固定小强度，形成 orbit 而不是站桩。
 * - danger：每个威胁按接近度叠加（1 - gap/radius 归一，clamp 0.05..1）；目标
 *   本身也是威胁（近身互殴时它一直在 dangerRadius 内），把"贴脸站桩"从最优解
 *   里挤出去——切向槽会胜出。
 * - 苦力怕（creeper）在 hardRadius 内：硬遮罩所有"朝向它"的槽（fuse 风险下
 *   任何前进方向都不可接受）。
 */
export function fightSteering(
	selfAt: Vec3,
	targetAt: Vec3,
	threats: ThreatView[],
	side: 1 | -1,
	prev: SlotMap | null,
	params: SteerParams = DEFAULT_STEER_PARAMS,
): { dir: SteerChoice | null; cur: SlotMap; hardRetreat: boolean; hardAt: { x: number; z: number } | null } {
	const interest = newSlotMap();
	const danger = newSlotMap();
	const toTarget = { x: targetAt.x - selfAt.x, z: targetAt.z - selfAt.z };
	const gap = Math.hypot(toTarget.x, toTarget.z);
	const approach = gap <= params.closeBand ? 0 : Math.min(1, 0.4 + (gap - params.closeBand) / 8);
	writeSlot(interest, toTarget.x, toTarget.z, approach, 2);
	let hardThreat: { x: number; z: number } | null = null;
	for (const threat of threats) {
		const dx = threat.x - selfAt.x;
		const dz = threat.z - selfAt.z;
		const d = Math.hypot(dx, dz);
		if (threat.hard === true || (threat.name === "creeper" && d <= params.creeperHardRadius)) {
			// 硬遮罩朝向它的槽：fuse 风险（或消费方判定）下绝不前进；同时本拍禁
			// 切向绕走（贴着爆炸半径 orbit 毫无意义，纯背向拉开才是正确行为）。
			writeSlot(danger, dx, dz, HARD);
			hardThreat = { x: dx, z: dz };
			continue;
		}
		if (d > params.dangerRadius) continue;
		const strength = Math.max(0.05, Math.min(1, 1 - d / params.dangerRadius));
		writeSlot(danger, dx, dz, strength, 1);
	}
	if (params.strafeStrength > 0 && hardThreat == null) {
		// 切向 = 目标方向旋转 ±90°。
		writeSlot(interest, -toTarget.z * side, toTarget.x * side, params.strafeStrength, 2);
	}
	blurSlots(danger);
	const cur = prev != null ? Float64Array.from(interest) : interest;
	if (prev != null) blendSlots(prev, cur, params.hysteresis);
	const dir = decideSlot(cur, danger);
	return { dir, cur, hardRetreat: hardThreat != null, hardAt: hardThreat };
}

/**
 * 世界系方向 → 键位（lookAt 钉在目标上：forward 轴 = 朝目标）。
 * 返回的三个键都是布尔；斜向由 forward+left/right 组合表达。
 */
export function dirToKeys(
	dir: { x: number; z: number },
	targetAt: Vec3,
	selfAt: Vec3,
): { forward: boolean; back: boolean; left: boolean; right: boolean } {
	const fx = targetAt.x - selfAt.x;
	const fz = targetAt.z - selfAt.z;
	const flen = Math.hypot(fx, fz);
	if (flen < 1e-9) return { forward: false, back: false, left: false, right: false };
	const ux = fx / flen;
	const uz = fz / flen;
	const along = dir.x * ux + dir.z * uz;
	// 左手垂直分量：facing 逆时针旋转 90°（朝东时左 = 北 = -z）。
	const lateral = dir.x * uz - dir.z * ux;
	return {
		forward: along > 0.3,
		back: along < -0.3,
		left: lateral > 0.3,
		right: lateral < -0.3,
	};
}
