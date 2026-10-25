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

export interface TransferAmounts {
	moved: Record<string, number>;
	remaining: Record<string, number>;
}

export function windowItem(value: JsonValue | null): ItemValue | null {
	return value as unknown as ItemValue | null;
}

export function windowRegion(snapshot: WindowSnapshot, name: "container" | "player"): number[] {
	const region = snapshot.layout.regions.find((entry) => entry.name === name);
	if (region == null) fail("WRONG_STATE", `window ${snapshot.type} has no ${name} slot region`);
	return region.slots;
}

function at(snapshot: WindowSnapshot, slot: number): ItemValue | null {
	const entry = snapshot.slots.find((candidate) => candidate.slot === slot);
	if (entry == null) fail("WRONG_STATE", `window slot ${slot} is unknown`);
	return windowItem(entry.item);
}

function expectation(item: ItemValue | null): StackExpectation {
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

interface WorkItem {
	item: ItemValue;
	remaining: number;
}

/** 只从本次首个可核验源快照建立清单；途中新增的物品不会扩张本次任务。 */
function manifest(snapshot: WindowSnapshot, input: TransferSelection): WorkItem[] {
	const source = windowRegion(snapshot, input.direction === "from" ? "container" : "player");
	const items = source
		.map((slot) => at(snapshot, slot))
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
): { matches: boolean; same: boolean; room: boolean } {
	const source = windowRegion(snapshot, input.direction === "from" ? "container" : "player");
	const destination = windowRegion(snapshot, input.direction === "from" ? "player" : "container");
	const items = source
		.map((slot) => at(snapshot, slot))
		.filter(
			(item): item is ItemValue =>
				item != null && (input.all === true || (input.item != null && matchesItem(input.item, item))),
		);
	const same = items.some((item) =>
		destination.some((slot) => {
			const existing = at(snapshot, slot);
			return (
				existing != null &&
				sameItem(item, existing) &&
				existing.stackSize != null &&
				existing.count < existing.stackSize
			);
		}),
	);
	return { matches: items.length > 0, same, room: same || destination.some((slot) => at(snapshot, slot) == null) };
}

export async function transferWindow(
	window: WindowSession,
	input: TransferSelection,
	onProgress?: (amounts: TransferAmounts) => Promise<void>,
): Promise<TransferAmounts> {
	let snapshot = (await window.snapshot()).value;
	if (snapshot.cursor != null) fail("WRONG_STATE", "window cursor is occupied before transfer");
	const source = windowRegion(snapshot, input.direction === "from" ? "container" : "player");
	const destination = windowRegion(snapshot, input.direction === "from" ? "player" : "container");
	const work = manifest(snapshot, input);
	const moved: Record<string, number> = {};
	let dispatched = false;
	const amounts = (): TransferAmounts => {
		const remaining: Record<string, number> = {};
		for (const entry of work)
			if (entry.remaining > 0) remaining[entry.item.name] = (remaining[entry.item.name] ?? 0) + entry.remaining;
		return { moved: { ...moved }, remaining };
	};
	const click = async (slot: number, button = 0): Promise<void> => {
		const receipt = await window.click({
			slot,
			button,
			mode: 0,
			expectedRevision: snapshot.revision,
			expectedSlots: [slot].map((index) => ({ slot: index, stack: expectation(at(snapshot, index)) })),
			expectedCursor: expectation(windowItem(snapshot.cursor)),
		});
		dispatched ||= receipt.dispatch !== "not_sent";
		if (receipt.completion !== "met" || receipt.needsSnapshot) {
			fail("TARGET_NOT_MET", "window click has no confirmed server result; it will not be repeated", {
				dispatch: receipt.completion === "not_met" ? "sent" : "unknown",
				effects: [receipt.effect],
			});
		}
		const next = (await window.snapshot()).value;
		if (next.window !== snapshot.window)
			fail("REFERENCE_STALE", "window changed during transfer", { dispatch: "sent" });
		snapshot = next;
	};
	try {
		for (const entry of work) {
			while (entry.remaining > 0) {
				const sourceSlot = source.find((slot) => {
					const item = at(snapshot, slot);
					return item != null && sameItem(item, entry.item);
				});
				if (sourceSlot == null) fail("MISSING_MATERIAL", `source ran out of ${entry.item.name}`);
				const sourceItem = at(snapshot, sourceSlot) as ItemValue;
				let targetSlot = destination.find((slot) => {
					const target = at(snapshot, slot);
					return (
						target != null &&
						sameItem(target, sourceItem) &&
						target.stackSize != null &&
						target.count < target.stackSize
					);
				});
				targetSlot ??= destination.find((slot) => at(snapshot, slot) == null);
				if (targetSlot == null) fail("INVENTORY_FULL", `destination has no room for ${sourceItem.name}`);
				const previousTarget = at(snapshot, targetSlot);
				const targetCount = previousTarget?.count ?? 0;
				const room = previousTarget == null ? sourceItem.count : (previousTarget.stackSize as number) - targetCount;
				const quantity = Math.min(sourceItem.count, entry.remaining, room);
				await click(sourceSlot);
				const held = windowItem(snapshot.cursor);
				if (held == null || !sameItem(held, sourceItem) || held.count !== sourceItem.count)
					fail("CONFLICT", "source stack changed while picking it up", { dispatch: "sent" });
				const place = async (button: number, expected: number): Promise<void> => {
					const beforeCount = at(snapshot, targetSlot)?.count ?? 0;
					await click(targetSlot, button);
					const afterTarget = at(snapshot, targetSlot);
					const delta = afterTarget != null && sameItem(afterTarget, sourceItem) ? afterTarget.count - beforeCount : 0;
					if (delta !== expected)
						fail("TARGET_NOT_MET", `expected ${expected} ${sourceItem.name} at destination, observed ${delta}`, {
							dispatch: "sent",
						});
					moved[sourceItem.name] = (moved[sourceItem.name] ?? 0) + delta;
					entry.remaining -= delta;
				};
				if (quantity === held.count || quantity === room) await place(0, quantity);
				else for (let i = 0; i < quantity; i++) await place(1, 1);
				if (snapshot.cursor != null) await click(sourceSlot);
				if (snapshot.cursor != null)
					fail("TARGET_NOT_MET", "cursor remainder could not be returned to its source slot", { dispatch: "sent" });
				await onProgress?.(amounts());
			}
		}
		return amounts();
	} catch (err) {
		if (err instanceof Error && err.name === "CallFailure") {
			const failure = err as CallFailure;
			if (dispatched && failure.dispatch === "not_sent") failure.dispatch = "sent";
			failure.progress = plain({ ...failure.progress, ...amounts() }) as CallFailure["progress"];
		}
		throw err;
	}
}
