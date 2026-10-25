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
};

export function isPlainContainer(type: string): boolean {
	return PLAIN_CONTAINER.test(type) || PLAIN_CONTAINER_EXTRA.has(type);
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
