/**
 * 身体类查询：self@1（身体状态 + 手持/护甲）与 inventory@1（槽位、计数、空地）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 self/inventory。
 * 两者共用同一次提交边界：self 的手持/护甲取自同一采样里的库存，而不是另读一次。
 * 读不到的字段一律进 unknown（health/food 不填 0，耐久不编造）。
 */

import type { ItemValue } from "../../contracts/body.js";
import type { ClientInventoryValue, ClientFactView } from "../../contracts/client-facts.js";
import type { Fact } from "../../contracts/values.js";
import { factOf } from "../shared/facts.js";
import { EMPTY_INPUT } from "../shared/schema.js";
import type { QuerySpec } from "../shared/query.js";

type SlotItem = ItemValue;

export interface GearView {
	held?: SlotItem;
	armor: { head?: SlotItem; chest?: SlotItem; legs?: SlotItem; feet?: SlotItem; offhand?: SlotItem };
}

/** 手持与护甲：来自同一份库存快照；槽位编号按 Java 玩家窗口。 */
function gearOf(inventory: ClientInventoryValue): GearView {
	const slotItem = (index: number): SlotItem | undefined => {
		const slot = inventory.slots.find((entry) => entry.slot === index);
		const item = slot?.item;
		return item == null ? undefined : { ...item };
	};
	const selected = inventory.selectedSlot;
	const held = selected == null ? undefined : slotItem(36 + selected);
	const armor: GearView["armor"] = {};
	const head = slotItem(5);
	const chest = slotItem(6);
	const legs = slotItem(7);
	const feet = slotItem(8);
	const offhand = slotItem(45);
	if (head != null) armor.head = head;
	if (chest != null) armor.chest = chest;
	if (legs != null) armor.legs = legs;
	if (feet != null) armor.feet = feet;
	if (offhand != null) armor.offhand = offhand;
	return held == null ? { armor } : { held, armor };
}

const selfQuery: QuerySpec = {
	descriptor: {
		ref: "self@1",
		summary: "Client body state at the current commit boundary (position, vitals, effects, held item, armor)",
		input: EMPTY_INPUT,
		output: { type: "object" },
		access: "read",
		watchable: true,
		feedback: false,
		examples: [
			{
				input: {},
				output: {
					value: {
						place: { dimension: "overworld", position: { x: 0, y: 64, z: 0 } },
						health: 20,
						food: 20,
						onGround: true,
						held: { name: "stone_pickaxe", count: 1 },
						armor: {},
					},
					coverage: "partial",
					unknown: ["maxHealth attribute not available"],
				},
			},
		],
	},
	reader: {
		kind: "current",
		read: (view: ClientFactView): Fact<unknown> => {
			const self = view.self();
			if (self.value == null) return self as Fact<unknown>;
			const inventory = view.inventory();
			const unknown = [...self.unknown, ...inventory.unknown];
			if (inventory.value == null) {
				unknown.push("inventory not received; held/armor unknown");
				return factOf({ ...self.value, armor: {} }, { unknown, source: self.source, basis: self.basis });
			}
			const gear = gearOf(inventory.value);

			return factOf({ ...self.value, ...gear }, { unknown, source: self.source, basis: self.basis });
		},
	},
};

const inventoryQuery: QuerySpec = {
	descriptor: {
		ref: "inventory@1",
		summary: "Inventory slots, layout regions, per-item counts and free space at the current commit boundary",
		input: EMPTY_INPUT,
		output: { type: "object" },
		access: "read",
		watchable: true,
		feedback: false,
		examples: [
			{
				input: {},
				output: {
					value: {
						slots: [{ slot: 36, name: "oak_log", count: 8 }],
						counts: { oak_log: 8 },
						usedSlots: 1,
						freeSlots: 35,
						held: { name: "oak_log", count: 8 },
					},
					coverage: "partial",
					unknown: ["item durability/components not captured in the current view"],
				},
			},
		],
	},
	reader: {
		kind: "current",
		read: (view: ClientFactView): Fact<unknown> => {
			const inventory = view.inventory();
			if (inventory.value == null) return inventory as Fact<unknown>;
			const value = inventory.value;
			const unknown = [...inventory.unknown];
			const slots: (ItemValue & { slot: number })[] = [];
			const counts: Record<string, number> = {};
			for (const slot of value.slots) {
				if (slot.item == null) continue;
				slots.push({ slot: slot.slot, ...slot.item });
				counts[slot.item.name] = (counts[slot.item.name] ?? 0) + slot.item.count;
			}
			// 可用空间只按主背包 + 快捷栏计（36 格）；护甲/副手/合成槽不参与搬运判断。
			const carry = value.layout.regions.filter((region) => region.name === "main" || region.name === "hotbar");
			const carrySlots = new Set(carry.flatMap((region) => region.slots));
			let usedSlots = 0;
			for (const slot of slots) if (carrySlots.has(slot.slot)) usedSlots++;
			const freeSlots = Math.max(0, carrySlots.size - usedSlots);
			const gear = gearOf(value);
			return factOf(
				{
					revision: value.revision,
					layout: value.layout,
					slots,
					counts,
					usedSlots,
					freeSlots,
					selectedSlot: value.selectedSlot,
					...gear,
				},
				{ unknown, source: inventory.source, basis: inventory.basis },
			);
		},
	},
};

export function bodyQueries(): QuerySpec[] {
	return [selfQuery, inventoryQuery];
}
