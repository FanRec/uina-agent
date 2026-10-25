/**
 * 静态游戏知识：版本数据里的物品、掉落与配方（item@1 / recipe@1 / mine / eat 共用）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4.2、modules/capabilities.md §3。
 * 知识随连接版本固定，不是观察事实：没有 observedAt/水位，也不随世界变化。
 * 缺失数据必须如实表达（sourcesComplete / null），不得用空数组冒充"无法获得"。
 */

export type ItemSource =
	| { kind: "craft" }
	| { kind: "smelt" }
	| { kind: "block"; block: string; requiredTool: string | null }
	| { kind: "entity"; entity: string }
	| { kind: "trade"; profession: string | null };

export interface KnowledgeItem {
	name: string;
	displayName: string;
	stackSize: number;
	/** 该物品放下后对应的方块名；不是方块时为 null。 */
	placeAs: string | null;
	/** 工具数据只在物品确实带耐久时给出；tier 来自声明表，未知为 null。 */
	tool: { type: string; tier: string | null; durability: number } | null;
	food: { hunger: number; saturation: number } | null;
	/** 燃料燃烧刻数；当前版本数据未提供时为 null。 */
	fuel: { ticks: number } | null;
	sources: ItemSource[];
	/** false 表示数据源缺少掉落/交易等类别，sources 不完整（不等于无法获得）。 */
	sourcesComplete: boolean;
}

export interface KnowledgeRecipe {
	station: "hand" | "crafting_table" | "furnace";
	ingredients: { item: string; count: number }[];
	output: { item: string; count: number };
	fuel?: { item: string; count: number };
}

/** 方块掉落：items 是可能产出（概率掉落也在此列），requiredTool 为最低工具名。 */
export interface KnowledgeBlockDrops {
	items: string[];
	requiredTool: string | null;
}

/**
 * RegistryKnowledge 由 Driver 用当前连接版本的游戏数据构建；
 * 组合根把它注入能力层，能力层不直接接触 mineflayer 注册表。
 */
export interface RegistryKnowledge {
	/** 实际采用的数据版本（如 1.21.11）。 */
	dataVersion: string;
	item(name: string): KnowledgeItem | null;
	/** 产出该物品的配方；当前数据只含工作台/手持合成，熔炼为空。 */
	recipesFor(item: string): KnowledgeRecipe[];
	blockDrops(block: string): KnowledgeBlockDrops | null;
	/** 已知物品名（用于把输入名规范成注册表名字，保留命名空间前缀容忍）。 */
	canonicalItemName(name: string): string | null;
	/** 实体分类（hostile/passive/player/other）；未知实体返回 null。 */
	entityKind(name: string): "hostile" | "passive" | "player" | "other" | null;
}
