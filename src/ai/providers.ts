import type { FinishReason, ModelProvider, ModelRequest, ThinkingLevel, Usage } from "../core/types.js";
import { configuredThinkingLevels, type ProviderConfig, type ProviderKind } from "./config.js";
import { createOpenAIProvider, fetchWithRetry } from "./gateway.js";
import { parseSSE, ProviderProtocolError } from "./sse.js";
import { effectiveContextWindow } from "./config.js";
import { copyValue, readonlySnapshot } from "../runtime/guard.js";

export function createProvider(name: string, conf: ProviderConfig): ModelProvider {
	const kind: ProviderKind = conf.type ?? "openai-compatible";
	if (kind === "openai-compatible") {
		return createOpenAIProvider({ ...conf, model: conf.model, modelContextWindow: effectiveContextWindow(conf) });
	}
	if (kind === "anthropic") return createAnthropicProvider(name, conf);
	return createGeminiProvider(name, conf);
}

function levels(conf: ProviderConfig): readonly ThinkingLevel[] | undefined {
	return configuredThinkingLevels(conf);
}

function createAnthropicProvider(name: string, conf: ProviderConfig): ModelProvider {
	return {
		name: conf.model,
		contextWindow: effectiveContextWindow(conf),
		thinkingLevels: levels(conf),
		includeThinking: Boolean(levels(conf)?.some((level) => level !== "off")),
		async refreshModels() {
			const response = await fetch(`${conf.baseUrl.replace(/\/$/, "")}/models`, {
				headers: { "x-api-key": conf.apiKey, "anthropic-version": "2023-06-01" },
			});
			if (!response.ok) throw new Error(`Anthropic 模型目录请求失败 HTTP ${response.status}`);
			const payload = (await response.json()) as { data?: Array<{ id?: string }> };
			return (payload.data ?? []).flatMap((model) => typeof model.id === "string" ? [{ id: model.id }] : []);
		},
		async stream(req, emit, signal) {
			const level = req.thinkingLevel ?? "off";
			const thinking = level === "off" ? undefined : thinkingBudget(level);
			let body: Record<string, unknown> = {
				model: conf.model,
				max_tokens: Math.max(8192, (thinking ?? 0) + 1024),
				system: anthropicSystem(req),
				messages: anthropicMessages(req),
				tools: req.tools?.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })),
				stream: true,
			};
			if (thinking) body.thinking = { type: "enabled", budget_tokens: thinking };

			let headers: Record<string, string> = {
				"content-type": "application/json",
				"x-api-key": conf.apiKey,
				"anthropic-version": "2023-06-01",
				accept: "text/event-stream",
			};
			headers = copyValue(await req.providerHooks.transformHeaders(conf.model, readonlySnapshot(headers)));
			body = copyValue(await req.providerHooks.transformPayload(conf.model, readonlySnapshot(body))) as Record<string, unknown>;

			const response = await fetchWithRetry(`${conf.baseUrl.replace(/\/$/, "")}/messages`, {
				maxRetries: conf.maxRetries ?? 2,
				signal,
				request: { method: "POST", signal, headers, body: JSON.stringify(body) },
			});
			const respHeaders: Record<string, string> = {};
			response.headers.forEach((value, key) => { respHeaders[key] = value; });
			await req.providerHooks.observeResponse(readonlySnapshot({ provider: conf.model, status: response.status, headers: respHeaders }));

			if (!response.ok) throw new Error(`Anthropic ${name} 请求失败 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
			if (!response.body) throw new ProviderProtocolError("Anthropic 响应无 body");

			let sawMessageStart = false;
			let sawMessageStop = false;
			let finishReason: FinishReason | undefined;
			let usageState: UsageState = {};
			const blocks = new Map<number, AnthropicBlock>();
			const reportUsage = (raw: AnthropicUsageRaw | undefined, index: number): void => {
				if (!raw) return;
				const patch = anthropicUsagePatch(raw, name, index);
				if (Object.keys(patch).length === 0) return;
				usageState = mergeUsage(usageState, patch);
				emit({ kind: "usage", usage: usageSnapshot(usageState) });
			};

			await parseSSE(response.body, (data, index) => {
				let event: AnthropicEvent;
				try {
					event = JSON.parse(data) as AnthropicEvent;
				} catch (error) {
					throw new ProviderProtocolError(`Anthropic ${name} SSE ${index} JSON 无效: ${String(error)}`, index);
				}
				if (event.type === "error") {
					const detail = event.error?.message ?? event.error?.type ?? "未知 provider 错误";
					throw new ProviderProtocolError(`Anthropic ${name} provider error: ${detail}`, index);
				}
				if (sawMessageStop) throw new ProviderProtocolError(`Anthropic ${name} message_stop 后仍收到事件`, index);
				if (event.type === "message_start") {
					if (sawMessageStart) throw new ProviderProtocolError(`Anthropic ${name} 重复 message_start`, index);
					sawMessageStart = true;
					reportUsage(event.message?.usage, index);
					return;
				}
				if (!sawMessageStart && isAnthropicProtocolEvent(event.type)) throw new ProviderProtocolError(`Anthropic ${name} 在 message_start 前收到 ${event.type}`, index);
				if (finishReason && event.type !== "message_stop" && event.type !== "message_delta") throw new ProviderProtocolError(`Anthropic ${name} stop_reason 后仍收到 ${event.type}`, index);

				switch (event.type) {
					case "content_block_start": {
						const blockIndex = requireEventIndex(event.index, name, index);
						if (blocks.has(blockIndex)) throw new ProviderProtocolError(`Anthropic ${name} 重复 content block ${blockIndex}`, index);
						const block = event.content_block;
						if (!block?.type) throw new ProviderProtocolError(`Anthropic ${name} content block 缺少 type`, index);
						if (block.type === "text") {
							blocks.set(blockIndex, { kind: "text" });
							if (block.text) emit({ kind: "text", text: block.text });
						} else if (block.type === "thinking") {
							blocks.set(blockIndex, { kind: "thinking" });
							if (block.thinking) emit({ kind: "thinking", text: block.thinking });
							if (block.signature !== undefined) emit({ kind: "thinking_signature", signature: block.signature });
						} else if (block.type === "tool_use") {
							if (!block.id || !block.name) throw new ProviderProtocolError(`Anthropic ${name} tool_use 缺少 id 或 name`, index);
							blocks.set(blockIndex, { kind: "tool_use", id: block.id, name: block.name, args: "", initialArgs: block.input });
						} else {
							throw new ProviderProtocolError(`Anthropic ${name} 不支持 content block ${block.type}`, index);
						}
						break;
					}
					case "content_block_delta": {
						const blockIndex = requireEventIndex(event.index, name, index);
						const block = blocks.get(blockIndex);
						if (!block) throw new ProviderProtocolError(`Anthropic ${name} delta 没有对应 content block ${blockIndex}`, index);
						const delta = event.delta;
						if (!delta?.type) throw new ProviderProtocolError(`Anthropic ${name} content delta 缺少 type`, index);
						if (delta.type === "text_delta" && block.kind === "text") {
							if (delta.text) emit({ kind: "text", text: delta.text });
						} else if (delta.type === "thinking_delta" && block.kind === "thinking") {
							if (delta.thinking) emit({ kind: "thinking", text: delta.thinking });
						} else if (delta.type === "signature_delta" && block.kind === "thinking") {
							if (delta.signature !== undefined) emit({ kind: "thinking_signature", signature: delta.signature });
						} else if (delta.type === "input_json_delta" && block.kind === "tool_use") {
							block.args += delta.partial_json ?? "";
						} else {
							throw new ProviderProtocolError(`Anthropic ${name} content delta ${delta.type} 与 block 类型不匹配`, index);
						}
						break;
					}
					case "content_block_stop": {
						const blockIndex = requireEventIndex(event.index, name, index);
						const block = blocks.get(blockIndex);
						if (!block) throw new ProviderProtocolError(`Anthropic ${name} 重复或未知 content block stop ${blockIndex}`, index);
						if (block.kind === "tool_use") {
							const args = block.args || (block.initialArgs ? JSON.stringify(block.initialArgs) : "{}");
							if (!isJsonObject(args)) throw new ProviderProtocolError(`Anthropic ${name} tool call ${block.name} 参数不是完整 JSON`, index);
							emit({ kind: "tool_call", call: { id: block.id, name: block.name, args, argsValid: true } });
						}
						blocks.delete(blockIndex);
						break;
					}
					case "message_delta":
						reportUsage(event.usage, index);
						if (event.delta?.stop_reason) {
							if (finishReason) throw new ProviderProtocolError(`Anthropic ${name} 重复 stop_reason`, index);
							finishReason = mapAnthropicStopReason(event.delta.stop_reason, event.delta.stop_details, name, index);
						}
						break;
					case "message_stop":
						if (!finishReason) throw new ProviderProtocolError(`Anthropic ${name} message_stop 缺少 stop_reason`, index);
						if (blocks.size > 0) throw new ProviderProtocolError(`Anthropic ${name} message_stop 前仍有未结束 content block`, index);
						sawMessageStop = true;
						emit({ kind: "finish", reason: finishReason });
						break;
					default:
						break;
				}
			}, signal);

			if (!sawMessageStart) throw new ProviderProtocolError(`Anthropic ${name} 流缺少 message_start`);
			if (!sawMessageStop) throw new ProviderProtocolError(`Anthropic ${name} 流缺少 message_stop`);
		},
	};
}

function createGeminiProvider(name: string, conf: ProviderConfig): ModelProvider {
	const thinkingLevels = levels(conf);
	return {
		name: conf.model,
		contextWindow: effectiveContextWindow(conf),
		thinkingLevels,
		includeThinking: Boolean(thinkingLevels?.some((level) => level !== "off")),
		async refreshModels() {
			const response = await fetch(`${conf.baseUrl.replace(/\/$/, "")}/models?key=${encodeURIComponent(conf.apiKey)}`);
			if (!response.ok) throw new Error(`Gemini 模型目录请求失败 HTTP ${response.status}`);
			const payload = (await response.json()) as { models?: Array<{ baseModelId?: string; inputTokenLimit?: number; thinking?: boolean; supportedGenerationMethods?: string[] }> };
			return (payload.models ?? []).flatMap((model) => {
				const contextWindow = model.inputTokenLimit;
				if (!model.supportedGenerationMethods?.includes("generateContent") || !model.baseModelId || typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return [];
				return [{ id: model.baseModelId, contextWindow, thinkingLevels: model.thinking ? levels(conf) : ["off" as const] }];
			});
		},
		async stream(req, emit, signal) {
			let headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
			let bodyPayload = geminiRequest(req, conf.geminiToolCallIds === true);
			headers = copyValue(await req.providerHooks.transformHeaders(conf.model, readonlySnapshot(headers)));
			bodyPayload = copyValue(await req.providerHooks.transformPayload(conf.model, readonlySnapshot(bodyPayload))) as Record<string, unknown>;

			const response = await fetchWithRetry(`${conf.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(conf.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(conf.apiKey)}`, { maxRetries: conf.maxRetries ?? 2, signal, request: { method: "POST", signal, headers, body: JSON.stringify(bodyPayload) } });
			const respHeaders: Record<string, string> = {};
			response.headers.forEach((value, key) => { respHeaders[key] = value; });
			await req.providerHooks.observeResponse(readonlySnapshot({ provider: conf.model, status: response.status, headers: respHeaders }));
			if (!response.ok) throw new Error(`Gemini ${name} 请求失败 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
			if (!response.body) throw new ProviderProtocolError("Gemini 响应无 body");

			let finished = false;
			let finishReason: FinishReason | undefined;
			let usageState: UsageState = {};
			let nextSyntheticCallId = 1;
			const calls = new Map<string, GeminiToolCall>();
			const reportUsage = (raw: GeminiUsageRaw | undefined, index: number): void => {
				if (!raw) return;
				const patch = geminiUsagePatch(raw, name, index);
				if (Object.keys(patch).length === 0) return;
				usageState = mergeUsage(usageState, patch);
				emit({ kind: "usage", usage: usageSnapshot(usageState) });
			};

			await parseSSE(response.body, (data, index) => {
				if (finished) throw new ProviderProtocolError(`Gemini ${name} finish 后仍收到事件`, index);
				let chunk: GeminiChunk;
				try {
					chunk = JSON.parse(data) as GeminiChunk;
				} catch (error) {
					throw new ProviderProtocolError(`Gemini ${name} SSE ${index} JSON 无效: ${String(error)}`, index);
				}
				if (chunk.error) throw new ProviderProtocolError(`Gemini ${name} provider error: ${chunk.error.message ?? chunk.error.status ?? "未知错误"}`, index);
				reportUsage(chunk.usageMetadata, index);
				if (chunk.candidates && chunk.candidates.length > 1) throw new ProviderProtocolError(`Gemini ${name} 返回多个 candidate，Uina 只支持单一候选`, index);
				const candidate = chunk.candidates?.[0];
				for (const part of candidate?.content?.parts ?? []) {
					if (part.thought && part.text) emit({ kind: "thinking", text: part.text });
					else if (part.text) emit({ kind: "text", text: part.text });
					if (part.thoughtSignature && !part.functionCall) emit({ kind: "thinking_signature", signature: part.thoughtSignature });
					if (part.functionCall) {
						const functionCall = part.functionCall;
						if (!functionCall.name?.trim()) throw new ProviderProtocolError(`Gemini ${name} functionCall 缺少 name`, index);
						if (functionCall.args !== undefined && !isRecord(functionCall.args)) throw new ProviderProtocolError(`Gemini ${name} functionCall ${functionCall.name} 参数不是对象`, index);
						const providerId = functionCall.id?.trim();
						if (conf.geminiToolCallIds === true && !providerId) throw new ProviderProtocolError(`Gemini ${name} 已配置要求 tool call id，但响应缺少 id`, index);
						const id = providerId || `gemini-call-${nextSyntheticCallId++}`;
						const previous = calls.get(id);
						if (previous && previous.name !== functionCall.name) throw new ProviderProtocolError(`Gemini ${name} tool call id ${id} 对应多个 name`, index);
						calls.set(id, { id, name: functionCall.name, args: { ...(previous?.args ?? {}), ...(functionCall.args ?? {}) }, thinkingSignature: functionCall.thoughtSignature ?? part.thoughtSignature ?? previous?.thinkingSignature });
					}
				}
				if (candidate?.finishReason) {
					if (finishReason) throw new ProviderProtocolError(`Gemini ${name} 重复 finishReason`, index);
					finishReason = mapGeminiFinishReason(candidate.finishReason, calls.size, name, index);
					for (const call of calls.values()) {
						emit({ kind: "tool_call", call: { id: call.id, name: call.name, args: JSON.stringify(call.args), argsValid: true, ...(call.thinkingSignature ? { thinkingSignature: call.thinkingSignature } : {}) } });
					}
					finished = true;
					emit({ kind: "finish", reason: finishReason });
				}
			}, signal);

			if (!finished || !finishReason) throw new ProviderProtocolError(`Gemini ${name} 流缺少 finishReason`);
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

function geminiRequest(req: ModelRequest, includeToolCallIds: boolean): Record<string, unknown> {
	const system = req.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
	const toolNames = new Map<string, string>();
	for (const message of req.messages) {
		if (message.role !== "assistant") continue;
		for (const call of message.tool_calls ?? []) {
			const previous = toolNames.get(call.id);
			if (previous && previous !== call.name) throw new ProviderProtocolError(`Gemini tool call id ${call.id} 对应多个 name`);
			toolNames.set(call.id, call.name);
		}
	}
	const contents: Array<{ role: string; parts: unknown[] }> = [];
	for (const message of req.messages.filter((entry) => entry.role !== "system")) {
		if (message.role === "tool") {
			const name = toolNames.get(message.tool_call_id);
			if (!name) throw new ProviderProtocolError(`Gemini tool result ${message.tool_call_id} 缺少对应 function call`);
			const response = message.status && message.status !== "succeeded" ? { error: message.content } : { output: message.content };
			const functionResponse = { functionResponse: { name, response, ...(includeToolCallIds ? { id: message.tool_call_id } : {}) } };
			const previous = contents.at(-1);
			if (previous?.role === "user" && previous.parts.some((part) => isRecord(part) && "functionResponse" in part)) previous.parts.push(functionResponse);
			else contents.push({ role: "user", parts: [functionResponse] });
			continue;
		}
		if (message.role === "assistant") {
			const parts: unknown[] = [];
			if (message.content) parts.push({ text: message.content });
			for (const call of message.tool_calls ?? []) parts.push({ functionCall: { ...(includeToolCallIds ? { id: call.id } : {}), name: call.name, args: call.args, ...(call.thinkingSignature ? { thoughtSignature: call.thinkingSignature } : {}) } });
			contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
			continue;
		}
		contents.push({ role: "user", parts: [{ text: message.content }] });
	}
	return {
		contents,
		...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
		...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })) }] } : {}),
		...(req.thinkingLevel && req.thinkingLevel !== "off" ? { generationConfig: { thinkingConfig: { includeThoughts: true } } } : {}),
	};
}

