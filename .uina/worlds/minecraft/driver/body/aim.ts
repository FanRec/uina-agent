/**
 * Body 私有的派发闸门几何与受控转头步进（§4.1/§4.2）。
 *
 * 这里是 Driver 拥有的最终交互合法性：Capability 的距离读数只是初筛，
 * "能不能点这个方块/这个面"以操作当刻的真实眼位、方块碰撞形状、射线与
 * 游戏模式射程为准。只做纯计算与最小世界查询，不做策略、不做动作。
 */

import { type CallFailure, callFailure, type Vec3 } from "../../contracts/values.js";
import { type MineflayerBot, toMineflayerVec3 } from "../mineflayer/adapter.js";

/** 原版生存模式口径：方块交互 4.5、实体交互 3（按命中点计，不是到中心）。 */
export const BLOCK_REACH = 4.5;
export const ENTITY_REACH = 3;

/**
 * 方块交互射程按游戏模式取值（§4.1「版本或模式特殊规则在 Driver 适配处处理」）。
 * 创造模式是 5 格；模式未知时按生存的保守值，宁可早拒也不越权派发。
 */
export function blockReachFor(bot: { game?: { gameMode?: string | null } | null }): number {
	return bot.game?.gameMode === "creative" ? 5 : BLOCK_REACH;
}

export interface AimAngles {
	yaw: number;
	pitch: number;
}

/**
 * 受控转头的观感初值（§4.2）：非协议常量，以录像校准。
 * yaw ≤ 12°/tick、pitch ≤ 10°/tick，收敛误差避免末端抖动。
 */
export const AIM_LIMITS = { yawDeg: 12, pitchDeg: 10, settleEpsilonDeg: 0.5 };

const DEG = 180 / Math.PI;

/** eye → point 的观察角（与 Mineflayer lookAt 同口径：yaw=atan2(-dx,-dz)，pitch=atan2(dy,水平距)）。 */
export function anglesTo(point: Vec3, eye: Vec3): AimAngles {
	const dx = point.x - eye.x;
	const dy = point.y - eye.y;
	const dz = point.z - eye.z;
	const ground = Math.sqrt(dx * dx + dz * dz);
	return { yaw: Math.atan2(-dx, -dz) * DEG, pitch: Math.atan2(dy, ground) * DEG };
}

const wrapDegrees = (value: number): number => {
	let angle = value % 360;
	if (angle > 180) angle -= 360;
	if (angle < -180) angle += 360;
	return angle;
};

const clampPitch = (pitch: number): number => Math.max(-90, Math.min(90, pitch));

/**
 * 从当前角向目标角走一步：yaw 取最短角差、pitch 夹在合法区间、每 Tick 限速；
 * 已在收敛误差内时返回原角并标记 settled，避免末端抖动。
 */
export function nextAimStep(
	current: AimAngles,
	target: AimAngles,
	limits: { yawDeg: number; pitchDeg: number; settleEpsilonDeg: number } = AIM_LIMITS,
): AimAngles & { settled: boolean } {
	const yawDelta = wrapDegrees(target.yaw - current.yaw);
	const pitchDelta = clampPitch(target.pitch) - current.pitch;
	const settled = Math.abs(yawDelta) <= limits.settleEpsilonDeg && Math.abs(pitchDelta) <= limits.settleEpsilonDeg;
	if (settled) return { yaw: current.yaw, pitch: current.pitch, settled: true };
	return {
		yaw: current.yaw + Math.sign(yawDelta) * Math.min(Math.abs(yawDelta), limits.yawDeg),
		pitch: current.pitch + Math.sign(pitchDelta) * Math.min(Math.abs(pitchDelta), limits.pitchDeg),
		settled: false,
	};
}

/** Mineflayer faceNumber ↔ 面法向（0=-Y 1=+Y 2=-Z 3=+Z 4=-X 5=+X）。 */
export const FACE_NORMALS: readonly Vec3[] = [
	{ x: 0, y: -1, z: 0 },
	{ x: 0, y: 1, z: 0 },
	{ x: 0, y: 0, z: -1 },
	{ x: 0, y: 0, z: 1 },
	{ x: -1, y: 0, z: 0 },
	{ x: 1, y: 0, z: 0 },
];

