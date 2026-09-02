/**
 * 内置工具：工具闭环的最小演示集。
 *  - get_time   : 同步快工具
 *  - remember   : 记忆 write（由模型判断何时值得记）
 *  - recall     : 记忆 read（由模型判断何时需要回忆）
 *  - forget     : 记忆 correction（废弃一条）
 *  - think_for  : Job 演示——受理即返回，完成以事件唤醒
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
			const item = mem.remember(fact, "fact");
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

/** Job 工具：后台托管长任务的示范——执行立即受理，延迟完成后经 onJobDone 回前台。 */
export function thinkForTool(
	onJobDone: (jobId: string, result: string) => void,
): Tool {
	return {
		isJob: true,
		def: {
			type: "function",
			function: {
				name: "think_for",
				description:
					"启动一个后台思考任务：想一个问题 N 秒，期间你可以继续处理别的，完成后会自动回来告诉你结果。用于需要花时间想的事。",
				parameters: {
					type: "object",
					properties: {
						seconds: { type: "number", description: "思考秒数 1-10" },
						question: { type: "string", description: "要想的问题" },
					},
					required: ["seconds", "question"],
				},
			},
		},
		run: async (args) => {
			const seconds = Math.min(10, Math.max(1, Number(args.seconds) || 3));
			const question = String(args.question ?? "");
			const jobId = `job_${Date.now().toString(36)}`;
			setTimeout(() => {
				onJobDone(
					jobId,
					`后台任务「${question}」想好了：值得从长计议，先记下这个念头。`,
				);
			}, seconds * 1000);
			return JSON.stringify({
				ok: true,
				jobId,
				note: `已在后台开始想「${question}」，约 ${seconds} 秒后我会主动告诉你。`,
			});
		},
	};
}
