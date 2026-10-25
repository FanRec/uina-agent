/**
 * 查询 Fact 组装：能力层只补"这次读到了什么/为什么还不知道"。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §2 Fact。
 * 未读到的字段进 unknown；不用默认值把未知变成已知。
 */

import type { Fact, FactBasis, FactSource } from "../../contracts/values.js";

export interface FactOptions {
	unknown?: string[];
	source?: FactSource | "mixed";
	basis?: FactBasis[];
}

export function factOf<T>(value: T, options: FactOptions = {}): Fact<T> {
	const unknown = options.unknown ?? [];
	return {
		value,
		observedAt: new Date().toISOString(),
		source: options.source ?? "server",
		coverage: unknown.length > 0 ? "partial" : "complete",
		unknown,
		evidence: [],
		...(options.basis != null ? { basis: options.basis } : {}),
	};
}
