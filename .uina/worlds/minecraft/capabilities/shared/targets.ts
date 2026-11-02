/**
 * 能力层的输入范式化：Pos/GridPos/BlockSpec/ItemSelector → 可直接比较的纯值。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §2.2。
 * 校验已由 Runtime（动作）或查询读取器（查询）按 schema 做过一次；这里不重复校验形状，
 * 只做"相对坐标 → 绝对坐标""声明 → 匹配函数"这类语义换算，不存在第二套校验。
 */

import {
	matchesDeclared,
	type PointTargetValue,
	resolveGrid,
	resolvePoint,
	specBlockName,
	stripNamespace,
} from "../../construction/target.js";
import type { BlockSpec, BlockStateValue, ItemSelector, SelfState } from "../../contracts/body.js";
import type { Vec3 } from "../../contracts/values.js";
import { callFailure } from "../../contracts/values.js";

export type { PointTargetValue };
/**
 * 坐标/名字/声明匹配的唯一定义在 `construction/target.ts`（施工与查询共用同一份判定）；
 * 能力层只按历史名字再导出，不复制实现。
 */
export { resolveGrid, resolvePoint, stripNamespace };

export function specName(spec: BlockSpec): string {
	return specBlockName(spec);
}

/** 声明 → 匹配：只比较显式声明的属性，未声明的状态不纳入目标（§4 place）。 */
export function matchBlockSpec(spec: BlockSpec, state: BlockStateValue | null): boolean {
	return matchesDeclared(spec, state);
}

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

/** 显式维度与当前维度不一致：K1 不做跨维度动作。 */
export function assertSameDimension(target: PointTargetValue, self: SelfState, what: string): void {
	if (target.dimension !== self.place.dimension) {
		fail("WRONG_STATE", `${what} is in dimension ${target.dimension}, current dimension is ${self.place.dimension}`, {
			hint: "K1 actions stay inside the current dimension; travel arrives with transit@1",
			recoverable: true,
		});
	}
}

export function selectorNames(selector: string | ItemSelector): string[] {
	if (typeof selector === "string") return [stripNamespace(selector)];
	return [stripNamespace(selector.name), ...(selector.substitutions ?? []).map(stripNamespace)];
}

export { matchesItem } from "../../contracts/items.js";

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
