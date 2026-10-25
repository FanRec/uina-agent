/**
 * 交互射程：一个口径，供所有动作在派发前判定"够不够得着"。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 可达性归调用方。
 * 服务端按"自眼位起算"判定方块交互（生存 4.5 格）；实体交互范围更小（约 3 格，另加目标碰撞箱）。
 * 这里只做算术，不做寻路：够不着就 UNREACHABLE，站位由调用方用 goto@1 安排。
 */

import type { SelfState } from "../../contracts/body.js";
import type { Vec3 } from "../../contracts/values.js";

/** 玩家眼高（feet 之上的偏移）；所有距离都从眼位量。 */
export const EYE_HEIGHT = 1.62;
/** 方块破坏/放置/右键的服务端上限（生存 4.5，创造 5）；取保守值，超了必被拒。 */
export const BLOCK_REACH = 4.5;
/** 实体交互/攻击的近似上限：3 格基础范围 + 目标碰撞箱，留一点余量免得误判够不着。 */
export const ENTITY_REACH = 4;

export function eyeOf(self: SelfState): Vec3 {
	return { x: self.place.position.x, y: self.place.position.y + EYE_HEIGHT, z: self.place.position.z };
}

/** 眼位到某格方块中心的距离（方块中心 = 整数坐标 + 0.5）。 */
export function blockReach(self: SelfState, block: Vec3): number {
	const eye = eyeOf(self);
	return Math.hypot(block.x + 0.5 - eye.x, block.y + 0.5 - eye.y, block.z + 0.5 - eye.z);
}

/** 供错误信息用：保留两位小数的距离。 */
export function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
