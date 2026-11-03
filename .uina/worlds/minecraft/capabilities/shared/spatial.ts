/**
 * 空间作业纯函数层：走廊规划、profile 展开、区域清空枚举、方块分类。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 tunnel/excavate。
 * 全部是确定性纯函数（不读世界、不做身体操作），单测直接覆盖；
 * 液体/重力方块的世界探测与挖放执行归动作层（tunnel.ts / excavate.ts）。
 */

import type { Vec3 } from "../../contracts/values.js";

export type TunnelProfile = "1x2" | "1x3" | "2x2" | "3x3";

/** profile 名义尺寸：宽 × 高（宽沿行进方向的垂直方向展开）。 */
export function expandProfile(profile: TunnelProfile): { width: number; height: number } {
	switch (profile) {
		case "1x2":
			return { width: 1, height: 2 };
		case "1x3":
			return { width: 1, height: 3 };
		case "2x2":
			return { width: 2, height: 2 };
		case "3x3":
			return { width: 3, height: 3 };
	}
}

/** 重力方块：失承会坠入已挖开的腔体（tunnel support 的探测对象）。 */
export function isGravityBlock(name: string): boolean {
	return name === "sand" || name === "red_sand" || name === "gravel";
}

/** 通道内不可徒步行进的流体：tunnel 如实失败，不冒进。 */
export function isLiquidBlock(name: string): boolean {
	return /water|lava|bubble_column/.test(name);
}

/** 清空前要先收内容的容器（excavate"先收容器内容"；shulker 各染色变体同匹配）。 */
export function isContainerBlock(name: string): boolean {
	return /^(chest|trapped_chest|barrel|.*shulker_box|furnace|hopper|dispenser|dropper)$/.test(name);
}

/** excavate 默认保留（capabilities §4：keep 缺省值）。 */
export const DEFAULT_EXCAVATE_KEEP = ["bedrock", "chest", "furnace", "spawner"] as const;

/** excavate 单次体素上限（capabilities §2 体积表）。 */
export const EXCAVATE_MAX_VOXELS = 4096;

export interface TunnelColumn {
	/** 本列脚位（地板格）。 */
	floor: Vec3;
	/** 本列要打开的格子（profile 自地板展开，主行进线 + 宽度方向；下坡列含檐块），已去重。 */
	cells: Vec3[];
	/** 主行进线 profile 顶之上的第一格（support 重力探测起点；下坡列它本身要挖）。 */
	ceiling: Vec3;
	/** 下坡过渡列：ceiling 檐块要挖（头部过檐），支撑探测自 ceiling+1 起步。 */
	digCeiling: boolean;
}

function keyOf(at: Vec3): string {
	return `${at.x},${at.y},${at.z}`;
}

/**
 * 走廊规划：L 形两轴水平段 + 高差处理。
 * stairs "auto"：台阶 1:1——每水平步地板最多 ±1，成坡可走；水平步数不够时
 * 段尾补竖井站（竖直段能否真实走通由执行结算，规划不预判成功）。
 * stairs "never"：不做台阶塑形——水平段保持恒定地板高度，高差在段尾竖井衔接。
 */
