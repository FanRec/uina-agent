/**
 * Construction 的 Target 语义：设计格的四分类、镜像/旋转与规范化。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §2.2、§4「共用目标与差异处理」。
 * 这里只有纯值计算，不读世界、不读文件、不碰身体。
 *
 * 四类目标的含义（合同原文）：
 * - set：必须持有声明方块与显式状态；
 * - clear：必须为空（设计声明的清空，不由 replace 猜出）；
 * - preserve：不产生修改，也不算目标未达成；
 * - unknown：设计来源不明，任何空气策略都不能把它变成可拆除目标。
 *
 * 变换语义（合同未定义，本文件是唯一定义处）：
 * - mirror 在**自身包围盒内**翻转（`x → nx-1-x` / `z → nz-1-z`），
 *   不产生负坐标，因此 mirror 不改变 size；
 * - rotate 是绕 Y 轴顺时针（东→南），90/270 会交换 x/z 两轴，size 随之交换；
 * - 顺序固定：先 mirror 再 rotate，状态与坐标用同一顺序，两者才会一致；
 * - 方块状态只变换能确定语义的五个属性（facing/axis/rotation/hinge/shape），
 *   其中 shape 与 half 相对于 facing 表达，旋转时不需要改，镜像时要左右互换。
 *   其余属性原样复制；无法安全变换的组合不静默猜（见 transformBlockState）。
 */

import type { BlockSpec, BlockStateValue } from "../contracts/body.js";
import { itemName } from "../contracts/items.js";
import type { Vec3 } from "../contracts/values.js";
import type { ConstructionTargetCell, ConstructionTargetKind } from "../contracts/world.js";

/** 四分类的唯一来源是 contracts/world.ts（public-api §5）；这里只做别名，不复制定义。 */
export type TargetKind = ConstructionTargetKind;
/** 一个设计格：本地偏移（相对设计原点）或已加锚点的绝对格，两种形态由 context 决定。 */
export type TargetCell = ConstructionTargetCell;

export interface ConstructionTarget {
	/** 设计盒尺寸 [nx, ny, nz]；本地格必须落在 [0,size) 内。 */
	size: Vec3;
	/** 本地格（相对设计原点，未变换）。 */
	cells: TargetCell[];
}

export type MirrorMode = "none" | "x" | "z";
export type Rotation = 0 | 90 | 180 | 270;

export interface TransformSpec {
	mirror?: MirrorMode;
	rotate?: Rotation;
}

/** 施工域的可解释失败：由调用方决定映射成哪个 CallFailure（输入侧或环境侧）。 */
export class ConstructionError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly hint?: string,
	) {
		super(message);
		this.name = "ConstructionError";
	}
}

export function isAirName(name: string): boolean {
	const bare = itemName(name);
	return bare === "air" || bare === "cave_air" || bare === "void_air";
}

/**
 * 方块/物品名的唯一归一化：去掉 `minecraft:` 前缀。
 * 实现就是 contracts/items 的 itemName（全仓唯一一份）；本名保留给施工域与
 * 能力层（shared/targets.ts 从这里再导出）。
 */
export { itemName as stripNamespace };

export function specBlockName(spec: BlockSpec): string {
	return itemName(typeof spec === "string" ? spec : spec.name);
}

/**
 * 可被放置直接替换的方块：空气、流体与常见地表植物。
 * 其余方块要么本来就是目标状态，要么必须显式 `replace=true` 才允许拆除。
 * 这是 place@1 与施工计划的**同一份**判据，不各写一套。
 */
const REPLACEABLE = new Set([
	"air",
	"cave_air",
	"void_air",
	"water",
	"lava",
	"short_grass",
	"tall_grass",
	"fern",
	"large_fern",
	"dead_bush",
	"snow",
	"vine",
	"seagrass",
	"tall_seagrass",
]);

export function isReplaceableName(name: string): boolean {
	return REPLACEABLE.has(itemName(name));
}

/** 可以充当放置支撑面 / 阻挡施工的实心方块：非空气且不可替换。 */
export function isSolidName(name: string): boolean {
	return !isReplaceableName(name);
}

