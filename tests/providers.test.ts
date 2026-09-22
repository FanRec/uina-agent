import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createModel, createProvider, ModelRegistry } from "../src/ai/providers.js";
import type { ProviderConfig } from "../src/ai/config.js";
import type { Model, ModelRequest, Provider, StreamDelta } from "../src/core/types.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";

const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function sse(events: Array<Record<string, unknown> | string>): string {
	return events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
}

async function endpoint(body: string, status = 200, headers: Record<string, string> = { "content-type": "text/event-stream" }): Promise<string> {
	const server = createServer((_request, response) => {
		response.writeHead(status, headers);
		response.end(body);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("测试 Provider 地址不可用");
	return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

interface TestPair {
	provider: Provider;
	model: Model;
}

function testProvider(name: string, conf: ProviderConfig): TestPair {
	return {
		provider: createProvider(name, conf),
		model: createModel(conf, name),
	};
}

async function streamProvider(target: TestPair, request: Partial<ModelRequest> = {}, signal?: AbortSignal): Promise<StreamDelta[]> {
	const output: StreamDelta[] = [];
	await target.provider.stream(target.model, { messages: [{ role: "user", content: "hi" }], providerHooks: NO_RUNTIME_HOOKS.provider, ...request }, (delta) => output.push(delta), signal);
	return output;
}

function baseConfig(baseUrl: string, type: ProviderConfig["type"]): ProviderConfig {
	const shared: ProviderConfig = { baseUrl, apiKey: "local-test", model: "model", modelContextWindow: 4096, maxRetries: 0, type, thinkingLevels: ["off", "high"] };
	// 这些事实必须显式声明：适配器不再发明 max_tokens、wire 控制方式或 thinking 预算。
	if (type === "anthropic") return { ...shared, maxOutputTokens: 4096, thinkingBudgets: { high: 2048 } };
	if (type === "gemini") return { ...shared, geminiThinkingFormat: "level" };
	return shared;
}

describe("Anthropic provider protocol", () => {
	it("preserves initial and streamed text/thinking, signature, and cumulative usage", async () => {
		const baseUrl = await endpoint(sse([
			{ type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 2 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "先", signature: "sig-0" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "-1" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "答" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "案" } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5, output_tokens_details: { thinking_tokens: 2 } } },
			{ type: "message_stop" },
		]));
		const output = await streamProvider(testProvider("anthropic", baseConfig(baseUrl, "anthropic")));
		expect(output.filter((d) => d.kind === "thinking").map((d) => d.kind === "thinking" && d.text)).toEqual(["先", "想"]);
		expect(output.filter((d) => d.kind === "thinking_signature").map((d) => d.kind === "thinking_signature" && d.signature)).toEqual(["sig-0", "-1"]);
		expect(output.filter((d) => d.kind === "text").map((d) => d.kind === "text" && d.text)).toEqual(["答", "案"]);
		expect(output.at(-1)).toEqual({ kind: "finish", reason: "stop" });
		// Anthropic reports no authoritative total; the adapter keeps totalTokens
		// absent so the UI shows an estimate instead of a fabricated exact number.
		expect(output.findLast(d => d.kind === "usage")).toEqual({ kind: "usage", usage: { input: 12, output: 5, cacheRead: 2, reasoning: 2 } });
	});

	it("reassembles tool input and maps tool_use to tool_calls", async () => {
		const baseUrl = await endpoint(sse([
			{ type: "message_start", message: { usage: { input_tokens: 3 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "echo" } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"value":' } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"ok"}' } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		]));
		const output = await streamProvider(testProvider("anthropic", baseConfig(baseUrl, "anthropic")));
		expect(output.find((d) => d.kind === "tool_call")).toEqual({ kind: "tool_call", call: { id: "tool-1", name: "echo", args: '{"value":"ok"}', argsValid: true } });
		expect(output.at(-1)).toEqual({ kind: "finish", reason: "tool_calls" });
	});

	it.each(["refusal", "sensitive", "pause_turn", "stop_sequence", "provider_added"])("does not flatten %s into success", async (reason) => {
		const baseUrl = await endpoint(sse([
			{ type: "message_start", message: { usage: { input_tokens: 1 } } },
			{ type: "message_delta", delta: { stop_reason: reason } },
			{ type: "message_stop" },
		]));
		await expect(streamProvider(testProvider("anthropic", baseConfig(baseUrl, "anthropic")))).rejects.toThrow(reason === "provider_added" ? "未知 stop_reason" : reason);
	});

	it("rejects missing terminal lifecycle and malformed tool input", async () => {
		const missingStop = await endpoint(sse([
			{ type: "message_start", message: {} },
			{ type: "message_delta", delta: { stop_reason: "end_turn" } },
		]));
		await expect(streamProvider(testProvider("anthropic", baseConfig(missingStop, "anthropic")))).rejects.toThrow("message_stop");

		const malformed = await endpoint(sse([
			{ type: "message_start", message: {} },
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "echo" } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"value":' } },
			{ type: "content_block_stop", index: 0 },
		]));
		await expect(streamProvider(testProvider("anthropic", baseConfig(malformed, "anthropic")))).rejects.toThrow("不是完整 JSON");

		const providerError = await endpoint(sse([{ type: "error", error: { type: "overloaded_error", message: "busy" } }]));
		await expect(streamProvider(testProvider("anthropic", baseConfig(providerError, "anthropic")))).rejects.toThrow("busy");
	});
});

describe("Gemini provider protocol", () => {
	it("maps STOP with a function call to tool_calls and merges usage", async () => {
		const baseUrl = await endpoint(sse([
			{ candidates: [{ content: { parts: [{ thought: true, text: "思考", thoughtSignature: "thought-sig" }] } }] },
			{ candidates: [{ content: { parts: [{ functionCall: { id: "provider-call", name: "echo", args: { value: "ok" } }, thoughtSignature: "call-sig" }] } }], usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 2 } },
			{ candidates: [{ finishReason: "STOP" }], usageMetadata: { candidatesTokenCount: 3, thoughtsTokenCount: 1, totalTokenCount: 14 } },
		]));
		const output = await streamProvider(testProvider("gemini", baseConfig(baseUrl, "gemini")), { thinkingLevel: "high" });
		expect(output).toContainEqual({ kind: "thinking", text: "思考" });
		expect(output).toContainEqual({ kind: "thinking_signature", signature: "thought-sig" });
		expect(output).toContainEqual({ kind: "tool_call", call: { id: "provider-call", name: "echo", args: '{"value":"ok"}', argsValid: true, thinkingSignature: "call-sig" } });
		expect(output.at(-1)).toEqual({ kind: "finish", reason: "tool_calls" });
		expect(output.findLast((d) => d.kind === "usage")).toEqual({ kind: "usage", usage: { input: 8, output: 4, cacheRead: 2, reasoning: 1, totalTokens: 14 } });
	});

	it("does not reuse usage from a previous request", async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			requests++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(sse(requests === 1
				? [{ usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 } }, { candidates: [{ finishReason: "STOP" }] }]
				: [{ candidates: [{ finishReason: "STOP" }] }]));
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("测试 Provider 地址不可用");
		const pair = testProvider("gemini", { ...baseConfig(`http://127.0.0.1:${(address as AddressInfo).port}`, "gemini") });
		const first = await streamProvider(pair);
		const second = await streamProvider(pair);
		expect(first.some((delta) => delta.kind === "usage")).toBe(true);
		expect(second.some((delta) => delta.kind === "usage")).toBe(false);
	});

	it("routes tool result name from the matching assistant call and honors explicit call ids", async () => {
		let requestBody = "";
		const server = createServer((request, response) => {
			request.on("data", (chunk) => { requestBody += String(chunk); });
			request.on("end", () => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(sse([{ candidates: [{ finishReason: "STOP" }] }]));
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("测试 Provider 地址不可用");
		const pair = testProvider("gemini", { ...baseConfig(`http://127.0.0.1:${(address as AddressInfo).port}`, "gemini"), geminiToolCallIds: true });
		await streamProvider(pair, {
			messages: [
				{ role: "assistant", content: "", tool_calls: [{ id: "call-1", name: "echo", args: { value: "ok" } }, { id: "call-2", name: "echo", args: { value: "two" } }] },
				{ role: "tool", tool_call_id: "call-1", content: "done", status: "succeeded" },
				{ role: "tool", tool_call_id: "call-2", content: "done-two", status: "succeeded" },
			],
		});
		const payload = JSON.parse(requestBody) as { contents: Array<{ parts?: Array<{ functionCall?: unknown; functionResponse?: { name?: string; id?: string; response?: unknown } }> }> };
		const responseParts = payload.contents.flatMap((content) => content.parts ?? []).flatMap((part) => part.functionResponse ? [part.functionResponse] : []);
		expect(responseParts).toEqual([
			{ name: "echo", id: "call-1", response: { output: "done" } },
			{ name: "echo", id: "call-2", response: { output: "done-two" } },
		]);
		expect(payload.contents.filter((content) => content.parts?.some((part) => part.functionResponse))).toHaveLength(1);
	});

	it.each(["SAFETY", "MALFORMED_FUNCTION_CALL", "UNEXPECTED_NEW_REASON"])("rejects Gemini finish reason %s", async (reason) => {
		const baseUrl = await endpoint(sse([{ candidates: [{ finishReason: reason }] }]));
		await expect(streamProvider(testProvider("gemini", baseConfig(baseUrl, "gemini")))).rejects.toThrow(reason);
	});

	it("rejects missing finish, invalid usage, and unknown tool result ids", async () => {
		const missingFinish = await endpoint(sse([{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }]));
		await expect(streamProvider(testProvider("gemini", baseConfig(missingFinish, "gemini")))).rejects.toThrow("finishReason");

		const invalidUsage = await endpoint(sse([{ usageMetadata: { promptTokenCount: 1, cachedContentTokenCount: 2 } }, { candidates: [{ finishReason: "STOP" }] }]));
		await expect(streamProvider(testProvider("gemini", baseConfig(invalidUsage, "gemini")))).rejects.toThrow("cachedContentTokenCount");

		const providerError = await endpoint(sse([{ error: { status: "UNAVAILABLE", message: "busy" } }]));
		await expect(streamProvider(testProvider("gemini", baseConfig(providerError, "gemini")))).rejects.toThrow("busy");

		const unknownTool = await endpoint(sse([{ candidates: [{ finishReason: "STOP" }] }]));
		await expect(streamProvider(testProvider("gemini", baseConfig(unknownTool, "gemini")), {
			messages: [{ role: "tool", tool_call_id: "missing", content: "done" }],
		})).rejects.toThrow("缺少对应 function call");

		const missingCallId = await endpoint(sse([{ candidates: [{ content: { parts: [{ functionCall: { name: "echo", args: {} } }] } }] }, { candidates: [{ finishReason: "STOP" }] }]));
		await expect(streamProvider(testProvider("gemini", { ...baseConfig(missingCallId, "gemini"), geminiToolCallIds: true }))).rejects.toThrow("缺少 id");
	});

	it("propagates cancellation without fabricating a finish", async () => {
		const originalFetch = globalThis.fetch;
		const controller = new AbortController();
		const output: StreamDelta[] = [];
		const body = new ReadableStream<Uint8Array>({
			start(stream) {
				stream.enqueue(new TextEncoder().encode(sse([{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }])));
				setTimeout(() => { try { stream.enqueue(new TextEncoder().encode(sse([{ candidates: [{ finishReason: "STOP" }] }]))); } catch { /* stream was cancelled */ } }, 100);
			},
		});
		globalThis.fetch = async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		try {
			const pair = testProvider("gemini", baseConfig("http://example.test", "gemini"));
			const promise = pair.provider.stream(pair.model, { messages: [{ role: "user", content: "hi" }], providerHooks: NO_RUNTIME_HOOKS.provider }, (delta) => output.push(delta), controller.signal);
			controller.abort();
			await expect(promise).rejects.toThrow();
			// The promise is rejected before a terminal event can be normalized.
			expect(output.some((delta) => delta.kind === "finish")).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("Provider hooks and model discovery", () => {
	it("runs transport hooks with readonly snapshots and visible response metadata", async () => {
		const baseUrl = await endpoint(sse([
			{ type: "message_start", message: {} },
			{ type: "message_delta", delta: { stop_reason: "end_turn" } },
			{ type: "message_stop" },
		]));
		const order: string[] = [];
		const pair = testProvider("anthropic", baseConfig(baseUrl, "anthropic"));
		await pair.provider.stream(pair.model, {
			messages: [{ role: "user", content: "hi" }],
			providerHooks: {
				async transformHeaders(_provider, headers) { order.push("headers"); expect(Object.isFrozen(headers)).toBe(true); return { ...headers, "x-test": "1" }; },
				async transformPayload(_provider, payload) { order.push("payload"); expect(Object.isFrozen(payload)).toBe(true); return payload; },
				async observeResponse(input) { order.push(`response:${input.status}`); },
			},
		}, () => {});
		expect(order).toEqual(["headers", "payload", "response:200"]);
	});

	it("surfaces model discovery failures instead of swallowing them", async () => {
		const baseUrl = await endpoint("failed", 503, { "content-type": "text/plain" });
		const registry = new ModelRegistry({ default: "broken", providers: { broken: { ...baseConfig(baseUrl, "openai-compatible") } } });
		await expect(registry.refreshModels()).rejects.toThrow("broken");
	});

	it("部分成功不得报成整体失败：说清 N/M，且成功者已取得的目录不因抛错丢失", async () => {
		const okUrl = await endpoint(JSON.stringify({ data: [{ id: "dyn-ok" }] }), 200, { "content-type": "application/json" });
		const badUrl = await endpoint("failed", 503, { "content-type": "text/plain" });
		const registry = new ModelRegistry({
			default: "good/model",
			providers: {
				good: { ...baseConfig(okUrl, "openai-compatible") },
				bad: { ...baseConfig(badUrl, "openai-compatible") },
			},
		});

		// 仍以抛错上报（保留既有「不得吞掉失败」的意图），但必须说清 N/M 与具体是谁
		const error = await registry.refreshModels().then(
			() => null,
			(e: unknown) => e as Error,
		);
		expect(error).not.toBeNull();
		expect(error!.message).toContain("1/2 家已更新");
		expect(error!.message).toContain("bad");

		// 成功者的发现结果必须仍在 registry 里：以「缺 contextWindow 不可选择」这一
		// 特定错误区分「已发现但不可选」与「根本没发现」。
		// （这两类 /models 端点不汇报上下文窗口，故发现结果本来就不可选——这是端点的
		// 事实，不是 registry 的缺陷；本断言只证明结果没被抛错连带丢弃。）
		expect(() => registry.resolve("good/dyn-ok")).toThrow(/缺少 contextWindow/);
	});
});
