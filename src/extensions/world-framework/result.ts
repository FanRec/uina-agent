import type { ToolExecutionResult } from "../../tools/broker.js";

export type WorldEffectStatus = "accepted" | "applied" | "simulated" | "unknown" | "not_started";

export function worldSucceeded(
	result: string,
	details?: Record<string, unknown>,
	effect?: WorldEffectStatus,
): ToolExecutionResult {
	const verify = typeof details?.verify === "string" ? ` verify=${details.verify}` : "";
	return {
		result: effect
			? `${result} [effect=${effect}${verify}]`
			: verify
				? `${result} [verify=${details!.verify}]`
				: result,
		status: "succeeded",
		...(details || effect ? { details: { ...(details ?? {}), ...(effect ? { effectStatus: effect } : {}) } } : {}),
	};
}

export function worldFailed(result: string, details?: Record<string, unknown>): ToolExecutionResult {
	const reason = typeof details?.reason === "string" ? ` [reason=${details.reason}]` : "";
	return { result: result + reason, status: "failed", ...(details ? { details } : {}) };
}

export function worldUnknown(result: string, details?: Record<string, unknown>): ToolExecutionResult {
	const verify = typeof details?.verify === "string" ? ` [verify=${details.verify}]` : "";
	return { result: result + verify, status: "unknown", ...(details ? { details } : {}) };
}

export function worldCancelled(result: string, details?: Record<string, unknown>): ToolExecutionResult {
	return { result, status: "cancelled", ...(details ? { details } : {}) };
}

export function worldNotStarted(result: string, details?: Record<string, unknown>): ToolExecutionResult {
	return { result, status: "not_started", ...(details ? { details } : {}) };
}
