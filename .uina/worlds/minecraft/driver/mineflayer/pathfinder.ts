/**
 * Pathfinder 受控适配层：driver/mineflayer/ 内独立 import mineflayer-pathfinder 的位置。
 *
 * 唯一定义来源：docs/proposals/mc/modules/driver.md §9.1、§9.3。
 * 边界规则（§9.1）：上层不得 import 插件类、不得触碰 bot.pathfinder 内部对象、
 * 不得持有 Movements/目标/锁实例；本文件只收发原语（坐标、数值、布尔），
 * 并把上游错误名收敛为固定集合。插件装配面视图（PathfinderAssembly）不出本文件。
 * 完整受控独占（§9.3）：保留上游规划与执行；写源封印由调用方的 physicsTick
 * 守卫配合本文件 clearGoal 的同步清键路径完成，stop()/setGoal(null)
 * 不作为停止屏障的唯一证据。
 * 固定源码 2.4.5 事实：公开 stop() 只置标志；内部 stop() 先发 path_stop 再
 * fullStop（清键 + 零速 + 位置回中，属本 Operation 的修正，不是服务端纠偏）；
 * monitorMovement 在 stateGoal 为空时不再写键位。
 */

import { createRequire } from "node:module";
import type { Vec3 } from "../../contracts/values.js";
import type { RoutePlanAction } from "../../contracts/world.js";
import type { MineflayerBot } from "./adapter.js";
import { toMineflayerVec3 } from "./adapter.js";

/**
 * mineflayer-pathfinder 是 CJS module.exports 对象字面量，tsx 纯 ESM 下具名导入
 * 不可静态识别；经 createRequire 加载（与 adapter.ts 的 vec3、engine.ts 的 Ajv
 * 同一仓库惯例）。类型按本文件用到的最小面收敛，不依赖包内 d.ts。
 */
const pathfinderModule = createRequire(import.meta.url)("mineflayer-pathfinder") as {
	/** 插件注入函数（上游 index.js 的 inject）。 */
	pathfinder: (bot: MineflayerBot) => void;
	/** Movements 构造器；registry 由 bot 携带。 */
	Movements: new (
		bot: MineflayerBot,
	) => PathfinderMovements;
	goals: { GoalNear: new (x: number, y: number, z: number, range: number) => unknown };
};

/** 本文件触碰的 Movements 最小面。 */
interface PathfinderMovements {
	allowParkour: boolean;
	maxDropDown: number;
	allowSprinting: boolean;
	canDig: boolean;
	allow1by1towers: boolean;
	canOpenDoors: boolean;
	/** 上游默认 true：落水不受 maxDropDown 约束，见 MOVEMENTS_POLICY 的说明。 */
	infiniteLiquidDropdownDistance: boolean;
	scafoldingBlocks: number[];
	/** 补丁扩展字段：A* 扩展偏置（1 = 上游原序）。 */
	heuristicWeight: number;
}

const { pathfinder, Movements } = pathfinderModule;
const { GoalNear } = pathfinderModule.goals;

/** gotoNear 可收敛的上游拒绝名（lib/goto.js 固定集合）。 */
export type PathfinderGotoErrorName = "NoPath" | "Timeout" | "PathStopped" | "GoalChanged";

export interface PathfinderMovementsConfig {
	sprint: boolean;
	digThrough: boolean;
	/** 允许垫方块到达；脚手架方块沿用上游默认（dirt/cobblestone）。 */
	placeToReach: boolean;
}

/** 适配层内的插件装配面视图；仅本文件可见。 */
interface PathfinderAssembly {
	getPathFromTo(
		movements: PathfinderMovements,
		start: unknown,
		goal: unknown,
		options: object,
	): IterableIterator<{ result: { status: string; cost: number; path: PlanMove[] } }>;
	movements?: unknown;
	goal?: unknown;
	setMovements(movements: unknown): void;
	setGoal(goal: unknown, dynamic?: boolean): void;
	goto(goal: unknown): Promise<void>;
	isMoving(): boolean;
}

