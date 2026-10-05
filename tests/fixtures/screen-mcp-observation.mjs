import { createInterface } from "node:readline";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=";
const targetSchema = { type: "object" };
const tools = [
	{
		name: "ListTargets",
		description: "List displays and app windows without operating the desktop.",
		inputSchema: { type: "object", additionalProperties: false },
	},
	{
		name: "Screenshot",
		description: "Capture a fast image; does not click, type, focus, or move windows.",
		inputSchema: { type: "object", properties: { target: targetSchema }, additionalProperties: false },
	},
	{
		name: "Snapshot",
		description: "Inspect image and accessible page semantics; page is not JavaScript DOM and partial is normal.",
		inputSchema: { type: "object", properties: { target: targetSchema }, additionalProperties: false },
	},
];

function send(message) {
	process.stdout.write(JSON.stringify(message) + "\n");
}
createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "screen-fixture", version: "0.1.0" },
			},
		});
	} else if (message.method === "tools/list") {
		send({ jsonrpc: "2.0", id: message.id, result: { tools } });
	} else if (message.method === "tools/call") {
		const name = message.params?.name;
		const observation = {
			kind: name === "Snapshot" ? "snapshot" : "screenshot",
			status: name === "Snapshot" ? "partial" : "ok",
			target: { kind: "desktop" },
			startedAt: "2026-10-05T00:00:00Z",
			completedAt: "2026-10-05T00:00:01Z",
			image: {
				status: "ok",
				valid: true,
				source: "fixture",
				originalSize: [1, 1],
				outputSize: [1, 1],
				bounds: [0, 0, 1, 1],
			},
			semantics:
				name === "Snapshot"
					? { status: "unavailable", errors: [{ code: "semantic_unavailable", message: "fixture" }] }
					: { status: "not_requested" },
			warnings: [],
		};
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				content: [
					{
						type: "text",
						text: name === "Snapshot" ? "Observation: PARTIAL\nSemantics: UNAVAILABLE" : "Observation: OK",
					},
					{ type: "image", data: png, mimeType: "image/png" },
				],
				structuredContent: observation,
				isError: false,
			},
		});
	}
});
