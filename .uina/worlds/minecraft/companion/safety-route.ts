import type { SafetyInterventionRecord } from "../contracts/runtime.js";
import type { SafetyCause } from "../runtime/safety.js";

/** 结算过的终态；`null` 表示还没结算，此时谈不上"要不要说"。 */
type SafetyEnding = Exclude<SafetyInterventionRecord["ended"], null>;

/**
 * 这条安全干预的终态要不要单独说一句。
 *
 * 只有两种情况不必说：世界自己关门（cancelled，模型也要走了），以及连接变了导致的失效
 * （connection / death 事实已经承担同一件事）。
 *
 * 其余都必须说，包括 invalidated 但起因不是连接的——抢占失败、会话关闭出错、崩溃恢复
 * 留下的未结算记录。它们意味着"危险触发了、脱险没跑成"，而且没有任何别的事实替它说。
 * 用终态值推断"有没有被覆盖"是错的，覆盖关系只有起因知道。
 */
export function safetyNeedsAttention(ended: SafetyEnding, cause: SafetyCause | null): boolean {
	if (ended === "cancelled") return false;
	if (ended === "invalidated" && cause === "connection") return false;
	return true;
}
