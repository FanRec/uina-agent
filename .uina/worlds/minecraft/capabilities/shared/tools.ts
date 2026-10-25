/** Harvest eligibility comes from the version registry, never a guessed tier order. */
import type { ItemSelector } from "../../contracts/body.js";
import type { HarvestRequirement, RegistryKnowledge } from "../../contracts/knowledge.js";
import { fail, matchesItem, stripNamespace } from "./targets.js";
import type { InventorySnapshot, SlotView } from "./views.js";
export function harvestRequirement(knowledge: RegistryKnowledge | null, block: string): HarvestRequirement {
	return knowledge?.blockDrops(block)?.harvest ?? { kind: "unknown" };
}
function eligible(requirement: HarvestRequirement, name: string): boolean {
	return (
		requirement.kind === "any" || (requirement.kind === "tools" && requirement.names.includes(stripNamespace(name)))
	);
}
function candidates(inventory: InventorySnapshot, requested?: string | ItemSelector): SlotView[] {
	const slots = [...inventory.slots].sort((a, b) => a.slot - b.slot);
	const selected = inventory.selectedSlot;
	const held =
		selected == null
			? slots.find((slot) => slot.name === inventory.held?.name)
			: slots.find((slot) => slot.slot === selected + 36);
	return (held ? [held, ...slots.filter((slot) => slot !== held)] : slots).filter(
		(slot) => requested == null || matchesItem(requested, slot),
	);
}
export function chooseTool(
	knowledge: RegistryKnowledge | null,
	inventory: InventorySnapshot,
	block: string,
	requested?: string | ItemSelector,
): string | null {
	const requirement = harvestRequirement(knowledge, block);
	const matches = candidates(inventory, requested);
	if (requested != null && matches.length === 0)
		fail("MISSING_MATERIAL", "requested tool has no verifiable matching inventory item");
	if (requirement.kind === "unknown") fail("WRONG_STATE", `harvest requirements of ${block} are unknown`);
	if (requirement.kind === "any" && requested == null) return null;
	const match = matches.find((slot) => eligible(requirement, slot.name));
	if (match == null)
		fail("MISSING_TOOL", `no matching inventory tool can harvest ${block}`, {
			hint: requirement.kind === "tools" ? `accepted tools: ${requirement.names.join(", ")}` : undefined,
		});
	return match.name;
}
export function canHarvest(
	knowledge: RegistryKnowledge | null,
	inventory: InventorySnapshot,
	block: string,
	requested?: string | ItemSelector,
): boolean {
	const requirement = harvestRequirement(knowledge, block);
	return requirement.kind === "any"
		? requested == null || candidates(inventory, requested).length > 0
		: candidates(inventory, requested).some((slot) => eligible(requirement, slot.name));
}
