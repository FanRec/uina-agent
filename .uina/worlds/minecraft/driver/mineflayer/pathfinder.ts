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
	allowSprinting: boolean;
	canDig: boolean;
}

const { pathfinder, Movements } = pathfinderModule;
const { GoalNear } = pathfinderModule.goals;

/** gotoNear 可收敛的上游拒绝名（lib/goto.js 固定集合）。 */
export type PathfinderGotoErrorName = "NoPath" | "Timeout" | "PathStopped" | "GoalChanged";

export interface PathfinderMovementsConfig {
	sprint: boolean;
	digThrough: boolean;
}

/** 适配层内的插件装配面视图；仅本文件可见。 */
interface PathfinderAssembly {
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
 * placeToReach 语义（搭路方块开关）2.4.5 无独立旗标，归能力层经脚手架配置扩展。
 */
export function configureMovements(bot: MineflayerBot, config: PathfinderMovementsConfig): void {
	const assembly = (bot as BotWithAssembly).pathfinder;
	const existing = assembly?.movements;
	const movements = existing instanceof Movements ? existing : new Movements(bot);
	movements.allowSprinting = config.sprint;
	movements.canDig = config.digThrough;
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
