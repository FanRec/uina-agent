import { afterEach, describe, expect, it, SubjectHarness } from "./harness/index.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAIProvider, toWireMessages } from "../src/ai/gateway.js";
import { createModel } from "../src/ai/providers.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";
import type { ChatMsg, Model, ModelStreamFn, StreamDelta } from "../src/core/types.js";

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
		const harness = SubjectHarness.create({
			model: pair.model,
			stream: pair.stream,
			thinkingLevel: "high",
		});
		harness.subscribe((e) => {
			if (e.type === "output_update" && e.channel === "thinking") thinking.push(e.text);
		});
		await harness.run("问题");
		const answer = harness.historySnapshot().find((message) => message.role === "assistant");
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
		const harness = SubjectHarness.create({ model, stream, thinkingLevel: "high" });
		const seen = new Promise<void>((resolve) => { thinkingSeen = resolve; });
		harness.pushInput("中断问题");
		await seen;
		harness.interrupt();
		await harness.waitForIdle();
		expect(harness.historySnapshot().some((message) => message.role === "assistant" && message.thinking === "未完成分析" && message.status === "aborted")).toBe(true);
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
		expect(() => SubjectHarness.create({ model, stream, thinkingLevel: "high" }))
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

describe("deepseek reasoning_content 出站回传", () => {
	// DeepSeek thinking 模式要求 assistant 帧携带 reasoning_content（空串即"无推理"）：
	// 缺字段 + thinking enabled + 帧在生成前缀位 ⇒ 400
	// `reasoning_content` in the thinking mode must be passed back。
	it("无 thinking 的 assistant 帧补空串 reasoning_content", () => {
		const wire = toWireMessages([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "", tool_calls: [{ id: "c1", name: "f", args: {}, argsValid: true }] },
		] as ChatMsg[], "deepseek") as Array<{ role: string; reasoning_content?: unknown }>;
		expect(wire[1]).toMatchObject({ role: "assistant", reasoning_content: "" });
	});

	it("保留真实 thinking 原文", () => {
		const wire = toWireMessages([
			{ role: "assistant", content: "好", thinking: "分析过程" },
		] as ChatMsg[], "deepseek") as Array<{ role: string; reasoning_content?: unknown }>;
		expect(wire[0]).toMatchObject({ reasoning_content: "分析过程" });
	});

	it("openai 格式不写 reasoning_content", () => {
		const wire = toWireMessages([
			{ role: "assistant", content: "好", thinking: "分析过程" },
		] as ChatMsg[], "openai") as Array<Record<string, unknown>>;
		expect("reasoning_content" in wire[0]!).toBe(false);
	});
});
