import type { ModelProvider, ModelRequest, ThinkingLevel, Usage } from "../core/types.js";
import { resolveOfficialThinkingLevels, type ProviderConfig, type ProviderKind } from "./config.js";
import { createOpenAIProvider } from "./gateway.js";
import { fetchWithRetry } from "./gateway.js";
import { parseSSE, ProviderProtocolError } from "./sse.js";
import { effectiveContextWindow } from "./config.js";

export function createProvider(name: string, conf: ProviderConfig): ModelProvider {
	const kind: ProviderKind = conf.type ?? "openai-compatible";
	if (kind === "openai-compatible") return createOpenAIProvider({ ...conf, model: conf.model, modelContextWindow: effectiveContextWindow(conf) });
	if (kind === "anthropic") return createAnthropicProvider(name, conf);
	return createGeminiProvider(name, conf);
}

function levels(conf: ProviderConfig): readonly ThinkingLevel[] {
	return resolveOfficialThinkingLevels(conf);
}

function createAnthropicProvider(name: string, conf: ProviderConfig): ModelProvider {
	return {
		name: conf.model,
		contextWindow: effectiveContextWindow(conf),
		thinkingLevels: levels(conf),
		includeThinking: true,
		async stream(req, emit, signal) {
			const level = req.thinkingLevel ?? "off";
			const thinking = level === "off" ? undefined : thinkingBudget(level);
			let body: Record<string, unknown> = {
				model: conf.model,
				max_tokens: Math.max(8192, (thinking ?? 0) + 1024),
				system: anthropicSystem(req),
				messages: anthropicMessages(req),
				tools: req.tools?.map((tool) => ({
					name: tool.function.name,
					description: tool.function.description,
					input_schema: tool.function.parameters,
				})),
				stream: true,
			};
			if (thinking) body.thinking = { type: "enabled", budget_tokens: thinking };

			let headers: Record<string, string> = {
				"content-type": "application/json",
				"x-api-key": conf.apiKey,
				"anthropic-version": "2023-06-01",
				accept: "text/event-stream",
			};

			if (req.extensionHost) {
				headers = await req.extensionHost.emitBeforeProviderHeaders(conf.model, headers);
				body = (await req.extensionHost.emitBeforeProviderRequest(conf.model, body)) as Record<string, unknown>;
			}

			const response = await fetchWithRetry(`${conf.baseUrl.replace(/\/$/, "")}/messages`, { maxRetries: conf.maxRetries ?? 2, signal, request: { method: "POST", signal, headers, body: JSON.stringify(body) } });

			if (req.extensionHost) {
				const respHeaders: Record<string, string> = {};
				response.headers.forEach((v, k) => {
					respHeaders[k] = v;
				});
				await req.extensionHost.emitAfterProviderResponse(conf.model, response.status, respHeaders);
			}

			if (!response.ok) throw new Error(`Anthropic ${name} 请求失败 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
			if (!response.body) throw new ProviderProtocolError("Anthropic 响应无 body");
			let finished = false;
			let finishReason = "stop";
			const calls = new Map<number, { id: string; name: string; args: string }>();
			await parseSSE(response.body, (data, index) => {
				let event: AnthropicEvent;
				try { event = JSON.parse(data) as AnthropicEvent; } catch (error) { throw new ProviderProtocolError(`Anthropic SSE ${index} JSON 无效: ${String(error)}`, index); }
				if (event.type === "content_block_delta") {
					const delta = event.delta;
					if (delta?.type === "thinking_delta" && delta.thinking) emit({ kind: "thinking", text: delta.thinking });
					if (delta?.type === "signature_delta" && delta.signature) emit({ kind: "thinking_signature", signature: delta.signature });
					if (delta?.type === "text_delta" && delta.text) emit({ kind: "text", text: delta.text });
					if (delta?.type === "input_json_delta") {
						const call = calls.get(event.index ?? 0); if (call) call.args += delta.partial_json ?? "";
					}
				}
				if (event.type === "message_start" && event.message?.usage) emit({ kind: "usage", usage: anthropicUsage(event.message.usage) });
				if (event.type === "message_delta" && event.usage) emit({ kind: "usage", usage: anthropicUsage(event.usage) });
				if (event.type === "content_block_start" && event.content_block?.type === "tool_use") calls.set(event.index ?? 0, { id: event.content_block.id ?? "", name: event.content_block.name ?? "", args: "" });
				if (event.type === "content_block_stop" && calls.has(event.index ?? 0)) {
					const call = calls.get(event.index ?? 0)!;
					if (!call.id || !call.name) throw new ProviderProtocolError("Anthropic tool call 缺少 id 或 name", index);
					emit({ kind: "tool_call", call: { ...call, args: call.args || "{}", argsValid: isJsonObject(call.args || "{}") } });
				}
				if (event.type === "message_delta" && event.delta?.stop_reason) finishReason = event.delta.stop_reason === "tool_use" ? "tool_calls" : event.delta.stop_reason === "max_tokens" ? "length" : "stop";
				if (event.type === "message_stop") { finished = true; emit({ kind: "finish", reason: finishReason }); }
			}, signal);
			if (!finished) throw new ProviderProtocolError("Anthropic 流缺少 message_stop");
		},
	};
}

function createGeminiProvider(name: string, conf: ProviderConfig): ModelProvider {
	return {
		name: conf.model,
		contextWindow: effectiveContextWindow(conf),
		thinkingLevels: levels(conf),
		async stream(req, emit, signal) {
			let headers: Record<string, string> = {
				"content-type": "application/json",
				accept: "text/event-stream",
			};
			let bodyPayload = geminiRequest(req);

			if (req.extensionHost) {
				headers = await req.extensionHost.emitBeforeProviderHeaders(conf.model, headers);
				bodyPayload = (await req.extensionHost.emitBeforeProviderRequest(conf.model, bodyPayload)) as Record<string, unknown>;
			}

			const response = await fetchWithRetry(`${conf.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(conf.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(conf.apiKey)}`, { maxRetries: conf.maxRetries ?? 2, signal, request: { method: "POST", signal, headers, body: JSON.stringify(bodyPayload) } });

			if (req.extensionHost) {
				const respHeaders: Record<string, string> = {};
				response.headers.forEach((v, k) => {
					respHeaders[k] = v;
				});
				await req.extensionHost.emitAfterProviderResponse(conf.model, response.status, respHeaders);
			}

			if (!response.ok) throw new Error(`Gemini ${name} 请求失败 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
			if (!response.body) throw new ProviderProtocolError("Gemini 响应无 body");
			let finished = false;
			await parseSSE(response.body, (data, index) => {
				let chunk: GeminiChunk;
				try { chunk = JSON.parse(data) as GeminiChunk; } catch (error) { throw new ProviderProtocolError(`Gemini SSE ${index} JSON 无效: ${String(error)}`, index); }
				for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
					if (part.thought && part.text) emit({ kind: "thinking", text: part.text });
					else if (part.text) emit({ kind: "text", text: part.text });
					if (part.functionCall) emit({ kind: "tool_call", call: { id: part.functionCall.id ?? part.functionCall.name, name: part.functionCall.name, args: JSON.stringify(part.functionCall.args ?? {}), argsValid: true } });
				}
				if (chunk.usageMetadata) emit({ kind: "usage", usage: geminiUsage(chunk.usageMetadata) });
				if (chunk.candidates?.[0]?.finishReason) { finished = true; emit({ kind: "finish", reason: chunk.candidates[0].finishReason === "STOP" ? "stop" : "length" }); }
			}, signal);
			if (!finished) throw new ProviderProtocolError("Gemini 流缺少 finishReason");
		},
	};
}

function anthropicSystem(req: ModelRequest): string | undefined {
	const text = req.messages.filter((message) => message.role === "system").map((message) => message.content).filter(Boolean).join("\n\n");
	return text || undefined;
}

function anthropicMessages(req: ModelRequest): unknown[] {
	return req.messages.filter((message) => message.role !== "system").map((message) => {
		if (message.role === "tool") return { role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content, is_error: message.status && message.status !== "succeeded" }] };
		if (message.role === "assistant") {
			const content: unknown[] = [];
			if (message.thinking) content.push({ type: "thinking", thinking: message.thinking, signature: message.thinkingSignature ?? "" });
			if (message.content) content.push({ type: "text", text: message.content });
			for (const call of message.tool_calls ?? []) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
			return { role: "assistant", content: content.length ? content : "" };
		}
		return { role: "user", content: message.content };
	});
}

