import type { Tool, ToolExecutionContext } from "../tools/broker.js";

/**
 * 通用受管任务工具构建器（TaskExecution 统一接缝）。
 *
 * 核心职责：
 * 1. 统一解析调用者所有权身份（context?.ownerId ?? defaultOwnerId）；
 * 2. 业务处理器直接返回领域事实对象，底层统一序列化为 JSON 字符串并附加 succeeded 状态；
 * 3. 严格遵循架构契约：参数结构与范围校验全权交由 ToolBroker（Ajv + JSON Schema），业务 Handler 专注于执行。
 */
export function createOwnedTool(
	name: string,
	description: string,
	parameters: Record<string, unknown>,
	handler: (args: Record<string, unknown>, caller: string, signal?: AbortSignal) => Promise<unknown> | unknown,
	defaultOwnerId: string,
): Tool {
	return {
		def: {
			type: "function",
			function: {
				name,
				description,
				parameters,
			},
		},
		run: async (args, signal, context?: ToolExecutionContext) => {
			const caller = context?.ownerId ?? defaultOwnerId;
			const res = await handler(args, caller, signal);
			return {
				result: typeof res === "string" ? res : JSON.stringify(res),
				status: "succeeded",
			};
		},
	};
}

