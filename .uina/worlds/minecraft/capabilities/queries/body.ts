/**
 * 身体类查询：self@1（身体状态 + 手持/护甲）与 inventory@1（槽位、计数、空地）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 self/inventory。
 * 两者共用同一次提交边界：self 的手持/护甲取自同一采样里的库存，而不是另读一次。
 * 读不到的字段一律进 unknown（health/food 不填 0，耐久不编造）。
 */

import type { ItemValue } from "../../contracts/body.js";
import type { ClientFactView, ClientInventoryValue } from "../../contracts/client-facts.js";
import type { Fact, JsonSchema, JsonValue } from "../../contracts/values.js";
import { callFailure } from "../../contracts/values.js";
import type { CapabilityDefinition, MinecraftCapabilityModule } from "../catalog.js";
import { factOf } from "../shared/facts.js";
import { EMPTY_INPUT } from "../shared/schema.js";

type SlotItem = Record<string, JsonValue>;

/**
 * 省略值为 null 的字段：stackSize/components/durability 在大多数槽位上都是 null，
 * 每个槽固定占位是纯噪音。非 null 原样保留（耐久、组件仍是可核实事实）。
 */
function compactItem(item: ItemValue): SlotItem {
	const out: SlotItem = { name: item.name, count: item.count };
	if (item.stackSize != null) out.stackSize = item.stackSize;
	if (item.components != null) out.components = item.components;
	if (item.durability != null) out.durability = item.durability;
	return out;
}

export interface GearView {
	held?: SlotItem;
	armor: { head?: SlotItem; chest?: SlotItem; legs?: SlotItem; feet?: SlotItem; offhand?: SlotItem };
}

/** 手持与护甲：来自同一份库存快照；槽位编号按 Java 玩家窗口。 */
function gearOf(inventory: ClientInventoryValue): GearView {
	const slotItem = (index: number): SlotItem | undefined => {
		const slot = inventory.slots.find((entry) => entry.slot === index);
		const item = slot?.item;
		return item == null ? undefined : compactItem(item);
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

const selfDefinition: CapabilityDefinition = {
	kind: "query",
	descriptor: {
		ref: "self@1",
		// 手持/护甲切自同一份库存快照：库存修订也参与 self@1 的游标。
		facts: ["self", "inventory"],
		summary: "Client body state at the current commit boundary (position, vitals, effects, held item, armor)",
		input: EMPTY_INPUT,
		output: { type: "object" },
		access: "read",
		watchable: true,
		feedback: true,
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
	bind: () => ({
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
	}),
};

const INVENTORY_INPUT: JsonSchema = {
	type: "object",
	properties: {
		since: { type: "integer", minimum: 0, description: "inventory revision; omit for the full read" },
	},
	additionalProperties: false,
};

/** 主背包/快捷栏占用与总数（两种模式共用；护甲/副手/合成槽不参与搬运判断）。 */
function carrySummary(
	value: ClientInventoryValue,
	slots: { slot: number; item: ItemValue | null }[],
): { counts: Record<string, number>; usedSlots: number; freeSlots: number } {
	const counts: Record<string, number> = {};
	for (const slot of slots) {
		if (slot.item == null) continue;
		counts[slot.item.name] = (counts[slot.item.name] ?? 0) + slot.item.count;
	}
	const carry = value.layout.regions.filter((region) => region.name === "main" || region.name === "hotbar");
	const carrySlots = new Set(carry.flatMap((region) => region.slots));
	let usedSlots = 0;
	for (const slot of slots) if (slot.item != null && carrySlots.has(slot.slot)) usedSlots++;
	return { counts, usedSlots, freeSlots: Math.max(0, carrySlots.size - usedSlots) };
}

/** 全量形态（省略 since 或标记不可用时的回退）；extraUnknown 追加进事实 unknown。 */
function fullInventoryFact(
	value: ClientInventoryValue,
	meta: { unknown: string[]; source: Fact<unknown>["source"]; basis: Fact<unknown>["basis"] },
	summary: { counts: Record<string, number>; usedSlots: number; freeSlots: number },
	extraUnknown: string[],
): Fact<unknown> {
	const slots: (SlotItem & { slot: number })[] = [];
	for (const slot of value.slots) if (slot.item != null) slots.push({ slot: slot.slot, ...compactItem(slot.item) });
	return factOf(
		{
			revision: value.revision,
			layout: value.layout,
			slots,
			...summary,
			selectedSlot: value.selectedSlot,
			...gearOf(value),
		},
		{ unknown: [...meta.unknown, ...extraUnknown], source: meta.source, basis: meta.basis },
	);
}

const inventoryDefinition: CapabilityDefinition = {
	kind: "query",
	descriptor: {
		ref: "inventory@1",
		facts: ["inventory"],
		summary: "Inventory slots, layout regions, per-item counts and free space at the current commit boundary",
		input: INVENTORY_INPUT,
		output: { type: "object" },
		access: "read",
		watchable: true,
		feedback: true,
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
			{
				input: { since: 41 },
				output: {
					value: {
						revision: 47,
						changes: [
							{ slot: 36, item: { name: "oak_log", count: 11, stackSize: 64, durability: null, components: null } },
							{ slot: 37, item: null },
						],
						counts: { oak_log: 11 },
						usedSlots: 1,
						freeSlots: 35,
						selectedSlot: 0,
					},
				},
			},
		],
	},
	bind: () => ({
		kind: "current",
		read: (view: ClientFactView, input: JsonValue): Fact<unknown> => {
			const inventory = view.inventory();
			if (inventory.value == null) return inventory as Fact<unknown>;
			const value = inventory.value;
			const meta = { unknown: [...inventory.unknown], source: inventory.source, basis: inventory.basis };
			const since = (input as { since?: number } | null)?.since;
			const fullSlots = value.slots.map((slot) => ({ slot: slot.slot, item: slot.item }));
			const summary = carrySummary(value, fullSlots);
			if (since === undefined) return fullInventoryFact(value, meta, summary, []);
			// 游标超前（含跨进程重启后 revision 归零）：如时报错，不编差量。
			if (value.revision < since)
				throw callFailure({
					code: "INVALID_INPUT",
					source: "input",
					message: `since ${since} is ahead of the current inventory revision ${value.revision}`,
					hint: "revision is per-connection; re-read inventory@1 without since",
					dispatch: "not_sent",
					effects: [],
					recoverable: true,
				});
			const changes = view.inventoryChanges(since);
			// 标记不可用：退回全量并如实标注，不冒充差量。
			if (changes == null)
				return fullInventoryFact(value, meta, summary, ["slot change marks unavailable; returning full inventory"]);
			return factOf({ revision: value.revision, changes, ...summary, selectedSlot: value.selectedSlot }, meta);
		},
	}),
};

export const bodyModule: MinecraftCapabilityModule = {
	id: "body",
	definitions: [selfDefinition, inventoryDefinition],
};
