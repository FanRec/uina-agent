/**
 * build.plan@1 的观察成形：World 只把施工计划端口的结果包成 Observation。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 build.plan、public-api §5。
 * 计划是派生结果，不是任何存储/采样源的观察：source=derived、cursor=null、不可等待
 * （§2.5：派生计算不能进 waitUntil，否则 World 要为任意派生结果的依赖变化建响应式图）。
 * 要盯现场变化就等 block@1/blocks@1/region@1 的观察版本。
 * 输入校验与目标解析归计划端口实现（组合根用 Construction 装配），本文件不做第二套校验。
 */

import type { Observation } from "../contracts/values.js";
import type { BuildPlanValue } from "../contracts/world.js";

export const BUILD_PLAN_REF = "build.plan@1";

export function buildPlanObservation<T>(plan: BuildPlanValue): Observation<T> {
	return {
		value: plan as T,
		observedAt: new Date().toISOString(),
		source: "derived",
		coverage: "complete",
		unknown: [],
		evidence: [],
		cursor: null,
	};
}
