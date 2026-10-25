import { describe, expect, test } from "vitest";
import { buildRegistryKnowledge, type RegistryLike } from "../../.uina/worlds/minecraft/driver/facts/knowledge.js";

/**
 * 静态知识整形（contracts/knowledge.ts、capabilities §3 item/recipe）。
 *
 * 数据来源固定为 minecraft-data 形状：这里用一份最小注册表锁住四个易错点：
 * 精准采集掉落不算普通掉落、harvest 保留注册表允许工具集合、镜像配方的去重、
 * 缺失类别用 sourcesComplete=false 如实表达（不把空列表解释成"无法获得"）。
 */

const registry: RegistryLike = {
	version: { minecraftVersion: "1.21.11" },
	itemsByName: {
		air: { id: 0, name: "air", displayName: "Air", stackSize: 64 },
		stone: { id: 1, name: "stone", displayName: "Stone", stackSize: 64 },
		cobblestone: { id: 35, name: "cobblestone", displayName: "Cobblestone", stackSize: 64 },
		apple: { id: 893, name: "apple", displayName: "Apple", stackSize: 64 },
		iron_ingot: { id: 904, name: "iron_ingot", displayName: "Iron Ingot", stackSize: 64 },
		wooden_pickaxe: { id: 913, name: "wooden_pickaxe", displayName: "Wooden Pickaxe", stackSize: 1, maxDurability: 59 },
		iron_pickaxe: { id: 933, name: "iron_pickaxe", displayName: "Iron Pickaxe", stackSize: 1, maxDurability: 250 },
		stick: { id: 946, name: "stick", displayName: "Stick", stackSize: 64 },
		wheat: { id: 296, name: "wheat", displayName: "Wheat", stackSize: 64 },
		hay_block: { id: 849, name: "hay_block", displayName: "Hay Block", stackSize: 64 },
	},
	items: {
		0: { id: 0, name: "air" },
		1: { id: 1, name: "stone" },
		35: { id: 35, name: "cobblestone" },
		296: { id: 296, name: "wheat" },
		849: { id: 849, name: "hay_block" },
		893: { id: 893, name: "apple" },
		904: { id: 904, name: "iron_ingot" },
		913: { id: 913, name: "wooden_pickaxe" },
		933: { id: 933, name: "iron_pickaxe" },
		946: { id: 946, name: "stick" },
	},
	blocksByName: {
		stone: { id: 1, name: "stone", harvestTools: { "913": true, "933": true } },
		cobblestone: { id: 35, name: "cobblestone" },
	},
	foodsByName: { apple: { foodPoints: 4, saturation: 19.2 } },
	blockLoot: {
		stone: {
			block: "stone",
			drops: [
				{ item: "stone", silkTouch: true },
				{ item: "cobblestone", noSilkTouch: true },
			],
		},
	},
	entityLoot: {
		zombie: { entity: "zombie", drops: [{ item: "iron_ingot" }, { item: "apple" }] },
	},
	entitiesByName: {
		zombie: { type: "hostile", category: "Hostile mobs" },
		cow: { type: "animal", category: "Passive mobs" },
	},
	recipes: {
		"933": [
			{
				inShape: [
					[904, 904, 904],
					[null, 946, null],
					[null, 946, null],
				],
				result: { id: 933, count: 1 },
			},
			// 镜像摆法：同料同产物，必须去重成一条
			{
				inShape: [
					[904, 904, 904],
					[null, 946, null],
					[null, 946, null],
				],
				result: { id: 933, count: 1 },
			},
		],
		// 9 个同种材料的 shapeless：物品种类只有 1 种，但格子有 9 个，必须走工作台。
		"849": [{ ingredients: Array.from({ length: 9 }, () => 296), result: { id: 849, count: 1 } }],
	},
};

const knowledge = buildRegistryKnowledge(registry);

