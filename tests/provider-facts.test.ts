import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createProvider, anthropicMessages, geminiRequest } from "../src/ai/providers.js";
import { configuredThinkingLevels } from "../src/ai/config.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";
import type { ChatMsg, StreamDelta } from "../src/core/types.js";
import { estimateContextTokens } from "../src/agent/context.js";
import { UIHost } from "../src/ui/ui-host.js";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });
async function endpoint(events: unknown[], capture?: (body: Record<string, unknown>) => void) {
	const server = createServer((req, res) => {
		let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => {
			capture?.(JSON.parse(body)); res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""));
		});
	}); servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const finish = { choices: [{ delta: {}, finish_reason: "stop" }] };
const request = { messages: [{ role: "user" as const, content: "test" }], providerHooks: NO_RUNTIME_HOOKS.provider };

it("retains usage-only tail and keeps missing output and total unknown", async () => {
	const baseUrl = await endpoint([finish, { choices: [], usage: { prompt_tokens: 100 } }, "[DONE]"]);
	const provider = createProvider("fixture", { baseUrl, apiKey: "test", model: "fixture", modelContextWindow: 4096 });
	const deltas: StreamDelta[] = []; await provider.stream(request, delta => deltas.push(delta));
	const usage = deltas.find(d => d.kind === "usage");
	expect(usage).toMatchObject({ usage: { input: 100 } });
	if (usage?.kind !== "usage") throw new Error("missing usage");
	expect(usage.usage.output).toBeUndefined(); expect(usage.usage.totalTokens).toBeUndefined();
	expect(estimateContextTokens([{ role: "assistant", content: "small", usage: usage.usage }]).actual).toBe(false);
});

it("rejects content after finish instead of silently discarding it", async () => {
	const baseUrl = await endpoint([finish, { choices: [{ delta: { content: "illegal" } }] }, "[DONE]"]);
	const provider = createProvider("fixture", { baseUrl, apiKey: "test", model: "fixture", modelContextWindow: 4096 });
	await expect(provider.stream(request, () => {})).rejects.toThrow("额外内容");
});

it.each(["off", "high", "max"] as const)("encodes DeepSeek %s without collapsing levels", async level => {
	let body: Record<string, unknown> = {};
	const baseUrl = await endpoint([finish, "[DONE]"], value => { body = value; });
	const provider = createProvider("fixture", { baseUrl, apiKey: "test", model: "deepseek-v4-flash", modelContextWindow: 4096, thinkingFormat: "deepseek", thinkingLevels: ["off", "high", "max"] });
	await provider.stream({ ...request, thinkingLevel: level }, () => {});
	expect(body.thinking).toEqual({ type: level === "off" ? "disabled" : "enabled" });
	expect(body.reasoning_effort).toBe(level === "off" ? undefined : level);
});

it("preserves ordered signed provider blocks through adapter replay", async () => {
	const blocks = [{ type: "text", text: "before" }, { type: "thinking", thinking: "thought", signature: "signature" }, { type: "redacted_thinking", data: "opaque" }, { type: "text", text: "after" }];
	const baseUrl = await endpoint([{ type: "message_start" }, ...blocks.flatMap((content_block, index) => [{ type: "content_block_start", index, content_block }, { type: "content_block_stop", index }]), { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }]);
	const provider = createProvider("fixture", { baseUrl, apiKey: "test", model: "fixture", modelContextWindow: 4096, type: "anthropic", maxOutputTokens: 4096 });
	const deltas: StreamDelta[] = []; await provider.stream(request, delta => deltas.push(delta));
	const replay = deltas.find(d => d.kind === "provider_replay"); if (replay?.kind !== "provider_replay") throw new Error("missing replay");
	const messages: ChatMsg[] = [{ role: "assistant", content: "beforeafter", thinking: "thought", providerReplay: JSON.parse(JSON.stringify(replay.replay)) }];
	expect(anthropicMessages({ ...request, messages })).toEqual([{ role: "assistant", content: blocks }]);
	const gemini = geminiRequest({ ...request, messages: [{ role: "assistant", content: "", tool_calls: [{ id: "call", name: "probe", args: {}, thinkingSignature: "signed" }] }] }, false);
	expect(gemini.contents).toEqual([{ role: "model", parts: [{ functionCall: { name: "probe", args: {} }, thoughtSignature: "signed" }] }]);
});

	it("UI cannot expand the declared thinking controls", () => {
		const ui = new UIHost(); ui.setThinkingLevels(["off", "low"]);
		expect(() => ui.setReasoningEffort("high")).toThrow("不支持");
		expect(geminiRequest({ ...request, thinkingLevel: "low" }, false, "level").generationConfig).toEqual({ thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } });
	});

	it("explicit configuration is the only source of thinking levels; nothing is invented", () => {
		// 显式声明不再被按模型名的档位表静默收窄，也不会被静默抹掉。
		expect(configuredThinkingLevels({ baseUrl: "", apiKey: "", model: "gemini-2.5-pro", type: "gemini", thinkingLevels: ["off", "high"] })).toEqual(["off", "high"]);
		expect(configuredThinkingLevels({ baseUrl: "", apiKey: "", model: "qwen-max", type: "openai-compatible", thinkingFormat: "qwen", thinkingLevels: ["off", "high"] })).toEqual(["off", "high"]);
		// 未声明就是未知，而不是补造一个默认档位。
		expect(configuredThinkingLevels({ baseUrl: "", apiKey: "", model: "gemini-2.5-pro", type: "gemini" })).toBeUndefined();
		// 缺少 wire 控制方式时报错，而不是按模型名猜一个。
		expect(() => createProvider("g", { baseUrl: "https://example.test", apiKey: "x", model: "gemini-9-pro", modelContextWindow: 4096, type: "gemini", thinkingLevels: ["off", "high"] })).toThrow("geminiThinkingFormat");
		// 数值预算必须显式给出，不能由代码发明。
		expect(() => createProvider("g", { baseUrl: "https://example.test", apiKey: "x", model: "g", modelContextWindow: 4096, type: "gemini", thinkingLevels: ["high"], geminiThinkingFormat: "budget" })).toThrow("thinkingBudgets");
		// Anthropic 的 max_tokens 同样必须显式，而不是补一个 8192。
		expect(() => createProvider("a", { baseUrl: "https://example.test", apiKey: "x", model: "a", modelContextWindow: 4096, type: "anthropic" })).toThrow("maxOutputTokens");
	});
