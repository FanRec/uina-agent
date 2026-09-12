import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Subject } from "../src/agent/loop.js";
import { createOpenAIProvider } from "../src/ai/gateway.js";
import { createModel } from "../src/ai/providers.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";
import { ToolBroker } from "../src/tools/broker.js";
import type { Model, ModelStreamFn, StreamDelta } from "../src/core/types.js";

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

function providerFromDeltas(deltas: StreamDelta[]): { model: Model; stream: ModelStreamFn } {
	const model: Model = {
		id: "thinking-mock",
		name: "thinking-mock",
		providerId: "mock",
		contextWindow: 128_000,
		thinkingLevels: ["off", "high"],
	};
	const stream: ModelStreamFn = async (_m, _req, emit) => {
		for (const delta of deltas) emit(delta);
	};
	return { model, stream };
}

describe("thinking pipeline", () => {
	it("keeps thinking separate from answer and persists it in assistant history", async () => {
		const thinking: string[] = [];
		const pair = providerFromDeltas([
			{ kind: "thinking", text: "先分析" },
			{ kind: "text", text: "答案" },
			{ kind: "finish", reason: "stop" },
		]);
		const subject = new Subject(pair.model, pair.stream, new ToolBroker(), { thinkingLevel: "high" });
		subject.subscribe((e) => {
			if (e.type === "output_update" && e.channel === "thinking") thinking.push(e.text);
		});
		subject.pushInput("问题");
		await subject.waitForIdle();
		const answer = subject.historySnapshot().find((message) => message.role === "assistant");
		expect(thinking).toEqual(["先分析"]);
		expect(answer).toMatchObject({ content: "答案", thinking: "先分析", status: "complete" });
	});

	it("retains thinking when cancellation happens before answer text", async () => {
		let thinkingSeen: (() => void) | undefined;
		const model: Model = {
			id: "abort-thinking",
			name: "abort-thinking",
			providerId: "mock",
			contextWindow: 128_000,
			thinkingLevels: ["off", "high"],
		};
		const stream: ModelStreamFn = async (_m, _req, emit, signal) => {
			emit({ kind: "thinking", text: "未完成分析" });
			thinkingSeen?.();
			await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
		};
		const subject = new Subject(model, stream, new ToolBroker(), { thinkingLevel: "high" });
		const seen = new Promise<void>((resolve) => { thinkingSeen = resolve; });
		subject.pushInput("中断问题");
		await seen;
		subject.interrupt();
		await subject.waitForIdle();
		expect(subject.historySnapshot().some((message) => message.role === "assistant" && message.thinking === "未完成分析" && message.status === "aborted")).toBe(true);
	});

	it("rejects an unsupported configured level before provider execution", async () => {
		let called = false;
		const model: Model = {
			id: "limited",
			name: "limited",
			providerId: "mock",
			contextWindow: 128_000,
			thinkingLevels: ["off"],
		};
		const stream: ModelStreamFn = async () => { called = true; };
		expect(() => new Subject(model, stream, new ToolBroker(), { thinkingLevel: "high" }))
			.toThrow("未声明支持 thinking level");
		expect(called).toBe(false);
	});
});

describe("OpenAI-compatible thinking", () => {
	it("maps reasoning effort and reasoning_content to unified events", async () => {
		let requestBody = "";
		const server = createServer((req, res) => {
			req.on("data", (chunk) => { requestBody += chunk; });
			req.on("end", () => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(`data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\ndata: {"choices":[{"delta":{"content":"答复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		const events: string[] = [];
		const provider = createOpenAIProvider("openai", { baseUrl, apiKey: "x" });
		const model: Model = {
			id: "m",
			name: "m",
			providerId: "openai",
			contextWindow: 4096,
			thinkingLevels: ["off", "high"],
		};
		await provider.stream(
			model,
			{ messages: [{ role: "user", content: "hi" }], thinkingLevel: "high", providerHooks: NO_RUNTIME_HOOKS.provider },
			delta => { if (delta.kind === "thinking") events.push(delta.text); },
		);
		expect(events).toEqual(["思考"]);
		expect(JSON.parse(requestBody).reasoning_effort).toBe("high");
	});

	it("creates the configured Anthropic and Gemini adapter kinds", () => {
		const base = { baseUrl: "https://example.test", apiKey: "x", model: "m", modelContextWindow: 4096 };
		expect(createModel({ ...base, type: "anthropic", thinkingLevels: ["off", "high"], maxOutputTokens: 4096, thinkingBudgets: { high: 2048 } }, "a").thinkingLevels).toEqual(["off", "high"]);
		expect(createModel({ ...base, type: "gemini" }, "g").thinkingLevels).toBeUndefined();
	});
});