type BotWithAssembly = MineflayerBot & { pathfinder?: PathfinderAssembly };

/** 受控加载（幂等）：保留上游搜索与执行算法。 */
export function loadPathfinderPlugin(bot: MineflayerBot): void {
	if ((bot as BotWithAssembly).pathfinder == null) bot.loadPlugin(pathfinder);
}

/**
 * 规划口径的固定策略（不是每次调用可调的参数）。放在一处是为了让"哪些是策略、
 * 哪些是调用方选项"一眼可分，并让单测能直接断言策略本身。
 *
 * - allowParkour=false：上游执行器做不稳跑酷节点（要精确的起跳时机），
 *   默认 true 会让 A* 规划出走不出来的路线，因此规划与执行一致地关闭。
 * - canOpenDoors=true：上游默认关（闭门 useOne 会再"用一下"把开着的门关上）；
 *   补丁已修为仅闭门生成 useOne 且执行器核验开门事实。
 * - infiniteLiquidDropdownDistance=false：落水下落同样受 maxDropDown 约束。
 *   上游默认 true = 不限深度，真服实测（G28 归因）：平台架在 y≈199、下方 y≈62 是
 *   海面时，"从平台边缘落进海里"成为 cost 1 的合法一步，目标不可达的几何上 A*
 *   把整片海面搜完（70,916 节点 / 5s think budget 超时）；关掉后同题 1,922 节点 /
 *   1352ms 诚实 noPath。规划出 100+ 格落水也不是这台机器能执行的动作。
 * - heuristicWeight=3：欧氏启发式在爬升地形严重低估真实代价，无偏置搜索沿等高线
 *   泛洪（24 格山头 5.8 万节点超时）。只改扩展顺序：合法性、g 代价、isEnd 不动。
 */
export const MOVEMENTS_POLICY = {
	allowParkour: false,
	canOpenDoors: true,
	infiniteLiquidDropdownDistance: false,
	heuristicWeight: 3,
} as const;

/**
 * 导航选项 → Movements 字段的唯一赋值口径：活动导航（configureMovements）与只读
 * 试算（planPath/planEscape）共用，防止第三份配置漂移（driver.md §9.1、§2.11）。
 * Disabling placements removes usable scaffolding as well as towers: bridging and jump supports
 * consult remainingBlocks, not allow1by1towers. Re-enabling restores this adapter's default materials.
 * 上游执行器做不稳跑酷节点（要精确的起跳时机）；默认 true 会让 A* 规划出
 * 走不出来的路线，因此规划与执行一致地关闭。
 */
function applyMovementsConfig(
	movements: PathfinderMovements,
	bot: MineflayerBot,
	config: PathfinderMovementsConfig,
): void {
	movements.allowSprinting = config.sprint;
	movements.canDig = config.digThrough;
	movements.allow1by1towers = config.placeToReach;
	movements.allowParkour = MOVEMENTS_POLICY.allowParkour;
	movements.heuristicWeight = MOVEMENTS_POLICY.heuristicWeight;
	movements.canOpenDoors = MOVEMENTS_POLICY.canOpenDoors;
	movements.infiniteLiquidDropdownDistance = MOVEMENTS_POLICY.infiniteLiquidDropdownDistance;
	movements.scafoldingBlocks = config.placeToReach
		? [bot.registry.itemsByName.dirt.id, bot.registry.itemsByName.cobblestone.id]
		: [];
}

/** 以原语配置 Movements；实例不外泄（§9.1）。复用已装载实例，避免重置寻路共享状态。 */
export function configureMovements(bot: MineflayerBot, config: PathfinderMovementsConfig): void {
	const assembly = (bot as BotWithAssembly).pathfinder;
	const existing = assembly?.movements;
	const movements = existing instanceof Movements ? existing : new Movements(bot);
	applyMovementsConfig(movements, bot, config);
	assembly?.setMovements(movements);
}

