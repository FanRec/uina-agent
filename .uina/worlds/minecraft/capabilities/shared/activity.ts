/**
 * K8 实体交互的纯决策面（批 18）：床名、夜间判定、可骑实体与转向能力。
 *
 * 事实依据（2026-11-01 真服探针 + mineflayer bed.js/fishing.js 口径）：
 * - 夜间 = ticks ∈ [12541, 23458]（bed.js 同源；雷暴白天可睡是协议上限，见偏差登记）。
 * - 上车证据 = set_passengers；拴绳证据 = attach_entity（vehicleId<=0 = 解除）。
 * - 船 = 客户端权威（vehicle_move）；minecart 不可转向；pig/strider 需手持胡萝卜钓竿/诡异菌。
 */

/** 全部床方块名（16 色 + 旧版 bed；bed.js 同表）。 */
export const BED_NAMES: readonly string[] = [
	"white_bed",
	"orange_bed",
	"magenta_bed",
	"light_blue_bed",
	"yellow_bed",
	"lime_bed",
	"pink_bed",
	"gray_bed",
	"light_gray_bed",
	"cyan_bed",
	"purple_bed",
	"blue_bed",
	"brown_bed",
	"green_bed",
	"red_bed",
	"black_bed",
	"bed",
];

export const isBedName = (name: string): boolean => BED_NAMES.includes(name);

/** 服务端夜间窗口（bed.js 口径）：只在此区间入睡成功。 */
export const NIGHT_TICKS_MIN = 12541;
export const NIGHT_TICKS_MAX = 23458;
export const isNightTicks = (ticks: number): boolean => ticks >= NIGHT_TICKS_MIN && ticks <= NIGHT_TICKS_MAX;

/** 服务端把时间跳回白天后的上限刻数（睡到天亮的提前退出判据）。 */
export const DAY_TICKS_MAX = 12000;

/** 服务端拒绝入睡时"附近有怪"的水平判定半径（bed.js monsterRange 折算）。 */
export const SLEEP_MONSTER_RADIUS = 9;

/** 可骑实体判定：船按材质展开成 *_boat/*_raft，矿车一族，马族，猪/骆驼/炽足兽。 */
export function isMountName(name: string): boolean {
	if (name.endsWith("_boat") || name.endsWith("_raft") || name === "boat") return true;
	if (name.includes("minecart")) return true;
	if (name === "horse" || name === "donkey" || name === "mule" || name === "skeleton_horse" || name === "zombie_horse")
		return true;
	return name === "pig" || name === "strider" || name === "camel";
}

/**
 * 转向能力：minecart 不可转向（to 给定 → WRONG_STATE）；
 * pig/strider 可"骑"但转向依赖手持专属物品，未持有时原地不动（驾驶停滞如实 UNREACHABLE）。
 */
export function isSteerableMount(name: string): boolean {
	if (name.includes("minecart")) return false;
	return isMountName(name);
}

/** 拴绳链接的解除判据：attach_entity 的 vehicleId<=0（1.21.11 实测释放发 0，不是 -1）。 */
export const isDetachedLink = (vehicleId: number): boolean => vehicleId <= 0;

/**
 * 可系拴绳结的方块（原版只认普通栅栏，墙/栅栏门都不行）。
 * blocks@1 单名限制下按这份清单并查；tie@lead 用。
 */
export const FENCE_NAMES: readonly string[] = [
	"oak_fence",
	"spruce_fence",
	"birch_fence",
	"jungle_fence",
	"acacia_fence",
	"dark_oak_fence",
	"mangrove_fence",
	"cherry_fence",
	"pale_oak_fence",
	"bamboo_fence",
	"crimson_fence",
	"warped_fence",
	"nether_brick_fence",
];
