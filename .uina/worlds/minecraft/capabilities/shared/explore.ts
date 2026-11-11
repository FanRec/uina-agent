/**
 * explore@1 的纯逻辑：稀疏观察图、前沿提取、候选评分与派发失败记账。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md#explore、§2.10。
 * 覆盖记忆限单次探索活动（01-DESIGN §6：不建第二世界数据库）——只存 region
 * 读实际观测过的格，未入图的格一律按未知处理；未加载（-1）格不入图，未知不是空气。
 * 常量集中此处（实现冻结；真服场景验收时一次调定），不做用户配置。
 */

import type { Vec3 } from "../../contracts/values.js";
import { distance, stripNamespace } from "./targets.js";

// —— 观察盒（实现冻结） ——
/** 每站观察盒：以脚底格为中心水平 ±16、竖直 ±3（33×7×33=7623 ≤ region 8192 上限）。 */
export const OBSERVE_HALF = 16;
export const OBSERVE_VERTICAL = 3;
/** until 扫描半径（blocks/entities 查询，与旧段扫描一致）。 */
export const SCAN_RADIUS = 32;

// —— 候选与估价（实现冻结） ——
/** 启发式排序后只对前 K 个候选做 route.plan 真实估价。 */
export const ROUTE_CHECK_TOP = 5;
/** 单段导航墙钟上限；整次预算由动作层统一结算。 */
export const LEG_MAX_TIME_MS = 45000;
export const LEG_TOLERANCE = 2;
/** 评分权重：未知邻增益 / 行走代价 / 岩浆危险 / 失败记账 / 方向偏置。 */
export const W_GAIN = 10;
export const W_DIST = 1;
export const W_HAZARD = 25;
export const W_ATTEMPT = 15;
export const DIRECTION_BIAS = 4;
/** 同一前沿格 TIMEOUT 失败记账达到该次数判死（UNREACHABLE 立即判死）。 */
export const ATTEMPTS_BEFORE_DEAD = 2;

export type Cardinal = "n" | "e" | "s" | "w";
export type Direction = Cardinal | "any";
export const DIRECTIONS: readonly Cardinal[] = ["n", "e", "s", "w"];

const VECTORS: Record<Cardinal, { x: number; z: number }> = {
	n: { x: 0, z: -1 },
	e: { x: 1, z: 0 },
	s: { x: 0, z: 1 },
	w: { x: -1, z: 0 },
};

const NEIGHBORS: readonly Vec3[] = [
	{ x: 1, y: 0, z: 0 },
	{ x: -1, y: 0, z: 0 },
	{ x: 0, y: 1, z: 0 },
	{ x: 0, y: -1, z: 0 },
	{ x: 0, y: 0, z: 1 },
	{ x: 0, y: 0, z: -1 },
];

export type CellState = "air" | "water" | "lava" | "solid";

/** region palette 名字分类；其余一律按阻挡（列合法性由 goto 真判，图只服务覆盖）。 */
export function classifyCell(name: string): CellState {
	if (name === "air") return "air";
	if (name === "lava") return "lava";
	if (name === "water") return "water";
	return "solid";
}

/** region@1 输出的观察切片（order 固定 "xzy"，未加载格 cells 为 -1）。 */
export interface RegionSample {
	origin: Vec3;
	shape: [number, number, number];
	palette: { name: string }[];
	cells: number[];
}

function cellKey(at: Vec3): string {
	return `${at.x},${at.y},${at.z}`;
}

/**
 * 单次探索活动的稀疏覆盖图：格状态 + 死格记账，按维度分区。
 * 只增不剪——会话级规模（每站 ~7.6k 格，重复大半）全图扫描可接受；
 * 跨 Run 复用走 World 领域记录，不在这里。
 */
export class ObservationMap {
	readonly dimension: string;
	private readonly cells = new Map<string, CellState>();
	private readonly dead = new Set<string>();
	private readonly attempts = new Map<string, number>();
	private readonly visited = new Set<string>();

	constructor(dimension: string) {
		this.dimension = dimension;
	}

	/** 站过的格不再是候选目标——同格重观察不产生新信息（until 扫描在每站照常做）。 */
	markVisited(at: Vec3): void {
		this.visited.add(cellKey(at));
	}

	cellAt(at: Vec3): CellState | null {
		return this.cells.get(cellKey(at)) ?? null;
	}

