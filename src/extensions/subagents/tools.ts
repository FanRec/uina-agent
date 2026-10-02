import type { Tool } from "../../tools/broker.js";
import type { SubagentRegistry } from "./registry.js";
import { createOwnedTool } from "../task-tool.js";

const byIdSchema = {
	type: "object",
	additionalProperties: false,
	required: ["subagent_id"],
	properties: { subagent_id: { type: "string", minLength: 1 } },
} as const;
const transcriptSchema = {
	type: "object",
	additionalProperties: false,
	required: ["subagent_id"],
	properties: {
		subagent_id: { type: "string", minLength: 1 },
		cursor: { type: "integer", minimum: 0 },
		limit: { type: "integer", minimum: 1, maximum: 500 },
	},
} as const;

export function createSubagentTools(registry: SubagentRegistry, ownerId: string): Tool[] {
	const tool = (
		name: string,
		description: string,
		parameters: Record<string, unknown>,
		handler: (args: Record<string, unknown>, caller: string) => Promise<unknown> | unknown,
	) => createOwnedTool(name, description, parameters, handler, ownerId);

	return [
		{
			def: {
				type: "function",
				function: {
					name: "subagent_start",
					description:
						"为独立上下文、并行或长任务派生子代理；简单工具调用不要使用。返回 subagent_id，随后用 subagent_status/output 跟进。",
					parameters: {
						type: "object",
						additionalProperties: false,
						required: ["label", "prompt"],
						properties: { label: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 } },
					},
				},
			},
			run: async (args, _signal, context) => {
				const caller = context?.ownerId ?? ownerId;
				const snapshot = registry.start({
					ownerId: caller,
					parentId: caller,
					label: args.label as string,
					prompt: args.prompt as string,
				});
				// Generic effect fact: this tool dispatched a background task. The id is the
				// stable external operation identity; Session Core only records it.
				return {
					result: JSON.stringify({ phase: "accepted", subagent: snapshot }),
					status: "succeeded" as const,
					details: {
						effects: [{ effectType: "task.dispatch", externalOperationId: snapshot.id, label: String(args.label) }],
					},
				};
			},
		},
		tool(
			"subagent_list",
			"查看当前调用方拥有的所有内部子代理列表。",
			{ type: "object", additionalProperties: false, properties: {} },
			(_args, caller) => registry.list(caller),
		),
		tool("subagent_status", "查看子代理实时状态、错误和快照；不读取完整输出。", byIdSchema, (args, caller) =>
			registry.get(args.subagent_id as string, caller),
		),
		tool(
			"subagent_output",
			"用 cursor 增量读取子代理 thinking/text/tool 输出；优先于完整 transcript。",
			{
				type: "object",
				additionalProperties: false,
				required: ["subagent_id"],
				properties: { subagent_id: { type: "string", minLength: 1 }, cursor: { type: "integer", minimum: 0 } },
			},
			(args, caller) => registry.read(args.subagent_id as string, caller, args.cursor as number | undefined),
		),
		tool(
			"subagent_messages",
			"按页读取子代理完整对话轨迹；仅在增量输出不足以判断时使用。",
			transcriptSchema,
			(args, caller) =>
				registry.transcript(
					args.subagent_id as string,
					caller,
					args.cursor as number | undefined,
					args.limit as number | undefined,
				),
		),
		tool(
			"subagent_send",
			"向仍可用的子代理追加任务；返回受理/排队事实，随后用 status/output 观察。",
			{
				type: "object",
				additionalProperties: false,
				required: ["subagent_id", "text"],
				properties: { subagent_id: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1 } },
			},
			async (args, caller) => {
				return registry.send(args.subagent_id as string, caller, args.text as string);
			},
		),
		tool(
			"subagent_interrupt",
			"请求中断子代理；返回请求状态，最终是否 settled 需再查 status。",
			byIdSchema,
			async (args, caller) => {
				const phase = await registry.interrupt(args.subagent_id as string, caller);
				return { phase, subagent: registry.get(args.subagent_id as string, caller) };
			},
		),
	];
}
