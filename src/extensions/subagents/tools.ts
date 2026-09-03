import type { Tool } from "../../tools/broker.js";
import type { SubagentRegistry } from "./registry.js";

export function createSubagentTools(registry: SubagentRegistry, ownerId: string): Tool[] {
	return [
		tool("subagent_start", "Start a continuable internal agent.", { type: "object", additionalProperties: false, required: ["label", "prompt"], properties: { label: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 } } }, async (args) => JSON.stringify(registry.start({ ownerId, label: args.label as string, prompt: args.prompt as string }))),
		tool("subagent_list", "List owned internal agents.", { type: "object", additionalProperties: false, properties: {} }, async () => JSON.stringify(registry.list(ownerId))),
		tool("subagent_status", "Inspect one internal agent.", { type: "object", additionalProperties: false, required: ["subagent_id"], properties: { subagent_id: { type: "string" } } }, async (args) => JSON.stringify(registry.get(args.subagent_id as string, ownerId))),
		tool("subagent_output", "Read incremental internal agent output.", { type: "object", additionalProperties: false, required: ["subagent_id"], properties: { subagent_id: { type: "string" }, cursor: { type: "integer", minimum: 0 } } }, async (args) => JSON.stringify(registry.read(args.subagent_id as string, ownerId, args.cursor as number | undefined))),
		tool("subagent_messages", "Read an internal agent transcript.", { type: "object", additionalProperties: false, required: ["subagent_id"], properties: { subagent_id: { type: "string" } } }, async (args) => JSON.stringify(registry.transcript(args.subagent_id as string, ownerId))),
		tool("subagent_send", "Send a follow-up to an internal agent.", { type: "object", additionalProperties: false, required: ["subagent_id", "text"], properties: { subagent_id: { type: "string" }, text: { type: "string", minLength: 1 } } }, async (args) => { await registry.send(args.subagent_id as string, ownerId, args.text as string); return JSON.stringify({ status: "accepted" }); }),
		tool("subagent_interrupt", "Request an internal agent interruption.", { type: "object", additionalProperties: false, required: ["subagent_id"], properties: { subagent_id: { type: "string" } } }, async (args) => JSON.stringify({ status: await registry.interrupt(args.subagent_id as string, ownerId) })),
	];
}

function tool(name: string, description: string, parameters: Record<string, unknown>, run: (args: Record<string, unknown>) => Promise<string>): Tool {
	return { def: { type: "function", function: { name, description, parameters } }, run };
}
