import { describe, expect, it } from "vitest";
import { buildContext } from "../src/agent/context.js";
import { toWireMessages } from "../src/ai/gateway.js";
import { anthropicMessages, geminiRequest } from "../src/ai/providers.js";
import type { ChatMsg, ModelRequest, ModelStreamFn } from "../src/core/types.js";
import { mockModel } from "./helpers/mock-provider.js";

describe("Context Hygiene & Protocol Sanitization", () => {
	it("embeds runtime events into system prompt and never produces trailing system messages", () => {
		const history: ChatMsg[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
			{ role: "user", content: "what is next?" },
		];
		const runtimeInputs = [
			{ source: { kind: "watcher", type: "fs" }, text: "file.txt changed" },
		];

		const context = buildContext({
			history,
			systemPrompt: "You are Uina.",
			runtimeInputs,
		});

		// First message is system and contains runtime events
		expect(context[0]?.role).toBe("system");
		expect(context[0]?.content).toContain("You are Uina.");
		expect(context[0]?.content).toContain("<runtime_events>");
		expect(context[0]?.content).toContain("file.txt changed");

		// Last message MUST NOT be a system message
		expect(context.at(-1)?.role).toBe("user");
		expect(context.at(-1)?.content).toBe("what is next?");
		expect(context.filter((m) => m.role === "system").length).toBe(1);
	});

	it("filters out ghost empty assistant messages (interrupted without content)", () => {
		const history: ChatMsg[] = [
			{ role: "user", content: "question 1" },
			// Interrupted during thinking, no reply generated, thinking stripped for non-deepseek provider
			{ role: "assistant", content: "", thinking: "aborted thoughts", status: "aborted" },
			{ role: "user", content: "question 2" },
		];

		const context = buildContext({
			history,
			includeThinking: false,
		});

		// Ghost empty assistant message must not be sent
		expect(context.map((m) => m.role)).toEqual(["system", "user", "user"]);
		expect(context.map((m) => m.content)).toEqual([expect.any(String), "question 1", "question 2"]);
	});

	it("strips dangling tool_calls that have no corresponding tool responses", () => {
		const history: ChatMsg[] = [
			{ role: "user", content: "call something" },
			// Assistant emitted tool call, but was aborted or crashed before tool responded
			{
				role: "assistant",
				content: "I will call a tool",
				tool_calls: [{ id: "orphan-call", name: "test_tool", args: {} }],
				status: "error",
			},
			{ role: "user", content: "try again" },
		];

		const context = buildContext({
			history,
		});

		const assistantMsg = context.find((m) => m.role === "assistant");
		expect(assistantMsg).toBeDefined();
		// Dangling tool_calls must be stripped to prevent HTTP 400
		expect(assistantMsg?.tool_calls).toBeUndefined();
		expect(assistantMsg?.content).toBe("I will call a tool");
	});

	it("preserves legitimate tool calls with matching tool responses", () => {
		const history: ChatMsg[] = [
			{ role: "user", content: "call something" },
			{
				role: "assistant",
				content: "",
				tool_calls: [{ id: "call-1", name: "test_tool", args: {} }],
				status: "complete",
			},
			{
				role: "tool",
				tool_call_id: "call-1",
				content: "tool output",
				status: "succeeded",
			},
		];

		const context = buildContext({
			history,
		});

		expect(context.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
		const assistantMsg = context.find((m) => m.role === "assistant");
		expect(assistantMsg?.tool_calls?.length).toBe(1);
		expect(assistantMsg?.tool_calls?.[0]?.id).toBe("call-1");
	});

	it("sanitizes wire messages in toWireMessages against empty frames", () => {
		const messages: ModelRequest["messages"] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "" }, // Empty
			{ role: "user", content: "next" },
		];

		const wire = toWireMessages(messages) as Array<{ role: string; content: string }>;
		expect(wire.length).toBe(2);
		expect(wire[0]?.role).toBe("user");
		expect(wire[1]?.role).toBe("user");
	});

	it("groups multiple parallel tool results into a single user message for Anthropic", () => {
		const messages: ModelRequest["messages"] = [
			{ role: "user", content: "run two tools" },
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{ id: "call-1", name: "tool_1", args: {} },
					{ id: "call-2", name: "tool_2", args: {} },
				],
			},
			{ role: "tool", tool_call_id: "call-1", content: "result 1", status: "succeeded" },
			{ role: "tool", tool_call_id: "call-2", content: "result 2", status: "succeeded" },
		];

		const anthropic = anthropicMessages({ messages, providerHooks: {} as any }) as Array<{ role: string; content: unknown }>;
		// Must strictly alternate user -> assistant -> user (3 messages total, NOT 4)
		expect(anthropic.length).toBe(3);
		expect(anthropic[0]?.role).toBe("user");
		expect(anthropic[1]?.role).toBe("assistant");
		expect(anthropic[2]?.role).toBe("user");

		// The 3rd message must contain BOTH tool_results
		const lastUserContent = anthropic[2]?.content as Array<{ type: string; tool_use_id: string }>;
		expect(Array.isArray(lastUserContent)).toBe(true);
		expect(lastUserContent.length).toBe(2);
		expect(lastUserContent[0]?.tool_use_id).toBe("call-1");
		expect(lastUserContent[1]?.tool_use_id).toBe("call-2");
	});

	it("merges consecutive user messages for Anthropic to maintain strictly alternating roles", () => {
		const messages: ModelRequest["messages"] = [
			{ role: "user", content: "[历史摘要] Previous context" },
			{ role: "user", content: "Current question" },
		];

		const anthropic = anthropicMessages({ messages, providerHooks: {} as any }) as Array<{ role: string; content: unknown }>;
		expect(anthropic.length).toBe(1);
		expect(anthropic[0]?.role).toBe("user");
		expect(anthropic[0]?.content).toBe("[历史摘要] Previous context\n\nCurrent question");
	});

	it("does not anchor compaction token estimates on stale pre-compaction usage", async () => {
		const { estimateContextTokens } = await import("../src/agent/context.js");
		const { clearRetainedUsage } = await import("../src/agent/compaction.js");

		// A retained assistant from before compaction still carries the absolute usage the
		// provider reported for the *pre-compaction* context.
		const staleUsage = { input: 110000, output: 2000, totalTokens: 112000 };
		const retained: import("../src/core/types.js").AgentMessage[] = [
			{ role: "assistant", content: "earlier reply", usage: staleUsage },
			{ role: "tool", tool_call_id: "c1", content: "tool output", status: "succeeded" },
		];

		// Anchoring on the stale usage reports the pre-compaction size.
		expect(estimateContextTokens(retained).tokens).toBeGreaterThan(100000);

		// After compaction clears retained usage, the estimate reflects the real context.
		const cleared = clearRetainedUsage(retained);
		expect((cleared[0] as { usage?: unknown }).usage).toBeUndefined();
		const after = estimateContextTokens([
			{ role: "compactionSummary", summary: "x".repeat(400), content: "compacted" },
			...cleared,
		]).tokens;
		expect(after).toBeLessThan(10000);

		// The source message must not be mutated (clone semantics stay intact).
		expect((retained[0] as { usage?: unknown }).usage).toBe(staleUsage);
	});
	it("anchors on trustworthy usage only and never marks a part-sum fallback as exact", async () => {
		const { estimateContextTokens } = await import("../src/agent/context.js");

		// Aborted / errored turns never saw a complete context; their usage must not anchor.
		const aborted = estimateContextTokens([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "cut off", status: "aborted", usage: { totalTokens: 99999 } },
		]);
		expect(aborted.tokens).toBeLessThan(99999);
		expect(aborted.actual).toBe(false);

		// A provider total is exact.
		const withTotal = estimateContextTokens([
			{ role: "assistant", content: "ok", status: "complete", usage: { totalTokens: 5000 } },
		]);
		expect(withTotal.tokens).toBe(5000);
		expect(withTotal.actual).toBe(true);

		// A part-sum fallback is a usable anchor but must stay marked as not exact.
		const partSum = estimateContextTokens([
			{ role: "assistant", content: "ok", status: "complete", usage: { input: 100, output: 20 } },
		]);
		expect(partSum.tokens).toBe(120);
		expect(partSum.actual).toBe(false);
	});
	it("skips empty assistant frames in Gemini and groups function responses", () => {
		const messages: ModelRequest["messages"] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "" }, // empty assistant
			{ role: "user", content: "run tool" },
			{ role: "assistant", content: "", tool_calls: [{ id: "call-1", name: "tool_1", args: {} }] },
			{ role: "tool", tool_call_id: "call-1", content: "result 1", status: "succeeded" },
		];

		const gemini = geminiRequest({ messages, providerHooks: {} as any }, true) as { contents: Array<{ role: string; parts: unknown[] }> };
		// Empty assistant must be skipped, tool result wrapped in user
		const roles = gemini.contents.map((c) => c.role);
		expect(roles).toEqual(["user", "model", "user"]);
	});

	it("convertToLlm cleanly projects custom and compactionSummary AgentMessages into LLM user turns", async () => {
		const { convertToLlm } = await import("../src/agent/context.js");
		const agentMessages: import("../src/core/types.js").AgentMessage[] = [
			{ role: "compactionSummary", summary: "compacted memory", content: "[历史摘要] compacted memory" },
			{ role: "custom", customType: "probe", content: "injected probe context" },
			{ role: "user", content: "user query" },
			{ role: "assistant", content: "assistant answer" },
		];

		const llmMessages = convertToLlm(agentMessages);
		expect(llmMessages.map((m) => m.role)).toEqual(["user", "user", "user", "assistant"]);
		expect(llmMessages[0]?.content).toBe("[历史摘要] compacted memory");
		expect(llmMessages[1]?.content).toBe("injected probe context");
		expect(llmMessages[2]?.content).toBe("user query");
		expect(llmMessages[3]?.content).toBe("assistant answer");
	});

	it("Subject stores custom message as role 'custom' in historySnapshot but projects cleanly to LLM", async () => {
		const { Subject } = await import("../src/agent/loop.js");
		const { ToolBroker } = await import("../src/tools/broker.js");
		const recordedRequests: ModelRequest[] = [];
		const model = mockModel({ id: "mock", name: "mock" });
		const stream: ModelStreamFn = async (_m, req, onDelta) => {
			recordedRequests.push(req);
			onDelta({ kind: "text", text: "acknowledged" });
			onDelta({ kind: "finish", reason: "stop" });
		};

		const subject = new Subject(model, stream, new ToolBroker());
		await subject.appendCustomMessage({
			customType: "test-probe",
			content: "PROBE_DATA_123",
		});

		// 1. Single-track fact: subject.historySnapshot() retains role: 'custom'
		const history = subject.historySnapshot();
		expect(history).toHaveLength(1);
		expect(history[0]?.role).toBe("custom");
		expect((history[0] as any).customType).toBe("test-probe");

		// 2. Next turn: pure projection converts it for LLM request
		await subject.pushInput("next question");
		await subject.waitForIdle();

		expect(recordedRequests.length).toBeGreaterThan(0);
		const lastReq = recordedRequests[0]!;
		const userTexts = lastReq.messages.filter((m) => m.role === "user").map((m) => m.content);
		expect(userTexts).toContain("PROBE_DATA_123");
		expect(userTexts).toContain("next question");
	});
});
