/** 槽位搬移：两个方向共用一个固定清单与 mode-0 点击算法。 */
import { matchesItem, sameItem } from "../../contracts/items.js";
import type { ItemSelector, StackExpectation, ItemValue, WindowSession, WindowSnapshot } from "../../contracts/body.js";
import type { CallFailure, JsonValue } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import { fail } from "./targets.js";

export interface TransferSelection {
	direction: "from" | "to";
	item?: string | ItemSelector;
	count?: number;
	all?: true;
}

/** 方块一侧与玩家一侧的区域名。普通容器用 container；熔炉取产物用 result。 */
export interface TransferRegions {
	block: string;
	player: string;
}

const DEFAULT_REGIONS: TransferRegions = { block: "container", player: "player" };

export interface TransferAmounts {
	moved: Record<string, number>;
	remaining: Record<string, number>;
}

export function windowItem(value: JsonValue | null): ItemValue | null {
	return value as unknown as ItemValue | null;
}

export function windowRegion(snapshot: WindowSnapshot, name: string): number[] {
	const region = snapshot.layout.regions.find((entry) => entry.name === name);
	if (region == null) fail("WRONG_STATE", `window ${snapshot.type} has no ${name} slot region`);
	return region.slots;
}

export function windowSlot(snapshot: WindowSnapshot, slot: number): ItemValue | null {
	const entry = snapshot.slots.find((candidate) => candidate.slot === slot);
	if (entry == null) fail("WRONG_STATE", `window slot ${slot} is unknown`);
	return windowItem(entry.item);
}

export function expectation(item: ItemValue | null): StackExpectation {
	if (item == null) return { item: null, count: 0 };
	return {
		item: {
			name: item.name,
			...(item.components != null ? { components: item.components } : {}),
			...(item.durability != null ? { minDurability: item.durability } : {}),
		},
		count: item.count,
	};
}

/**
 * 一次 mode-0 点击的全部纪律都收在这里：必须拿到服务端确认的 met，绝不重放，
 * 成功后换成服务端新快照。摆格、装料、取产物都走它，避免第二份确认逻辑。
 */
export interface WindowMoveState {
	snapshot: WindowSnapshot;
	/** 是否已经派发过任何点击；失败结算靠它把 not_sent 升级成 sent。 */
	dispatched: boolean;
}

export function moveState(snapshot: WindowSnapshot): WindowMoveState {
	return { snapshot, dispatched: false };
}

export async function windowClick(
	window: WindowSession,
	state: WindowMoveState,
	slot: number,
	button: 0 | 1 = 0,
): Promise<void> {
	const receipt = await window.click({
		slot,
		button,
		mode: 0,
		expectedRevision: state.snapshot.revision,
		expectedSlots: [{ slot, stack: expectation(windowSlot(state.snapshot, slot)) }],
		expectedCursor: expectation(windowItem(state.snapshot.cursor)),
	});
	if (receipt.dispatch !== "not_sent") state.dispatched = true;
	if (receipt.completion !== "met" || receipt.needsSnapshot || receipt.confirmed == null) {
		fail("TARGET_NOT_MET", "window click has no confirmed server result; it will not be repeated", {
			dispatch: receipt.completion === "not_met" ? "sent" : "unknown",
			effects: [receipt.effect],
		});
	}
	const next = receipt.confirmed;
	if (next.window !== state.snapshot.window)
		fail("REFERENCE_STALE", "window changed during the operation", { dispatch: "sent" });
	state.snapshot = next;
}

function destinationSlot(snapshot: WindowSnapshot, slots: number[], held: ItemValue): number | undefined {
	return (
		slots.find((slot) => {
			const item = windowSlot(snapshot, slot);
			return item != null && sameItem(item, held) && item.stackSize != null && item.count < item.stackSize;
		}) ?? slots.find((slot) => windowSlot(snapshot, slot) == null)
	);
}

/** Place a bounded cursor quantity, recording each confirmed destination change before any later wait. */
export async function placeCursor(
	window: WindowSession,
	state: WindowMoveState,
	destination: number[],
	count: number,
	onPlaced: (item: ItemValue, count: number) => void | Promise<void>,
): Promise<void> {
	let remaining = count;
	while (remaining > 0) {
		const held = windowItem(state.snapshot.cursor);
		if (held == null) fail("CONFLICT", "cursor emptied before the selected quantity was placed", { dispatch: "sent" });
		const slot = destinationSlot(state.snapshot, destination, held);
		if (slot == null) fail("INVENTORY_FULL", `destination has no room for ${held.name}`, { dispatch: "sent" });
		const target = windowSlot(state.snapshot, slot);
		const room = target == null ? held.count : (target.stackSize as number) - target.count;
		const quantity = Math.min(remaining, held.count, room);
		const place = async (button: 0 | 1, expected: number): Promise<void> => {
			const before = windowSlot(state.snapshot, slot)?.count ?? 0;
			await windowClick(window, state, slot, button);
			const after = windowSlot(state.snapshot, slot);
			const delta = after != null && sameItem(after, held) ? after.count - before : 0;
			if (delta !== expected)
				fail("TARGET_NOT_MET", `expected ${expected} ${held.name} at destination, observed ${delta}`, {
					dispatch: "sent",
				});
			remaining -= delta;
			await onPlaced(held, delta);
		};
		if (quantity === held.count || quantity === room) await place(0, quantity);
		else for (let i = 0; i < quantity; i++) await place(1, 1);
	}
}

