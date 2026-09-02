/**
 * 内置工具：最小工具集。
 *  - get_time : 同步快工具（无副作用、确定性——工具闭环路径的测试锚点）
 */
import type { Tool } from "./broker.js";

export function getTimeTool(): Tool {
	return {
		def: {
			type: "function",
			function: {
				name: "get_time",
				description: "获取当前日期和时间",
				parameters: { type: "object", properties: {} },
			},
		},
		run: async () => new Date().toLocaleString("zh-CN", { hour12: false }),
	};
}
