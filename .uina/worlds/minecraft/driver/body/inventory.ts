/** Equip and toss share the authoritative click session used by containers. */
import type {
	EquipSlot,
	ItemSelector,
	ItemValue,
	StackExpectation,
	TossOutcome,
	WindowSession,
	WindowSnapshot,
} from "../../contracts/body.js";
import { matchesItem } from "../../contracts/items.js";
import type { CallFailure, EffectReceipt } from "../../contracts/values.js";
import { fail } from "../execution.js";
import type { BodyOperationDeps } from "./operation.js";

interface InventoryDeps extends BodyOperationDeps {
	window: WindowSession;
	selectedSlot: number;
}
function failure(code: string, message: string): CallFailure {
	return fail({ code, message, source: "capability", dispatch: "not_sent", recoverable: true });
}
function itemAt(snapshot: WindowSnapshot, slot: number): ItemValue | null {
	return snapshot.slots[slot]?.item as unknown as ItemValue | null;
}
function expected(item: ItemValue | null): StackExpectation {
	return item == null
		? { item: null, count: 0 }
		: {
				item: {
					name: item.name,
					...(item.components == null ? {} : { components: item.components }),
					...(item.durability == null ? {} : { minDurability: item.durability }),
				},
				count: item.count,
			};
}
async function click(
	deps: InventoryDeps,
	snapshot: WindowSnapshot,
	slot: number,
	button = 0,
	confirmed?: () => void,
): Promise<WindowSnapshot> {
	deps.guard();
	const receipt = await deps.window.click({
		slot,
		button,
		mode: 0,
		expectedRevision: snapshot.revision,
		expectedSlots: slot === -999 ? [] : [{ slot, stack: expected(itemAt(snapshot, slot)) }],
		expectedCursor: expected(snapshot.cursor as unknown as ItemValue | null),
	});
	if (receipt.completion !== "met" || receipt.needsSnapshot || receipt.confirmed == null)
		throw fail({
			code: "TARGET_NOT_MET",
			source: "capability",
			message: "inventory click lacks an authoritative result; it will not be repeated",
			dispatch: receipt.dispatch,
			effects: [receipt.effect],
			recoverable: false,
		});
	confirmed?.();
	deps.guard();
	return receipt.confirmed;
}
function emptyCursor(snapshot: WindowSnapshot): void {
	if (snapshot.cursor != null) throw failure("CURSOR_NOT_EMPTY", "inventory requires a confirmed empty cursor");
}
function hasUnverifiable(snapshot: WindowSnapshot, selector: ItemSelector): boolean {
	return snapshot.slots.some(({ item }) => {
		const value = item as unknown as ItemValue | null;
		return (
			value != null &&
			matchesItem({ name: selector.name, substitutions: selector.substitutions }, value) &&
			((selector.components !== undefined && value.components == null) ||
				(selector.minDurability !== undefined && value.durability == null))
		);
	});
}