function thinkingBudget(level: ThinkingLevel): number {
	return { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32768, off: 0 }[level];
}

function isJsonObject(value: string): boolean {
	try { return isRecord(JSON.parse(value)); } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

interface UsageState {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	totalTokens?: number;
}

type UsagePatch = Partial<UsageState>;

function mergeUsage(state: UsageState, patch: UsagePatch): UsageState {
	const next = { ...state };
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const) if (patch[key] !== undefined) next[key] = patch[key];
	if (patch.totalTokens === undefined) next.totalTokens = (next.input ?? 0) + (next.output ?? 0) + (next.cacheRead ?? 0) + (next.cacheWrite ?? 0);
	return next;
}

function usageSnapshot(state: UsageState): Usage {
	return { input: state.input ?? 0, output: state.output ?? 0, cacheRead: state.cacheRead ?? 0, cacheWrite: state.cacheWrite ?? 0, reasoning: state.reasoning ?? 0, totalTokens: state.totalTokens ?? (state.input ?? 0) + (state.output ?? 0) + (state.cacheRead ?? 0) + (state.cacheWrite ?? 0) };
}

function count(value: unknown, provider: string, field: string, index: number): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProviderProtocolError(`${provider} usage ${field} 不是非负整数`, index);
	return value as number;
}

