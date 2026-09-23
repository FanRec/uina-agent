import type { Model, ThinkingLevel } from "./types.js";

export const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_384;

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
	model: Pick<Model, "contextWindow" | "maxOutputTokens" | "thinkingBudgets">,
	thinkingLevel?: ThinkingLevel,
): number | undefined {
	if (model.contextWindow === undefined) return undefined;
	const declaredThinking = thinkingLevel && thinkingLevel !== "off"
		? model.thinkingBudgets?.[thinkingLevel]
		: undefined;
	const fallback = Math.min(DEFAULT_OUTPUT_RESERVE_TOKENS, Math.floor(model.contextWindow / 2));
	const reserved = model.maxOutputTokens ?? declaredThinking ?? fallback;
	return Math.max(0, model.contextWindow - Math.min(model.contextWindow, reserved));
}