export function specProperties(spec: BlockSpec): Record<string, string> {
	return typeof spec === "string" ? {} : { ...(spec.properties ?? {}) };
}

function intVec(value: Vec3, what: string): Vec3 {
	for (const axis of ["x", "y", "z"] as const) {
		if (!Number.isInteger(value[axis])) {
			throw new ConstructionError("INVALID_INPUT", `${what}.${axis} must be an integer, got ${value[axis]}`);
		}
	}
	return { x: value.x, y: value.y, z: value.z };
}

/**
 * 规范化设计格：校验整数坐标与包围盒、把绝对格折成本地偏移、检测重复格。
 * 允许来源给绝对坐标（本地坐标被平移过），以最小角为原点重新归一。
 */
export function normalizeTarget(cells: TargetCell[], size?: Vec3): ConstructionTarget {
	if (cells.length === 0) throw new ConstructionError("INVALID_INPUT", "target has no cells");
	const points = cells.map((cell) => ({ cell, at: intVec(cell.at, "target cell") }));
	const min = {
		x: Math.min(...points.map((p) => p.at.x)),
		y: Math.min(...points.map((p) => p.at.y)),
		z: Math.min(...points.map((p) => p.at.z)),
	};
	const max = {
		x: Math.max(...points.map((p) => p.at.x)),
		y: Math.max(...points.map((p) => p.at.y)),
		z: Math.max(...points.map((p) => p.at.z)),
	};
	const extent = { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };
	if (size != null) {
		const declared = intVec(size, "target size");
		if (declared.x !== extent.x || declared.y !== extent.y || declared.z !== extent.z) {
			throw new ConstructionError(
				"INVALID_INPUT",
				`declared size ${declared.x}x${declared.y}x${declared.z} does not match the cell extent ${extent.x}x${extent.y}x${extent.z}`,
			);
		}
	}
	const seen = new Set<string>();
	const local: TargetCell[] = [];
	for (const { cell, at } of points) {
		const rel = { x: at.x - min.x, y: at.y - min.y, z: at.z - min.z };
		const key = `${rel.x},${rel.y},${rel.z}`;
		if (seen.has(key)) throw new ConstructionError("INVALID_INPUT", `duplicate target cell at ${key}`);
		seen.add(key);
		local.push({ ...cell, at: rel });
	}
	return { size: extent, cells: local };
}

/** 旋转后的包围盒尺寸；mirror 不改变尺寸。 */
export function transformedSize(size: Vec3, transform: TransformSpec): Vec3 {
	const rotate = transform.rotate ?? 0;
	if (rotate === 90 || rotate === 270) return { x: size.z, y: size.y, z: size.x };
	return { x: size.x, y: size.y, z: size.z };
}

function mirrorPoint(at: Vec3, size: Vec3, mirror: MirrorMode): Vec3 {
	if (mirror === "x") return { x: size.x - 1 - at.x, y: at.y, z: at.z };
	if (mirror === "z") return { x: at.x, y: at.y, z: size.z - 1 - at.z };
	return at;
}

/**
 * 旋转 90° 顺时针（东→南）。在 nz×nx 的盒子内：`x' = nz-1-z, z' = x`。
 * 180/270 由 90 反复应用得到，保证与状态变换的 "+4/90°" 完全同源。
 */
function rotatePointOnce(at: Vec3, size: Vec3): { at: Vec3; size: Vec3 } {
	return { at: { x: size.z - 1 - at.z, y: at.y, z: at.x }, size: { x: size.z, y: size.y, z: size.x } };
}

const HORIZONTAL = ["north", "east", "south", "west"] as const;

/** 顺时针转 90°：north→east→south→west→north。 */
function rotateFacing(value: string): string {
	const index = HORIZONTAL.indexOf(value as (typeof HORIZONTAL)[number]);
	if (index < 0) return value;
	return HORIZONTAL[(index + 1) % 4]!;
}

function mirrorFacing(value: string, mirror: MirrorMode): string {
	if (mirror === "x") {
		if (value === "east") return "west";
		if (value === "west") return "east";
		return value;
	}
	if (mirror === "z") {
		if (value === "north") return "south";
		if (value === "south") return "north";
		return value;
	}
	return value;
}