export interface BlockHit {
	/** Mineflayer faceNumber（activateBlock/startDig 直接可用）。 */
	faceNumber: number;
	/** 面法向。 */
	face: Vec3;
	/** 命中点在方块内的局部坐标 ∈ [0,1]^3（activateBlock 的 cursor）。 */
	cursor: Vec3;
	/** 世界坐标命中点。 */
	point: Vec3;
	/** 眼位到命中点的实际距离（射程判据用这个，不是到方块中心）。 */
	distance: number;
}

export type HitGateResult =
	| { ok: true; hit: BlockHit }
	| { ok: false; code: "NOT_FOUND" | "OUT_OF_REACH" | "UNREACHABLE"; message: string; occluder?: Vec3 };

export interface RayHit {
	position: Vec3;
	faceNumber?: number;
	point?: Vec3;
}

export interface HitGateWorld {
	/** prismarine 方块（shapes 为方块局部 [0,1] 的 AABB 列表）；未加载为 null。 */
	blockAt(position: Vec3): { shapes: number[][] } | null;
	/** bot.world.raycast（prismarine 为 async）：沿射线返回首个命中的方块位置。 */
	raycast(eye: Vec3, direction: Vec3, range: number): Promise<RayHit | null> | RayHit | null;
}

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const normalize = (a: Vec3): Vec3 => {
	const length = Math.hypot(a.x, a.y, a.z);
	return length === 0 ? { x: 0, y: 0, z: 0 } : scale(a, 1 / length);
};

/**
 * 射线与轴对齐盒的入射距离（slab 法）；不相交返回 null，起点在盒内返回 0。
 * 实体命中箱与遮挡方块共用它，"首命中是否早于命中箱"才有可比的同一口径。
 */
const rayBoxEntry = (eye: Vec3, direction: Vec3, min: Vec3, max: Vec3): number | null => {
	let enter = -Infinity;
	let exit = Infinity;
	for (const axis of ["x", "y", "z"] as const) {
		const d = direction[axis];
		const o = eye[axis];
		if (Math.abs(d) < 1e-9) {
			if (o < min[axis] || o > max[axis]) return null;
			continue;
		}
		const t1 = (min[axis] - o) / d;
		const t2 = (max[axis] - o) / d;
		enter = Math.max(enter, Math.min(t1, t2));
		exit = Math.min(exit, Math.max(t1, t2));
		if (enter > exit) return null;
	}
	if (exit < 0) return null;
	return Math.max(0, enter);
};

const normalOfFace = (faceNumber: number): Vec3 => FACE_NORMALS[faceNumber] ?? { x: 0, y: 1, z: 0 };

/**
 * 对指定面上的一个采样点做射线检查：首个被击中的方块必须是目标方块本身。
 * 玻璃等"看得见不能点穿"的方块会以首命中身份出现，使检查如实失败。
 * 命中点/进入面由目标真实形状的射线-AABB 精确解给出，不取方块中心近似。
 */
