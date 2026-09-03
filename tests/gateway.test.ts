import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAIProvider, toWireMessages } from "../src/ai/gateway.js";
import { ProviderProtocolError } from "../src/ai/sse.js";
import type { StreamDelta } from "../src/core/types.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

function sse(events: string[], crlf = false): string {
	const newline = crlf ? "\r\n" : "\n";
	return events.map((event) => `data: ${event}${newline}${newline}`).join("");
}

async function endpoint(body: string): Promise<string> {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(body);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function collect(baseUrl: string, signal?: AbortSignal): Promise<StreamDelta[]> {
	const provider = createOpenAIProvider({ baseUrl, apiKey: "test", model: "m", modelContextWindow: 4096 });
	const output: StreamDelta[] = [];
	await provider.stream({ messages: [{ role: "user", content: "hi" }], providerHooks: NO_RUNTIME_HOOKS.provider }, (delta) => output.push(delta), signal);
	return output;
}

describe("OpenAI gateway", () => {
	it("parses text, CRLF and finish marker", async () => {
		const base = await endpoint(
			sse([
				JSON.stringify({ choices: [{ delta: { content: "你好" } }] }),
				JSON.stringify({ choices: [{ delta: { content: "世界" } }] }),
				JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
				"[DONE]",
			], true),
		);
		const output = await collect(base);
		expect(output.filter((d) => d.kind === "text").map((d) => d.kind === "text" && d.text)).toEqual(["你好", "世界"]);
		expect(output.at(-1)).toEqual({ kind: "finish", reason: "stop" });
	});

	it("joins multi-line data events", async () => {
		const body = `data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
		const output = await collect(await endpoint(body));
		expect(output).toContainEqual({ kind: "text", text: "ok" });
	});

	it("reassembles fragmented tool calls", async () => {
		const output = await collect(
			await endpoint(
				sse([
					JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "get_", arguments: '{"a":' } }] } }] }),
					JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "time", arguments: "1}" } }] } }] }),
					JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
					"[DONE]",
				]),
			),
		);
		const call = output.find((delta) => delta.kind === "tool_call");
		expect(call).toEqual({
			kind: "tool_call",
			call: { id: "t1", name: "get_time", args: '{"a":1}', argsValid: true },
		});
	});

	it("rejects invalid JSON, missing finish and content filtering", async () => {
		await expect(collect(await endpoint(sse(["not-json", "[DONE]"])))).rejects.toBeInstanceOf(ProviderProtocolError);
		await expect(collect(await endpoint(sse([JSON.stringify({ choices: [{ delta: { content: "partial" } }] }), "[DONE]"])))).rejects.toThrow("finish_reason");
		await expect(collect(await endpoint(sse([JSON.stringify({ choices: [{ delta: {}, finish_reason: "content_filter" }] }), "[DONE]"])))).rejects.toThrow("content_filter");
	});

	it("rejects an abnormal finish reason and incomplete arguments", async () => {
		await expect(collect(await endpoint(sse([JSON.stringify({ choices: [{ delta: {}, finish_reason: "provider_magic" }] }), "[DONE]"])))).rejects.toThrow("未知 finish_reason");
		await expect(collect(await endpoint(sse([
			JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t", function: { name: "x", arguments: '{"a":' } }] } }] }),
			JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
			"[DONE]",
		])))).rejects.toThrow("完整 JSON");
	});

	it("propagates abort without fabricating a finish", async () => {
		const controller = new AbortController();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`));
				setTimeout(() => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "y" } }] })}\n\n`)), 100);
			},
		});
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		try {
			const promise = collect("http://example/v1", controller.signal);
			controller.abort();
			await expect(promise).rejects.toThrow();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("converts internal tool messages to wire format", () => {
		expect(toWireMessages([
			{ role: "assistant", content: "", tool_calls: [{ id: "t1", name: "x", args: { a: 1 } }] },
			{ role: "tool", tool_call_id: "t1", content: "ok", status: "succeeded" },
		])).toEqual([
			{ role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: '{"a":1}' } }] },
			{ role: "tool", tool_call_id: "t1", content: "ok" },
		]);
	});
});
