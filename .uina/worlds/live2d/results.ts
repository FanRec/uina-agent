import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import type { SomaticActionResult } from "./director/director.js";
import type { MotionInjectionEvidence } from "./adapter/vts-client.js";

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

/** 拒绝原因词表（§2.1 表格，normative）。
 *  分类规则：调用方格式错误（缺参/类型错）→ invalid_*；环境/词表事实不满足 → unknown_* / 专属词。 */
export type RejectReason =
	| "cancelled"
 | "unknown_cue"
 | "effect_baseline_unavailable"
	| "paused"
	| "model_not_ready"
	| "unadapted"
	| "external_source"
	| "invalid_params"
	| "invalid_duration"
	| "invalid_motion"
	| "preset_missing"
	| "unknown_pose"
	| "unknown_expression"
	| "unknown_attention"
	| "unknown_costume"
	| "unknown_motion"
	| "unknown_ambient"
	| "resource_conflict"
	| "hotkey_missing"
	| "unfocused";

export const EFFECT_STATUSES: readonly EffectStatus[] = ["not_started", "applied", "accepted", "cancelled", "unknown"];
export const VERIFICATIONS: readonly Verification[] = ["local_intent", "input_accepted"];

export function toolSucceeded(
	result: string,
	details?: { effectStatus?: EffectStatus; verification?: Verification; [key: string]: unknown },
): ToolExecutionResult {
	return {
		result,
		status: "succeeded",
		...(details ? { details } : {}),
	};
}

/** rejected：除 cancelled 走 cancelled 状态外，其余拒绝一律 failed（§2.1：拒绝不是 unknown——事实明确）。 */
export function toolRejected(
	reason: RejectReason,
	message: string,
	extra?: Record<string, unknown>,
): ToolExecutionResult {
	return {
		result: message,
		status: reason === "cancelled" ? "cancelled" : "failed",
		details: { reason, effectStatus: "not_started", ...extra },
	};
}

export function toolUnknown(message: string, extra?: Record<string, unknown>): ToolExecutionResult {
	return {
		result: message,
		status: "unknown",
		details: { effectStatus: "unknown", ...extra },
	};
}

/**
 * 引擎动作终态 → 工具结果（§2.1 映射，normative）：
 * completed 仅在本次所需输入接受已确认时 succeeded，否则 unknown；cancelled → cancelled。
 * failed(disconnected) → unknown（网络中断，效果不明）。
 */
export function fromEngineResult(
	engine: SomaticActionResult,
	label: string,
	evidence?: MotionInjectionEvidence,
	requiredInputs: readonly string[] = [],
	callName?: string,
): ToolExecutionResult {
	switch (engine.status) {
		case "completed":
			if (!evidence?.accepted || requiredInputs.some((input) => !evidence.acceptedInputs.includes(input)))
				return toolUnknown(`${label}已播放，但状态未完整确认。`, { injection: evidence });
			// 成功回执回显调用名（不是作者描述）：闭环调用方自己的符号，语义由 details 承载。
			return toolSucceeded(`${callName ?? label} OK`, {
				effectStatus: "accepted",
				verification: "input_accepted",
				injection: evidence,
			});
		case "cancelled":
			return {
				result: `${label}已取消${engine.reason ? `（${engine.reason}）` : ""}。`,
				status: "cancelled",
				details: {
					effectStatus: "cancelled",
					...(engine.reason ? { reason: engine.reason } : {}),
				},
			};
		case "failed":
			if (engine.reason === "disconnected")
				return toolUnknown(`${label}因连接中断结果不明。`, { reason: "disconnected" });
			return {
				result: `${label}失败：${engine.reason ?? "未知原因"}。`,
				status: "failed",
				details: { effectStatus: "unknown", engineReason: engine.reason },
			};
	}
}