export function planCorridor(from: Vec3, to: Vec3, profile: TunnelProfile, stairs: "auto" | "never"): TunnelColumn[] {
	const { width, height } = expandProfile(profile);
	const start = { x: from.x, y: from.y, z: from.z };
	const end = { x: to.x, y: to.y, z: to.z };

	// 水平单位步：先长轴后短轴（少转弯；等长先 x，稳定确定）。
	const steps: Vec3[] = [];
	const pushAxis = (delta: number, dir: Vec3): void => {
		const magnitude = Math.abs(delta);
		for (let i = 0; i < magnitude; i++) steps.push(dir);
	};
	if (Math.abs(end.x - start.x) >= Math.abs(end.z - start.z)) {
		pushAxis(end.x - start.x, { x: Math.sign(end.x - start.x), y: 0, z: 0 });
		pushAxis(end.z - start.z, { x: 0, y: 0, z: Math.sign(end.z - start.z) });
	} else {
		pushAxis(end.z - start.z, { x: 0, y: 0, z: Math.sign(end.z - start.z) });
		pushAxis(end.x - start.x, { x: Math.sign(end.x - start.x), y: 0, z: 0 });
	}

	// 地板高度序列：auto 把 |dy| 分摊到前 |dy| 个水平步（1:1），never 保持水平。
	const dy = end.y - start.y;
	const ramping = stairs === "auto" && dy !== 0;
	const floors: Vec3[] = [{ ...start }];
	let cursor = { ...start };
	let y = start.y;
	let ramped = 0;
	for (const step of steps) {
		if (ramping && ramped < Math.abs(dy)) {
			y += Math.sign(dy);
			ramped += 1;
		}
		cursor = { x: cursor.x + step.x, y, z: cursor.z + step.z };
		floors.push({ ...cursor });
	}
	// 剩余高差：同一 (x,z) 竖直升降衔接。
	let remaining = ramping ? dy - Math.sign(dy) * ramped : dy;
	while (remaining !== 0) {
		y += Math.sign(remaining);
		remaining -= Math.sign(remaining);
		floors.push({ x: cursor.x, y, z: cursor.z });
	}

	const columns: TunnelColumn[] = [];
	for (let i = 0; i < floors.length; i++) {
		const floor = floors[i];
		const previous = floors[i - 1] ?? floors[i + 1] ?? floor;
		// 行进方向：本列相对邻列的水平分量；x 向行进宽度沿 z 展开，其余（含竖井）沿 x。
		const dirX = Math.sign(floor.x - previous.x);
		const perp: Vec3 = dirX !== 0 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
		const cells: Vec3[] = [];
		for (let k = 0; k < width; k++) {
			for (let h = 0; h < height; h++) {
				cells.push({ x: floor.x + perp.x * k, y: floor.y + h, z: floor.z + perp.z * k });
			}
		}
		// 下坡过渡要挖檐块（主行进线头顶那格）：走廊在低层，机器人从高层走近时
		// 头部（1.8 高）会撞在过渡面的实体檐上——onGround 又不让它先下落，物理卡死。
		// 檐块 = ceiling 主线格；挖了它支撑探测也从再上一格起步。
		// 首列是起点（不是"走下来的"），永不挖檐。
		const descending = i > 0 && floor.y < floors[i - 1]!.y;
		if (descending) cells.push({ x: floor.x, y: floor.y + height, z: floor.z });
		const seen = new Set<string>();
		columns.push({
			floor,
			cells: cells.filter((cell) => (seen.has(keyOf(cell)) ? false : (seen.add(keyOf(cell)), true))),
			ceiling: { x: floor.x, y: floor.y + height, z: floor.z },
			digCeiling: descending,
		});
	}
	// 上坡过渡要挖前一位列的跳跃净空（prev 的 ceiling 格）：2 高空间里跳跃被天花板
	// 削顶（脚只能抬 ~0.2），跳不上 1 格台阶——净空挖开后跳跃弧线才够得到踏步面。
	// 与下坡挖檐对称；挖了它支撑探测也从再上一格起步。
	// G24：升坡列自身也要 3 高净空——越顶瞬间头部会探进落点列的顶格，height<3 的
	// profile 把升坡列 ceiling 一并挖除；height≥3 的走廊净空已够，不多挖。
	const widenAscender = height < 3;
	const openCeiling = (column: TunnelColumn): void => {
		column.cells.push(column.ceiling);
		column.digCeiling = true;
		const seen = new Set(column.cells.map(keyOf));
		column.cells = column.cells.filter((cell) => seen.delete(keyOf(cell)));
	};
	for (let i = 1; i < columns.length; i++) {
		if (columns[i]!.floor.y > columns[i - 1]!.floor.y) {
			openCeiling(columns[i - 1]!);
			if (widenAscender) openCeiling(columns[i]!);
		}
	}
	return columns;
}

/**
 * 区域清空枚举：层自上而下（清空时头顶先开，不掉落掩埋）；
 * 层内顺序由执行按当前位置就近排序（orderNear），规划不定死。
 */
export function planExcavation(min: Vec3, max: Vec3): Vec3[][] {
	const layers: Vec3[][] = [];
	for (let y = max.y; y >= min.y; y--) {
		const layer: Vec3[] = [];
		for (let z = min.z; z <= max.z; z++) {
			for (let x = min.x; x <= max.x; x++) {
				layer.push({ x, y, z });
			}
		}
		layers.push(layer);
	}
	return layers;
}

/** 层内就近序：先近后远（曼哈顿距离），减少同层来回走。 */
export function orderNear(cells: Vec3[], near: Vec3): Vec3[] {
	const distance = (at: Vec3): number => Math.abs(at.x - near.x) + Math.abs(at.y - near.y) + Math.abs(at.z - near.z);
	return [...cells].sort((a, b) => distance(a) - distance(b));
}

/** 闭区间盒的角点（from/to 闭区间，归一化 min/max）。 */
export function normalizeBox(from: Vec3, to: Vec3): { min: Vec3; max: Vec3; voxels: number } {
	const min = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) };
	const max = { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) };
	return { min, max, voxels: (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1) };
}