describe("item：物品知识", () => {
	test("工具：类型/档位/耐久来自注册表，不猜", () => {
		expect(knowledge.item("iron_pickaxe")?.tool).toEqual({ type: "pickaxe", tier: "iron", durability: 250 });
		expect(knowledge.item("stick")?.tool).toBeNull();
	});

	test("食物：hunger/saturation 来自 foods 数据", () => {
		expect(knowledge.item("apple")?.food).toEqual({ hunger: 4, saturation: 19.2 });
	});

	test("来源：合成/方块/实体都进 sources，缺失类别让 sourcesComplete=false", () => {
		const pickaxe = knowledge.item("iron_pickaxe");
		expect(pickaxe?.sources.some((source) => source.kind === "craft")).toBe(true);
		expect(pickaxe?.sourcesComplete).toBe(false);
		const cobble = knowledge.item("cobblestone");
		expect(cobble?.sources).toEqual([
			{ kind: "block", block: "stone", harvest: { kind: "tools", names: ["wooden_pickaxe", "iron_pickaxe"] } },
		]);
		const apple = knowledge.item("apple");
		expect(apple?.sources).toEqual([{ kind: "entity", entity: "zombie" }]);
	});

	test("未知物品返回 null，规范化名字可容忍命名空间", () => {
		expect(knowledge.item("diamond_block")).toBeNull();
		expect(knowledge.canonicalItemName("minecraft:apple")).toBe("apple");
		expect(knowledge.canonicalItemName("nope")).toBeNull();
	});

	test("熔炼来源进 sources，燃料刻数来自燃料表（未收录即 null）", () => {
		expect(knowledge.item("iron_ingot")?.sources.some((source) => source.kind === "smelt")).toBe(true);
		expect(knowledge.item("stick")?.fuel).toEqual({ ticks: 100 });
		expect(knowledge.item("stone")?.fuel).toBeNull();
	});
});

describe("blockDrops：普通挖掘掉落", () => {
	test("精准采集专属掉落不算普通掉落；harvest 保留注册表允许工具集合", () => {
		expect(knowledge.blockDrops("stone")).toEqual({
			items: ["cobblestone"],
			harvest: { kind: "tools", names: ["wooden_pickaxe", "iron_pickaxe"] },
		});
	});

	test("没有掉落数据返回 null（不伪造空列表）", () => {
		expect(knowledge.blockDrops("netherite_block")).toBeNull();
	});
});

describe("recipe：配方整形", () => {
	test("3x3 走工作台，镜像摆法去重，材料按名字聚合", () => {
		const recipes = knowledge.recipesFor("iron_pickaxe");
		expect(recipes).toHaveLength(1);
		expect(recipes[0]?.station).toBe("crafting_table");
		expect(recipes[0]?.output).toEqual({ item: "iron_pickaxe", count: 1 });
		expect(recipes[0]?.ingredients).toEqual([
			{ item: "iron_ingot", count: 3 },
			{ item: "stick", count: 2 },
		]);
	});

	test("成形配方保留摆格图案（空格是 null，不是缺项）", () => {
		expect(knowledge.recipesFor("iron_pickaxe")[0]?.pattern).toEqual([
			["iron_ingot", "iron_ingot", "iron_ingot"],
			[null, "stick", null],
			[null, "stick", null],
		]);
	});

	test("站别按实际格子数判定：9 个同种材料的 shapeless 也要工作台", () => {
		const recipe = knowledge.recipesFor("hay_block")[0];
		expect(recipe?.station).toBe("crafting_table");
		expect(recipe?.pattern).toBeUndefined();
		expect(recipe?.ingredients).toEqual([{ item: "wheat", count: 9 }]);
	});

	test("熔炼配方来自版本数据表：一条原料一条配方，带烹饪刻数", () => {
		const furnace = knowledge
			.recipesFor("iron_ingot")
			.filter((recipe) => recipe.station === "furnace")
			.map((recipe) => recipe.ingredients[0]?.item);
		expect(furnace).toContain("raw_iron");
		expect(furnace).toContain("iron_ore");
		const raw = knowledge.recipesFor("iron_ingot").find((recipe) => recipe.ingredients[0]?.item === "raw_iron");
		expect(raw?.output).toEqual({ item: "iron_ingot", count: 1 });
		expect(raw?.cookTicks).toBe(200);
	});
});

describe("实体分类", () => {
	test("hostile/passive/player 来自 entities 数据", () => {
		expect(knowledge.entityKind("zombie")).toBe("hostile");
		expect(knowledge.entityKind("cow")).toBe("passive");
		expect(knowledge.entityKind("player")).toBe("player");
		expect(knowledge.entityKind("minecart")).toBeNull();
	});
});
