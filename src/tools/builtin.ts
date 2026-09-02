/**
 * 内置工具：工具闭环的最小集。
 *  - get_time : 同步快工具
 *  - remember : 记忆 write（由模型判断何时值得记）
 *  - recall   : 记忆 read（由模型判断何时需要回忆）
 *  - forget   : 记忆 correction（废弃一条）
 */
import type { Tool } from "./broker.js";
import type { MemoryPort } from "../memory/port.js";

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

export function rememberTool(mem: MemoryPort): Tool {
	return {
		def: {
			type: "function",
			function: {
				name: "remember",
				description:
					"把值得长期记住的信息写入记忆（用户的个人信息、约定、你学到的经验），之后跨会话都能回忆到。",
				parameters: {
					type: "object",
					properties: {
						fact: {
							type: "string",
							description: "要记住的内容，第三人称陈述句，含关键信息",
						},
					},
					required: ["fact"],
				},
			},
		},
		run: async (args) => {
			const fact = String(args.fact ?? "").trim();
			if (!fact) return JSON.stringify({ error: "fact 为空" });
			const item = mem.remember(fact);
			return JSON.stringify({ ok: true, id: item.id });
		},
	};
}

export function recallTool(mem: MemoryPort): Tool {
	return {
		def: {
			type: "function",
			function: {
				name: "recall",
				description:
					"从自己的长期记忆中检索相关内容。当话题涉及以前经历、用户提过的事、或你需要上下文时调用。",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "检索关键词，如人名、话题" },
					},
					required: ["query"],
				},
			},
		},
		run: async (args) => {
			const q = String(args.query ?? "").trim();
			const hits = mem.recall(q, 5);
			if (hits.length === 0) return JSON.stringify({ found: false });
			return JSON.stringify({
				found: true,
				memories: hits.map((h) => ({ id: h.id, text: h.text, ts: h.ts })),
			});
		},
	};
}

export function forgetTool(mem: MemoryPort): Tool {
	return {
		def: {
			type: "function",
			function: {
				name: "forget",
				description:
					"废弃一条记忆（按 id）。记忆错误、过时或用户要求忘掉时使用。id 来自 recall 结果。",
				parameters: {
					type: "object",
					properties: {
						id: { type: "string", description: "要废弃的记忆 id" },
					},
					required: ["id"],
				},
			},
		},
		run: async (args) => {
			const ok = mem.archive(String(args.id ?? ""));
			return JSON.stringify(ok ? { ok: true } : { error: "找不到该记忆" });
		},
	};
}