interface WorkItem {
	item: ItemValue;
	remaining: number;
}

/** 只从本次首个可核验源快照建立清单；途中新增的物品不会扩张本次任务。 */
function manifest(snapshot: WindowSnapshot, input: TransferSelection, regions: TransferRegions): WorkItem[] {
	const source = windowRegion(snapshot, input.direction === "from" ? regions.block : regions.player);
	const items = source
		.map((slot) => windowSlot(snapshot, slot))
		.filter(
			(item): item is ItemValue =>
				item != null && (input.all === true || (input.item != null && matchesItem(input.item, item))),
		);
	if (items.length === 0) fail("NOT_FOUND", "the selected source has no matching item");
	let left = input.count ?? items.reduce((total, item) => total + item.count, 0);
	const result: WorkItem[] = [];
	for (const item of items) {
		const quantity = Math.min(left, item.count);
		if (quantity > 0) result.push({ item, remaining: quantity });
		left -= quantity;
		if (left === 0) break;
	}
	// 显式数量超过源总量时，保留请求差额；可用部分仍可完成且不回滚。
	if (left > 0) (result[result.length - 1] as WorkItem).remaining += left;
	return result;
}

export function transferRoom(
	snapshot: WindowSnapshot,
	input: TransferSelection,
	regions: TransferRegions = DEFAULT_REGIONS,
): { matches: boolean; same: boolean; room: boolean } {
	const source = windowRegion(snapshot, input.direction === "from" ? regions.block : regions.player);
	const destination = windowRegion(snapshot, input.direction === "from" ? regions.player : regions.block);
	const items = source
		.map((slot) => windowSlot(snapshot, slot))
		.filter(
			(item): item is ItemValue =>
				item != null && (input.all === true || (input.item != null && matchesItem(input.item, item))),
		);
	const same = items.some((item) =>
		destination.some((slot) => {
			const existing = windowSlot(snapshot, slot);
			return (
				existing != null &&
				sameItem(item, existing) &&
				existing.stackSize != null &&
				existing.count < existing.stackSize
			);
		}),
	);
	return {
		matches: items.length > 0,
		same,
		room: same || destination.some((slot) => windowSlot(snapshot, slot) == null),
	};
}

export async function transferWindow(
	window: WindowSession,
	input: TransferSelection,
	options: { onProgress?: (amounts: TransferAmounts) => Promise<void>; regions?: TransferRegions } = {},
): Promise<TransferAmounts> {
	const regions = options.regions ?? DEFAULT_REGIONS;
	const state = moveState((await window.snapshot()).value);
	if (state.snapshot.cursor != null) fail("WRONG_STATE", "window cursor is occupied before transfer");
	const source = windowRegion(state.snapshot, input.direction === "from" ? regions.block : regions.player);
	const destination = windowRegion(state.snapshot, input.direction === "from" ? regions.player : regions.block);
	const work = manifest(state.snapshot, input, regions);
	const moved: Record<string, number> = {};
	const amounts = (): TransferAmounts => {
		const remaining: Record<string, number> = {};
		for (const entry of work)
			if (entry.remaining > 0) remaining[entry.item.name] = (remaining[entry.item.name] ?? 0) + entry.remaining;
		return { moved: { ...moved }, remaining };
	};
	const click = (slot: number, button: 0 | 1 = 0) => windowClick(window, state, slot, button);
	try {
		for (const entry of work) {
			while (entry.remaining > 0) {
				const sourceSlot = source.find((slot) => {
					const item = windowSlot(state.snapshot, slot);
					return item != null && sameItem(item, entry.item);
				});
				if (sourceSlot == null) fail("MISSING_MATERIAL", `source ran out of ${entry.item.name}`);
				const sourceItem = windowSlot(state.snapshot, sourceSlot) as ItemValue;
				if (destinationSlot(state.snapshot, destination, sourceItem) == null)
					fail("INVENTORY_FULL", `destination has no room for ${sourceItem.name}`);
				const room = destination.reduce((total, slot) => {
					const target = windowSlot(state.snapshot, slot);
					if (target == null) return total + (sourceItem.stackSize ?? sourceItem.count);
					return (
						total +
						(sameItem(target, sourceItem) && target.stackSize != null
							? Math.max(0, target.stackSize - target.count)
							: 0)
					);
				}, 0);
				const quantity = Math.min(sourceItem.count, entry.remaining, room);
				await click(sourceSlot);
				const held = windowItem(state.snapshot.cursor);
				if (held == null || !sameItem(held, sourceItem) || held.count !== sourceItem.count)
					fail("CONFLICT", "source stack changed while picking it up", { dispatch: "sent" });
				await placeCursor(window, state, destination, quantity, async (item, delta) => {
					moved[item.name] = (moved[item.name] ?? 0) + delta;
					entry.remaining -= delta;
					await options.onProgress?.(amounts());
				});
				if (state.snapshot.cursor != null) await click(sourceSlot);
				if (state.snapshot.cursor != null)
					fail("TARGET_NOT_MET", "cursor remainder could not be returned to its source slot", { dispatch: "sent" });
			}
		}
		return amounts();
	} catch (err) {
		if (err instanceof Error && err.name === "CallFailure") {
			const failure = err as CallFailure;
			if (state.dispatched && failure.dispatch === "not_sent") failure.dispatch = "sent";
			failure.progress = plain({ ...failure.progress, ...amounts() }) as CallFailure["progress"];
		}
		throw err;
	}
}