export async function runEquip(
	deps: InventoryDeps,
	selector: ItemSelector | null,
	slot: EquipSlot,
): Promise<EffectReceipt> {
	let snapshot = (await deps.window.snapshot()).value;
	emptyCursor(snapshot);
	const target = slot === "hand" ? 36 + deps.selectedSlot : { offhand: 45, head: 5, chest: 6, legs: 7, feet: 8 }[slot];
	if (selector == null && slot !== "hand" && slot !== "offhand")
		throw failure("INVALID_INPUT", "only hands can be emptied");
	const operation = deps.mintOp();
	const effect = deps.mintEff();
	const current = itemAt(snapshot, target);
	if (
		(selector == null && current == null) ||
		(selector != null && current != null && matchesItem(selector, current))
	) {
		deps.recorder.record(effect, operation, "body.equip@1", "receipt", "not_sent", "met");
		return { effect, dispatch: "not_sent", completion: "met", evidence: [] };
	}
	let source: number;
	let destination: number;
	if (selector == null) {
		// 空手优先换选空快捷栏位（held_item_slot 包，免窗口点击）：真服实证从手持槽
		// 取物的点击拿不到权威确认（放入可以），点击路径只作无空位时的兜底。
		if (slot === "hand") {
			for (let candidate = 36; candidate <= 44; candidate++) {
				if (candidate === target || itemAt(snapshot, candidate) != null) continue;
				deps.bot.setQuickBarSlot(candidate - 36);
				deps.recorder.record(effect, operation, "body.equip@1", "receipt", "sent", "met", {
					how: "hotbar-slot-select",
					selectedSlot: candidate - 36,
				});
				return { effect, dispatch: "sent", completion: "met", evidence: [] };
			}
		}
		source = target;
		destination =
			snapshot.slots.find(
				(entry) => entry.slot >= 9 && entry.slot <= 44 && entry.slot !== target && entry.item === null,
			)?.slot ?? -1;
		if (destination < 0) throw failure("INVENTORY_FULL", "no empty main inventory slot for the held item");
	} else {
		source =
			snapshot.slots.find(
				(entry) =>
					entry.slot >= 5 &&
					entry.slot !== target &&
					entry.item != null &&
					matchesItem(selector, entry.item as unknown as ItemValue),
			)?.slot ?? -1;
		if (source < 0)
			throw failure(
				hasUnverifiable(snapshot, selector) ? "WRONG_STATE" : "MISSING_MATERIAL",
				"no verifiable matching inventory item",
			);
		destination = target;
	}
	deps.guard();
	deps.recorder.record(effect, operation, "body.equip@1", "dispatch", "sent", "unknown");
	try {
		snapshot = await click(deps, snapshot, source);
		snapshot = await click(deps, snapshot, destination);
		if (snapshot.cursor != null) snapshot = await click(deps, snapshot, source);
		emptyCursor(snapshot);
		const after = itemAt(snapshot, target);
		if (selector == null ? after != null : after == null || !matchesItem(selector, after))
			throw failure("TARGET_NOT_MET", "server inventory does not satisfy the requested equipment");
		deps.recorder.record(effect, operation, "body.equip@1", "receipt", "sent", "met");
		return { effect, dispatch: "sent", completion: "met", evidence: [] };
	} catch (error) {
		deps.recorder.record(effect, operation, "body.equip@1", "receipt", "sent", "unknown");
		throw error;
	}
}

export async function runToss(deps: InventoryDeps, selector: ItemSelector, count: number): Promise<TossOutcome> {
	if (!Number.isInteger(count) || count < 1) throw failure("INVALID_INPUT", "toss count must be a positive integer");
	let snapshot = (await deps.window.snapshot()).value;
	emptyCursor(snapshot);
	const sources = snapshot.slots.filter(
		(entry) =>
			entry.slot >= 9 &&
			entry.slot <= 44 &&
			entry.item != null &&
			matchesItem(selector, entry.item as unknown as ItemValue),
	);
	if (sources.length === 0)
		throw failure(
			hasUnverifiable(snapshot, selector) ? "WRONG_STATE" : "NOT_FOUND",
			"no verifiable matching item in main inventory",
		);
	if (sources.reduce((sum, entry) => sum + (entry.item as unknown as ItemValue).count, 0) < count)
		throw failure("MISSING_MATERIAL", "main inventory contains fewer matching items than requested");
	const operation = deps.mintOp();
	const effect = deps.mintEff();
	const removed: Record<string, number> = {};
	let remaining = count;
	deps.guard();
	deps.recorder.record(effect, operation, "body.toss@1", "dispatch", "sent", "unknown");
	try {
		for (const source of sources) {
			if (remaining === 0) break;
			const item = itemAt(snapshot, source.slot);
			if (item == null || !matchesItem(selector, item))
				throw failure("CONFLICT", "selected source changed before toss");
			const quantity = Math.min(remaining, item.count);
			snapshot = await click(deps, snapshot, source.slot);
			if (quantity === item.count) {
				snapshot = await click(deps, snapshot, -999, 0, () => {
					removed[item.name] = (removed[item.name] ?? 0) + quantity;
					remaining -= quantity;
				});
			} else {
				for (let i = 0; i < quantity; i++)
					snapshot = await click(deps, snapshot, -999, 1, () => {
						removed[item.name] = (removed[item.name] ?? 0) + 1;
						remaining--;
					});
			}
			if (snapshot.cursor != null) snapshot = await click(deps, snapshot, source.slot);
			emptyCursor(snapshot);
		}
		deps.recorder.record(effect, operation, "body.toss@1", "receipt", "sent", "met", { removed, remaining });
		return { receipt: { effect, dispatch: "sent", completion: "met", evidence: [] }, removed, remaining };
	} catch (error) {
		deps.recorder.record(effect, operation, "body.toss@1", "receipt", "sent", "unknown", { removed, remaining });
		if (error instanceof Error && error.name === "CallFailure") {
			const failure = error as CallFailure;
			failure.progress = { ...failure.progress, removed, remaining };
			if (failure.dispatch === "not_sent") failure.dispatch = "sent";
		}
		throw error;
	}
}
