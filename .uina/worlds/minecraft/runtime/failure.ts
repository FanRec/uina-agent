/**
 * 未知抛出 → CallFailure 归一（runtime 与身体队列共用）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/runtime.md §5.6（五态与失败归因）。
 * 只做形状归一，不猜语义：非 CallFailure 的抛出按 INTERNAL/not_sent 处理，
 * 不把实现 bug 伪装成环境或输入错误。
 */

import type { CallFailure } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";

export function isCallFailure(err: unknown): err is CallFailure {
	return (
		err instanceof Error && (err as CallFailure).name === "CallFailure" && typeof (err as CallFailure).code === "string"
	);
}

export function toCallFailure(err: unknown): CallFailure {
	if (isCallFailure(err)) return err;
	return callFailure({
		code: "INTERNAL",
		source: "capability",
		message: err instanceof Error ? err.message : String(err),
		dispatch: "not_sent",
		effects: [],
		recoverable: false,
	});
}
