/**
 * 能力层失败收口的唯一实现。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §7.1（CallFailure）；
 * 反复口径不一的清理见 archive/review-2026-11-09-quality.md。
 *
 * 只做两件事：把已发生的领域进度并进 CallFailure；在确有派发证据时把
 * `not_sent` 升级为 `sent`。`dispatched` 必须由调用方从真实派发事实给出，
 * 不能用"进入了 catch"推断——谎报 sent 会让恢复侧以为服务端可能已执行。
 */

import type { CallFailure, JsonValue } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";

export interface FailureSettlement {
	/** 本动作是否已经真的派发过业务写；决定 not_sent 能否升级为 sent。 */
	dispatched: boolean;
	/** 已发生的领域进度；与 CallFailure 原有的 progress 合并，不覆盖。 */
	progress: Record<string, JsonValue>;
}

/** 收口后原样抛出；非 CallFailure 不做任何改写。 */
export function settleFailure(error: unknown, settlement: FailureSettlement): never {
	if (error instanceof Error && error.name === "CallFailure") {
		const failure = error as CallFailure;
		if (settlement.dispatched && failure.dispatch === "not_sent") failure.dispatch = "sent";
		failure.progress = plain({ ...failure.progress, ...settlement.progress }) as CallFailure["progress"];
	}
	throw error;
}
