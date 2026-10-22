import type { Model, ThinkingLevel } from "./types.js";

export const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_384;

/**
 * 默认输入预算上限。窗口再大也只先发这么多历史：
 * 每请求成本与首字节延迟都随输入线性增长，而大多数回合根本用不到窗口的一半。
 * 协议事实不变——这只是"一次发多少"，随时可由 provider 配置的 inputBudgetTokens 覆盖。
 */
export const DEFAULT_INPUT_BUDGET_TOKENS = 60_000;

/** Stable model identity used by requests, usage, settings and UI freshness. */
export function modelKey(model: Pick<Model, "providerId" | "id">): string {
	return `${model.providerId}/${model.id}`;
}

/**
 * Maximum model-input budget. Explicit output metadata wins; when it is
 * unknown we retain the existing conservative reserve without inventing a
 * provider-specific value.
 */
export function inputTokenBudget(
	model: Pick<Model, "contextWindow" | "maxOutputTokens" | "thinkingBudgets" | "inputBudgetTokens">,
	thinkingLevel?: ThinkingLevel,
): number | undefined {
	if (model.contextWindow === undefined) return undefined;
	const declaredThinking =
		thinkingLevel && thinkingLevel !== "off" ? model.thinkingBudgets?.[thinkingLevel] : undefined;
	const fallback = Math.min(DEFAULT_OUTPUT_RESERVE_TOKENS, Math.floor(model.contextWindow / 2));
	const reserved = model.maxOutputTokens ?? declaredThinking ?? fallback;
	const ceiling = Math.max(0, model.contextWindow - Math.min(model.contextWindow, reserved));
	const requested = model.inputBudgetTokens;
	if (requested === undefined) return Math.min(ceiling, DEFAULT_INPUT_BUDGET_TOKENS);
	if (requested <= 0) return ceiling;
	return Math.min(ceiling, requested);
}