async function rayHitsFace(
	world: HitGateWorld,
	eye: Vec3,
	target: Vec3,
	sample: Vec3,
	expectedFaceNumber: number | null,
): Promise<{ hit: BlockHit } | { blocked: Vec3 } | { miss: true }> {
	const point = add(target, sample);
	const direction = normalize({ x: point.x - eye.x, y: point.y - eye.y, z: point.z - eye.z });
	if (direction.x === 0 && direction.y === 0 && direction.z === 0) return { miss: true };
	const first = await world.raycast(eye, direction, distance(eye, point) + 1);
	if (first == null) return { miss: true };
	if (first.position.x !== target.x || first.position.y !== target.y || first.position.z !== target.z) {
		return { blocked: first.position };
	}
	const block = world.blockAt(target);
	const shapes = block?.shapes ?? [[0, 0, 0, 1, 1, 1]];
	const origin = { x: eye.x - target.x, y: eye.y - target.y, z: eye.z - target.z };
	let best: { t: number; faceNumber: number } | null = null;
	for (const shape of shapes) {
		// 射线-AABB（slab 法）：零方向分量按平行处理——origin 在板内即贯穿，
		// 在板外即无交，不制造巨值假交点。
		let near = Number.NEGATIVE_INFINITY;
		let far = Number.POSITIVE_INFINITY;
		let faceNumber = 1;
		let miss = false;
		const slab = (lo: number, hi: number, o: number, d: number, enter: number, exit: number): void => {
			if (Math.abs(d) < 1e-12) {
				if (o < lo || o > hi) miss = true;
				return;
			}
			const t1 = (lo - o) / d;
			const t2 = (hi - o) / d;
			const [tNear, tFar] = t1 <= t2 ? [t1, t2] : [t2, t1];
			if (tNear > near) {
				near = tNear;
				faceNumber = d > 0 ? enter : exit;
			}
			if (tFar < far) far = tFar;
		};
		// d>0 时从低面进入：x 低面法向 -x（face 4）、y 低面 -y（0）、z 低面 -z（2）。
		slab(shape[0], shape[3], origin.x, direction.x, 4, 5);
		slab(shape[1], shape[4], origin.y, direction.y, 0, 1);
		slab(shape[2], shape[5], origin.z, direction.z, 2, 3);
		if (miss || near > far || far < 0) continue;
		if (best == null || near < best.t) best = { t: near, faceNumber };
	}
	// 采样点在请求面上，但射线可能从别的面先进（如俯视时射向北面样本会先进顶面）：
	// 进入面与请求面不符即视为该样本不可命中，不算受阻也不算成功。
	if (best == null || (expectedFaceNumber != null && best.faceNumber !== expectedFaceNumber)) {
		return { miss: true };
	}
	const hitPoint = add(eye, scale(direction, best.t));
	const clampedCursor = {
		x: Math.max(0, Math.min(1, hitPoint.x - target.x)),
		y: Math.max(0, Math.min(1, hitPoint.y - target.y)),
		z: Math.max(0, Math.min(1, hitPoint.z - target.z)),
	};
	return {
		hit: {
			faceNumber: best.faceNumber,
			face: normalOfFace(best.faceNumber),
			cursor: clampedCursor,
			point: hitPoint,
			distance: distance(eye, hitPoint),
		},
	};
}

/**
 * 某一面上的采样点：面平面坐标取真实形状在该轴上的极值面，切向取形状中心
 * 与四个极角——覆盖半砖、楼梯、门等部分形状的实际可命中区域。
 */
function faceSamples(block: { shapes?: number[][] }, faceNumber: number): Vec3[] {
	const shapes = block.shapes ?? [[0, 0, 0, 1, 1, 1]];
	if (shapes.length === 0) return [];
	const normal = normalOfFace(faceNumber);
	const axis = normal.x !== 0 ? 0 : normal.y !== 0 ? 1 : 2;
	const tangents = [0, 1, 2].filter((candidate) => candidate !== axis);
	const axisKey = axis === 0 ? "x" : axis === 1 ? "y" : "z";
	const tangentKeys: ("x" | "y" | "z")[] = tangents.map((a) => (a === 0 ? "x" : a === 1 ? "y" : "z"));
	const shapeIndex = (key: "x" | "y" | "z", end: boolean): number =>
		key === "x" ? (end ? 3 : 0) : key === "y" ? (end ? 4 : 1) : end ? 5 : 2;
	const range = (key: "x" | "y" | "z", end: boolean): { min: number; max: number } => {
		const values = shapes.map((shape) => shape[shapeIndex(key, end)]!);
		return { min: Math.max(0, Math.min(...values)), max: Math.min(1, Math.max(...values)) };
	};
	// 面平面坐标取真实形状在该轴上的极值面：半砖顶面是 0.5，不是 1；
	// 门/楼梯/火把这类部分形状必须按自己的实际几何取采样面。
	const fixedRange = range(axisKey, normal[axisKey] > 0);
	const fixed = normal[axisKey] > 0 ? fixedRange.max : fixedRange.min;
	const points: Vec3[] = [];
	const make = (a: number, b: number): Vec3 => {
		const point: Vec3 = { x: 0.5, y: 0.5, z: 0.5 };
		const record = point as unknown as Record<string, number>;
		record[axisKey] = fixed;
		record[tangentKeys[0]!] = Math.max(0, Math.min(1, a));
		record[tangentKeys[1]!] = Math.max(0, Math.min(1, b));
		return point;
	};
	const [first, second] = tangentKeys;
	const minA = range(first!, false).min;
	const maxA = range(first!, true).max;
	const minB = range(second!, false).min;
	const maxB = range(second!, true).max;
	points.push(make((minA + maxA) / 2, (minB + maxB) / 2));
	for (const [a, b] of [
		[minA, minB],
		[minA, maxB],
		[maxA, minB],
		[maxA, maxB],
	]) {
		points.push(make(a, b));
	}
	return points;
}

