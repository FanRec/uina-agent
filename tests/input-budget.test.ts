/**
 * 每请求输入预算的边界：默认上限 60k 只收窄、不放大窗口可用值；
 * inputBudgetTokens 显式覆盖，0 表示回到窗口上限。
 */

import { DEFAULT_INPUT_BUDGET_TOKENS, inputTokenBudget } from "../src/core/model.js";
import type { Model } from "../src/core/types.js";
import { describe, expect, test } from "./harness/index.js";

function createModel(overrides: Partial<Model> = {}): Model {
	return {
		id: "model",
		name: "Model",
		providerId: "provider",
		contextWindow: 200_000,
		maxOutputTokens: 16_384,
		...overrides,
	};
}

describe("每请求输入预算", () => {
	test("未配置时默认上限 60k，且不超过窗口可用值", () => {
		expect(inputTokenBudget(createModel())).toBe(DEFAULT_INPUT_BUDGET_TOKENS);
		expect(inputTokenBudget(createModel({ contextWindow: 1_000_000 }))).toBe(DEFAULT_INPUT_BUDGET_TOKENS);
		expect(inputTokenBudget(createModel({ contextWindow: 8_000, maxOutputTokens: undefined }))).toBe(4_000);
	});

	test("显式正数取窗口可用值与配置值的较小者", () => {
		expect(inputTokenBudget(createModel({ inputBudgetTokens: 100_000 }))).toBe(100_000);
		expect(inputTokenBudget(createModel({ inputBudgetTokens: 200_000 }))).toBe(183_616);
	});

	test("0 表示不额外设限，未知窗口保持未知", () => {
		expect(inputTokenBudget(createModel({ inputBudgetTokens: 0 }))).toBe(183_616);
		expect(inputTokenBudget(createModel({ contextWindow: undefined }))).toBeUndefined();
	});
});
