// 最小 MCP stdio server fixture：换行分隔 JSON-RPC 2.0，回应 initialize / tools/list / tools/call。
// 刻意不依赖任何 npm 包，保证测试只验证 stdio 传输本身。
import { createInterface } from "node:readline";

const tools = [
	{
		name: "echo",
		description: "Echo back the input text",
		inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	},
];

function send(message) {
	process.stdout.write(JSON.stringify(message) + "\n");
}

const lineReader = createInterface({ input: process.stdin });
lineReader.on("line", (line) => {
	if (!line.trim()) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.jsonrpc !== "2.0" || message.id === undefined || message.id === null) return;
	if (message.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "fixture-stdio", version: "0.0.1" },
				instructions: "fixture stdio server for uina mcp tests",
			},
		});
		return;
	}
	if (message.method === "tools/list") {
		send({ jsonrpc: "2.0", id: message.id, result: { tools } });
		return;
	}
	if (message.method === "tools/call") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: { content: [{ type: "text", text: `echo:${message.params?.arguments?.text ?? ""}` }] },
		});
		return;
	}
	send({
		jsonrpc: "2.0",
		id: message.id,
		error: { code: -32601, message: `method not found: ${message.method}` },
	});
});
