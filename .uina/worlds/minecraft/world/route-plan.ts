/**
 * route.plan@1 试算的观察成形：World 只负责把计划端口的结果包成 Observation。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 route.plan、public-api §5。
 * 计划是试算结果，不是任何存储/采样源的观察：source=derived、cursor=null、不可等待；
 * 要盯路况就等 block@1/blocks@1 的观察版本。输入校验与目标换算归计划端口实现
 * （组合根用 Driver 受控寻路装配），本文件不做第二套校验。
 */

import type { Observation } from "../contracts/values.js";
import type { RoutePlanResult } from "../contracts/world.js";

export const ROUTE_PLAN_REF = "route.plan@1";

export function routePlanObservation<T>(result: RoutePlanResult): Observation<T> {
	return {
		value: result as T,
		observedAt: new Date().toISOString(),
		source: "derived",
		coverage: "complete",
		unknown: [],
		evidence: [],
		cursor: null,
	};
}
