/**
 * 单格放置原语：place@1 与 build@1 共用的"先判后放"序列。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 place 与 §4「共用目标与差异处理」。
 *
 * 分成两段是刻意的，不是拆得过细：
 * - `inspectPlacement` 在**取身体之前**做完目标/冲突/材料/支撑面/射程判断——一次注定失败的
 *   调用不该占住单槽身体队列（经验 13）；
 * - `commitPlacement` 在 `withBody` 内只做装备 + 交互 + 等世界读回，完成判据是目标格的实际
 *   状态匹配声明，不按派发成功算。
 *
 * 支撑面的选法是"六邻居里第一个可点击的实心方块"（下→上→北→南→西→东），射程按**支撑面**
 * 量而不是目标格量：真正被点的是支撑面。`face` 是交互约束，不是最终朝向。
 */

import { isReplaceableName, matchesDeclared, specBlockName } from "../../construction/target.js";
import type { BlockSpec, BlockStateValue, SelfState } from "../../contracts/body.js";
import type { BodyCallScope, CallContext } from "../../contracts/capabilities.js";
import type { Vec3 } from "../../contracts/values.js";
import type { WorldReadPort } from "../../contracts/world.js";
import { pollUntil } from "../shared/observe.js";
import { BLOCK_REACH, blockReach } from "../shared/reach.js";
import { faceVector, NEIGHBORS, stripNamespace } from "../shared/targets.js";
import { itemCountOf, readBlockAt, readInventory } from "../shared/views.js";

const BLOCK_CHECK_TIMEOUT_MS = 1500;
const BLOCK_CHECK_INTERVAL_MS = 150;

/** 可点击的支撑面：目标格与"被点的那一面"。 */
export interface AimHit {
	target: Vec3;
	support: Vec3;
	face: "up" | "down" | "north" | "south" | "east" | "west";
}

/**
 * 取身体之前能得出的全部结论。
 *
 * `no-support` 与 `out-of-reach` 必须分开：前者是"这一格现在还没有可点的面"
 * （自下而上施工时上层外侧常如此，等邻居放好就有了），后者才是"有面但站得太远"。
 * 施工要按前者延后重试、按后者走近；合成一个码就只能盲目走位或盲目放弃。
 */
export type PlacementPrecheck =
	| { kind: "already"; block: BlockStateValue; target: Vec3 }
	| { kind: "conflict"; by: string }
	| { kind: "missing"; name: string; held: string[] }
	| { kind: "no-support"; target: Vec3 | null }
	| { kind: "out-of-reach"; detail: string; distance: number }
	| { kind: "ready"; aims: AimHit[]; heldName: string | null };

/** 派发之后的实际结局。 */
export type PlacementOutcome =
	| { kind: "placed"; block: BlockStateValue }
	| { kind: "not_met"; actual: string | null; target: Vec3; expected: string };

/** 视角短射线：返回"眼前要放的那一格"与可点击的支撑面。 */
export async function aimedCell(world: WorldReadPort, self: SelfState): Promise<AimHit | null> {
	const look = self.look;
	if (look == null) return null;
	const yaw = look.yaw;
	const pitch = look.pitch;
	const dir = {
		x: -Math.sin(yaw) * Math.cos(pitch),
		y: -Math.sin(pitch),
		z: Math.cos(yaw) * Math.cos(pitch),
	};
	const eye = { x: self.place.position.x, y: self.place.position.y + 1.62, z: self.place.position.z };
	let previous = { x: Math.floor(eye.x), y: Math.floor(eye.y), z: Math.floor(eye.z) };
	for (let step = 1; step <= 22; step++) {
		const point = { x: eye.x + dir.x * step * 0.2, y: eye.y + dir.y * step * 0.2, z: eye.z + dir.z * step * 0.2 };
		const cell = { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) };
		if (cell.x === previous.x && cell.y === previous.y && cell.z === previous.z) continue;
		const block = await readBlockAt(world, cell);
		if (block != null && !isReplaceableName(block.name)) {
			const dx = previous.x - cell.x;
			const dy = previous.y - cell.y;
			const dz = previous.z - cell.z;
			const face =
				Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= Math.abs(dz)
					? dx > 0
						? "east"
						: "west"
					: Math.abs(dy) >= Math.abs(dz)
						? dy > 0
							? "up"
							: "down"
						: dz > 0
							? "south"
							: "north";
			return { target: previous, support: cell, face };
		}
		previous = cell;
	}
	return null;
}

/**
 * 显式 at：列出所有可点击的支撑面（下→上→北→南→西→东）。
 *
 * 返回**全部**候选而不是第一个：服务端会拒绝某些面（真服实测：门顶放不上，
 * 因为门不是完整方块），只认第一个面会让"有支撑但被拒"变成假失败。
 */
