/**
 * 静态游戏知识：由当前连接的注册表构建 RegistryKnowledge（contracts/knowledge.ts）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4.2、modules/capabilities.md §3 item/recipe。
 * 数据只来自 minecraft-data（经 prismarine-registry），不做网络补全、不猜掉落率：
 * - 方块掉落只取"普通挖掘"条目（silkTouch!==true），requiredTool 取 harvestTools 里最弱的工具；
 * - 配方只有合成（本版本数据无熔炼/交易），缺失类别用 sourcesComplete=false 如实表达；
 * - 燃料数据当前版本未提供，fuel 保持 null 而不是 0。
 */

import type {
	KnowledgeBlockDrops,
	KnowledgeItem,
	KnowledgeRecipe,
	ItemSource,
	RegistryKnowledge,
} from "../../contracts/knowledge.js";

interface ItemData {
	id: number;
	name: string;
	displayName?: string;
	stackSize?: number;
	maxDurability?: number;
}

interface BlockData {
	id: number;
	name: string;
	harvestTools?: Record<string, boolean>;
}

interface LootDrop {
	item: string;
	dropChance?: number;
	silkTouch?: boolean;
	noSilkTouch?: boolean;
}

interface LootEntry {
	block?: string;
	entity?: string;
	drops: LootDrop[];
}

interface RawRecipe {
	inShape?: (number | null)[][];
	ingredients?: number[];
	result: { id: number; count: number };
}

/** prismarine-registry 中本模块实际读取的字段（其余不依赖）。 */
export interface RegistryLike {
	version?: { minecraftVersion?: string; dataVersion?: number };
	itemsByName: Record<string, ItemData>;
	items?: Record<number, ItemData>;
	blocksByName: Record<string, BlockData>;
	foodsByName?: Record<string, { foodPoints?: number; saturation?: number }>;
	blockLoot?: Record<string, LootEntry>;
	entityLoot?: Record<string, LootEntry>;
	entitiesByName?: Record<string, { type?: string; category?: string }>;
	recipes?: Record<string, RawRecipe[]>;
}

/** 工具类型/材质表：只覆盖原版工具命名，不匹配就如实 null。 */
const TOOL_TYPES = ["pickaxe", "axe", "shovel", "hoe", "sword"] as const;
const TOOL_TIERS = ["wooden", "stone", "iron", "golden", "diamond", "netherite"] as const;

function toolOf(item: ItemData): KnowledgeItem["tool"] {
	if (typeof item.maxDurability !== "number") return null;
	const type = TOOL_TYPES.find((t) => item.name.endsWith(`_${t}`));
	if (type == null) return null;
	const tier = TOOL_TIERS.find((t) => item.name.startsWith(`${t}_`)) ?? null;
	return { type, tier, durability: item.maxDurability };
}

function stripNamespace(name: string): string {
	return name.replace(/^minecraft:/, "");
}

/** 普通挖掘（非精准采集）的掉落条目；概率掉落保留在列表里，不折算成概率。 */
function normalDrops(entry: LootEntry): string[] {
	const out: string[] = [];
	for (const drop of entry.drops) {
		if (drop.silkTouch === true) continue;
		const name = stripNamespace(drop.item);
		if (!out.includes(name)) out.push(name);
	}
	return out;
}

