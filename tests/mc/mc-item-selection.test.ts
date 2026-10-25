import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { buildRegistryKnowledge } from "../../.uina/worlds/minecraft/driver/facts/knowledge.js";
import { chooseTool, canHarvest } from "../../.uina/worlds/minecraft/capabilities/shared/tools.js";
import { matchesItem } from "../../.uina/worlds/minecraft/capabilities/shared/targets.js";

const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));
const registry = mf("prismarine-registry")("1.21.11");
const knowledge = buildRegistryKnowledge(registry);
function inventory(names: string[], held?: string) {
	return {
		slots: names.map((name, i) => ({ slot: i + 9, name, count: 1 })),
		counts: {},
		...(held ? { held: { name: held, count: 1 } } : {}),
	};
}

describe("real 1.21.11 harvest requirements", () => {
	test("gold never substitutes for iron on diamond ore", () => {
		expect(canHarvest(knowledge, inventory(["golden_pickaxe"]), "diamond_ore", undefined)).toBe(false);
		expect(chooseTool(knowledge, inventory(["golden_pickaxe", "iron_pickaxe"]), "diamond_ore", undefined)).toBe(
			"iron_pickaxe",
		);
	});
	test("copper is accepted for iron ore, wood is not; held eligible tool wins", () => {
		expect(canHarvest(knowledge, inventory(["wooden_pickaxe"]), "iron_ore", undefined)).toBe(false);
		expect(chooseTool(knowledge, inventory(["copper_pickaxe"]), "iron_ore", undefined)).toBe("copper_pickaxe");
		expect(
			chooseTool(knowledge, inventory(["iron_pickaxe", "copper_pickaxe"], "copper_pickaxe"), "iron_ore", undefined),
		).toBe("copper_pickaxe");
	});
	test("explicit tools must also meet harvest requirements", () => {
		expect(() => chooseTool(knowledge, inventory(["golden_pickaxe"]), "diamond_ore", "golden_pickaxe")).toThrowError(
			/harvest/,
		);
	});
});

describe("shared item constraints", () => {
	test("components are not silently ignored and remaining durability is used", () => {
		const item = {
			name: "iron_pickaxe",
			count: 1,
			stackSize: 1,
			components: { added: [], removed: [] },
			durability: 12,
		};
		expect(
			matchesItem({ name: "minecraft:iron_pickaxe", components: { added: ["enchanted"], removed: [] } }, item),
		).toBe(false);
		expect(matchesItem({ name: "iron_pickaxe", minDurability: 10 }, item)).toBe(true);
		expect(matchesItem({ name: "iron_pickaxe", minDurability: 13 }, item)).toBe(false);
		expect(
			matchesItem({ name: "stone_pickaxe", substitutions: ["minecraft:iron_pickaxe"], minDurability: 10 }, item),
		).toBe(true);
	});
});