interface AnthropicUsageRaw {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	output_tokens_details?: { thinking_tokens?: number };
}

function anthropicUsagePatch(raw: AnthropicUsageRaw, provider: string, index: number): UsagePatch {
	const patch: UsagePatch = {};
	const input = count(raw.input_tokens, provider, "input_tokens", index);
	const output = count(raw.output_tokens, provider, "output_tokens", index);
	const cacheRead = count(raw.cache_read_input_tokens, provider, "cache_read_input_tokens", index);
	const cacheWrite = count(raw.cache_creation_input_tokens, provider, "cache_creation_input_tokens", index);
	const reasoning = count(raw.output_tokens_details?.thinking_tokens, provider, "thinking_tokens", index);
	if (input !== undefined) patch.input = input;
	if (output !== undefined) patch.output = output;
	if (cacheRead !== undefined) patch.cacheRead = cacheRead;
	if (cacheWrite !== undefined) patch.cacheWrite = cacheWrite;
	if (reasoning !== undefined) patch.reasoning = reasoning;
	return patch;
}

interface GeminiUsageRaw {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	thoughtsTokenCount?: number;
	cachedContentTokenCount?: number;
	totalTokenCount?: number;
}

function geminiUsagePatch(raw: GeminiUsageRaw, provider: string, index: number): UsagePatch {
	const prompt = count(raw.promptTokenCount, provider, "promptTokenCount", index);
	const cacheRead = count(raw.cachedContentTokenCount, provider, "cachedContentTokenCount", index);
	if (prompt !== undefined && cacheRead !== undefined && cacheRead > prompt) throw new ProviderProtocolError(`${provider} usage cachedContentTokenCount 大于 promptTokenCount`, index);
	const candidates = count(raw.candidatesTokenCount, provider, "candidatesTokenCount", index);
	const thoughts = count(raw.thoughtsTokenCount, provider, "thoughtsTokenCount", index);
	const patch: UsagePatch = {};
	const totalTokens = count(raw.totalTokenCount, provider, "totalTokenCount", index);
	if (prompt !== undefined) patch.input = prompt - (cacheRead ?? 0);
	if (candidates !== undefined || thoughts !== undefined) patch.output = (candidates ?? 0) + (thoughts ?? 0);
	if (cacheRead !== undefined) patch.cacheRead = cacheRead;
	if (thoughts !== undefined) patch.reasoning = thoughts;
	if (totalTokens !== undefined) patch.totalTokens = totalTokens;
	return patch;
}

