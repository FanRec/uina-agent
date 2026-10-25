/**
 * 能力层的输入范式化：Pos/GridPos/BlockSpec/ItemSelector → 可直接比较的纯值。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §2.2。
 * 校验已由 Runtime（动作）或查询读取器（查询）按 schema 做过一次；这里不重复校验形状，
 * 只做"相对坐标 → 绝对坐标""声明 → 匹配函数"这类语义换算，不存在第二套校验。
 */

import type { BlockSpec, BlockStateValue, ItemSelector, SelfState } from "../../contracts/body.js";
import { callFailure } from "../../contracts/values.js";
import type { Vec3 } from "../../contracts/values.js";

export interface FailureOptions {
	hint?: string;
	dispatch?: "not_sent" | "sent" | "unknown";
	progress?: Record<string, unknown>;
	effects?: string[];
	recoverable?: boolean;
}

/** 能力层失败：source=capability，dispatch 默认 not_sent（未派发就不该说 sent）。 */
export function fail(code: string, message: string, options: FailureOptions = {}): never {
	throw callFailure({
		code,
		source: "capability",
		message,
		hint: options.hint,
		dispatch: options.dispatch ?? "not_sent",
		progress: options.progress as never,
		effects: options.effects ?? [],
		recoverable: options.recoverable ?? true,
	});
}

export function stripNamespace(name: string): string {
	return name.replace(/^minecraft:/, "");
}

export interface PointTargetValue {
	position: Vec3;
	dimension: string;
}

type RawPos = { x: number; y: number; z: number } | { position: Vec3; dimension: string } | { rel: Vec3 };

function isRel(raw: RawPos): raw is { rel: Vec3 } {
	return "rel" in raw;
}

/** 连续坐标：rel 相对当前站位，{position,dimension} 保留显式维度。 */
export function resolvePoint(raw: unknown, self: SelfState): PointTargetValue {
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
export function resolveGrid(raw: unknown, self: SelfState): Vec3 {
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

/** 显式维度与当前维度不一致：K1 不做跨维度动作。 */
export function assertSameDimension(target: PointTargetValue, self: SelfState, what: string): void {
	if (target.dimension !== self.place.dimension) {
		fail("WRONG_STATE", `${what} is in dimension ${target.dimension}, current dimension is ${self.place.dimension}`, {
			hint: "K1 actions stay inside the current dimension; travel arrives with transit@1",
			recoverable: true,
		});
	}
}

export function specName(spec: BlockSpec): string {
	return stripNamespace(typeof spec === "string" ? spec : spec.name);
}

/** 声明 → 匹配：只比较显式声明的属性，未声明的状态不纳入目标（§4 place）。 */
export function matchBlockSpec(spec: BlockSpec, state: BlockStateValue | null): boolean {
	if (state == null) return false;
	if (stripNamespace(state.name) !== specName(spec)) return false;
	if (typeof spec === "string" || spec.properties == null) return true;
	for (const [key, value] of Object.entries(spec.properties)) {
		if (state.properties[key] !== value) return false;
	}
	return true;
}

export interface ItemLike {
	name: string;
	count: number;
	durability?: { used: number; max: number } | null;
}

export function selectorNames(selector: string | ItemSelector): string[] {
	if (typeof selector === "string") return [stripNamespace(selector)];
	return [stripNamespace(selector.name), ...(selector.substitutions ?? []).map(stripNamespace)];
}

/** 物品选择：名字（含 substitutions）+ 最小剩余耐久；components 匹配未实现时由 Driver 拒绝。 */
export function matchesItem(selector: string | ItemSelector, item: ItemLike): boolean {
	if (!selectorNames(selector).includes(stripNamespace(item.name))) return false;
	if (typeof selector === "string") return true;
	if (selector.minDurability != null) {
		if (item.durability == null) return false;
		if (item.durability.max - item.durability.used < selector.minDurability) return false;
	}
	return true;
}

/** 面名 → 单位法向。 */
export function faceVector(face: "up" | "down" | "north" | "south" | "east" | "west"): Vec3 {
	switch (face) {
		case "up":
			return { x: 0, y: 1, z: 0 };
		case "down":
			return { x: 0, y: -1, z: 0 };
		case "north":
			return { x: 0, y: 0, z: -1 };
		case "south":
			return { x: 0, y: 0, z: 1 };
		case "east":
			return { x: 1, y: 0, z: 0 };
		case "west":
			return { x: -1, y: 0, z: 0 };
	}
}

export function distance(a: Vec3, b: Vec3): number {
	return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function addVec(a: Vec3, b: Vec3): Vec3 {
	return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sameVec(a: Vec3, b: Vec3): boolean {
	return a.x === b.x && a.y === b.y && a.z === b.z;
}

/**
 * 六邻居：目标格四周的可点击支撑面。
 * face 是**支撑方块被点击的那一面**（法向指向目标格），不是支撑相对目标的方向：
 * 支撑在下方 → 点它的上面（up）；支撑在西方 → 点它的东面（east）。
 */
export const NEIGHBORS: { face: "up" | "down" | "north" | "south" | "east" | "west"; offset: Vec3 }[] = [
	{ face: "up", offset: { x: 0, y: -1, z: 0 } },
	{ face: "down", offset: { x: 0, y: 1, z: 0 } },
	{ face: "south", offset: { x: 0, y: 0, z: -1 } },
	{ face: "north", offset: { x: 0, y: 0, z: 1 } },
	{ face: "east", offset: { x: -1, y: 0, z: 0 } },
	{ face: "west", offset: { x: 1, y: 0, z: 0 } },
];
