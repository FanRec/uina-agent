/**
 * 窗口布局的唯一定义：窗口类型 → 槽位区域。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4.3 WindowSnapshot.layout。
 * 消费方两处，必须共用同一张表，否则点击的槽位语义会分叉：
 * - driver/mineflayer/protocol.ts 建立玩家库存快照（window 0）；
 * - driver/window/session.ts 建立打开中的窗口快照。
 *
 * 区域命名规则（能力层只能按名字取格，不能按索引猜）：
 * - 普通容器：container（全部业务槽）+ player（主背包 27 + 快捷栏 9）。
 * - 玩家窗口：result(0)、crafting(1..4)、armor(5..8)、player(9..44)、offhand(45)。
 * - 工作台：result(0)、crafting(1..9)、player(10..45)。
 * - 熔炉：input(0)、fuel(1)、result(2)、player(3..38)。
 * - 酿造台：bottle(0..2)、ingredient(3)、fuel(4)、player(5..40)。
 * - 附魔台：input(0)、lapis(1)、player(2..37)。
 * - 铁砧/砂轮/商人：input(0,1)、result(2)、player(3..38)。
 * 工作站窗口**不**产出 container 区域：把 input/fuel/result 当普通格搬会静默错位，
 * 因此让按 container 取格的调用方显式失败。
 */

export interface SlotRegion {
	name: string;
	slots: number[];
}

export interface WindowLayout {
	slotCount: number;
	regions: SlotRegion[];
}

const range = (start: number, count: number): number[] => Array.from({ length: count }, (_, i) => start + i);

/** 普通容器：业务槽数量随类型变化，玩家区恒为 36 格并紧接其后。 */
const PLAIN_CONTAINER = /^minecraft:generic_9x[1-6]$/;
const PLAIN_CONTAINER_EXTRA = new Set(["minecraft:generic_3x3", "minecraft:hopper", "minecraft:shulker_box"]);

/** 玩家窗口与工作站窗口的槽位数是协议常量，与方块名无关（工作台报 crafting，不是 crafting_table）。 */
const FIXED: Readonly<Record<string, WindowLayout>> = {
	"minecraft:inventory": {
		slotCount: 46,
		regions: [
			{ name: "result", slots: [0] },
			{ name: "crafting", slots: range(1, 4) },
			{ name: "armor", slots: range(5, 4) },
			{ name: "player", slots: range(9, 36) },
			{ name: "offhand", slots: [45] },
		],
	},
	"minecraft:crafting": {
		slotCount: 46,
		regions: [
			{ name: "result", slots: [0] },
			{ name: "crafting", slots: range(1, 9) },
			{ name: "player", slots: range(10, 36) },
		],
	},
	"minecraft:furnace": {
		slotCount: 39,
		regions: [
			{ name: "input", slots: [0] },
			{ name: "fuel", slots: [1] },
			{ name: "result", slots: [2] },
			{ name: "player", slots: range(3, 36) },
		],
	},
	// 酿造台：3 个药水槽 + 原料 + 燃料（烈焰粉），进度走 properties 0=酿造刻数、1=燃料。
	"minecraft:brewing_stand": {
		slotCount: 41,
		regions: [
			{ name: "bottle", slots: range(0, 3) },
			{ name: "ingredient", slots: [3] },
			{ name: "fuel", slots: [4] },
			{ name: "player", slots: range(5, 36) },
		],
	},
	// 附魔台：物品 + 青金石；三档等级要求走 properties 0..2（3 是随机种子，能力层不用）。
	"minecraft:enchantment": {
		slotCount: 38,
		regions: [
			{ name: "input", slots: [0] },
			{ name: "lapis", slots: [1] },
			{ name: "player", slots: range(2, 36) },
		],
	},
	// 铁砧/砂轮/商人三者的菜单形状相同：两个输入 + 一个结果。费用（铁砧）走 properties 0。
	"minecraft:anvil": {
		slotCount: 39,
		regions: [
			{ name: "input", slots: [0, 1] },
			{ name: "result", slots: [2] },
			{ name: "player", slots: range(3, 36) },
		],
	},
	"minecraft:grindstone": {
		slotCount: 39,
		regions: [
			{ name: "input", slots: [0, 1] },
			{ name: "result", slots: [2] },
			{ name: "player", slots: range(3, 36) },
		],
	},
	"minecraft:merchant": {
		slotCount: 39,
		regions: [
			{ name: "input", slots: [0, 1] },
			{ name: "result", slots: [2] },
			{ name: "player", slots: range(3, 36) },
		],
	},
};

export function isPlainContainer(type: string): boolean {
	return PLAIN_CONTAINER.test(type) || PLAIN_CONTAINER_EXTRA.has(type);
}

/**
 * 哪些方块真的会开出窗口（打开前的预检，避免对着石头白等 5 秒）。
 * 与下面的布局表同住一个文件：窗口类型与"能开出窗口的方块"是同一件事的两面。
 * 注意这不等于"是容器"——`container@1` 能开哪些是能力层自己的策略。
 */
const WINDOW_BLOCKS = new Set([
	"chest",
	"trapped_chest",
	"ender_chest",
	"barrel",
	"hopper",
	"dispenser",
	"dropper",
	"crafting_table",
	"furnace",
	"brewing_stand",
	"enchanting_table",
	"anvil",
	"chipped_anvil",
	"damaged_anvil",
	"grindstone",
]);

export function opensWindow(blockName: string): boolean {
	return WINDOW_BLOCKS.has(blockName) || /(?:^|_)shulker_box$/.test(blockName);
}

/** 固定布局（玩家窗口与工作站）；未知类型返回 null。 */
export function fixedLayout(type: string): WindowLayout | null {
	return FIXED[type] ?? null;
}

export type LayoutResult = { layout: WindowLayout } | { reason: string };

/**
 * 由原生窗口的实测槽数判定布局。不猜：固定表要求槽数精确匹配，
 * 普通容器要求"业务槽 + 36 玩家槽"的结构成立。
 */
export function windowLayout(
	type: string,
	slotCount: number,
	inventoryStart: number,
	inventoryEnd: number,
): LayoutResult {
	const fixed = fixedLayout(type);
	if (fixed != null) {
		if (slotCount !== fixed.slotCount) {
			return { reason: `window ${type} reports ${slotCount} slots, expected ${fixed.slotCount}` };
		}
		return { layout: fixed };
	}
	if (!isPlainContainer(type)) {
		return { reason: `window layout ${type} is not supported for container operations` };
	}
	if (inventoryStart <= 0 || inventoryEnd !== slotCount || slotCount - inventoryStart !== 36) {
		return { reason: "window does not expose a verified container plus 36-slot player layout" };
	}
	return {
		layout: {
			slotCount,
			regions: [
				{ name: "container", slots: range(0, inventoryStart) },
				{ name: "player", slots: range(inventoryStart, 36) },
			],
		},
	};
}
