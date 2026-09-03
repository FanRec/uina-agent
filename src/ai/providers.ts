import type { ModelProvider, ModelRequest, ThinkingLevel } from "../core/types.js";
import type { ProviderConfig, ProviderKind } from "./config.js";
import { createOpenAIProvider } from "./gateway.js";
import { parseSSE, ProviderProtocolError } from "./sse.js";

export function createProvider(name: string, conf: ProviderConfig): ModelProvider {
	const kind: ProviderKind = conf.type ?? "openai-compatible";
	if (kind === "openai-compatible") return createOpenAIProvider({ ...conf, model: conf.model });
	if (kind === "anthropic") return createAnthropicProvider(name, conf);
	return createGeminiProvider(name, conf);
}

function levels(conf: ProviderConfig): readonly ThinkingLevel[] {
	return conf.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
}

function createAnthropicProvider(name: string, conf: ProviderConfig): ModelProvider {
	return {
		name: conf.model,
		contextWindow: conf.contextWindow,
		thinkingLevels: levels(conf),
		includeThinking: true,
		async stream(req, emit, signal) {
			const level = req.thinkingLevel ?? "off";
			let body: Record<string, unknown> = {
				model: conf.model,
				max_tokens: 8192,
				messages: anthropicMessages(req),
				tools: req.tools?.map((tool) => ({
					name: tool.function.name,
					description: tool.function.description,
					input_schema: tool.function.parameters,
				})),
				stream: true,
			};
			if (level !== "off") body.thinking = { type: "enabled", budget_tokens: thinkingBudget(level) };

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

			const response = await fetch(`${conf.baseUrl.replace(/\/$/, "")}/messages`, {
				method: "POST",
				signal,
				headers,
				body: JSON.stringify(body),
			});

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
		contextWindow: conf.contextWindow,
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

			const response = await fetch(`${conf.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(conf.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(conf.apiKey)}`, {
				method: "POST",
				signal,
				headers,
				body: JSON.stringify(bodyPayload),
			});

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
				if (chunk.candidates?.[0]?.finishReason) { finished = true; emit({ kind: "finish", reason: chunk.candidates[0].finishReason === "STOP" ? "stop" : "length" }); }
			}, signal);
			if (!finished) throw new ProviderProtocolError("Gemini 流缺少 finishReason");
		},
	};
}

function anthropicMessages(req: ModelRequest): unknown[] {
	return req.messages.filter((message) => message.role !== "system").map((message) => {
		if (message.role !== "assistant" || !message.thinking) return { role: message.role === "assistant" ? "assistant" : "user", content: message.content };
		return { role: "assistant", content: [{ type: "thinking", thinking: message.thinking, signature: message.thinkingSignature ?? "" }, ...(message.content ? [{ type: "text", text: message.content }] : [])] };
	});
}

function geminiRequest(req: ModelRequest): Record<string, unknown> {
	return { contents: req.messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })), systemInstruction: { parts: [{ text: req.messages.find((message) => message.role === "system")?.content ?? "" }] }, generationConfig: req.thinkingLevel && req.thinkingLevel !== "off" ? { thinkingConfig: { includeThoughts: true } } : undefined };
}

function thinkingBudget(level: ThinkingLevel): number { return { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32768, off: 0 }[level]; }
function isJsonObject(value: string): boolean { try { const parsed = JSON.parse(value); return !!parsed && typeof parsed === "object" && !Array.isArray(parsed); } catch { return false; } }

interface AnthropicEvent { type?: string; index?: number; delta?: { type?: string; thinking?: string; text?: string; partial_json?: string; signature?: string; stop_reason?: string | null }; content_block?: { type?: string; id?: string; name?: string }; }
interface GeminiChunk { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ thought?: boolean; text?: string; functionCall?: { id?: string; name: string; args?: Record<string, unknown> } }> } }> }

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

		// 2. 尝试解析厂商/模型格式
		const normalized = modelOrProviderName.toLowerCase();
		let conf: ProviderConfig | null = null;

		if (normalized.includes("deepseek")) {
			const apiKey = process.env.DEEPSEEK_API_KEY || process.env.UINA_API_KEY_DEEPSEEK || "";
			if (!apiKey) throw new Error(`缺少 DeepSeek API Key (请设置环境变量 DEEPSEEK_API_KEY)`);
			conf = {
				baseUrl: "https://api.deepseek.com",
				apiKey,
				model: modelOrProviderName.replace(/^deepseek\//i, ""),
				thinkingFormat: "deepseek",
				contextWindow: 65536,
				thinkingLevels: ["off", "minimal", "low", "medium", "high", "max"],
			};
		} else if (normalized.includes("claude") || normalized.includes("anthropic")) {
			const apiKey = process.env.ANTHROPIC_API_KEY || process.env.UINA_API_KEY_ANTHROPIC || "";
			if (!apiKey) throw new Error(`缺少 Anthropic API Key (请设置环境变量 ANTHROPIC_API_KEY)`);
			conf = {
				baseUrl: "https://api.anthropic.com/v1",
				apiKey,
				model: modelOrProviderName.replace(/^anthropic\//i, ""),
				type: "anthropic",
				contextWindow: 200000,
				thinkingLevels: ["off", "low", "medium", "high", "max"],
			};
		} else if (normalized.includes("gpt") || normalized.includes("openai") || normalized.includes("o1") || normalized.includes("o3")) {
			const apiKey = process.env.OPENAI_API_KEY || process.env.UINA_API_KEY_OPENAI || "";
			if (!apiKey) throw new Error(`缺少 OpenAI API Key (请设置环境变量 OPENAI_API_KEY)`);
			conf = {
				baseUrl: "https://api.openai.com/v1",
				apiKey,
				model: modelOrProviderName.replace(/^openai\//i, ""),
				contextWindow: 128000,
				thinkingLevels: normalized.includes("o1") || normalized.includes("o3") ? ["off", "low", "medium", "high"] : ["off"],
			};
		} else if (normalized.includes("ollama")) {
			const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
			conf = {
				baseUrl,
				apiKey: "ollama",
				model: modelOrProviderName.replace(/^ollama\//i, ""),
				contextWindow: 32768,
				thinkingLevels: ["off"],
			};
		}

		if (conf) {
			const provider = createProvider(modelOrProviderName, conf);
			this.instances.set(modelOrProviderName, provider);
			return provider;
		}

		throw new Error(`无法识别的模型或提供商: ${modelOrProviderName}，且未在 auth.json 中配置`);
	}

	register(name: string, provider: ModelProvider): void {
		this.instances.set(name, provider);
	}
}
