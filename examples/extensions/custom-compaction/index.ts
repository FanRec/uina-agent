import type { ExtensionAPI } from "../../../src/extensions/index.js";
/**
 * History View（信息注入体系）示例：历史形塑的唯一接缝。
 *
 * 官方 compaction 扩展通过 pi.registerHistoryView 拥有"压缩后的可见历史"；
 * 同一宿主只允许一个提供者——本示例演示用同一接缝提供一份**不调用摘要模型**的
 * 确定性折叠策略（保留头部任务陈述与最近工作、折叠中段）。若与官方 compaction
 * 同时激活，后注册者会直接失败（单一所有者合同），这是设计而非缺陷。
 *
 * 只读、无副作用：每轮从 canonical 历史重新折叠，不消费事件、不写状态。
 */
export default function activate(api: ExtensionAPI): void {
	api.registerHistoryView((history) => {
		const KEEP_HEAD = 2;
		const KEEP_TAIL = 6;
		if (history.length <= KEEP_HEAD + KEEP_TAIL) return history;
		const middle = history.slice(KEEP_HEAD, history.length - KEEP_TAIL);
		const digest =
			`[${middle.length} 条早期消息已折叠] ` +
			middle
				.filter((message) => message.role === "user")
				.slice(0, 3)
				.map((message) => message.content.slice(0, 80))
				.join(" / ");
		return [...history.slice(0, KEEP_HEAD), { role: "user", content: digest }, ...history.slice(-KEEP_TAIL)];
	});
}