	/** region 读入图；-1（未加载）格不入图。返回本批新观测格数。 */
	ingest(sample: RegionSample): number {
		const [nx, ny, nz] = sample.shape;
		let added = 0;
		for (let dy = 0; dy < ny; dy++) {
			for (let dz = 0; dz < nz; dz++) {
				for (let dx = 0; dx < nx; dx++) {
					const index = dy * nx * nz + dz * nx + dx;
					const entry = sample.palette[sample.cells[index] ?? -1];
					if (entry == null) continue;
					const at = { x: sample.origin.x + dx, y: sample.origin.y + dy, z: sample.origin.z + dz };
					const key = cellKey(at);
					if (!this.cells.has(key)) added += 1;
					this.cells.set(key, classifyCell(entry.name));
				}
			}
		}
		return added;
	}

	/** 六邻中的未知格数（未入图即未知，含请求过但未加载的 -1 格）。 */
	unknownNeighbors(at: Vec3): number {
		let unknown = 0;
		for (const d of NEIGHBORS) {
			if (this.cells.get(cellKey({ x: at.x + d.x, y: at.y + d.y, z: at.z + d.z })) == null) unknown += 1;
		}
		return unknown;
	}

	/** 自身或六邻存在岩浆。 */
	hazardNear(at: Vec3): boolean {
		if (this.cells.get(cellKey(at)) === "lava") return true;
		return NEIGHBORS.some((d) => this.cells.get(cellKey({ x: at.x + d.x, y: at.y + d.y, z: at.z + d.z })) === "lava");
	}

	attemptCount(at: Vec3): number {
		return this.attempts.get(cellKey(at)) ?? 0;
	}

	/**
	 * 派发失败记账：UNREACHABLE 立即判死；TIMEOUT（导航超时）与 plan（route.plan
	 * 判定不可达的软失败）两次判死。只判死该格，不封方向。
	 */
	markFailed(at: Vec3, kind: "unreachable" | "timeout" | "plan"): void {
		const key = cellKey(at);
		if (kind === "unreachable") {
			this.dead.add(key);
			return;
		}
		const count = (this.attempts.get(key) ?? 0) + 1;
		this.attempts.set(key, count);
		if (count >= ATTEMPTS_BEFORE_DEAD) this.dead.add(key);
	}

	/** 可站立列：本格与头顶可通行（air/water）、脚下一格 solid。纯水下列不算（游泳不是探索步）。 */
	private standable(at: Vec3): boolean {
		const here = this.cells.get(cellKey(at));
		if (here !== "air" && here !== "water") return false;
		const head = this.cells.get(cellKey({ x: at.x, y: at.y + 1, z: at.z }));
		if (head !== "air" && head !== "water") return false;
		return this.cells.get(cellKey({ x: at.x, y: at.y - 1, z: at.z })) === "solid";
	}

	/** 前沿：可站立、未判死、未站过、六邻存在未知格。全图扫描——覆盖图只增不剪，会话级规模可接受。 */
	frontiers(): Vec3[] {
		const result: Vec3[] = [];
		for (const [key, state] of this.cells) {
			if (state !== "air" && state !== "water") continue;
			if (this.dead.has(key) || this.visited.has(key)) continue;
			const [xs, ys, zs] = key.split(",");
			const at = { x: Number(xs), y: Number(ys), z: Number(zs) };
			if (!this.standable(at)) continue;
			if (this.unknownNeighbors(at) > 0) result.push(at);
		}
		return result;
	}
}

export interface FrontierCandidate {
	at: Vec3;
	/** 六邻未知格数（信息增益近似）。 */
	gain: number;
	/** 与当前位置的直线距离。 */
	straight: number;
	hazard: boolean;
	attempts: number;
	/** direction 偏置分（方向对齐为正）。 */
	bias: number;
}

function heuristicScore(candidate: FrontierCandidate): number {
	return (
		candidate.gain * W_GAIN -
		candidate.straight * W_DIST -
		(candidate.hazard ? W_HAZARD : 0) -
		candidate.attempts * W_ATTEMPT +
		candidate.bias
	);
}

function byDeterministicOrder(a: FrontierCandidate, b: FrontierCandidate): number {
	return (
		heuristicScore(b) - heuristicScore(a) ||
		a.straight - b.straight ||
		a.at.x - b.at.x ||
		a.at.y - b.at.y ||
		a.at.z - b.at.z
	);
}