function swapAxis(value: string): string {
	if (value === "x") return "z";
	if (value === "z") return "x";
	return value;
}

function swapSided(value: string): string {
	if (value === "left") return "right";
	if (value === "right") return "left";
	if (value === "inner_left") return "inner_right";
	if (value === "inner_right") return "inner_left";
	if (value === "outer_left") return "outer_right";
	if (value === "outer_right") return "outer_left";
	return value;
}

/**
 * 声明状态随坐标一起变换（research.md:317「坐标与 Block State 一起转换」）。
 *
 * 只处理语义确定的属性：
 * - `facing`：水平四向按旋转/镜像变换，up/down 不动；
 * - `axis`：90/270 交换 x/z，镜像不动；
 * - `rotation`（0–15，告示牌/旗帜）：每 90° +4；镜像按顺时针角度的反射
 *   （x 轴 `(16-r)%16`、z 轴 `(8-r)%16`）；
 * - `hinge`/`shape`：相对 facing 表达，旋转不动、镜像时左右互换；
 * - 其它属性原样复制。
 * `rotation` 不是整数或越界、`facing`/`axis` 出现未识别值时不猜，直接失败。
 */
export function transformBlockState(spec: BlockSpec, transform: TransformSpec): BlockSpec {
	if (typeof spec === "string") return spec;
	const mirror = transform.mirror ?? "none";
	const rotate = transform.rotate ?? 0;
	if (mirror === "none" && rotate === 0) return spec;
	const properties: Record<string, string> = {};
	for (const [key, value] of Object.entries(spec.properties ?? {})) {
		if (key === "facing") {
			let next = value;
			if (HORIZONTAL.includes(next as (typeof HORIZONTAL)[number])) {
				for (let step = 0; step < rotate / 90; step++) next = rotateFacing(next);
				next = mirrorFacing(next, mirror);
			} else if (next !== "up" && next !== "down") {
				throw new ConstructionError(
					"INVALID_INPUT",
					`cannot transform facing="${next}" on ${spec.name}: only up/down/north/east/south/west are known`,
				);
			}
			properties[key] = next;
			continue;
		}
		if (key === "axis") {
			const swapped = rotate === 90 || rotate === 270 ? swapAxis(value) : value;
			if (swapped !== "x" && swapped !== "y" && swapped !== "z") {
				throw new ConstructionError(
					"INVALID_INPUT",
					`cannot transform axis="${value}" on ${spec.name}: only x/y/z are known`,
				);
			}
			properties[key] = swapped;
			continue;
		}
		if (key === "rotation") {
			const raw = Number(value);
			if (!Number.isInteger(raw) || raw < 0 || raw > 15) {
				throw new ConstructionError(
					"INVALID_INPUT",
					`cannot transform rotation="${value}" on ${spec.name}: expected an integer 0-15`,
				);
			}
			let next = (((raw + (rotate / 90) * 4) % 16) + 16) % 16;
			if (mirror === "x") next = (16 - next) % 16;
			else if (mirror === "z") next = (8 - next + 16) % 16;
			properties[key] = String(next);
			continue;
		}
		if (key === "hinge" || key === "shape") {
			properties[key] = mirror === "none" ? value : swapSided(value);
			continue;
		}
		properties[key] = value;
	}
	return { name: spec.name, properties };
}

/**
 * 把本地设计格实例化到世界：mirror → rotate → 平移 at。
 *
 * 返回按 (y, z, x) 排序的绝对格，顺序固定，计划与执行读同一份顺序。
 */
