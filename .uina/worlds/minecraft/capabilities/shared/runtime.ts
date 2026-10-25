/**
 * 能力层使用的 Runtime 接缝（结构最小面；组合根注入 MinecraftRuntime）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §7.1。
 * 能力只经这两个入口取得控制归属与 chat 旁路，不持有引擎对象。
 */

import type { ControlOwner } from "../../contracts/body.js";
import type { EffectReceipt } from "../../contracts/values.js";

export interface CapabilityRuntime {
	/** chat 旁路（不占 Body）；必须在活动调用 frame 内使用。 */
	chat(text: string, signal: AbortSignal): Promise<EffectReceipt>;
	/** 受控独占导航作用域；独占期内效果事实归属给定 owner。 */
	navigate<T>(owner: ControlOwner, fn: () => Promise<T>): Promise<T>;
}