export function buildRegistryKnowledge(registry: RegistryLike): RegistryKnowledge {
	const version = registry.version?.minecraftVersion ?? "unknown";
	const itemsById = registry.items ?? Object.fromEntries(Object.values(registry.itemsByName).map((i) => [i.id, i]));

	// 反向索引：物品 → 配方 / 方块掉落 / 实体掉落（构建一次，查询期只读）。
	const recipesByOutput = new Map<string, KnowledgeRecipe[]>();
	const blocksByDrop = new Map<string, { block: string; requiredTool: string | null }[]>();
	const entitiesByDrop = new Map<string, string[]>();

	const requiredToolOf = (block: BlockData): string | null => {
		const tools = block.harvestTools;
		if (tools == null) return null;
		const ids = Object.keys(tools)
			.map((id) => Number(id))
			.filter((id) => Number.isFinite(id))
			.sort((a, b) => a - b);
		const weakest = ids.length > 0 ? itemsById[ids[0]] : undefined;
		return weakest == null ? null : stripNamespace(weakest.name);
	};

	for (const [idText, recipes] of Object.entries(registry.recipes ?? {})) {
		const outputId = Number(idText);
		const outputItem = itemsById[outputId];
		if (outputItem == null) continue;
		const shaped: KnowledgeRecipe[] = [];
		for (const recipe of recipes) {
			if (recipe.result == null || recipe.result.count <= 0) continue;
			const ingredients = new Map<string, number>();
			const add = (cell: number | null) => {
				if (cell == null || cell < 0) return;
				const item = itemsById[cell];
				if (item == null) return;
				const name = stripNamespace(item.name);
				ingredients.set(name, (ingredients.get(name) ?? 0) + 1);
			};
			if (recipe.inShape != null) for (const row of recipe.inShape) for (const cell of row) add(cell);
			if (recipe.ingredients != null) for (const cell of recipe.ingredients) add(cell);
			if (ingredients.size === 0) continue;
			const rows = recipe.inShape?.length ?? 1;
			const cols = recipe.inShape != null ? Math.max(...recipe.inShape.map((r) => r.length)) : 1;
			const station = rows > 2 || cols > 2 || ingredients.size > 4 ? "crafting_table" : "hand";
			const normalised = [...ingredients.entries()]
				.map(([item, count]) => ({ item, count }))
				.sort((a, b) => a.item.localeCompare(b.item));
			// 同料同产物的镜像/变体只保留一份（避免 plan 里重复计数）。
			const key = `${station}|${normalised.map((i) => `${i.item}x${i.count}`).join(",")}`;
			if (shaped.some((r) => signatureOf(r) === key)) continue;
			shaped.push({
				station,
				ingredients: normalised,
				output: { item: stripNamespace(outputItem.name), count: recipe.result.count },
			});
		}
		if (shaped.length > 0) recipesByOutput.set(stripNamespace(outputItem.name), shaped);
	}

	for (const [blockName, entry] of Object.entries(registry.blockLoot ?? {})) {
		const block = stripNamespace(entry.block ?? blockName);
		const requiredTool = requiredToolOf(registry.blocksByName[block] ?? { id: -1, name: block });
		for (const item of normalDrops(entry)) {
			const list = blocksByDrop.get(item) ?? [];
			list.push({ block, requiredTool });
			blocksByDrop.set(item, list);
		}
	}

	for (const [entityName, entry] of Object.entries(registry.entityLoot ?? {})) {
		const entity = stripNamespace(entry.entity ?? entityName);
		for (const item of normalDrops(entry)) {
			const list = entitiesByDrop.get(item) ?? [];
			list.push(entity);
			entitiesByDrop.set(item, list);
		}
	}

	// 类别覆盖：本数据集有合成/方块/实体，缺熔炼与交易。
	const categoriesComplete = false;

	const itemCache = new Map<string, KnowledgeItem | null>();

	const itemOf = (rawName: string): KnowledgeItem | null => {
		const name = stripNamespace(rawName);
		const cached = itemCache.get(name);
		if (cached !== undefined) return cached;
		const data = registry.itemsByName[name];
		if (data == null) {
			itemCache.set(name, null);
			return null;
		}
		const sources: ItemSource[] = [];
		if (recipesByOutput.has(name)) sources.push({ kind: "craft" });
		for (const dropped of entitiesByDrop.get(name) ?? []) sources.push({ kind: "entity", entity: dropped });
		for (const block of blocksByDrop.get(name) ?? []) {
			sources.push({ kind: "block", block: block.block, requiredTool: block.requiredTool });
		}
		const block = registry.blocksByName[name];
		const food = registry.foodsByName?.[name];
		const value: KnowledgeItem = {
			name,
			displayName: data.displayName ?? name,
			stackSize: data.stackSize ?? 64,
			placeAs: block != null ? stripNamespace(block.name) : null,
			tool: toolOf(data),
			food: food?.foodPoints != null ? { hunger: food.foodPoints, saturation: food.saturation ?? 0 } : null,
			fuel: null,
			sources,
			sourcesComplete: categoriesComplete,
		};
		itemCache.set(name, value);
		return value;
	};

	return {
		dataVersion: version,
		item: itemOf,
		recipesFor: (name) => recipesByOutput.get(stripNamespace(name)) ?? [],
		blockDrops: (blockName): KnowledgeBlockDrops | null => {
			const name = stripNamespace(blockName);
			const entry = registry.blockLoot?.[name];
			if (entry == null) return null;
			return {
				items: normalDrops(entry),
				requiredTool: requiredToolOf(registry.blocksByName[name] ?? { id: -1, name }),
			};
		},
		canonicalItemName: (name) => {
			const stripped = stripNamespace(name);
			return registry.itemsByName[stripped] != null ? stripped : null;
		},
		entityKind: (name) => {
			const stripped = stripNamespace(name);
			if (stripped === "player") return "player";
			const entity = registry.entitiesByName?.[stripped];
			if (entity == null) return null;
			const category = entity.category ?? "";
			if (entity.type === "hostile" || /hostile/i.test(category)) return "hostile";
			if (/passive|animal|ambient|water|tameable/i.test(category) || entity.type === "animal") return "passive";
			return "other";
		},
	};
}

function signatureOf(recipe: KnowledgeRecipe): string {
	return `${recipe.station}|${recipe.ingredients.map((i) => `${i.item}x${i.count}`).join(",")}`;
}
