/**
 * 上下文检视器数据端口：UI 不伸手进 Host/ExtensionRunner，经本端口只读拉取。
 *
 * 两条数据通道的分工（与设计文档一致）：
 * - turn.prepare 事实（系统提示词全文 + 回合注入）走 context_prepare 事件流，UIHost 缓存；
 * - transformContext 每请求改写与 auxiliary 登记走本端口拉取（实时直读，不缓存不过期）。
 */

import type { InjectionProvenance } from "../../host/events.js";

/** auxiliary 登记的分组条目：label 携带真实 kind 前缀（custom_entry/event），不混标。 */
export interface AuxiliaryGroup {
	readonly label: string;
	readonly count: number;
}

export interface ContextIntelPort {
	/** 最近一次 turn.transformContext 聚合运行的逐扩展贡献（每次读取实时直读聚合层）。 */
	lastTransformInjections(): readonly InjectionProvenance[];
	/** auxiliary 登记按 kind+类型分组计数（capability 私有持久状态概览）。 */
	auxiliarySummary(): readonly AuxiliaryGroup[];
}

export function createContextIntelAdapter(deps: {
	transformInjections: () => readonly InjectionProvenance[];
	auxiliaryEntries: () => readonly { readonly kind: string; readonly name: string }[];
}): ContextIntelPort {
	return {
		lastTransformInjections: deps.transformInjections,
		auxiliarySummary: () => {
			const counts = new Map<string, number>();
			for (const entry of deps.auxiliaryEntries()) {
				const key = `${entry.kind}:${entry.name}`;
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
			return [...counts.entries()].map(([key, count]) => ({
				label: key.replace(":", " "),
				count,
			}));
		},
	};
}
