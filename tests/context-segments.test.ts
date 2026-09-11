import { describe, expect, it } from "vitest";
import {
	countContextSegmentChars,
	calculateContextSegments,
	estimateRequestTokens,
	estimateContextTokens,
} from "../src/agent/context.js";
import type { AgentMessage, ChatMsg, ToolDef } from "../src/core/types.js";

describe("Context Segments & Unified Token Estimation", () => {
	const sampleTools: ToolDef[] = [
		{
			type: "function",
			function: {
				name: "search_tool",
				description: "搜索工具",
				parameters: { type: "object", properties: { q: { type: "string" } } },
			},
		},
	];

	it("countContextSegmentChars safely counts characters in five distinct segments", () => {
		const messages: (AgentMessage | ChatMsg)[] = [
			{ role: "system", content: "You are Uina." }, // system: 13 + 16 = 29
			{ role: "user", content: "Hello" }, // prompt: 5 + 16 = 21
			{ role: "custom", content: "custom alert", customType: "notice" }, // prompt: 12 + 16 = 28
			{ role: "compactionSummary", summary: "short summary" }, // prompt: 13 + 32 = 45
			{
				role: "assistant",
				content: "I will use search.", // assistant: 18 + 16 = 34
				thinking: "pondering query", // thinking: 15 + 16 = 31
				tool_calls: [{ id: "c1", name: "search_tool", args: { q: "abc" } }], // tools: JSON.stringify.length
			},
			{ role: "tool", tool_call_id: "c1", content: "result found" }, // tools: 12 + 16 = 28
		];

		const seg = countContextSegmentChars(messages, sampleTools);

		expect(seg.system).toBe(29);
		expect(seg.prompt).toBe(21 + 28 + 45);
		expect(seg.assistant).toBe(34);
		expect(seg.thinking).toBe(31);
		const expectedToolCallsChars = JSON.stringify([{ id: "c1", name: "search_tool", args: { q: "abc" } }]).length;
		const expectedToolsChars = JSON.stringify(sampleTools).length;
		expect(seg.tools).toBe(28 + expectedToolCallsChars + expectedToolsChars);
	});

	it("does not inflate tool chars when tools array is empty", () => {
		const seg = countContextSegmentChars([], []);
		expect(seg.tools).toBe(0);
		expect(seg.system).toBe(0);
		expect(seg.prompt).toBe(0);
		expect(seg.assistant).toBe(0);
		expect(seg.thinking).toBe(0);

		const estimate = estimateRequestTokens([], []);
		expect(estimate).toBe(0);
	});

	it("estimateRequestTokens accurately derives from segment character counts", () => {
		const messages: ChatMsg[] = [
			{ role: "user", content: "1234" }, // 4 + 16 = 20
			{ role: "assistant", content: "5678", thinking: "abcd" }, // 4 + 16 = 20; thinking: 4 + 16 = 20
		];

		// Without thinking: totalChars = 20 + 20 = 40 => 40 / 4 = 10
		const tokensWithoutThinking = estimateRequestTokens(messages, [], false);
		expect(tokensWithoutThinking).toBe(10);

		// With thinking: totalChars = 20 + 20 + 20 = 60 => 60 / 4 = 15
		const tokensWithThinking = estimateRequestTokens(messages, [], true);
		expect(tokensWithThinking).toBe(15);
	});

	it("calculateContextSegments supports unscaled ceil and scaled proportional distribution", () => {
		const messages: ChatMsg[] = [
			{ role: "system", content: "sys" }, // 3 + 16 = 19
			{ role: "user", content: "usr" }, // 3 + 16 = 19
			{ role: "assistant", content: "ast", thinking: "thk" }, // ast: 19, thk: 19
		];

		// Unscaled: Math.ceil(19 / 4) = 5 for each
		const unscaled = calculateContextSegments(messages);
		expect(unscaled).toEqual({
			system: 5,
			prompt: 5,
			assistant: 5,
			thinking: 5,
			tools: 0,
		});

		// Scaled: exact sum equals totalScaleTokens
		const scaled = calculateContextSegments(messages, [], 100);
		const sum = scaled.system + scaled.prompt + scaled.assistant + scaled.thinking + scaled.tools;
		expect(sum).toBe(100);
		expect(scaled.tools).toBe(0);
	});

	it("calculateContextSegments returns all zeros on empty input", () => {
		const empty = calculateContextSegments([], []);
		expect(empty).toEqual({ system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 });
	});

	it("estimateContextTokens anchors at last assistant usage and calculates trailing tokens with tools option", () => {
		const messages: (AgentMessage | ChatMsg)[] = [
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: "response 1",
				usage: { input: 10, output: 5, totalTokens: 15 },
			},
			{ role: "user", content: "hello 2" }, // trailing: 7 + 16 = 23 chars => 6 tokens
		];

		// Anchored at index 1 with 15 tokens + trailing (6 tokens) = 21 tokens
		const estimate = estimateContextTokens(messages);
		expect(estimate.actual).toBe(false);
		expect(estimate.tokens).toBe(21);

		// When trailing is empty, actual is true
		const exact = estimateContextTokens(messages.slice(0, 2));
		expect(exact.actual).toBe(true);
		expect(exact.tokens).toBe(15);

		// With tools option
		const withTools = estimateContextTokens(messages, { tools: sampleTools });
		expect(withTools.tokens).toBeGreaterThan(21);
	});

	it("handles undefined message content defensively without throwing", () => {
		const messages = [
			{ role: "user", content: undefined as unknown as string },
			{ role: "assistant", content: "" },
		] as ChatMsg[];

		expect(() => countContextSegmentChars(messages)).not.toThrow();
		const seg = countContextSegmentChars(messages);
		expect(seg.prompt).toBe(16);
		expect(seg.assistant).toBe(16);
	});
});