/** GoalNear 的原语入参收敛；目标实例不出本文件。reject 时 Error.name ∈ PathfinderGotoErrorName。 */
export function gotoNear(bot: MineflayerBot, at: Vec3, tolerance: number): Promise<void> {
	const assembly = (bot as BotWithAssembly).pathfinder;
	if (assembly == null) {
		throw new Error("pathfinder plugin is not loaded");
	}
	const goal = new GoalNear(at.x, at.y, at.z, tolerance);
	return assembly.goto(goal);
}

/** 清除目标：同步触发上游 resetPath（清路径/停挖/释放锁/清控制键）。 */
export function clearGoal(bot: MineflayerBot): void {
	(bot as BotWithAssembly).pathfinder?.setGoal(null);
}

/** 插件是否仍持有目标（写源活性指标；null/未装载为 false）。 */
export function pathfinderGoalActive(bot: MineflayerBot): boolean {
	return (bot as BotWithAssembly).pathfinder?.goal != null;
}

/** 路径是否仍在推进（路径队列非空）。 */
export function pathfinderMoving(bot: MineflayerBot): boolean {
	return (bot as BotWithAssembly).pathfinder?.isMoving() ?? false;
}

/** Read-only short search; never setGoal/setMovements or start the upstream writer. */
export function escapeWaypoints(path: Vec3[], current: Vec3): Vec3[] {
	const points = path.length
		? path
		: [{ x: Math.floor(current.x), y: Math.floor(current.y), z: Math.floor(current.z) }];
	return points.map((p) => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }));
}
export function escapeGoalBias(node: Vec3, origin: Vec3): number {
	return Math.hypot(node.x + 0.5 - origin.x, node.y - origin.y, node.z + 0.5 - origin.z) * 0.001;
}
export function escapeThreatClearance(node: Vec3, threats: Vec3[]): boolean {
	return threats.every((t) => Math.hypot(t.x - (node.x + 0.5), t.y - node.y, t.z - (node.z + 0.5)) >= 8.15);
}
export async function planEscape(
	bot: MineflayerBot,
	kind: "lava" | "drowning" | "low_health_damage",
	threats: Vec3[],
	signal: AbortSignal,
): Promise<Vec3[] | null> {
	loadPathfinderPlugin(bot);
	const movements = new Movements(bot);
	// 逃生口径：不挖不垫、允许冲刺（构造器默认）、下落上限 1 格。
	applyMovementsConfig(movements, bot, { sprint: true, digThrough: false, placeToReach: false });
	movements.maxDropDown = 1;
	const block = (p: Vec3) => bot.blockAt(toMineflayerVec3(p), false);
	const origin = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
	const goal = {
		// Break equal grid-cost ties using the actual sub-cell body position. A
		// moving player at a lava edge must not turn back across the source cell.
		heuristic: (node: Vec3) => escapeGoalBias(node, origin),
		hasChanged: () => false,
		isValid: () => true,
		isEnd: (node: Vec3) => {
			const feet = block(node),
				head = block({ ...node, y: node.y + 1 }),
				floor = block({ ...node, y: node.y - 1 });
			if (!feet || !head || !floor) return false;
			if ([feet.name, head.name].some((n) => /lava|fire|cactus|magma/.test(n))) return false;
			if (head.boundingBox !== "empty" || /water|bubble_column/.test(head.name)) return false;
			if (kind === "drowning") return true;
			if (feet.boundingBox !== "empty" || floor.boundingBox !== "block") return false;
			return kind !== "low_health_damage" || escapeThreatClearance(node, threats);
		},
	};
	const iterator = (bot as BotWithAssembly).pathfinder!.getPathFromTo(movements, bot.entity.position, goal, {
		timeout: 250,
		tickTimeout: 2,
		searchRadius: 16,
		optimizePath: false,
	});
	for (const { result } of iterator) {
		signal.throwIfAborted();
		if (result.status === "success") return escapeWaypoints(result.path, bot.entity.position);
		if (result.status !== "partial") return null;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return null;
}

export function canBreathe(bot: MineflayerBot, position: Vec3): boolean | null {
	const head = bot.blockAt(toMineflayerVec3({ ...position, y: position.y + 1.62 }), false);
	return head == null ? null : head.boundingBox === "empty" && !/water|lava|bubble_column/.test(head.name);
}

// ---- route.plan@1：只读试算（capabilities.md §3 route.plan、§2.11） ----

export interface PlannedStep {
	x: number;
	y: number;
	z: number;
	action: RoutePlanAction;
}

export interface PlannedPath {
	status: "success" | "noPath" | "timeout";
	/** 上游 a* 代价合计（移动代价单位，近似穿越+挖掘/垫块的秒数量级）。 */
	cost: number;
	steps: PlannedStep[];
	needs: { dig: number; place: number };
}

/** 上游 Move 的最小面（optimizePath=false 保留原始节点）；导出供确定性测试构造。 */
export interface PlanMove {
	x: number;
	y: number;
	z: number;
	toBreak: unknown[];
	toPlace: unknown[];
	parkour: boolean;
}

/** 逐格动作（固定推导，写入适配文件不扩散）：垫块 > 挖掘 > 跳跃（上升/跑酷） > 行走。 */
function stepAction(move: PlanMove, previous: PlanMove | null): RoutePlanAction {
	if (move.toPlace.length > 0) return "place";
	if (move.toBreak.length > 0) return "dig";
	if (move.parkour || (previous != null && move.y > previous.y)) return "jump";
	return "walk";
}

/** Move 链 → 动作步与需求计数（首节点是起点 Move，无动作，跳过但参与上升判定）。 */
export function deriveSteps(moves: PlanMove[]): { steps: PlannedStep[]; needs: { dig: number; place: number } } {
	const body = moves.length > 0 ? moves.slice(1) : [];
	const steps: PlannedStep[] = [];
	let dig = 0;
	let place = 0;
	let previous: PlanMove | null = moves.length > 0 ? moves[0]! : null;
	for (const move of body) {
		dig += move.toBreak.length;
		place += move.toPlace.length;
		steps.push({ x: move.x, y: move.y, z: move.z, action: stepAction(move, previous) });
		previous = move;
	}
	return { steps, needs: { dig, place } };
}

/**
 * 只读试算到 GoalNear 的路径：局部 Movements（不触碰活动导航的共享配置）、
 * never setGoal、optimizePath=false 保留上游 Move 的 toBreak/toPlace。
 * 每次 compute 受 tickTimeout 约束，并在迭代间 setImmediate 让出事件循环——
 * a* 最多跑满上游 think 超时（5s），同步排水会让心跳饿死（owner 过期）。
 * status 收敛为 success/noPath/timeout（partial 只是中间产出）。
 */
export async function planPath(
	bot: MineflayerBot,
	at: Vec3,
	tolerance: number,
	config: PathfinderMovementsConfig,
): Promise<PlannedPath> {
	loadPathfinderPlugin(bot);
	const assembly = (bot as BotWithAssembly).pathfinder;
	if (assembly == null) throw new Error("pathfinder plugin is not loaded");
	const movements = new Movements(bot);
	applyMovementsConfig(movements, bot, config);
	const goal = new GoalNear(at.x, at.y, at.z, tolerance);
	const iterator = assembly.getPathFromTo(movements, bot.entity.position, goal, { optimizePath: false });
	for (;;) {
		const step = iterator.next();
		if (step.done) break;
		const { result } = step.value;
		if (result.status === "success" || result.status === "noPath" || result.status === "timeout") {
			return { status: result.status, cost: result.cost, ...deriveSteps(result.path) };
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	// 生成器在非 partial 终态收尾；兜底按无路径收敛（不发生即不出口）。
	return { status: "noPath", cost: 0, steps: [], needs: { dig: 0, place: 0 } };
}