function geminiRequest(req: ModelRequest): Record<string, unknown> {
	const system = req.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
	const contents = req.messages.filter((message) => message.role !== "system").map((message) => {
		if (message.role === "tool") return { role: "user", parts: [{ functionResponse: { name: message.tool_call_id, response: { content: message.content, status: message.status ?? "succeeded" } } }] };
		if (message.role === "assistant") {
			const parts: unknown[] = [];
			if (message.content) parts.push({ text: message.content });
			for (const call of message.tool_calls ?? []) parts.push({ functionCall: { id: call.id, name: call.name, args: call.args } });
			return { role: "model", parts: parts.length ? parts : [{ text: "" }] };
		}
		return { role: "user", parts: [{ text: message.content }] };
	});
	return {
		contents,
		...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
		...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })) }] } : {}),
		...(req.thinkingLevel && req.thinkingLevel !== "off" ? { generationConfig: { thinkingConfig: { includeThoughts: true } } } : {}),
	};
}

function thinkingBudget(level: ThinkingLevel): number { return { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32768, off: 0 }[level]; }
function isJsonObject(value: string): boolean { try { const parsed = JSON.parse(value); return !!parsed && typeof parsed === "object" && !Array.isArray(parsed); } catch { return false; } }

function anthropicUsage(raw: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens_details?: { thinking_tokens?: number } }): Usage { const cacheRead = raw.cache_read_input_tokens ?? 0; const cacheWrite = raw.cache_creation_input_tokens ?? 0; const input = raw.input_tokens ?? 0; const output = raw.output_tokens ?? 0; return { input, output, cacheRead, cacheWrite, reasoning: raw.output_tokens_details?.thinking_tokens ?? 0, totalTokens: input + output + cacheRead + cacheWrite }; }
function geminiUsage(raw: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number; totalTokenCount?: number }): Usage { const cacheRead = raw.cachedContentTokenCount ?? 0; const input = Math.max(0, (raw.promptTokenCount ?? 0) - cacheRead); const output = (raw.candidatesTokenCount ?? 0) + (raw.thoughtsTokenCount ?? 0); return { input, output, cacheRead, cacheWrite: 0, reasoning: raw.thoughtsTokenCount ?? 0, totalTokens: raw.totalTokenCount ?? input + output + cacheRead }; }
interface AnthropicEvent { type?: string; index?: number; delta?: { type?: string; thinking?: string; text?: string; partial_json?: string; signature?: string; stop_reason?: string | null }; content_block?: { type?: string; id?: string; name?: string }; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens_details?: { thinking_tokens?: number } }; message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }; }
interface GeminiChunk { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number; totalTokenCount?: number }; candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ thought?: boolean; text?: string; functionCall?: { id?: string; name: string; args?: Record<string, unknown> } }> } }> }

