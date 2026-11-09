/**
 * 静态游戏知识：由当前连接的注册表构建 RegistryKnowledge（contracts/knowledge.ts）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4.2、modules/capabilities.md §3 item/recipe。
 * 数据来源两处，边界清楚：
 * - 合成配方、方块/实体掉落、物品属性来自 minecraft-data（经 prismarine-registry）；
 * - 熔炼配方与燃料刻数来自 smelting.ts（Paper 1.21.11 jar 抽取 + 手工燃料表），
 *   因为 minecraft-data 的 PC 数据没有 smelting/燃料字段。
 * 不做网络补全、不猜掉落率：
 * - 方块掉落只取"普通挖掘"条目（silkTouch!==true），harvest 保留 harvestTools 的实际成员；
 * - 缺失的来源类别用 sourcesComplete=false 如实表达；燃料表未收录的保持 null 而不是 0。
 */

import type {
	HarvestRequirement,
	ItemSource,
	KnowledgeBlockDrops,
	KnowledgeItem,
	KnowledgeRecipe,
	RegistryKnowledge,
} from "../../contracts/knowledge.js";
import { itemName as stripNamespace } from "../../contracts/items.js";
import { FUEL_TICKS, SMELTING } from "./smelting.js";

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
	/** 附魔注册表（prismarine-registry 已从 minecraft-data 载入）；线上组件只给编号。 */
	enchantmentsArray?: { id: number; name: string; displayName?: string; maxLevel?: number }[];
}

/** 工具类型/材质表：只覆盖原版工具命名，不匹配就如实 null。 */
const TOOL_TYPES = ["pickaxe", "axe", "shovel", "hoe", "sword"] as const;
const TOOL_TIERS = ["wooden", "copper", "stone", "iron", "golden", "diamond", "netherite"] as const;

