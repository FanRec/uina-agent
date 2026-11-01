/**
 * 施工计划：把规范化目标与现场读数求差异，算材料缺口、冲突、支撑缺口与粗估工期。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 build.plan、§4「共用目标与差异处理」。
 * `build.plan` 只做这一步（读现场、求差异、报缺口），`build` 做全部（再排操作、挖或放、核验剩余）。
 * 两者**共用同一份目标与差异实现**：这里算出来的 `targets` 就是 build 执行的那一份，
 * 不存在第二套"计划说的"和"执行做的"。
 *
 * 几个口径必须说清楚，否则字段会被误读：
 * - `targets` 是全量规范化目标（含已匹配格与 preserve/unknown），不是"待办清单"；
 * - `need` 只统计**现场尚未匹配**的 set 格（已匹配的格不需要材料）；
 * - `missing` 只减背包里**直接可用**的同名方块，不把"有原木"当"有木板"（合成缺口归 recipe@1）；
 * - `blocked` 是现场被别的实心方块占着、且本次不允许替换的 set 格；
 * - `unreachable` 是**结构上**没有支撑面的 set 格（六邻居既非现场实心、也不在同一计划的 set 目标里），
 *   不是寻路判决——真正的走不过去由 build 的 remaining.reason 如实上报；
 * - `estTicks` 是排期用的粗估（常量见下），不是执行承诺。
 */

import type { BlockSpec, BlockStateValue } from "../contracts/body.js";
import type { Vec3 } from "../contracts/values.js";
import type { BuildPlanBlocked, BuildPlanValue } from "../contracts/world.js";
import { ConstructionError, isReplaceableName, matchesDeclared, orderTargets, specBlockName } from "./target.js";
import type { TargetCell } from "./target.js";

/** 计划返回的 targets 上限（合同值，见 capabilities.md §2.4 与 §4 的体积口径）。 */
export const MAX_PLAN_TARGETS = 2048;

/**
 * 粗估常量（ticks）：一次短途走位、挖一格、放一格。
 * 与 route.plan 的 estTimeSec 同性质——给排期一个量级，不作为执行期限。
 */
const TRAVEL_TICKS = 40;
const DIG_TICKS = 15;
const PLACE_TICKS = 8;
/** 一次走位大约能覆盖几个待处理格（相邻格连续处理，实测再调）。 */
const CELLS_PER_LEG = 8;

/** 现场读数：未加载/越界一律 null（未知不等于空气）。 */
export interface FieldView {
	blockAt(at: Vec3): BlockStateValue | null;
}

export interface PlanRequest {
	cells: TargetCell[];
	replace: boolean;
	blueprint?: { ref: string; digest: string };
}

/** 计划结果的形状由 contracts/world.ts 唯一给出（public-api §5），这里只做别名。 */
export type PlanBlocked = BuildPlanBlocked;
export type PlanValue = BuildPlanValue;

const OFFSETS: Vec3[] = [
	{ x: 1, y: 0, z: 0 },
	{ x: -1, y: 0, z: 0 },
	{ x: 0, y: 1, z: 0 },
	{ x: 0, y: -1, z: 0 },
	{ x: 0, y: 0, z: 1 },
	{ x: 0, y: 0, z: -1 },
];

function cellKey(at: Vec3): string {
	return `${at.x},${at.y},${at.z}`;
}

function shifted(at: Vec3, offset: Vec3): Vec3 {
	return { x: at.x + offset.x, y: at.y + offset.y, z: at.z + offset.z };
}

export function planConstruction(
	request: PlanRequest,
	field: FieldView,
	inventoryCounts: Record<string, number>,
): PlanValue {
	if (request.cells.length === 0) throw new ConstructionError("INVALID_INPUT", "build target has no cells");
	if (request.cells.length > MAX_PLAN_TARGETS) {
		throw new ConstructionError(
			"INVALID_INPUT",
			`design has ${request.cells.length} target cells, over the ${MAX_PLAN_TARGETS} limit`,
			"split the design into smaller blueprints (the limit bounds one plan/build call)",
		);
	}
	const targets = orderTargets(request.cells);

	/**
	 * 同一计划里的 set 格可以充当支撑面，但**只有同层或更低**的格：
	 * 施工自下而上，还没放上去的格不可能给下面的格当点击面。
	 */
	const plannedSet = new Map<string, number>();
	for (const cell of targets) if (cell.kind === "set") plannedSet.set(cellKey(cell.at), cell.at.y);

	const need = new Map<string, number>();
	const blocked: PlanBlocked[] = [];
	const unreachable: { at: Vec3 }[] = [];
	let clearCount = 0;
	let placeCount = 0;

	for (const cell of targets) {
		if (cell.kind === "preserve" || cell.kind === "unknown") continue;
		const current = field.blockAt(cell.at);

		if (cell.kind === "clear") {
			// 未加载的格既不能算已清空，也不能当空气：留给 build 的 remaining 如实报。
			if (current == null) continue;
			if (current.name !== "air") clearCount += 1;
			continue;
		}

		const spec = cell.block as BlockSpec;
		if (matchesDeclared(spec, current)) continue;
		const name = specBlockName(spec);
		placeCount += 1;

		if (current != null && !isReplaceableName(current.name)) {
			if (request.replace) {
				clearCount += 1;
			} else {
				blocked.push({ at: cell.at, by: current.name.replace(/^minecraft:/, "") });
				continue;
			}
		}
		need.set(name, (need.get(name) ?? 0) + 1);

		if (current == null) {
			// 未加载：既不算缺支撑，也不承诺能放——build 会按实际现场重判。
			continue;
		}
		const supported = OFFSETS.some((offset) => {
			const neighbourAt = shifted(cell.at, offset);
			const planned = plannedSet.get(cellKey(neighbourAt));
			if (planned !== undefined && planned <= cell.at.y) return true;
			const neighbour = field.blockAt(neighbourAt);
			return neighbour != null && !isReplaceableName(neighbour.name);
		});
		if (!supported) unreachable.push({ at: cell.at });
	}

	const missing: Record<string, number> = {};
	const needRecord: Record<string, number> = {};
	for (const [name, count] of [...need.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		needRecord[name] = count;
		const available = inventoryCounts[name] ?? 0;
		if (available < count) missing[name] = count - available;
	}

	const legs = Math.ceil((placeCount + clearCount) / CELLS_PER_LEG);
	return {
		...(request.blueprint != null ? { blueprint: request.blueprint } : {}),
		targets,
		need: needRecord,
		missing,
		blocked,
		unreachable,
		estTicks: legs * TRAVEL_TICKS + clearCount * DIG_TICKS + placeCount * PLACE_TICKS,
	};
}