export function applyTransform(target: ConstructionTarget, at: Vec3, transform: TransformSpec = {}): TargetCell[] {
	const anchor = intVec(at, "at");
	const mirror = transform.mirror ?? "none";
	const rotate = transform.rotate ?? 0;
	if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) {
		throw new ConstructionError("INVALID_INPUT", `rotate must be 0/90/180/270, got ${rotate}`);
	}
	const placed: TargetCell[] = [];
	const seen = new Set<string>();
	for (const cell of target.cells) {
		const local = intVec(cell.at, "target cell");
		if (
			local.x < 0 ||
			local.y < 0 ||
			local.z < 0 ||
			local.x >= target.size.x ||
			local.y >= target.size.y ||
			local.z >= target.size.z
		) {
			throw new ConstructionError(
				"INVALID_INPUT",
				`target cell ${local.x},${local.y},${local.z} is outside the ${target.size.x}x${target.size.y}x${target.size.z} design box`,
			);
		}
		let point = mirrorPoint(local, target.size, mirror);
		let size = transformedSize(target.size, { mirror });
		for (let step = 0; step < rotate / 90; step++) {
			const rotated = rotatePointOnce(point, size);
			point = rotated.at;
			size = rotated.size;
		}
		const absolute = { x: point.x + anchor.x, y: point.y + anchor.y, z: point.z + anchor.z };
		const key = `${absolute.x},${absolute.y},${absolute.z}`;
		if (seen.has(key)) throw new ConstructionError("INVALID_INPUT", `duplicate target cell at ${key}`);
		seen.add(key);
		placed.push({
			at: absolute,
			kind: cell.kind,
			...(cell.block != null ? { block: transformBlockState(cell.block, transform) } : {}),
			...(cell.reason != null ? { reason: cell.reason } : {}),
		});
	}
	return orderTargets(placed);
}

/** 计划与执行共用的固定顺序：先按高度，再按 z，再按 x。 */
export function orderTargets(cells: TargetCell[]): TargetCell[] {
	return [...cells].sort((a, b) => a.at.y - b.at.y || a.at.z - b.at.z || a.at.x - b.at.x);
}

/** Target 内的机器可读形态（`target.json` 与 `.schem` 解码的共同产物）。 */
export function targetToCellSpecs(target: ConstructionTarget): TargetCell[] {
	return orderTargets(target.cells);
}

/** 现场方块状态是否满足声明（名字 + 每个显式属性；未声明的状态不参与判定）。 */
export function matchesDeclared(spec: BlockSpec, state: BlockStateValue | null): boolean {
	if (state == null) return false;
	if (specBlockName(state.name) !== specBlockName(spec)) return false;
	const properties = specProperties(spec);
	for (const [key, value] of Object.entries(properties)) {
		if (state.properties[key] !== value) return false;
	}
	return true;
}

// ---- Pos / GridPos 的语义换算（capabilities §2.2，能力层从这里再导出） ----

export interface PointTargetValue {
	position: Vec3;
	dimension: string;
}

type RawPos = { x: number; y: number; z: number } | { position: Vec3; dimension: string } | { rel: Vec3 };

function isRel(raw: RawPos): raw is { rel: Vec3 } {
	return "rel" in raw;
}

/** 连续坐标：rel 相对当前站位，{position,dimension} 保留显式维度。 */
export function resolvePoint(raw: unknown, self: { place: { position: Vec3; dimension: string } }): PointTargetValue {
	const value = raw as RawPos;
	if (isRel(value)) {
		return {
			dimension: self.place.dimension,
			position: {
				x: self.place.position.x + value.rel.x,
				y: self.place.position.y + value.rel.y,
				z: self.place.position.z + value.rel.z,
			},
		};
	}
	if ("position" in value) return { position: value.position, dimension: value.dimension };
	return { position: { x: value.x, y: value.y, z: value.z }, dimension: self.place.dimension };
}

/** 整数格：rel 相对脚下格（当前位置向下取整），结果保证整数。 */
export function resolveGrid(raw: unknown, self: { place: { position: Vec3; dimension: string } }): Vec3 {
	const value = raw as RawPos;
	if (isRel(value)) {
		return {
			x: Math.floor(self.place.position.x) + value.rel.x,
			y: Math.floor(self.place.position.y) + value.rel.y,
			z: Math.floor(self.place.position.z) + value.rel.z,
		};
	}
	const point = resolvePoint(raw, self);
	return {
		x: Math.round(point.position.x),
		y: Math.round(point.position.y),
		z: Math.round(point.position.z),
	};
}
