/**
 * 世界本地扫描：站立/露天判据与露天出口查找（surface@1 的 SurfaceProbe 实现；G3）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §5、modules/capabilities.md §4 surface。
 * 只读 bot.blockAt 的本地区块数据，不写世界、不占控制；未加载区块如实 null（未知，不猜）。
 * 固体 = boundingBox "block"；液体 = water/lava/bubble_column（与 pathfinder 逃生判据同口径）。
 * 露天按"头顶之上无实体块"判定：液体不遮天（水下抬头仍见天），站立判据另行排除液体——
 * 两者组合才是"露天且可站立"。
 *
 * 成本边界（真服实测）：blockAt 单次 ~0.1-0.2ms，全盘 33×33 列 × 全高扫描会把事件循环
 * 卡住几十秒（心跳饿死 → OWNER_EXPIRED，批11 经验 2 的翻版）。因此：
 * - findSkyAccess 用螺旋环序 + 命中即退（多数场景在近环解决）；
 * - 列扫描起点限高（头顶 64 格内），不扫全高；
 * - 方法是异步的，每个环之间 setImmediate 让出事件循环。
 */

import type { MineflayerBot } from "./adapter.js";
import { toMineflayerVec3 } from "./adapter.js";
import type { SurfaceProbe } from "../../contracts/world.js";
import type { Vec3 } from "../../contracts/values.js";

/** 1.21 各维度世界顶（overworld 319 / nether 191 / end 255）。 */
function worldTopY(bot: MineflayerBot): number {
	const dimension = String(bot.game?.dimension ?? "");
	if (dimension.includes("nether")) return 191;
	if (dimension.includes("end")) return 255;
	return 319;
}

interface ScanBlock {
	name: string;
	boundingBox: "empty" | "block" | "fluid";
}

function blockAt(bot: MineflayerBot, x: number, y: number, z: number): ScanBlock | null {
	return bot.blockAt(toMineflayerVec3({ x, y, z }), false) as ScanBlock | null;
}

function isSolid(block: ScanBlock): boolean {
	return block.boundingBox === "block";
}

function isLiquid(name: string): boolean {
	return /water|lava|bubble_column/.test(name);
}

/** 列扫描起点：世界顶与"脚位上方 64 格"取低者——找出口不需要比这更高的天空。 */
const COLUMN_UP_BOUND = 64;

/** 站立判据：脚下实心、脚/头两格非固体且非液体。任一格未加载 → null。 */
export function standableAt(bot: MineflayerBot, at: Vec3): boolean | null {
	const x = Math.floor(at.x);
	const y = Math.floor(at.y);
	const z = Math.floor(at.z);
	const floor = blockAt(bot, x, y - 1, z);
	const feet = blockAt(bot, x, y, z);
	const head = blockAt(bot, x, y + 1, z);
	if (floor == null || feet == null || head == null) return null;
	if (!isSolid(floor)) return false;
	if (isSolid(feet) || isSolid(head)) return false;
	if (isLiquid(feet.name) || isLiquid(head.name)) return false;
	return true;
}

/** 露天判据：头顶（y+2..top）无实体块。扫描路径上任一格未加载 → null。 */
export function skyOpenAt(bot: MineflayerBot, at: Vec3): boolean | null {
	const x = Math.floor(at.x);
	const z = Math.floor(at.z);
	const top = worldTopY(bot);
	for (let y = top; y > Math.floor(at.y) + 1; y--) {
		const block = blockAt(bot, x, y, z);
		if (block == null) return null;
		if (isSolid(block)) return false;
	}
	return true;
}

/** 一根柱子自上而下找第一实体块；未加载 → null（列未知）。 */
function columnGround(bot: MineflayerBot, x: number, z: number, top: number, bottom: number): number | null {
	for (let y = top; y >= bottom; y--) {
		const block = blockAt(bot, x, y, z);
		if (block == null) return null;
		if (isSolid(block)) return y;
	}
	return null;
}

function yieldEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 半径内最近的露天可站脚位：按距离环序螺旋扫描，命中即退。
 * 列扫描起点限高（center.y + COLUMN_UP_BOUND）；列未加载/限高范围内无实体块 → 跳过该列。
 * 每个环之间让出事件循环。无命中 → null（不猜）。
 */
export async function findSkyAccess(bot: MineflayerBot, center: Vec3, radius: number): Promise<Vec3 | null> {
	const cx = Math.floor(center.x);
	const cz = Math.floor(center.z);
	const cy = Math.floor(center.y);
	let best: Vec3 | null = null;
	for (let ring = 0; ring <= radius; ring++) {
		for (let dx = -ring; dx <= ring; dx++) {
			for (let dz = -ring; dz <= ring; dz++) {
				if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
				const x = cx + dx;
				const z = cz + dz;
				const top = Math.min(worldTopY(bot), cy + COLUMN_UP_BOUND);
				const ground = columnGround(bot, x, z, top, Math.max(-64, cy - 16));
				if (ground == null) continue;
				const at: Vec3 = { x, y: ground + 1, z };
				if (standableAt(bot, at) !== true) continue;
				// 站立判据不含"头顶开放"——封闭房间内部也可站。出口必须露天，补 skyOpen 复核。
				if (skyOpenAt(bot, at) !== true) continue;
				if (
					best == null ||
					Math.hypot(at.x - center.x, at.y - center.y, at.z - center.z) <
						Math.hypot(best.x - center.x, best.y - center.y, best.z - center.z)
				) {
					best = at;
				}
			}
		}
		// 近环命中即可用（出口选择不求全局最优，求立刻能走）；扫描让出事件循环。
		if (best != null) return best;
		await yieldEventLoop();
	}
	return best;
}

export function createSurfaceProbe(bot: MineflayerBot): SurfaceProbe {
	return {
		standable: async (at) => standableAt(bot, at),
		skyOpen: async (at) => skyOpenAt(bot, at),
		findSkyAccess: (center, radius) => findSkyAccess(bot, center, radius),
	};
}