/** 候选按启发式降序（并列按直线距离、坐标升序——完全确定）。 */
export function rankFrontiers(
	from: Vec3,
	candidates: Vec3[],
	map: ObservationMap,
	direction: Direction,
): FrontierCandidate[] {
	const biasVector = direction === "any" ? null : VECTORS[direction];
	const ranked = candidates.map((at) => {
		const straight = distance(from, at);
		let bias = 0;
		if (biasVector != null) {
			const dx = at.x - from.x;
			const dz = at.z - from.z;
			const length = Math.hypot(dx, dz);
			if (length > 0) bias = ((dx * biasVector.x + dz * biasVector.z) / length) * DIRECTION_BIAS;
		}
		return {
			at,
			gain: map.unknownNeighbors(at),
			straight,
			hazard: map.hazardNear(at),
			attempts: map.attemptCount(at),
			bias,
		};
	});
	ranked.sort(byDeterministicOrder);
	return ranked;
}

/**
 * 候选挑选：有 route.plan 可达估价者用路径距离重排并只在其间挑选。全部候选都被
 * 判不可达（"unreachable"，真实计划证据）时返回 null——调用方软记账后换一批，
 * 不向已知不可达处派发；全部无证据（null，估价读取失败）才回退启发式最优
 * （goto 会诚实裁决）。并列裁决与 rankFrontiers 同序，保证无估价时结果确定。
 */
export function pickFrontier(
	candidates: FrontierCandidate[],
	estimates: (number | "unreachable" | null)[],
): Vec3 | null {
	if (candidates.length === 0) return null;
	const scored = candidates.map((candidate, i) => {
		const plan = estimates[i] ?? null;
		return {
			candidate,
			state: plan,
			score: typeof plan === "number" ? candidate.gain * W_GAIN - plan * W_DIST : null,
		};
	});
	const okPool = scored.filter((entry) => typeof entry.state === "number");
	const pool = okPool.length > 0 ? okPool : scored.some((entry) => entry.state === "unreachable") ? [] : scored;
	const scoreOf = (entry: { score: number | null }): number => entry.score ?? Number.NEGATIVE_INFINITY;
	pool.sort(
		(a, b) =>
			scoreOf(b) - scoreOf(a) ||
			a.candidate.straight - b.candidate.straight ||
			a.candidate.at.x - b.candidate.at.x ||
			a.candidate.at.y - b.candidate.at.y ||
			a.candidate.at.z - b.candidate.at.z,
	);
	return pool[0]?.candidate.at ?? null;
}

export function matchesTargetName(actual: string, wanted: string): boolean {
	return stripNamespace(actual) === stripNamespace(wanted);
}

// ---- 跨侦察动作共享的会话步骤（explore@1 与 survey@1 同源；不复制寻路） ----

/** 每站观察盒读数：以脚底格为原点的 region 体素切片。 */
export async function observeAround(
	world: import("../../contracts/world.js").WorldPort,
	self: { place: { position: Vec3 } },
): Promise<RegionSample> {
	const at = {
		x: Math.floor(self.place.position.x) - OBSERVE_HALF,
		y: Math.floor(self.place.position.y) - OBSERVE_VERTICAL,
		z: Math.floor(self.place.position.z) - OBSERVE_HALF,
	};
	const observation = (await world.read<RegionSample>({
		ref: "region@1",
		input: { at, size: { x: OBSERVE_HALF * 2 + 1, y: OBSERVE_VERTICAL * 2 + 1, z: OBSERVE_HALF * 2 + 1 } },
	})) as { value: RegionSample };
	return observation.value;
}

/**
 * route.plan 只读估价：可达给路径距离，计划判定不可达给 "unreachable"（真实
 * 证据），读取异常给 null（无证据——goto 是真裁决）。估价只做排序与派发门槛。
 */
export async function estimateRoute(
	world: import("../../contracts/world.js").WorldPort,
	at: Vec3,
): Promise<number | "unreachable" | null> {
	try {
		const observation = (await world.read<{ ok: boolean; distance: number }>({
			ref: "route.plan@1",
			input: {
				at: { x: at.x, y: at.y, z: at.z },
				tolerance: LEG_TOLERANCE,
				digThrough: false,
				placeToReach: false,
				sprint: true,
			},
		})) as { value: { ok: boolean; distance: number } };
		if (!observation.value.ok) return "unreachable";
		return Number.isFinite(observation.value.distance) ? observation.value.distance : null;
	} catch {
		return null;
	}
}
