/**
 * 下界传送门几何与选址（transit@1 的值层）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 transit。
 * 纯函数：不读世界、不做身体操作，可建性由动作层用一次 region@1 体素读回喂进来。
 * 门面朝向只有两种（宽度沿 x 或沿 z）。vanilla 允许省掉四角黑曜石，这里照建完整
 * 4×5：一种形状 = 一个成本常量、一行支撑、一个点火格，不用为"为什么点不着"分情况。
 */

import type { Vec3 } from "../../contracts/values.js";
import { stripNamespace } from "./targets.js";

/** 门面朝向：`x` = 宽度沿 x（法线沿 z）；`z` = 宽度沿 z（法线沿 x）。 */
export type PortalAxis = "x" | "z";

/** 内部 2 宽 × 3 高；框 4 宽 × 5 高；14 格黑曜石。 */
export const PORTAL_INNER = { width: 2, height: 3 } as const;
export const PORTAL_FRAME = { width: 4, height: 5 } as const;
export const PORTAL_OBSIDIAN_COST = 14;

/** 触发点亮需要的物品（打火石）。 */
export const PORTAL_IGNITER = "flint_and_steel";

export interface PortalFrame {
	axis: PortalAxis;
	/** 左下角框块（x/y/z 最小）。 */
	origin: Vec3;
	/** 14 格黑曜石，按施工顺序：底排 → 左柱 → 右柱 → 顶排（自下而上）。 */
	obsidian: Vec3[];
	/** 6 格内部空气格（y 优先，其次宽度）。 */
	interior: Vec3[];
	/** 进门落脚格：内部左下（站在框底排顶面上）。 */
	entrance: Vec3;
	/**
	 * 点火格：底排里"正上方是内部空气"的那一格，点它的顶面，火才落在门内。
	 * 点四角（底排两端）会把火指向左右柱——那里是实心黑曜石，服务端什么都不会放。
	 */
	ignite: Vec3;
}

/** 框内坐标 → 世界格；i 沿宽度、j 沿高度。 */
function cell(origin: Vec3, axis: PortalAxis, i: number, j: number): Vec3 {
	return axis === "x"
		? { x: origin.x + i, y: origin.y + j, z: origin.z }
		: { x: origin.x, y: origin.y + j, z: origin.z + i };
}

export function portalFrame(origin: Vec3, axis: PortalAxis): PortalFrame {
	const obsidian: Vec3[] = [];
	for (let i = 0; i < PORTAL_FRAME.width; i++) obsidian.push(cell(origin, axis, i, 0));
	for (let j = 1; j <= PORTAL_INNER.height; j++) obsidian.push(cell(origin, axis, 0, j));
	for (let j = 1; j <= PORTAL_INNER.height; j++) obsidian.push(cell(origin, axis, PORTAL_FRAME.width - 1, j));
	for (let i = 0; i < PORTAL_FRAME.width; i++) obsidian.push(cell(origin, axis, i, PORTAL_FRAME.height - 1));
	const interior: Vec3[] = [];
	for (let j = 1; j <= PORTAL_INNER.height; j++) {
		for (let i = 1; i <= PORTAL_INNER.width; i++) interior.push(cell(origin, axis, i, j));
	}
	return { axis, origin, obsidian, interior, entrance: cell(origin, axis, 1, 1), ignite: cell(origin, axis, 1, 0) };
}

/** 站位（进门前落脚）：门两侧各一格，含脚下与头部两格。 */
export interface PortalApproach {
	feet: Vec3;
	head: Vec3;
	ground: Vec3;
	/** 站位比门内低一格：进门要先迈上底排（多按一拍 jump）。 */
	stepUp: boolean;
}

/**
 * 门前两侧的站位候选，顺序即偏好：
 * - 齐平（stepUp=false）：脚下地面与底排同高，直着走进去——门嵌进地面时的形态；
 * - 低一格（stepUp=true）：门直接立在平地上，底排自己就是那级台阶——这是最常见的建法，
 *   进门要先上一步。
 *
 * 只认齐平会让"在平地上就地建门"永远选不到址：底排放在地表时，门内必然比脚下高一格。
 */
export function portalApproaches(frame: PortalFrame): PortalApproach[] {
	const normal = frame.axis === "x" ? { x: 0, z: 1 } : { x: 1, z: 0 };
	const out: PortalApproach[] = [];
	for (const stepUp of [false, true]) {
		const y = frame.entrance.y - (stepUp ? 1 : 0);
		for (const sign of [-1, 1]) {
			const feet = { x: frame.entrance.x + normal.x * sign, y, z: frame.entrance.z + normal.z * sign };
			out.push({
				feet,
				head: { x: feet.x, y: feet.y + 1, z: feet.z },
				ground: { x: feet.x, y: feet.y - 1, z: feet.z },
				stepUp,
			});
		}
	}
	return out;
}

/**
 * 一次选址要检查的全部格子：
 * - `open`：框 14 格 + 内部 6 格必须是可替换方块（空地才能施工）；
 * - `supports`：底排下方 4 格必须是实心地面（框要立得住）；
 * - `approaches`：两侧 × 齐平/低一格共四个站位，任一"脚下实心 + 脚/头两格可替换"即可进门。
 */
