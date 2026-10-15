import type { MotionHandle } from "./director/director.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import type { SomaticActionResult } from "./director/director.js";
import type { MotionInjectionEvidence, VTSClient } from "./adapter/vts-client.js";

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
export type ActionReceiptOutcome = "OK" | "UNKNOWN" | "CANCELLED" | "FAILED";

/** Compact model-facing action receipt; structured evidence stays in details. */
export function actionReceipt(name: string, outcome: ActionReceiptOutcome, reason?: string): string {
	const suffix = reason && reason.toUpperCase() !== outcome ? `: ${reason}` : "";
	return `${name} ${outcome}${suffix}`;
}

/** 拒绝原因词表（§2.1 表格，normative）。
 *  分类规则：调用方格式错误（缺参/类型错）→ invalid_*；环境/词表事实不满足 → unknown_* / 专属词。 */
export type RejectReason =
	| "cancelled"
	| "fault"
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
	| "unfocused"
	| "engine_error";

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

/** not_started：世界尚未启动，动作未进入执行路径。 */
export function toolNotStarted(result: string, extra?: Record<string, unknown>): ToolExecutionResult {
	return {
		result,
		status: "not_started",
		details: { effectStatus: "not_started", ...extra },
	};
}

/**
 * 引擎动作终态 → 工具结果（§2.1 映射，normative）：
 * completed 仅在本次实际发出的注入输入全部接受已确认时 succeeded，否则 unknown；cancelled → cancelled。
 * 判据只核查 evidence.sentInputs——租约未驱动过的输入（如恒零通道绑定的输入）不要求确认。
 * failed(disconnected) → unknown（网络中断，效果不明）。
 */
export function fromEngineResult(
	engine: SomaticActionResult,
	motionName: string,
	evidence?: MotionInjectionEvidence,
): ToolExecutionResult {
	switch (engine.status) {
		case "completed":
			if (!evidence?.accepted || evidence.sentInputs.some((input) => !evidence.acceptedInputs.includes(input)))
				return toolUnknown(actionReceipt(motionName, "UNKNOWN", "input_unconfirmed"), {
					reason: "input_unconfirmed",
					injection: evidence,
				});
			return toolSucceeded(actionReceipt(motionName, "OK"), {
				effectStatus: "accepted",
				verification: "input_accepted",
				injection: evidence,
			});
		case "cancelled":
			return {
				result: actionReceipt(motionName, "CANCELLED", engine.reason),
				status: "cancelled",
				details: {
					effectStatus: "cancelled",
					...(engine.reason ? { reason: engine.reason } : {}),
				},
			};
		case "failed":
			if (engine.reason === "disconnected")
				return toolUnknown(actionReceipt(motionName, "UNKNOWN", "disconnected"), { reason: "disconnected" });
			return {
				result: actionReceipt(motionName, "FAILED", "engine_error"),
				status: "failed",
				details: { effectStatus: "unknown", reason: "engine_error", engineReason: engine.reason },
			};
	}
}

export function withCancellation<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const cleanup = () => signal.removeEventListener("abort", abort);
		const abort = () => {
			cleanup();
			reject(signal.reason);
		};
		request.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

export async function settleMotion(
	client: VTSClient,
	handle: MotionHandle,
	motionName: string,
): Promise<ToolExecutionResult> {
	const observation = client.observeMotionInjections(handle.id);
	try {
		const result = await handle.finished;
		const evidence = result.status === "completed" ? await observation.finish() : observation.snapshot();
		return fromEngineResult(result, motionName, evidence);
	} finally {
		observation.close();
	}
}