export async function supportsFor(world: WorldReadPort, target: Vec3): Promise<AimHit[]> {
	const hits: AimHit[] = [];
	for (const neighbor of NEIGHBORS) {
		const support = {
			x: target.x + neighbor.offset.x,
			y: target.y + neighbor.offset.y,
			z: target.z + neighbor.offset.z,
		};
		const block = await readBlockAt(world, support);
		if (block == null || isReplaceableName(block.name)) continue;
		hits.push({ target, support, face: neighbor.face });
	}
	return hits;
}

/**
 * 取身体之前的全部判断。`target` 为 null 表示按视角短射线取眼前那格（place@1 的老行为）。
 * 这里已经读过的库存会带回 `heldName`，commitPlacement 不再重复读一次。
 */
export async function inspectPlacement(
	world: WorldReadPort,
	self: SelfState,
	target: Vec3 | null,
	spec: BlockSpec,
	options: { replace: boolean },
): Promise<PlacementPrecheck> {
	const name = specBlockName(spec);
	const existing = target == null ? null : await readBlockAt(world, target);
	if (target != null && existing != null && matchesDeclared(spec, existing)) {
		return { kind: "already", block: { name: existing.name, properties: existing.properties }, target };
	}
	if (target != null && existing != null && !isReplaceableName(existing.name) && !options.replace) {
		return { kind: "conflict", by: stripNamespace(existing.name) };
	}
	const inventory = await readInventory(world);
	if (itemCountOf(inventory, name) <= 0) {
		return {
			kind: "missing",
			name,
			held: inventory.slots.map((slot) => slot.name),
		};
	}
	const aims =
		target != null
			? (await supportsFor(world, target)).filter((hit) => blockReach(self, hit.support) <= BLOCK_REACH)
			: [await aimedCell(world, self)].filter(
					(hit): hit is AimHit => hit != null && blockReach(self, hit.support) <= BLOCK_REACH,
				);
	if (aims.length === 0) {
		const any = target != null ? await supportsFor(world, target) : [];
		if (any.length === 0) return { kind: "no-support", target };
		const nearest = any
			.map((hit) => ({ hit, reach: blockReach(self, hit.support) }))
			.sort((a, b) => a.reach - b.reach)[0]!;
		return {
			kind: "out-of-reach",
			distance: nearest.reach,
			detail: `support ${nearest.hit.support.x},${nearest.hit.support.y},${nearest.hit.support.z} is out of reach (${nearest.reach.toFixed(2)} > ${BLOCK_REACH})`,
		};
	}
	return { kind: "ready", aims, heldName: inventory.held?.name ?? null };
}

/**
 * 在 withBody 内装备并交互，完成判据是目标格的实际状态匹配声明。
 *
 * 支撑面按候选顺序试：服务端拒绝某个面时换下一个，而不是把整格判成失败
 * （门顶放不上、告示牌顶面放不上都属于这一类）。每个面给一次确认窗。
 */
export async function commitPlacement(
	ctx: CallContext,
	scope: BodyCallScope,
	self: SelfState,
	spec: BlockSpec,
	aims: AimHit[],
	heldName: string | null,
	options: { face?: "auto" | "up" | "down" | "north" | "south" | "east" | "west" } = {},
): Promise<PlacementOutcome> {
	const name = specBlockName(spec);
	if (heldName !== name) {
		await scope.player.equip({ name }, "hand");
	}
	let last: BlockStateValue | null = null;
	for (const aim of aims) {
		await scope.player.interact({
			target: { place: placeOf(self, aim.support), block: aim.support },
			hand: "main",
			face: faceVector(options.face != null && options.face !== "auto" ? options.face : aim.face),
		});
		const settled = await pollUntil(
			async () => await readBlockAt(scope.world, aim.target),
			(block) => matchesDeclared(spec, block as BlockStateValue | null),
			{ timeoutMs: BLOCK_CHECK_TIMEOUT_MS, intervalMs: BLOCK_CHECK_INTERVAL_MS, signal: ctx.signal },
		);
		last = settled.last as BlockStateValue | null;
		if (settled.ok) {
			const placed = settled.last as BlockStateValue;
			return { kind: "placed", block: { name: stripNamespace(placed.name), properties: placed.properties ?? {} } };
		}
	}
	return { kind: "not_met", actual: last?.name ?? null, target: aims[0]!.target, expected: name };
}

export function placeOf(self: SelfState, position: Vec3) {
	return {
		world: self.place.world,
		worldRevision: self.place.worldRevision,
		dimension: self.place.dimension,
		position,
	};
}
