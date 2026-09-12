import type { Tool } from "../../tools/broker.js";
import type { SubagentRegistry } from "./registry.js";
import { createOwnedTool } from "../task-tool.js";

const byIdSchema = {
	type: "object",
	additionalProperties: false,
	required: ["subagent_id"],
	properties: { subagent_id: { type: "string", minLength: 1 } },
} as const;

export function createSubagentTools(registry: SubagentRegistry, ownerId: string): Tool[] {
	const tool = (
		name: string,
		description: string,
		parameters: Record<string, unknown>,
		handler: (args: Record<string, unknown>, caller: string) => Promise<unknown> | unknown,
	) => createOwnedTool(name, description, parameters, handler, ownerId);

	return [
		tool(
			"subagent_start",
			"启动并派生一个可持久交谈的内部子代理。",
			{
				type: "object",
				additionalProperties: false,
				required: ["label", "prompt"],
				properties: { label: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 } },
			},
			(args, caller) =>
				registry.start({
					ownerId: caller,
					parentId: caller,
					label: args.label as string,
					prompt: args.prompt as string,
				}),
		),
		tool("subagent_list", "查看当前调用方拥有的所有内部子代理列表。", { type: "object", additionalProperties: false, properties: {} }, (_args, caller) => registry.list(caller)),
		tool("subagent_status", "查看指定内部子代理的实时状态与执行快照。", byIdSchema, (args, caller) => registry.get(args.subagent_id as string, caller)),
		tool(
			"subagent_output",
			"游标增量读取内部子代理的实时输出流。",
			{
				type: "object",
				additionalProperties: false,
				required: ["subagent_id"],
				properties: { subagent_id: { type: "string", minLength: 1 }, cursor: { type: "integer", minimum: 0 } },
			},
			(args, caller) => registry.read(args.subagent_id as string, caller, args.cursor as number | undefined),
		),
		tool("subagent_messages", "读取指定内部子代理的完整对话轨迹转录记录。", byIdSchema, (args, caller) => registry.transcript(args.subagent_id as string, caller)),
		tool(
			"subagent_send",
			"向指定的内部子代理追加发送跟进消息。",
			{
				type: "object",
				additionalProperties: false,
				required: ["subagent_id", "text"],
				properties: { subagent_id: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1 } },
			},
			async (args, caller) => {
				await registry.send(args.subagent_id as string, caller, args.text as string);
				return { status: "accepted" };
			},
		),
		tool("subagent_interrupt", "向指定的内部子代理请求中断并停止执行。", byIdSchema, async (args, caller) => ({
			status: await registry.interrupt(args.subagent_id as string, caller),
		})),
	];
}


