import type { SessionAccess } from "../../session/types.js";
import type { ExtensionActivation } from "../runner.js";

/** session_read 的默认正文上限：与 read_file/grep/exec 的 50KB 档一致，
 * 让"进模型上下文的工具输出有界"这一前提全覆盖。 */
const DEFAULT_MAX_CHARS = 50_000;

/** Tool implementations resolve the executing subject; inherited tools never rewind their parent. */
export function activateSessionTools(resolve: (ownerId: string) => SessionAccess): ExtensionActivation {
	return (api) => {
		api.registerTool({
			def: {
				type: "function",
				function: {
					name: "session_list",
					description:
						"列出主线或只读历史节点；需要选择回溯目标时使用。返回 preview、canRewind 和分页游标；完整节点用 session_read。",
					parameters: {
						type: "object",
						properties: {
							scope: {
								type: "string",
								enum: ["main", "all"],
								description: "main 只列主线节点；all 额外包含只读历史分支节点",
							},
							after: { type: "string", minLength: 1, description: "分页游标，取自上一次结果的 next.after" },
							limit: { type: "integer", minimum: 1, description: "最多返回的节点数" },
						},
						additionalProperties: false,
					},
				},
			},
			run: async (args, _signal, context) => ({
				status: "succeeded",
				result: JSON.stringify(resolve(context?.ownerId ?? "root").list(args)),
			}),
		});

		api.registerTool({
			def: {
				type: "function",
				function: {
					name: "session_read",
					description:
						"读取指定会话节点的完整事实，用于核实历史；不会改变当前上下文，也不会重放工具。消息正文默认上限 50000 字符，超限返回截断正文和 next 翻页参数。",
					parameters: {
						type: "object",
						properties: {
							id: { type: "string", minLength: 1 },
							max_chars: {
								type: "integer",
								minimum: 1,
								maximum: 200_000,
								description: `消息正文上限；省略时默认 ${DEFAULT_MAX_CHARS}`,
							},
						},
						required: ["id"],
						additionalProperties: false,
					},
				},
			},
			run: async (args, _signal, context) => {
				const id = typeof args?.id === "string" ? args.id.trim() : "";
				if (!id) {
					throw new Error("session_read 需要提供有效的 id");
				}
				const entry = resolve(context?.ownerId ?? "root").read(id);
				const maxChars = typeof args.max_chars === "number" ? args.max_chars : DEFAULT_MAX_CHARS;
				if (entry.kind !== "message" && entry.kind !== "custom_message")
					return { status: "succeeded", result: JSON.stringify(entry) };
				const content = entry.kind === "message" ? entry.message.content : entry.content;
				if (content.length <= maxChars) return { status: "succeeded", result: JSON.stringify(entry) };
				return {
					status: "succeeded",
					result: JSON.stringify({
						entry: {
							...entry,
							...(entry.kind === "message"
								? { message: { ...entry.message, content: content.slice(0, maxChars) } }
								: { content: content.slice(0, maxChars) }),
						},
						truncated: true,
						next: { tool: "session_read", id, max_chars: maxChars * 2 },
					}),
				};
			},
		});

		api.registerTool({
			def: {
				type: "function",
				function: {
					name: "session_rewind",
					description:
						"整条推理路径错误时请求回溯到当前主线安全祖先。返回 scheduled 或 committed；scheduled 尚未提交。文件、后台任务和外部副作用不会撤销，重试前先核实状态。",
					parameters: {
						type: "object",
						properties: {
							targetId: { type: "string", minLength: 1 },
							reason: { type: "string", minLength: 1 },
							note: { type: "string" },
						},
						required: ["targetId", "reason"],
						additionalProperties: false,
					},
				},
			},
			run: async (args, signal, context) => {
				const targetId = typeof args?.targetId === "string" ? args.targetId.trim() : "";
				const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
				if (!targetId || !reason) {
					throw new Error("session_rewind 需要提供有效的 targetId 与 reason");
				}
				const summary = typeof args?.note === "string" ? args.note : undefined;
				const access = resolve(context?.ownerId ?? "root");
				const result = await access.requestRewind(
					{ targetId, reason, ...(summary ? { note: summary } : {}) },
					context?.callerId ?? api.id,
					signal,
				);
				return {
					status: "succeeded",
					result: JSON.stringify(result),
				};
			},
		});

		api.registerCommand({
			name: "rewind",
			description: "回溯当前主线：/rewind <target-id> <原因>，外部状态不撤销",
			handler: async (args) => {
				const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
				if (!match) {
					throw new Error("用法：/rewind <target-id> <原因>");
				}
				const result = await api.session.requestRewind({ targetId: match[1], reason: match[2] });
				api.ui.notify(`回溯请求 ${result.requestId}: ${result.status}`, "info", 5000);
			},
		});
	};
}