/**
 * 方块交互的最终派发闸门（§4.1）：
 * - 指定面：只检查该面的采样点，全部不可见/不可达即受阻；
 * - 未指定面：六个面依次检查，取第一个真实可命中的面；
 * - 首个被击中的方块必须是目标（玻璃不是透明通道）；
 * - 射程按眼位到命中点计（生存 4.5 口径，由调用方按模式给值）。
 */
export async function checkBlockHit(
	world: HitGateWorld,
	eye: Vec3,
	target: Vec3,
	options: { requestedFace?: Vec3; reach: number },
): Promise<HitGateResult> {
	const block = world.blockAt(target);
	if (block == null) {
		return {
			ok: false,
			code: "NOT_FOUND",
			message: `block ${target.x} ${target.y} ${target.z} is not loaded on the client`,
		};
	}
	// 空气/无碰撞形状的格没有可点击面：必须在采样前拒绝。空 shapes 会让面平面
	// 坐标算成 ±Infinity，射线方向变 NaN，prismarine 的 raycast 会死在步进循环里
	// （真服实证：瞄准期间目标被挖成空气，复核直接挂死）。
	if (block.shapes != null && block.shapes.length === 0) {
		return {
			ok: false,
			code: "NOT_FOUND",
			message: `block ${target.x} ${target.y} ${target.z} is air (no clickable shape)`,
		};
	}
	const requestedFaceNumber =
		options.requestedFace == null
			? null
			: FACE_NORMALS.findIndex(
					(candidate) =>
						candidate.x === options.requestedFace!.x &&
						candidate.y === options.requestedFace!.y &&
						candidate.z === options.requestedFace!.z,
				);
	if (options.requestedFace != null && requestedFaceNumber === -1) {
		// 面法向非法：调用方 schema 已拦常规输入，这里保守按不可达收口，不派发。
		return {
			ok: false,
			code: "UNREACHABLE",
			message: "requested face is not a valid face normal",
		};
	}
	const faces = requestedFaceNumber != null ? [requestedFaceNumber] : [1, 0, 3, 2, 5, 4];
	let blocked: Vec3 | undefined;
	let outOfReach: number | undefined;
	for (const faceNumber of faces) {
		for (const sample of faceSamples(block, faceNumber)) {
			const outcome = await rayHitsFace(world, eye, target, sample, requestedFaceNumber);
			if ("hit" in outcome) {
				if (outcome.hit.distance > options.reach) {
					outOfReach = Math.max(outOfReach ?? 0, outcome.hit.distance);
					continue;
				}
				return { ok: true, hit: outcome.hit };
			}
			if ("blocked" in outcome) blocked ??= outcome.blocked;
		}
	}
	if (outOfReach != null) {
		return {
			ok: false,
			code: "OUT_OF_REACH",
			message: `hit point is ${outOfReach.toFixed(2)} blocks from the eye (reach ${options.reach})`,
		};
	}
	return {
		ok: false,
		code: "UNREACHABLE",
		// 眼位写进消息：只报"被谁挡住"时，调用方无法判断是站位不对还是目标本身
		// 被完全包住，也无法据消息复现。三个坐标是判定的全部输入，一起给出。
		message:
			blocked != null
				? `line of sight to ${target.x} ${target.y} ${target.z} is blocked (first hit at ${blocked.x} ${blocked.y} ${blocked.z}, eye ${eye.x.toFixed(2)} ${eye.y.toFixed(2)} ${eye.z.toFixed(2)})`
				: `no hittable face of ${target.x} ${target.y} ${target.z} is visible from eye ${eye.x.toFixed(2)} ${eye.y.toFixed(2)} ${eye.z.toFixed(2)}`,
		...(blocked != null ? { occluder: blocked } : {}),
	};
}

// ---- 受控转头（§4.2）：离散动作与持续控制共用同一纯步进 ----
// Mineflayer yaw/pitch 是弧度；步进函数内部用度（观感初值以度表述）。

const toDegrees = (angles: AimAngles): AimAngles => ({ yaw: angles.yaw * DEG, pitch: angles.pitch * DEG });

