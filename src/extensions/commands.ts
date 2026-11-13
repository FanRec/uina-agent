import type { ExtensionRegistry } from "./renderer-registry.js";
import type { CommandResult } from "./ui-contract.js";

/**
 * 命令派发的结构化结果：
 * - `handled: false`：不是命令（普通 Prompt，交给正常输入路径）；
 * - `handled: true, agentInput?`：命令已执行；handler 返回 agent-input 结果时，
 *   宿主把它转成一条真实操作者输入（模型正文 + 展示正文分离），Router 不直接
 *   给 Subject 发消息。
 *
 * 未知命令与 handler 异常以 throw 表达：本地消费者显示、网关返回拒绝——
 * 不在 Router 内悄悄吞掉再向网关报告成功。
 */
export type CommandDispatchResult = { handled: false } | { handled: true; agentInput?: CommandResult };

/** One command path for terminal UI, pipe/stdin, gateway intents and one-shot execution. */
export class CommandRouter {
	constructor(private readonly registry: ExtensionRegistry) {}

	async dispatch(input: string): Promise<CommandDispatchResult> {
		if (!input.startsWith("/")) return { handled: false };
		const trimmed = input.slice(1).trim();
		// 裸 "/" 不是命令也不是 Prompt：吞掉，保持历史行为。
		if (!trimmed) return { handled: true };
		// 名称 = 首个空白前的 token；参数保留原始字符串（含内部空白，不拆分重拼）。
		const token = /^\S+/.exec(trimmed)![0]!;
		const rest = trimmed.slice(token.length).replace(/^\s+/, "");
		const colon = /^(.+):(\S*)$/.exec(token);
		if (colon && this.registry.getCommand(colon[1].toLowerCase())) {
			// 通用「已注册命令 + 冒号子名」：子名并入参数（/skill:name args → handler("name args")）。
			const subName = colon[2];
			const command = this.registry.getCommand(colon[1].toLowerCase())!;
			if (!command.handler) throw new Error(`/${colon[1]} 没有可执行的处理器`);
			const result = await command.handler(subName + (rest ? ` ${rest}` : ""));
			return { handled: true, ...(result ? { agentInput: result } : {}) };
		}
		const command = this.registry.getCommand(token.toLowerCase());
		if (!command?.handler) {
			throw new Error(`未知命令: /${token}。输入 /help 查看命令。`);
		}
		const result = await command.handler(rest);
		return { handled: true, ...(result ? { agentInput: result } : {}) };
	}
}
