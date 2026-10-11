import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import type { SomaticActionResult } from "./director/director.js";

/**
 * 工具结果词汇表（P4-1，边界规范 §2.1，normative）。
 *
 * - status 恒为 ToolResultStatus 五值（src/core/types.ts 单一事实）；
 * - details.effectStatus：not_started / applied / accepted / cancelled / unknown；
 * - details.verification：local_intent（仅本地意图生效）/ input_accepted（VTS 已接受注入帧）。
 *   **严禁**出现"画面已确认"级声称——画面确认只存在于作者验收记录（§7）。
 */

export type EffectStatus = "not_started" | "applied" | "accepted" | "cancelled" | "unknown";
export type Verification = "local_intent" | "input_accepted";

/** 拒绝原因词表（§2.1 表格，normative）。 */
export type RejectReason =
	| "cancelled"
	| "paused"
	| "model_not_ready"
	| "unadapted"
	| "draft"
	| "external_source"
	| "invalid_motion"
	| "invalid_duration"
	| "invalid_preview"
	| "unknown_pose"
	| "unknown_expression"
	| "unknown_attention"
	| "unknown_costume"
	| "unknown_motion"
	| "resource_conflict"
	| "hotkey_missing"
	| "author_session_required";

export const EFFECT_STATUSES: readonly EffectStatus[] = ["not_started", "applied", "accepted", "cancelled", "unknown"];
export const VERIFICATIONS: readonly Verification[] = ["local_intent", "input_accepted"];

const succeeded = (result: string, details?: { effectStatus?: EffectStatus; verification?: Verification; [key: string]: unknown }): ToolExecutionResult => ({
	result,
	status: "succeeded",
	...(details ? { details } : {}),
});

/** rejected：除 cancelled 走 cancelled 状态外，其余拒绝一律 failed（§2.1：拒绝不是 unknown——事实明确）。 */
const rejected = (reason: RejectReason, message: string, extra?: Record<string, unknown>): ToolExecutionResult => ({
	result: message,
	status: reason === "cancelled" ? ("cancelled" as const) : ("failed" as const),
	details: { reason, effectStatus: "not_started" satisfies EffectStatus as EffectStatus, ...extra },
});

const unknownOutcome = (message: string, extra?: Record<string, unknown>): ToolExecutionResult => ({
	result: message,
	status: "unknown",
	details: { effectStatus: "unknown" satisfies EffectStatus as EffectStatus, ...extra },
});

/**
 * 引擎动作终态 → 工具结果（§2.1 映射，normative）：
 * completed → succeeded；cancelled → cancelled；failed(disconnected) → unknown（网络中断，效果不明）；
 * unsupported → failed（模型缺必需物理通道，属稳定事实）。
 */
export const fromEngineResult = (engine: SomaticActionResult, label: string): ToolExecutionResult => {
	switch (engine.status) {
		case "completed":
			return succeeded(`${label}已完成。`, { effectStatus: "applied", verification: "input_accepted" });
		case "cancelled":
			return {
				result: `${label}已取消${engine.reason ? `（${engine.reason}）` : ""}。`,
				status: "cancelled",
				details: { effectStatus: "cancelled" satisfies EffectStatus as EffectStatus },
			};
		case "failed":
			return engine.reason === "disconnected"
				? unknownOutcome(`${label}因连接中断结果不明。`, { reason: "disconnected" })
				: {
						result: `${label}失败：${engine.reason ?? "未知原因"}。`,
						status: "failed" as const,
						details: { effectStatus: "unknown" satisfies EffectStatus as EffectStatus, engineReason: engine.reason },
					};
	}
};

export { succeeded as toolSucceeded, rejected as toolRejected, unknownOutcome as toolUnknown };
