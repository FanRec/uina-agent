import type { Tool, ToolExecutionContext } from "../../tools/broker.js";
import type { SubagentRegistry } from "./registry.js";

export function createSubagentTools(registry: SubagentRegistry, ownerId: string): Tool[] {
	const ownedTool = (
		name: string,
		description: string,
		parameters: Record<string, unknown>,
		run: (args: Record<string, unknown>, caller: string) => Promise<string>,
	): Tool => tool(name, description, parameters, (args, context) => run(args, context?.ownerId ?? ownerId));

	return [
		ownedTool("subagent_start", "Start a continuable internal agent.", {
			type: "object", additionalProperties: false, required: ["label", "prompt"],
			properties: { label: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 } },
		}, async (args, caller) => JSON.stringify(registry.start({ ownerId: caller, parentId: caller, label: args.label as string, prompt: args.prompt as string }))),
		ownedTool("subagent_list", "List owned internal agents.", {
			type: "object", additionalProperties: false, properties: {},
		}, async (_args, caller) => JSON.stringify(registry.list(caller))),
		ownedTool("subagent_status", "Inspect one internal agent.", {
			type: "object", additionalProperties: false, required: ["subagent_id"],
			properties: { subagent_id: { type: "string" } },
		}, async (args, caller) => JSON.stringify(registry.get(args.subagent_id as string, caller))),
		ownedTool("subagent_output", "Read incremental internal agent output.", {
			type: "object", additionalProperties: false, required: ["subagent_id"],
			properties: { subagent_id: { type: "string" }, cursor: { type: "integer", minimum: 0 } },
		}, async (args, caller) => JSON.stringify(registry.read(args.subagent_id as string, caller, args.cursor as number | undefined))),
		ownedTool("subagent_messages", "Read an internal agent transcript.", {
			type: "object", additionalProperties: false, required: ["subagent_id"],
			properties: { subagent_id: { type: "string" } },
		}, async (args, caller) => JSON.stringify(registry.transcript(args.subagent_id as string, caller))),
		ownedTool("subagent_send", "Send a follow-up to an internal agent.", {
			type: "object", additionalProperties: false, required: ["subagent_id", "text"],
			properties: { subagent_id: { type: "string" }, text: { type: "string", minLength: 1 } },
		}, async (args, caller) => { await registry.send(args.subagent_id as string, caller, args.text as string); return JSON.stringify({ status: "accepted" }); }),
		ownedTool("subagent_interrupt", "Request an internal agent interruption.", {
			type: "object", additionalProperties: false, required: ["subagent_id"],
			properties: { subagent_id: { type: "string" } },
		}, async (args, caller) => JSON.stringify({ status: await registry.interrupt(args.subagent_id as string, caller) })),
	];
}

function tool(name: string, description: string, parameters: Record<string, unknown>, run: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<string>): Tool {
	return { def: { type: "function", function: { name, description, parameters } }, run: async (args, _signal, context) => ({ result: await run(args, context), status: "succeeded" }) };
}