/**
 * 派发闸门用的真实眼位：操作当刻的姿态化眼高（蹲/站/骑乘由 Mineflayer 维护），
 * 不用固定 1.62 猜测。eyeHeight 缺失时退回包围盒推算。
 */
export function eyeOf(entity: { position: Vec3; eyeHeight?: number; height?: number }): Vec3 {
	const eyeHeight = entity.eyeHeight ?? (entity.height != null ? entity.height - 0.2 : 1.62);
	return { x: entity.position.x, y: entity.position.y + eyeHeight, z: entity.position.z };
}

export interface AimableBot {
	entity: { position: Vec3; yaw: number; pitch: number; eyeHeight?: number; height?: number };
	/** force=false：角度立即生效并随下一个物理 Tick 的位置包发出。 */
	look(yaw: number, pitch: number, force: boolean): Promise<void>;
	on(name: "physicsTick", listener: () => void): unknown;
	off(name: "physicsTick", listener: () => void): unknown;
}

/**
 * 受控转头到位：按纯步进函数逐 look 转一步，目标角每步按当前眼位重算（人可以
 * 边走边转）。look(force=false) 的发送确认由 Mineflayer lookingTask 承担——它
 * 恰在下一个物理 Tick 的位置包发出后 resolve，因此这里的逐 look await 就是
 * 每 Tick 一步的节奏。取消/断连立即退出；look 停滞（骑乘后停模拟等）或预算
 * 耗尽时有界报错，绝不满负荷挂等。
 * 有界口径：单 look 停滞 1500ms、全程 4s——180° 反向按 12°/tick 也在预算内。
 */
