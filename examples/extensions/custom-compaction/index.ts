import type { ExtensionAPI } from "../../../src/extensions/index.js";
/**
 * 压缩（上下文窗口管理）由官方 compaction capability 在
 * turn.transformContext 每请求拥有；本示例演示扩展在同一条 Interceptor 链上
 * 提供自己的裁剪策略（与官方 capability 链式组合：后激活者收到前者的输出）。
 * 这里不做 LLM 摘要——只折叠中段历史，保留头部任务陈述与最近工作。
 */
export default function activate(api: ExtensionAPI): void {
	api.onHook("turn.transformContext", async (messages) => {
		const KEEP_HEAD = 2;
		const KEEP_TAIL = 6;
		if (messages.length <= KEEP_HEAD + KEEP_TAIL) return undefined;
		const middle = messages.slice(KEEP_HEAD, messages.length - KEEP_TAIL);
		const digest =
			`[${middle.length} 条早期消息已折叠] ` +
			middle
				.filter((message) => message.role === "user")
				.slice(0, 3)
				.map((message) => message.content.slice(0, 80))
				.join(" / ");
		return {
			messages: [
				...messages.slice(0, KEEP_HEAD),
				{ role: "user", content: digest },
				...messages.slice(-KEEP_TAIL),
			],
		};
	});
}
