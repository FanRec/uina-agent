/**
 * explore@1 的纯逻辑：段规划、方向轮换与命中匹配。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md#explore、§2.10。
 * 常量集中此处（实现冻结；真服场景验收时一次调定），不做用户配置。
 * "未访问过"按整数格计；找不到不等于不存在（tracked/loaded 范围语义）。
 */

import type { Vec3 } from "../../contracts/values.js";
import { stripNamespace } from "./targets.js";

export const LEG_DISTANCE = 24;
export const LEG_TOLERANCE = 4;
export const SCAN_RADIUS = 32;
export const LEG_MAX_TIME_MS = 45000;
export const DIRECTIONS = ["n", "e", "s", "w"] as const;

export type Cardinal = (typeof DIRECTIONS)[number];
export type Direction = Cardinal | "any";

const VECTORS: Record<Cardinal, { x: number; z: number }> = {
	n: { x: 0, z: -1 },
	e: { x: 1, z: 0 },
	s: { x: 0, z: 1 },
	w: { x: -1, z: 0 },
};

function cellKey(at: Vec3): string {
	return `${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}`;
}

/**
 * 探索游标：已扫描格集合 + 死亡方向（该方向上一段 UNREACHABLE）。
 * direction 指定主方向时它最先，"any" 按 n→e→s→w 轮换；目标格已扫描的方向跳过。
 */
export class ExploreCursor {
	private readonly visited = new Set<string>();
	private readonly dead = new Set<Cardinal>();
	private readonly order: readonly Cardinal[];

	constructor(direction: Direction) {
		this.order = direction === "any" ? DIRECTIONS : [direction, ...DIRECTIONS.filter((d) => d !== direction)];
	}

	markVisited(at: Vec3): void {
		this.visited.add(cellKey(at));
	}

	markDead(direction: Cardinal): void {
		this.dead.add(direction);
	}

	/** 下一段：第一个未死且目标格未访问的方向；没有可用方向 → null（可达空间穷尽）。 */
	nextLeg(from: Vec3): { at: Vec3; direction: Cardinal } | null {
		for (const direction of this.order) {
			if (this.dead.has(direction)) continue;
			const v = VECTORS[direction];
			const at = { x: from.x + v.x * LEG_DISTANCE, y: from.y, z: from.z + v.z * LEG_DISTANCE };
			if (this.visited.has(cellKey(at))) continue;
			return { at, direction };
		}
		return null;
	}
}

export function matchesTargetName(actual: string, wanted: string): boolean {
	return stripNamespace(actual) === stripNamespace(wanted);
}
