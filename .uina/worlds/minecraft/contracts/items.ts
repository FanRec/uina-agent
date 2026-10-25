/** Shared pure item identity and selector semantics; no client or inventory authority. */
import type { ItemSelector, ItemValue } from "./body.js";

/** JSON semantics, including snapshots crossing a VM/Worker realm. */
export function jsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) || Array.isArray(b))
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((part, index) => jsonEqual(part, b[index]))
		);
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	return (
		keys.length === Object.keys(right).length &&
		keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
	);
}

export function itemName(name: string): string {
	return name.replace(/^minecraft:/, "");
}

export function matchesItem(
	selector: string | ItemSelector,
	item: Pick<ItemValue, "name" | "count"> & Partial<ItemValue>,
): boolean {
	const names = typeof selector === "string" ? [selector] : [selector.name, ...(selector.substitutions ?? [])];
	if (!names.some((name) => itemName(name) === itemName(item.name))) return false;
	if (typeof selector === "string") return true;
	if (
		selector.components !== undefined &&
		(item.components == null || !jsonEqual(selector.components, item.components))
	)
		return false;
	return (
		selector.minDurability === undefined ||
		(typeof item.durability === "number" && item.durability >= selector.minDurability)
	);
}

export function sameItem(a: ItemValue, b: ItemValue): boolean {
	return (
		itemName(a.name) === itemName(b.name) && a.durability === b.durability && jsonEqual(a.components, b.components)
	);
}
