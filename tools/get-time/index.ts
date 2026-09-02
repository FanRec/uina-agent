/**
 * get_time 工具：同步快工具（无副作用、确定性——工具闭环路径的测试锚点）。
 * 被 src/tools/loader.ts 自动发现并注册（pi 同款：extensions 目录 index.ts 约定）。
 */
import type { Tool } from "../../src/tools/broker.js";

const getTime: Tool = {
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

export default getTime;