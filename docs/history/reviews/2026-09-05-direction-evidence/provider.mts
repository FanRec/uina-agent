/**
 * Read-only direction-review evidence. Run from the repository root:
 *   node --import tsx docs/history/reviews/2026-09-05-direction-evidence/provider.mts
 *
 * Four probes exercise production adapters and Subject with an in-process fetch
 * stub. No real network, user configuration, credentials, or storage are used.
 * Outputs describe the current behavior; they are not provider integration tests.
 */
import { createOpenAIProvider } from "../../../../src/ai/gateway.js";
import { geminiRequest } from "../../../../src/ai/providers.js";
import { Subject } from "../../../../src/agent/loop.js";
import type { LoopHooks } from "../../../../src/agent/loop.js";
import type { ModelRequest, StreamDelta } from "../../../../src/core/types.js";
import { NO_RUNTIME_HOOKS } from "../../../../src/runtime/noop.js";
import { ToolBroker } from "../../../../src/tools/broker.js";

function sse(events: Array<Record<string, unknown> | string>): string {
	return events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
}

const originalFetch = globalThis.fetch;
let fixtureBody: string | undefined;
let interceptedFetchCalls = 0;
globalThis.fetch = async () => {
	interceptedFetchCalls++;
	if (fixtureBody === undefined) throw new Error("No local SSE fixture selected");
	return new Response(fixtureBody, { headers: { "content-type": "text/event-stream" } });
};

const request: ModelRequest = {
	messages: [{ role: "user", content: "hello" }],
	providerHooks: NO_RUNTIME_HOOKS.provider,
};
const fixtureProvider = () => createOpenAIProvider({
	baseUrl: "http://provider-review.invalid",
	apiKey: "audit-fixture-not-a-real-key",
	model: "audit-fixture",
	modelContextWindow: 100_000,
	maxRetries: 0,
});

try {
	// Probe 1: a usage-only chunk follows the content finish marker.
	fixtureBody = sse([
		{ choices: [{ delta: { content: "ok" } }] },
		{ choices: [{ delta: {}, finish_reason: "stop" }] },
		{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
		"[DONE]",
	]);
	const output: StreamDelta[] = [];
	await fixtureProvider().stream(request, (delta) => output.push(delta));
	console.log(JSON.stringify({
		probe: "usage_after_finish",
		receivedProviderUsage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
		emittedKinds: output.map((delta) => delta.kind),
		emittedUsage: output.filter((delta) => delta.kind === "usage"),
	}));

	// Probe 2: capture wire controls, without assuming any model's default behavior.
	const low = geminiRequest({ ...request, thinkingLevel: "low" }, false);
	const high = geminiRequest({ ...request, thinkingLevel: "high" }, false);
	const off = geminiRequest({ ...request, thinkingLevel: "off" }, false);
	console.log(JSON.stringify({
		probe: "gemini_thinking_levels",
		lowAndHighIdentical: JSON.stringify(low) === JSON.stringify(high),
		lowGenerationConfig: low.generationConfig ?? null,
		highGenerationConfig: high.generationConfig ?? null,
		offGenerationConfig: off.generationConfig ?? null,
	}));

	// Probe 3: inspect where a provider-native tool signature is replayed.
	const replay = geminiRequest({
		...request,
		messages: [
			{ role: "assistant", content: "", tool_calls: [{ id: "c", name: "echo", args: {}, thinkingSignature: "native-signature" }] },
			{ role: "tool", tool_call_id: "c", content: "ok" },
		],
	}, false);
	const contents = replay.contents as Array<{ role: string; parts: unknown[] }>;
	console.log(JSON.stringify({
		probe: "gemini_thought_signature_wire",
		replayedModelPart: contents.find((content) => content.role === "model")?.parts[0],
	}));

	// Probe 4: only the input count is supplied, then a nonempty answer is emitted.
	fixtureBody = sse([
		{ usage: { prompt_tokens: 10 } },
		{ choices: [{ delta: { content: "Output exists; its token count is not reported." } }] },
		{ choices: [{ delta: {}, finish_reason: "stop" }] },
		"[DONE]",
	]);
	const summaries: Array<Parameters<NonNullable<LoopHooks["onTurnEnd"]>>[1]> = [];
	const errors: string[] = [];
	const subject = new Subject(fixtureProvider(), new ToolBroker(), {
		onToken: () => {},
		onTurnEnd: (_turn, usage) => summaries.push(usage),
		onError: (error) => errors.push(error),
	}, { systemPrompt: "fixture" });
	await subject.pushInput("hello");
	await subject.waitForIdle();
	console.log(JSON.stringify({
		probe: "partial_usage_truth",
		receivedProviderUsage: { prompt_tokens: 10 },
		turnSummary: summaries.map((usage) => ({
			usedTokens: usage?.usedTokens,
			actual: usage?.actual,
			inputTokens: usage?.inputTokens,
			outputTokens: usage?.outputTokens,
		})),
		storedUsage: subject.historySnapshot().flatMap((message) => message.role === "assistant" ? [message.usage] : []),
		errors,
	}));
	console.log(JSON.stringify({ boundary: "in_process_fetch_stub", interceptedFetchCalls, realNetworkCalls: 0 }));
} finally {
	globalThis.fetch = originalFetch;
}