export class ModelRegistry {
	private instances = new Map<string, ModelProvider>();
	private config?: import("./config.js").UinaConfig;

	constructor(config?: import("./config.js").UinaConfig) {
		this.config = config;
	}

	resolve(modelOrProviderName: string): ModelProvider {
		if (this.instances.has(modelOrProviderName)) {
			return this.instances.get(modelOrProviderName)!;
		}

		// 1. 尝试从已配置的 auth.json 中获取
		if (this.config?.providers[modelOrProviderName]) {
			const conf = this.config.providers[modelOrProviderName];
			const provider = createProvider(modelOrProviderName, conf);
			this.instances.set(modelOrProviderName, provider);
			return provider;
		}

		throw new Error(`未配置或未注册的模型/Provider: ${modelOrProviderName}`);
	}

	register(name: string, provider: ModelProvider): () => void {
		if (this.instances.has(name)) throw new Error(`Provider 已注册: ${name}`);
		this.instances.set(name, provider);
		return () => { if (this.instances.get(name) === provider) this.instances.delete(name); };
	}

	choices(): Array<{ id: string; name: string }> {
		const configured = Object.entries(this.config?.providers ?? {}).map(([id, value]) => ({ id, name: value.model }));
		const registered = [...this.instances.entries()].map(([id, provider]) => ({ id, name: provider.name }));
		return [...configured, ...registered.filter((candidate) => !configured.some((item) => item.id === candidate.id))];
	}
}