type AnthropicBlock = { kind: "text" } | { kind: "thinking" } | { kind: "tool_use"; id: string; name: string; args: string; initialArgs?: Record<string, unknown> };

interface GeminiToolCall { id: string; name: string; args: Record<string, unknown>; thinkingSignature?: string; }

function requireEventIndex(value: number | undefined, provider: string, index: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProviderProtocolError(`${provider} content block 缺少有效 index`, index);
	return value as number;
}

function isAnthropicProtocolEvent(type: string | undefined): boolean {
	return type === "content_block_start" || type === "content_block_delta" || type === "content_block_stop" || type === "message_delta" || type === "message_stop";
}

function mapAnthropicStopReason(reason: string, details: { explanation?: string } | null | undefined, provider: string, index: number): FinishReason {
	switch (reason) {
		case "end_turn": return "stop";
		case "tool_use": return "tool_calls";
		case "max_tokens": return "length";
		case "refusal":
		case "sensitive":
			throw new ProviderProtocolError(`${provider} 以 ${reason} 终止${details?.explanation ? `: ${details.explanation}` : ""}`, index);
		case "pause_turn": throw new ProviderProtocolError(`${provider} 返回 pause_turn；当前运行时没有自动续接语义`, index);
		case "stop_sequence": throw new ProviderProtocolError(`${provider} 返回 stop_sequence，但 Uina 当前未配置 stop sequence`, index);
		default: throw new ProviderProtocolError(`${provider} 未知 stop_reason: ${reason}`, index);
	}
}

