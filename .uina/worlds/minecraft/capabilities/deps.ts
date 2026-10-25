/**
 * 能力层装配依赖：组合根注入，能力不自己找全局。
 *
 * runtime 用 getter 是因为 Runtime 的 open 是两段式：能力表在 open 前构建，
 * 受理只会发生在 open 之后（与 I1 相同的注入形状）。
 */

import type { GotoDirector } from "../driver/goto.js";
import type { RegistryKnowledge } from "../contracts/knowledge.js";
import type { CapabilityRuntime } from "./shared/runtime.js";

export interface CapabilityDeps {
	runtime: () => CapabilityRuntime;
	gotoDirector: GotoDirector;
	/** 静态知识：未连接时为 null（item/recipe 明确失败，不返回空表冒充）。 */
	knowledge: () => RegistryKnowledge | null;
}