export interface PortalSite {
	frame: PortalFrame;
	open: Vec3[];
	supports: Vec3[];
	approaches: PortalApproach[];
}

export function portalSite(origin: Vec3, axis: PortalAxis): PortalSite {
	const frame = portalFrame(origin, axis);
	const supports = frame.obsidian.slice(0, PORTAL_FRAME.width).map((at) => ({ x: at.x, y: at.y - 1, z: at.z }));
	return { frame, open: [...frame.obsidian, ...frame.interior], supports, approaches: portalApproaches(frame) };
}

/** region@1 的读回视图（palette + xzy 索引），只读一次就够判定一个候选。 */
export interface RegionGrid {
	origin: Vec3;
	shape: [number, number, number];
	palette: { name: string; properties: Record<string, string> }[];
	cells: number[];
}

export function regionGrid(value: unknown): RegionGrid | null {
	const raw = value as Partial<RegionGrid> | null;
	if (raw == null || raw.origin == null || raw.shape == null || raw.palette == null || raw.cells == null) return null;
	return raw as RegionGrid;
}

/** 取一格；越界或未加载（-1）返回 null——未知不是空气。 */
export function gridAt(grid: RegionGrid, at: Vec3): { name: string } | null {
	const [nx, ny, nz] = grid.shape;
	const ix = at.x - grid.origin.x;
	const iy = at.y - grid.origin.y;
	const iz = at.z - grid.origin.z;
	if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return null;
	const index = grid.cells[iy * nx * nz + iz * nx + ix]!;
	if (index < 0) return null;
	return grid.palette[index] ?? null;
}

/** 覆盖一个候选所需的 region 盒子（含两侧站位各一格）。 */
export function siteBounds(site: PortalSite): { from: Vec3; to: Vec3 } {
	const points = [...site.open, ...site.supports, ...site.approaches.flatMap((a) => [a.feet, a.head, a.ground])];
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const zs = points.map((p) => p.z);
	return {
		from: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
		to: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) },
	};
}

/**
 * 候选能不能建：`open` 全可替换、`supports` 全实心，且至少一侧站得进去。
 * 能建就返回**那一侧**（调用方还要用它走过去），否则 null——判定和"从哪进"是同一次计算，
 * 拆成两个函数就会各写一遍"能不能站"。
 */
export function portalSiteAccess(
	grid: RegionGrid,
	site: PortalSite,
	replaceable: (name: string) => boolean,
): PortalApproach | null {
	for (const at of site.open) {
		const block = gridAt(grid, at);
		if (block == null || !replaceable(block.name)) return null;
	}
	for (const at of site.supports) {
		const block = gridAt(grid, at);
		if (block == null || replaceable(block.name)) return null;
	}
	for (const approach of site.approaches) {
		const ground = gridAt(grid, approach.ground);
		const feet = gridAt(grid, approach.feet);
		const head = gridAt(grid, approach.head);
		if (ground == null || replaceable(ground.name)) continue;
		if (feet == null || !replaceable(feet.name)) continue;
		if (head == null || !replaceable(head.name)) continue;
		return approach;
	}
	return null;
}

/**
 * 候选生成：先在原地两种朝向，再按半径环向外扩（先近后远，同距离先 x 后 z）。
 * 只给候选，不判可建——判定要世界数据，归调用方。
 */
export function siteCandidates(anchor: Vec3, radius = 6): { origin: Vec3; axis: PortalAxis }[] {
	const base = { x: Math.floor(anchor.x), y: Math.floor(anchor.y), z: Math.floor(anchor.z) };
	const out: { origin: Vec3; axis: PortalAxis }[] = [];
	const offsets: Vec3[] = [{ x: 0, y: 0, z: 0 }];
	for (let r = 1; r <= radius; r++) {
		for (let dx = -r; dx <= r; dx++) {
			for (let dz = -r; dz <= r; dz++) {
				if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
				offsets.push({ x: dx, y: 0, z: dz });
			}
		}
	}
	for (const offset of offsets) {
		for (const axis of ["x", "z"] as const) {
			out.push({ origin: { x: base.x + offset.x, y: base.y + offset.y, z: base.z + offset.z }, axis });
		}
	}
	return out;
}

/** 维度名的裸形式（去掉 minecraft: 前缀）。 */
export function bareDimension(name: string): string {
	return stripNamespace(name);
}

/**
 * 门链接坐标：在下界按 1:8 换算，主世界 ↔ 下界以外的维度不缩放。
 * 返回值用于"在该维度里建门时应站到哪"——只影响选址，不改变目的地。
 */
export function linkedCoordinates(from: string, to: string, at: Vec3): Vec3 {
	const source = bareDimension(from);
	const target = bareDimension(to);
	if (source === target) return at;
	if (source === "the_nether" && target === "overworld") {
		return { x: at.x * 8, y: at.y, z: at.z * 8 };
	}
	if (source === "overworld" && target === "the_nether") {
		return { x: Math.floor(at.x / 8), y: at.y, z: Math.floor(at.z / 8) };
	}
	return at;
}

/** 选址离当前站位多远才值得换算过去（超过这个距离就地建门更省）。 */
export const LINKED_SITE_RADIUS = 128;