function mapGeminiFinishReason(reason: string, callCount: number, provider: string, index: number): FinishReason {
	switch (reason) {
		case "STOP": return callCount > 0 ? "tool_calls" : "stop";
		case "MAX_TOKENS": return "length";
		case "SAFETY":
		case "BLOCKLIST":
		case "PROHIBITED_CONTENT":
		case "SPII":
		case "IMAGE_SAFETY":
		case "IMAGE_PROHIBITED_CONTENT":
		case "IMAGE_RECITATION":
		case "RECITATION":
			throw new ProviderProtocolError(`${provider} 以 ${reason} 终止`, index);
		default: throw new ProviderProtocolError(`${provider} 未知或不支持 finishReason: ${reason}`, index);
	}
}

interface AnthropicEvent {
	type?: string;
	index?: number;
	delta?: { type?: string; thinking?: string; text?: string; partial_json?: string; signature?: string; stop_reason?: string | null; stop_details?: { explanation?: string } | null };
	content_block?: { type?: string; id?: string; name?: string; text?: string; thinking?: string; signature?: string; input?: Record<string, unknown> };
	usage?: AnthropicUsageRaw;
	message?: { usage?: AnthropicUsageRaw };
	error?: { type?: string; message?: string };
}

interface GeminiChunk {
	error?: { code?: number; message?: string; status?: string };
	usageMetadata?: GeminiUsageRaw;
	candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ thought?: boolean; text?: string; thoughtSignature?: string; functionCall?: { id?: string; name?: string; args?: Record<string, unknown>; thoughtSignature?: string } }> } }>;
}