export async function aimAtControlled(
	bot: AimableBot,
	point: Vec3,
	options: { signal: AbortSignal; totalBudgetMs?: number },
): Promise<void> {
	// 中断优先于镜头动画：abort 在任何等待点都立即打断转头（单次注册，退出即清理）。
	let rejectAbort: ((error: CallFailure) => void) | null = null;
	const onAbort = () =>
		rejectAbort?.(
			callFailure({
				code: "INTERRUPTED",
				source: "environment",
				message: "aiming was interrupted before the action was dispatched",
				dispatch: "not_sent",
				effects: [],
				recoverable: true,
			}),
		);
	const abortPromise = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	if (options.signal.aborted) onAbort();
	else options.signal.addEventListener("abort", onAbort, { once: true });
	const deadline = Date.now() + (options.totalBudgetMs ?? 4000);
	const stall = (work: Promise<void>): Promise<void> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(
				() =>
					reject(
						callFailure({
							code: "AIM_STALLED",
							source: "environment",
							message: "controlled aiming stalled; the client is not advancing look sends",
							dispatch: "not_sent",
							effects: [],
							recoverable: true,
						}),
					),
				1500,
			);
			void work.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
	try {
		void abortPromise.catch(() => {});
		for (;;) {
			if (options.signal.aborted) {
				throw callFailure({
					code: "INTERRUPTED",
					source: "environment",
					message: "aiming was interrupted before the action was dispatched",
					dispatch: "not_sent",
					effects: [],
					recoverable: true,
				});
			}
			if (Date.now() > deadline) {
				throw callFailure({
					code: "AIM_TIMEOUT",
					source: "environment",
					message: "controlled aiming exceeded its wall-clock budget before settling",
					dispatch: "not_sent",
					effects: [],
					recoverable: true,
				});
			}
			const eye = eyeOf(bot.entity);
			const target = anglesTo(point, eye);
			const step = nextAimStep(toDegrees({ yaw: bot.entity.yaw, pitch: bot.entity.pitch }), target);
			if (step.settled) return;
			await Promise.race([stall(bot.look(step.yaw / DEG, step.pitch / DEG, false)), abortPromise]);
		}
	} finally {
		options.signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Mineflayer bot → 闸门世界视图：blockAt 取真实碰撞形状，raycast 取首命中
 * 方块坐标。mining/session 两处派发闸门共用，避免各写一份适配。
 */
export function worldViewOf(bot: MineflayerBot): HitGateWorld {
	return {
		blockAt: (position) => {
			const block = bot.blockAt(toMineflayerVec3(position));
			return block == null ? null : { shapes: block.shapes };
		},
		raycast: async (eye, direction, range) => {
			const hit = await bot.world.raycast(toMineflayerVec3(eye), toMineflayerVec3(direction), range);
			if (hit == null) return null;
			// prismarine-world 运行时返回方块对象（位置在 hit.position），而它自己的
			// 类型声明只写了 x/y/z。两处都取：读顶层坐标会得到 undefined，使
			// "首命中是不是目标"永远为假——夹具里的普通对象掩盖过这个适配错误。
			const position = (hit as { position?: { x: number; y: number; z: number } }).position ?? {
				x: hit.x,
				y: hit.y,
				z: hit.z,
			};
			return { position };
		},
	};
}

/**
 * 实体交互的射程与遮挡判定（§4.1 实体）：眼位到命中箱的最近距离 ≤ 3，且朝命中箱的
 * 射线没有被方块先挡住。命中箱按 width/height 的真实 AABB 算，遮挡用同一射线的
 * AABB 入射距离比较——"首命中方块中心 ±0.5"的近似会把贴墙实体误判成被挡。
 */
export async function checkEntityHit(
	world: HitGateWorld,
	eye: Vec3,
	entity: { position: Vec3; height?: number; width?: number },
	reach = ENTITY_REACH,
): Promise<HitGateResult> {
	const half = (entity.width ?? 0.6) / 2;
	const height = entity.height ?? 1.8;
	const min = { x: entity.position.x - half, y: entity.position.y, z: entity.position.z - half };
	const max = { x: entity.position.x + half, y: entity.position.y + height, z: entity.position.z + half };
	const gap = {
		x: Math.max(min.x - eye.x, 0, eye.x - max.x),
		y: Math.max(min.y - eye.y, 0, eye.y - max.y),
		z: Math.max(min.z - eye.z, 0, eye.z - max.z),
	};
	const nearest = Math.hypot(gap.x, gap.y, gap.z);
	if (nearest > reach) {
		return {
			ok: false,
			code: "OUT_OF_REACH",
			message: `entity hitbox is ${nearest.toFixed(2)} blocks from the eye (reach ${reach})`,
		};
	}
	const center = { x: entity.position.x, y: entity.position.y + height / 2, z: entity.position.z };
	const direction = normalize({ x: center.x - eye.x, y: center.y - eye.y, z: center.z - eye.z });
	const entry = rayBoxEntry(eye, direction, min, max);
	// 眼睛已经在命中箱里时入射距离是 0：瞄向箱心，别把"瞄自己"交给转头步进。
	const hitDistance = entry != null && entry > 0.05 ? entry : distance(eye, center);
	const point =
		entry != null && entry > 0.05
			? { x: eye.x + direction.x * entry, y: eye.y + direction.y * entry, z: eye.z + direction.z * entry }
			: center;
	const clearHit: HitGateResult = {
		ok: true,
		hit: {
			faceNumber: 1,
			face: normalOfFace(1),
			cursor: { x: 0.5, y: 0.5, z: 0.5 },
			point,
			distance: hitDistance,
		},
	};
	const first = await world.raycast(eye, direction, hitDistance + 0.5);
	if (first == null) return clearHit;
	// 遮挡按方块真实碰撞形状算：半砖/门只占一部分体积，按整格 AABB 会把"从上方
	// 掠过"的视线误判成被挡。
	const shapes = world.blockAt(first.position)?.shapes ?? [[0, 0, 0, 1, 1, 1]];
	let blockEntry: number | null = null;
	for (const shape of shapes) {
		const entryOfShape = rayBoxEntry(
			eye,
			direction,
			{ x: first.position.x + shape[0]!, y: first.position.y + shape[1]!, z: first.position.z + shape[2]! },
			{ x: first.position.x + shape[3]!, y: first.position.y + shape[4]!, z: first.position.z + shape[5]! },
		);
		if (entryOfShape != null && (blockEntry == null || entryOfShape < blockEntry)) blockEntry = entryOfShape;
	}
	if (blockEntry != null && blockEntry < hitDistance - 0.01) {
		return {
			ok: false,
			code: "UNREACHABLE",
			message: `line of sight to the entity is blocked (first hit at ${first.position.x} ${first.position.y} ${first.position.z})`,
			occluder: first.position,
		};
	}
	return clearHit;
}