function toolOf(item: ItemData): KnowledgeItem["tool"] {
	if (typeof item.maxDurability !== "number") return null;
	const type = TOOL_TYPES.find((t) => item.name.endsWith(`_${t}`));
	if (type == null) return null;
	const tier = TOOL_TIERS.find((t) => item.name.startsWith(`${t}_`)) ?? null;
	return { type, tier, durability: item.maxDurability };
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
	const blocksByDrop = new Map<string, { block: string; harvest: HarvestRequirement }[]>();
	const entitiesByDrop = new Map<string, string[]>();

	const harvestOf = (block: BlockData | undefined): HarvestRequirement => {
		if (block == null) return { kind: "unknown" };
		if (block.harvestTools == null) return { kind: "any" };
		const ids = Object.entries(block.harvestTools).filter(([, allowed]) => allowed);
		const names = ids.map(([id]) => itemsById[Number(id)]?.name);
		if (names.some((name) => name == null)) return { kind: "unknown" };
		return { kind: "tools", names: (names as string[]).map(stripNamespace) };
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
			const rows = recipe.inShape != null && recipe.inShape.length > 0 ? recipe.inShape : null;
			if (rows != null) for (const row of rows) for (const cell of row) add(cell);
			if (recipe.ingredients != null) for (const cell of recipe.ingredients) add(cell);
			if (ingredients.size === 0) continue;
			// 图案必须保留：craft@1 靠它摆 3×3；空格是 null，不是缺项。
			const pattern = rows?.map((row) =>
				row.map((cell) =>
					cell == null || cell < 0 ? null : itemsById[cell] ? stripNamespace(itemsById[cell].name) : null,
				),
			);
			const cells =
				rows != null
					? rows.reduce((sum, row) => sum + row.filter((cell) => cell != null && cell >= 0).length, 0)
					: (recipe.ingredients?.length ?? 0);
			const cols = rows != null ? Math.max(...rows.map((row) => row.length)) : 1;
			// 判据是实际非空格数，不是"物品种类数"：9 个同种材料的 shapeless 一样要工作台。
			const station =
				rows != null && (rows.length > 2 || cols > 2) ? "crafting_table" : cells > 4 ? "crafting_table" : "hand";
			const normalised = [...ingredients.entries()]
				.map(([item, count]) => ({ item, count }))
				.sort((a, b) => a.item.localeCompare(b.item));
			const candidate: KnowledgeRecipe = {
				station,
				ingredients: normalised,
				output: { item: stripNamespace(outputItem.name), count: recipe.result.count },
				...(pattern == null ? {} : { pattern }),
			};
			// 完全相同的配方只留一份（真实数据没有重复，这里防止 plan 重复计数）。
			const key = signatureOf(candidate);
			if (shaped.some((r) => signatureOf(r) === key)) continue;
			shaped.push(candidate);
		}
		if (shaped.length > 0) recipesByOutput.set(stripNamespace(outputItem.name), shaped);
	}

	// 熔炼：一条 smelting 配方可能有多个可替代原料，按"每个原料一条配方"展开，
	// 让 ingredients 始终是真正的账单（而不是"任选其一"被误读成"全都要"）。
	for (const row of SMELTING) {
		for (const input of row.inputs) {
			const list = recipesByOutput.get(row.output) ?? [];
			list.push({
				station: "furnace",
				ingredients: [{ item: input, count: 1 }],
				output: { item: row.output, count: row.count },
				cookTicks: row.ticks,
			});
			recipesByOutput.set(row.output, list);
		}
	}

	for (const [blockName, entry] of Object.entries(registry.blockLoot ?? {})) {
		const block = stripNamespace(entry.block ?? blockName);
		const harvest = harvestOf(registry.blocksByName[block]);
		for (const item of normalDrops(entry)) {
			const list = blocksByDrop.get(item) ?? [];
			list.push({ block, harvest });
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

	// 类别覆盖：合成/熔炼/方块/实体都有，缺交易。
	const categoriesComplete = false;

	const enchantmentsById = new Map<number, { name: string; maxLevel: number }>();
	for (const entry of registry.enchantmentsArray ?? []) {
		enchantmentsById.set(entry.id, { name: stripNamespace(entry.name), maxLevel: entry.maxLevel ?? 1 });
	}

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
		const recipes = recipesByOutput.get(name) ?? [];
		if (recipes.some((recipe) => recipe.station !== "furnace")) sources.push({ kind: "craft" });
		if (recipes.some((recipe) => recipe.station === "furnace")) sources.push({ kind: "smelt" });
		for (const dropped of entitiesByDrop.get(name) ?? []) sources.push({ kind: "entity", entity: dropped });
		for (const block of blocksByDrop.get(name) ?? []) {
			sources.push({ kind: "block", block: block.block, harvest: block.harvest });
		}
		const block = registry.blocksByName[name];
		const food = registry.foodsByName?.[name];
		const fuelTicks = FUEL_TICKS[name];
		const value: KnowledgeItem = {
			name,
			displayName: data.displayName ?? name,
			stackSize: data.stackSize ?? 64,
			placeAs: block != null ? stripNamespace(block.name) : null,
			tool: toolOf(data),
			food: food?.foodPoints != null ? { hunger: food.foodPoints, saturation: food.saturation ?? 0 } : null,
			fuel: typeof fuelTicks === "number" ? { ticks: fuelTicks } : null,
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
				harvest: harvestOf(registry.blocksByName[name]),
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
			// villagers/动物在数据里的 category 常是 UNKNOWN，靠 type 判：漏掉这一支会让
			// entities@1 {kind:"passive"} 看不见村民（trade 的无目标路径就找不到商人）。
			if (
				entity.type === "passive" ||
				entity.type === "animal" ||
				/passive|animal|ambient|water|tameable/i.test(category)
			)
				return "passive";
			return "other";
		},
		enchantment: (id) => enchantmentsById.get(id) ?? null,
	};
}

function signatureOf(recipe: KnowledgeRecipe): string {
	const pattern = recipe.pattern?.map((row) => row.map((cell) => cell ?? ".").join(",")).join("|") ?? "";
	return `${recipe.station}|${pattern}|${recipe.ingredients.map((i) => `${i.item}x${i.count}`).join(",")}|${recipe.output.item}x${recipe.output.count}`;
}
