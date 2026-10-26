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
import type { MineflayerBot } from "./adapter.js";
import { toMineflayerVec3 } from "./adapter.js";
import type { Vec3 } from "../../contracts/values.js";

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
	scafoldingBlocks: number[];
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
	): IterableIterator<{ result: { status: string; path: Vec3[] } }>;
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
 * 以原语配置 Movements；实例不外泄（§9.1）。复用已装载实例，避免重置寻路共享状态。
 * Disabling placements removes usable scaffolding as well as towers: bridging and jump supports
 * consult remainingBlocks, not allow1by1towers. Re-enabling restores this adapter's default materials.
 */
export function configureMovements(bot: MineflayerBot, config: PathfinderMovementsConfig): void {
	const assembly = (bot as BotWithAssembly).pathfinder;
	const existing = assembly?.movements;
	const movements = existing instanceof Movements ? existing : new Movements(bot);
	movements.allowSprinting = config.sprint;
	movements.canDig = config.digThrough;
	movements.allow1by1towers = config.placeToReach;
	movements.scafoldingBlocks = config.placeToReach
		? [bot.registry.itemsByName.dirt.id, bot.registry.itemsByName.cobblestone.id]
		: [];
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
	movements.canDig = false;
	movements.allow1by1towers = false;
	movements.scafoldingBlocks = [];
	movements.allowParkour = false;
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
