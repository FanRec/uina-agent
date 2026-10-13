import type { ToolExecutionResult } from "../../tools/broker.js";

export type WorldEffectStatus = "accepted" | "applied" | "simulated" | "unknown" | "not_started";

/** succeeded 结果允许的外部效果值。unknown 归 worldUnknown，not_started 归框架层，禁止与 succeeded 组合。 */
export type WorldAppliedEffect = Exclude<WorldEffectStatus, "unknown" | "not_started">;

/** 把结构化标记以统一 [k=v] 形式追加到模型可见文本；同一事实同时写入 details 供程序消费。 */
function tagged(result: string, tags: string[]): string {
	return tags.length ? `${result} [${tags.join(" ")}]` : result;
}

export function worldSucceeded(
	result: string,
	details?: Record<string, unknown>,
	effect?: WorldAppliedEffect,
): ToolExecutionResult {
	const tags: string[] = [];
	if (effect) tags.push(`effect=${effect}`);
	if (typeof details?.verify === "string") tags.push(`verify=${details.verify}`);
	return {
		result: tagged(result, tags),
		status: "succeeded",
		...(details || effect ? { details: { ...(details ?? {}), ...(effect ? { effectStatus: effect } : {}) } } : {}),
	};
}

export function worldFailed(result: string, details?: Record<string, unknown>): ToolExecutionResult {
	const tags: string[] = [];
	if (typeof details?.reason === "string") tags.push(`reason=${details.reason}`);
	return { result: tagged(result, tags), status: "failed", ...(details ? { details } : {}) };
}

export function worldUnknown(result: string, details?: Record<string, unknown>): ToolExecutionResult {
	const tags: string[] = [];
	if (typeof details?.verify === "string") tags.push(`verify=${details.verify}`);
	return { result: tagged(result, tags), status: "unknown", ...(details ? { details } : {}) };
}

export function worldCancelled(result: string, details?: Record<string, unknown>): ToolExecutionResult {
	return { result, status: "cancelled", ...(details ? { details } : {}) };
}

export function worldNotStarted(result: string, details?: Record<string, unknown>): ToolExecutionResult {
	return { result, status: "not_started", ...(details ? { details } : {}) };
}
