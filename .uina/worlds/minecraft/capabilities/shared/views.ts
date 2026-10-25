/**
 * 能力侧读取的形状：动作从 ctx.world 读到的查询值在这里收敛成稳定局部类型。
 *
 * 这些形状对应 capabilities §3 各查询的 value；不复制权威 schema，
 * 只给 TypeScript 一个窄面（字段缺失时按可选处理，不编默认值）。
 */

import type { ItemValue } from "../../contracts/body.js";
import type { Observation } from "../../contracts/values.js";
import type { WorldReadPort } from "../../contracts/world.js";
import type { Vec3 } from "../../contracts/values.js";

export interface SlotView extends Partial<ItemValue> {
	slot: number;
	name: string;
	count: number;
}

export interface InventorySnapshot {
	slots: SlotView[];
	counts: Record<string, number>;
	held?: { name: string; count: number } & Partial<ItemValue>;
	armor?: Record<string, { name: string; count: number } & Partial<ItemValue>>;
	usedSlots?: number;
	freeSlots?: number;
	selectedSlot?: number | null;
}

export interface BlockSnapshot {
	name: string;
	position: Vec3;
	properties: Record<string, string>;
	sign: unknown;
	harvest?: { ok: boolean; requiredTools?: string[] };
}

export interface BlockReadValue {
	block: BlockSnapshot | null;
}

export interface WorldSnapshot {
	dimension: string;
	timeOfDay: string | null;
	ticks: number | null;
	dayCount: number | null;
	weather: string | null;
	biome: string | null;
	difficulty: string | null;
	gameMode: string | null;
	spawn: unknown;
}

export interface EntityEntryView {
	ref: { networkId: number; connection: string; incarnation: string; appearance: string };
	name: string;
	kind: "hostile" | "passive" | "player" | "other";
	position: Vec3;
	distance: number;
	item: { name: string; count: number } | null;
}

/** 读查询值；null value 原样返回（调用方决定 NOT_FOUND/WRONG_STATE）。 */
export async function readObservation<T>(
	world: WorldReadPort,
	ref: import("../../contracts/values.js").ExactRef,
	input: import("../../contracts/values.js").JsonValue,
): Promise<Observation<T>> {
	return (await world.read<T>({ ref, input })) as Observation<T>;
}

export async function readInventory(world: WorldReadPort): Promise<InventorySnapshot> {
	const observation = await readObservation<InventorySnapshot>(world, "inventory@1", {});
	if (observation.value == null) {
		throw new QueryValueMissing("inventory", observation.unknown);
	}
	return observation.value;
}

export async function readBlockAt(world: WorldReadPort, position: Vec3): Promise<BlockSnapshot | null> {
	// at 用纯值：Vec3 没有索引签名，不能直接当 JsonValue。
	const at = { x: position.x, y: position.y, z: position.z };
	const observation = await readObservation<BlockReadValue>(world, "block@1", { at });
	return observation.value?.block ?? null;
}

export class QueryValueMissing extends Error {
	constructor(
		readonly what: string,
		readonly unknown: string[],
	) {
		super(`${what} is not available: ${unknown.join("; ") || "unknown"}`);
		this.name = "QueryValueMissing";
	}
}

export function itemCountOf(inventory: InventorySnapshot, name: string): number {
	return inventory.counts[name] ?? 0;
}

export function slotsOf(inventory: InventorySnapshot, name: string): SlotView[] {
	return inventory.slots.filter((slot) => slot.name === name);
}

/** 主背包+快捷栏的槽位域；与 mineflayer 的 inventoryStart..inventoryEnd 一致。 */
export const PLAYER_SLOTS = { start: 9, end: 44 } as const;

/** 落在这个槽域内的物品堆（护甲/副手/合成格不参与搬运与丢弃）。 */
export function carrySlotsOf(inventory: InventorySnapshot): SlotView[] {
	return inventory.slots.filter((slot) => slot.slot >= PLAYER_SLOTS.start && slot.slot <= PLAYER_SLOTS.end);
}

/** 主背包+快捷栏内某物品的总数：drop 的可丢量与 toss 的可丢域必须一致。 */
export function carryCountOf(inventory: InventorySnapshot, name: string): number {
	return carrySlotsOf(inventory)
		.filter((slot) => slot.name === name)
		.reduce((total, slot) => total + slot.count, 0);
}

/** 只报正增量：采集/拾取只关心"这次多了什么"，减少的部分不是这批动作的产物。 */
export function positiveDelta(before: InventorySnapshot, after: InventorySnapshot): Record<string, number> {
	const delta: Record<string, number> = {};
	for (const [name, count] of Object.entries(after.counts)) {
		const gained = count - (before.counts[name] ?? 0);
		if (gained > 0) delta[name] = gained;
	}
	return delta;
}

/**
 * 主背包+快捷栏还能不能再装 need 个 name。
 * stackSize 未知时返回 null（判不了就不拦，别拿缺失知识当"背包满"）。
 */
export function canAccept(
	inventory: InventorySnapshot,
	name: string,
	stackSize: number | null,
	need = 1,
): boolean | null {
	if (stackSize == null) return null;
	const carry = carrySlotsOf(inventory);
	let room = carry
		.filter((slot) => slot.name === name)
		.reduce((total, slot) => total + Math.max(0, stackSize - slot.count), 0);
	const occupied = new Set(carry.map((slot) => slot.slot));
	room += (PLAYER_SLOTS.end - PLAYER_SLOTS.start + 1 - occupied.size) * stackSize;
	return room >= need;
}