export class ModelRegistry {
	private instances = new Map<string, ModelProvider>();
	private discovered = new Map<string, import("../core/types.js").DiscoveredModel[]>();
	private config?: import("./config.js").UinaConfig;

	constructor(config?: import("./config.js").UinaConfig) { this.config = config; }

	resolve(modelOrProviderName: string): ModelProvider {
		if (this.instances.has(modelOrProviderName)) return this.instances.get(modelOrProviderName)!;
		if (this.config?.providers[modelOrProviderName]) {
			const conf = this.config.providers[modelOrProviderName];
			const provider = createProvider(modelOrProviderName, conf);
			this.instances.set(modelOrProviderName, provider);
			return provider;
		}
		const slash = modelOrProviderName.indexOf("/");
		if (slash > 0) {
			const providerId = modelOrProviderName.slice(0, slash);
			const modelId = modelOrProviderName.slice(slash + 1);
			const base = this.config?.providers[providerId];
			const discovered = this.discovered.get(providerId)?.find((model) => model.id === modelId);
			if (base && discovered?.contextWindow) {
				const provider = createProvider(providerId, { ...base, model: modelId, modelContextWindow: discovered.contextWindow, maxContextWindow: base.maxContextWindow, ...(discovered.thinkingLevels ? { thinkingLevels: [...discovered.thinkingLevels] } : {}) });
				this.instances.set(modelOrProviderName, provider);
				return provider;
			}
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
		const dynamic = [...this.discovered.entries()].flatMap(([provider, models]) => models.filter((model) => model.contextWindow).map((model) => ({ id: `${provider}/${model.id}`, name: model.id })));
		return [...configured, ...registered.filter((candidate) => !configured.some((item) => item.id === candidate.id)), ...dynamic];
	}

	async refreshModels(): Promise<void> {
		const failures: string[] = [];
		for (const [id, conf] of Object.entries(this.config?.providers ?? {})) {
			this.discovered.delete(id);
			try {
				const provider = this.instances.get(id) ?? createProvider(id, conf);
				if (provider.refreshModels) this.discovered.set(id, [...await provider.refreshModels()]);
			} catch (error) {
				failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (failures.length > 0) throw new Error(`模型目录刷新失败：${failures.join("；")}`);
	}
}
