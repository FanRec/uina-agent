import { Registrations } from "../core/registrations.js";
import { assertImageInput } from "../core/content.js";
import type {
	DiscoveredModel,
	FinishReason,
	Model,
	ModelRequest,
	Provider,
	StreamDelta,
	ThinkingLevel,
	Usage,
} from "../core/types.js";
import {
	assertProviderFacts,
	configuredThinkingLevels,
	effectiveContextWindow,
	protocolCarriesThinking,
	type ProviderConfig,
	type ProviderKind,
	type UinaConfig,
} from "./config.js";
import { createOpenAIProvider, ProviderHttpError, sendModelStreamRequest } from "./gateway.js";
import { parseSSE, ProviderProtocolError } from "./sse.js";

/** 创建声明式纯数据 Model 规格 */
export function createModel(conf: ProviderConfig, providerId: string): Model {
	const kind: ProviderKind = conf.type ?? "openai-compatible";
	const effectiveWindow = effectiveContextWindow(conf);
	const levels = configuredThinkingLevels(conf);
	return {
		id: conf.model,
  imageInput: conf.imageInput,
		name: conf.model,
		providerId,
		contextWindow: effectiveWindow,
		maxContextWindow: conf.maxContextWindow,
		modelContextWindow: conf.modelContextWindow,
		maxOutputTokens: conf.maxOutputTokens,
		thinkingLevels: levels,
		includeThinking: conf.includeThinking ?? protocolCarriesThinking(kind, conf.thinkingFormat, levels),
		thinkingBudgets: conf.thinkingBudgets,
		compat: {
			thinkingFormat: conf.thinkingFormat,
			geminiToolCallIds: conf.geminiToolCallIds,
			geminiThinkingFormat: conf.geminiThinkingFormat,
		},
	};
}

/** 创建通信端点 Provider（包含启动期事实断言） */
export function createProvider(id: string, conf: ProviderConfig): Provider {
	const kind: ProviderKind = conf.type ?? "openai-compatible";
	assertProviderFacts(conf);
	if (kind === "openai-compatible") {
		return createOpenAIProvider(id, conf);
	}
	if (kind === "anthropic") return createAnthropicProvider(id, conf);
	return createGeminiProvider(id, conf);
}

export function createProviderAndModel(id: string, conf: ProviderConfig): { provider: Provider; model: Model } {
	const provider = createProvider(id, conf);
	const model = createModel(conf, id);
	return { provider, model };
}

function levels(conf: ProviderConfig): readonly ThinkingLevel[] | undefined {
	return configuredThinkingLevels(conf);
}

export function createAnthropicProvider(id: string, conf: ProviderConfig): Provider {
	return {
		id,
		baseUrl: conf.baseUrl,
		async refreshModels() {
			const response = await fetch(`${conf.baseUrl.replace(/\/$/, "")}/models`, {
				headers: { "x-api-key": conf.apiKey, "anthropic-version": "2023-06-01" },
			});
			if (!response.ok) throw new ProviderHttpError({ provider: id, status: response.status, action: "模型目录请求" });
			const payload = (await response.json()) as { data?: Array<{ id?: string }> };
			return (payload.data ?? []).flatMap((model) => typeof model.id === "string" ? [{ id: model.id }] : []);
		},
		async stream(model: Model, req: ModelRequest, emit: (d: StreamDelta) => void, signal?: AbortSignal): Promise<void> {
			assertImageInput(model, req);
			if (model.providerId !== id) {
				throw new Error(`模型 ${model.id} 的 providerId (${model.providerId}) 与端点 id (${id}) 不匹配`);
			}
			const level = req.thinkingLevel ?? "off";
			const thinking = level === "off" ? undefined : (model.thinkingBudgets?.[level] ?? thinkingBudget(conf, level));
			const body: Record<string, unknown> = {
				model: model.id,
				max_tokens: model.maxOutputTokens ?? maxOutputTokens(conf),
				system: anthropicSystem(req),
				messages: anthropicMessages(req),
				tools: req.tools?.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })),
				stream: true,
			};
			if (thinking) body.thinking = { type: "enabled", budget_tokens: thinking };

			const headers: Record<string, string> = {
				"content-type": "application/json",
				"x-api-key": conf.apiKey,
				"anthropic-version": "2023-06-01",
				accept: "text/event-stream",
			};

			const bodyStream = await sendModelStreamRequest({
				url: `${conf.baseUrl.replace(/\/$/, "")}/messages`,
				providerId: model.providerId,
				headers,
				body,
				hooks: req.providerHooks,
				signal,
				maxRetries: conf.maxRetries,
			});

			let sawMessageStart = false;
			let sawMessageStop = false;
			let finishReason: FinishReason | undefined;
			let usageState: UsageState = {};
			const blocks = new Map<number, AnthropicBlock>();
			const replayBlocks = new Map<number, Record<string, unknown>>();
			const reportUsage = (raw: AnthropicUsageRaw | undefined, index: number): void => {
				if (!raw) return;
				const patch = anthropicUsagePatch(raw, id, index);
				if (Object.keys(patch).length === 0) return;
				usageState = mergeUsage(usageState, patch);
				emit({ kind: "usage", usage: usageSnapshot(usageState) });
			};

			await parseSSE(bodyStream, (data, index) => {
				let event: AnthropicEvent;
				try {
					event = JSON.parse(data) as AnthropicEvent;
				} catch (error) {
					throw new ProviderProtocolError(`Anthropic ${id} SSE ${index} JSON 无效: ${String(error)}`, index);
				}
				if (event.type === "error") {
					const detail = event.error?.message ?? event.error?.type ?? "未知 provider 错误";
					throw new ProviderProtocolError(`Anthropic ${id} provider error: ${detail}`, index);
				}
				if (sawMessageStop) throw new ProviderProtocolError(`Anthropic ${id} message_stop 后仍收到事件`, index);
				if (event.type === "message_start") {
					if (sawMessageStart) throw new ProviderProtocolError(`Anthropic ${id} 重复 message_start`, index);
					sawMessageStart = true;
					reportUsage(event.message?.usage, index);
					return;
				}
				if (!sawMessageStart && isAnthropicProtocolEvent(event.type)) throw new ProviderProtocolError(`Anthropic ${id} 在 message_start 前收到 ${event.type}`, index);
				if (finishReason && event.type !== "message_stop" && event.type !== "message_delta") throw new ProviderProtocolError(`Anthropic ${id} stop_reason 后仍收到 ${event.type}`, index);

				switch (event.type) {
					case "content_block_start": {
						const blockIndex = requireEventIndex(event.index, id, index);
						if (blocks.has(blockIndex)) throw new ProviderProtocolError(`Anthropic ${id} 重复 content block ${blockIndex}`, index);
						const block = event.content_block;
						if (!block?.type) throw new ProviderProtocolError(`Anthropic ${id} content block 缺少 type`, index);
						replayBlocks.set(blockIndex, structuredClone(block) as Record<string, unknown>);
						if (block.type === "redacted_thinking") {
							blocks.set(blockIndex, { kind: "redacted_thinking" });
						} else if (block.type === "text") {
							blocks.set(blockIndex, { kind: "text" });
							if (block.text) emit({ kind: "text", text: block.text });
						} else if (block.type === "thinking") {
							blocks.set(blockIndex, { kind: "thinking" });
							if (block.thinking) emit({ kind: "thinking", text: block.thinking });
							if (block.signature !== undefined) emit({ kind: "thinking_signature", signature: block.signature });
						} else if (block.type === "tool_use") {
							if (!block.id || !block.name) throw new ProviderProtocolError(`Anthropic ${id} tool_use 缺少 id 或 name`, index);
							blocks.set(blockIndex, { kind: "tool_use", id: block.id, name: block.name, args: "", initialArgs: block.input });
						} else {
							throw new ProviderProtocolError(`Anthropic ${id} 不支持 content block ${block.type}`, index);
						}
						break;
					}
					case "content_block_delta": {
						const blockIndex = requireEventIndex(event.index, id, index);
						const block = blocks.get(blockIndex);
						if (!block) throw new ProviderProtocolError(`Anthropic ${id} delta 没有对应 content block ${blockIndex}`, index);
						const delta = event.delta;
						if (!delta?.type) throw new ProviderProtocolError(`Anthropic ${id} content delta 缺少 type`, index);
						const replay = replayBlocks.get(blockIndex)!;
						const field = delta.type === "text_delta" ? "text" : delta.type === "thinking_delta" ? "thinking" : delta.type === "signature_delta" ? "signature" : undefined;
						if (field) replay[field] = String(replay[field] ?? "") + String(delta[field] ?? "");
						if (delta.type === "text_delta" && block.kind === "text") {
							if (delta.text) emit({ kind: "text", text: delta.text });
						} else if (delta.type === "thinking_delta" && block.kind === "thinking") {
							if (delta.thinking) emit({ kind: "thinking", text: delta.thinking });
						} else if (delta.type === "signature_delta" && block.kind === "thinking") {
							if (delta.signature !== undefined) emit({ kind: "thinking_signature", signature: delta.signature });
						} else if (delta.type === "input_json_delta" && block.kind === "tool_use") {
							block.args += delta.partial_json ?? "";
						} else {
							throw new ProviderProtocolError(`Anthropic ${id} content delta ${delta.type} 与 block 类型不匹配`, index);
						}
						break;
					}
					case "content_block_stop": {
						const blockIndex = requireEventIndex(event.index, id, index);
						const block = blocks.get(blockIndex);
						if (!block) throw new ProviderProtocolError(`Anthropic ${id} 重复或未知 content block stop ${blockIndex}`, index);
						if (block.kind === "tool_use") {
							const args = block.args || (block.initialArgs ? JSON.stringify(block.initialArgs) : "{}");
							if (!isJsonObject(args)) throw new ProviderProtocolError(`Anthropic ${id} tool call ${block.name} 参数不是完整 JSON`, index);
							replayBlocks.get(blockIndex)!.input = JSON.parse(args);
							emit({ kind: "tool_call", call: { id: block.id, name: block.name, args, argsValid: true } });
						}
						blocks.delete(blockIndex);
						break;
					}
					case "message_delta":
						reportUsage(event.usage, index);
						if (event.delta?.stop_reason) {
							if (finishReason) throw new ProviderProtocolError(`Anthropic ${id} 重复 stop_reason`, index);
							finishReason = mapAnthropicStopReason(event.delta.stop_reason, event.delta.stop_details, id, index);
						}
						break;
					case "message_stop":
						if (!finishReason) throw new ProviderProtocolError(`Anthropic ${id} message_stop 缺少 stop_reason`, index);
						if (blocks.size > 0) throw new ProviderProtocolError(`Anthropic ${id} message_stop 前仍有未结束 content block`, index);
						sawMessageStop = true;
						emit({ kind: "provider_replay", replay: { format: "anthropic", blocks: [...replayBlocks.values()] } });
						emit({ kind: "finish", reason: finishReason });
						break;
					default:
						break;
				}
			}, signal);

			if (!sawMessageStart) throw new ProviderProtocolError(`Anthropic ${id} 流缺少 message_start`);
			if (!sawMessageStop) throw new ProviderProtocolError(`Anthropic ${id} 流缺少 message_stop`);
		},
	};
}

export function createGeminiProvider(id: string, conf: ProviderConfig): Provider {
	return {
		id,
		baseUrl: conf.baseUrl,
		async refreshModels() {
			const response = await fetch(`${conf.baseUrl.replace(/\/$/, "")}/models`, { headers: { "x-goog-api-key": conf.apiKey } });
			if (!response.ok) throw new ProviderHttpError({ provider: id, status: response.status, action: "模型目录请求" });
			const payload = (await response.json()) as { models?: Array<{ baseModelId?: string; inputTokenLimit?: number; thinking?: boolean; supportedGenerationMethods?: string[] }> };
			return (payload.models ?? []).flatMap((model) => {
				const contextWindow = model.inputTokenLimit;
				if (!model.supportedGenerationMethods?.includes("generateContent") || !model.baseModelId || typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return [];
				return [{ id: model.baseModelId, contextWindow, thinkingLevels: model.thinking === false ? ["off" as const] : undefined }];
			});
		},
		async stream(model: Model, req: ModelRequest, emit: (d: StreamDelta) => void, signal?: AbortSignal): Promise<void> {
			if (model.providerId !== id) {
				throw new Error(`模型 ${model.id} 的 providerId (${model.providerId}) 与端点 id (${id}) 不匹配`);
			}
			const thinkingLevels = model.thinkingLevels ?? levels(conf);
			const geminiToolCallIds = model.compat?.geminiToolCallIds ?? (conf.geminiToolCallIds === true);
			const geminiThinkingFormat = model.compat?.geminiThinkingFormat ?? conf.geminiThinkingFormat;
			const thinkingBudgets = model.thinkingBudgets ?? conf.thinkingBudgets;

			const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
			const bodyPayload = geminiRequest(
				{ ...req, thinkingLevel: thinkingLevels?.length ? req.thinkingLevel : undefined },
				geminiToolCallIds,
				geminiThinkingFormat,
				thinkingBudgets,
			);

			const bodyStream = await sendModelStreamRequest({
				url: `${conf.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`,
				providerId: model.providerId,
				headers,
				body: bodyPayload,
				hooks: req.providerHooks,
				signal,
				maxRetries: conf.maxRetries,
			});

			let finished = false;
			let finishReason: FinishReason | undefined;
			let usageState: UsageState = {};
			let nextSyntheticCallId = 1;
			const calls = new Map<string, GeminiToolCall>();
			const replayParts: unknown[] = [];
			const reportUsage = (raw: GeminiUsageRaw | undefined, index: number): void => {
				if (!raw) return;
				const patch = geminiUsagePatch(raw, id, index);
				if (Object.keys(patch).length === 0) return;
				usageState = mergeUsage(usageState, patch);
				emit({ kind: "usage", usage: usageSnapshot(usageState) });
			};

			await parseSSE(bodyStream, (data, index) => {
				if (finished) throw new ProviderProtocolError(`Gemini ${id} finish 后仍收到事件`, index);
				let chunk: GeminiChunk;
				try {
					chunk = JSON.parse(data) as GeminiChunk;
				} catch (error) {
					throw new ProviderProtocolError(`Gemini ${id} SSE ${index} JSON 无效: ${String(error)}`, index);
				}
				if (chunk.error) throw new ProviderProtocolError(`Gemini ${id} provider error: ${chunk.error.message ?? chunk.error.status ?? "未知错误"}`, index);
				reportUsage(chunk.usageMetadata, index);
				if (chunk.candidates && chunk.candidates.length > 1) throw new ProviderProtocolError(`Gemini ${id} 返回多个 candidate，Uina 只支持单一候选`, index);
				const candidate = chunk.candidates?.[0];
				for (const part of candidate?.content?.parts ?? []) {
					replayParts.push(structuredClone(part));
					if (part.thought && part.text) emit({ kind: "thinking", text: part.text });
					else if (part.text) emit({ kind: "text", text: part.text });
					if (part.thoughtSignature && !part.functionCall) emit({ kind: "thinking_signature", signature: part.thoughtSignature });
					if (part.functionCall) {
						const functionCall = part.functionCall;
						if (!functionCall.name?.trim()) throw new ProviderProtocolError(`Gemini ${id} functionCall 缺少 name`, index);
						if (functionCall.args !== undefined && !isRecord(functionCall.args)) throw new ProviderProtocolError(`Gemini ${id} functionCall ${functionCall.name} 参数不是对象`, index);
						const providerId = functionCall.id?.trim();
						if (conf.geminiToolCallIds === true && !providerId) throw new ProviderProtocolError(`Gemini ${id} 已配置要求 tool call id，但响应缺少 id`, index);
						const callId = providerId || `gemini-call-${nextSyntheticCallId++}`;
						const previous = calls.get(callId);
						if (previous && previous.name !== functionCall.name) throw new ProviderProtocolError(`Gemini ${id} tool call id ${callId} 对应多个 name`, index);
						calls.set(callId, { id: callId, name: functionCall.name, args: { ...(previous?.args ?? {}), ...(functionCall.args ?? {}) }, thinkingSignature: functionCall.thoughtSignature ?? part.thoughtSignature ?? previous?.thinkingSignature });
					}
				}
				if (candidate?.finishReason) {
					if (finishReason) throw new ProviderProtocolError(`Gemini ${id} 重复 finishReason`, index);
					finishReason = mapGeminiFinishReason(candidate.finishReason, calls.size, id, index);
					for (const call of calls.values()) {
						emit({ kind: "tool_call", call: { id: call.id, name: call.name, args: JSON.stringify(call.args), argsValid: true, ...(call.thinkingSignature ? { thinkingSignature: call.thinkingSignature } : {}) } });
					}
					finished = true;
					emit({ kind: "provider_replay", replay: { format: "gemini", blocks: replayParts } });
					emit({ kind: "finish", reason: finishReason });
				}
			}, signal);

			if (!finished || !finishReason) throw new ProviderProtocolError(`Gemini ${id} 流缺少 finishReason`);
		},
	};
}

function anthropicSystem(req: ModelRequest): string | undefined {
	const text = req.messages.filter((message) => message.role === "system").map((message) => message.content).filter(Boolean).join("\n\n");
	return text || undefined;
}

export function anthropicMessages(req: ModelRequest): unknown[] {
	const out: Array<{ role: "user" | "assistant"; content: unknown }> = [];

	for (const message of req.messages) {
		if (message.role === "system") continue;

		if (message.role === "tool") {
			const toolBlock = {
				type: "tool_result",
				tool_use_id: message.tool_call_id,
				content: message.images?.length ? [{ type: 'text', text: message.content || '[image]' }, ...message.images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }))] : message.content,
				is_error: message.status && message.status !== "succeeded",
			};
			const previous = out.at(-1);
			if (previous && previous.role === "user" && Array.isArray(previous.content)) {
				previous.content.push(toolBlock);
			} else {
				out.push({ role: "user", content: [toolBlock] });
			}
			continue;
		}

		if (message.role === "assistant") {
			const blocks: unknown[] = message.providerReplay?.format === "anthropic" ? structuredClone(message.providerReplay.blocks) : [];
			if (message.providerReplay?.format !== "anthropic") {
				if (message.thinking) blocks.push({ type: "thinking", thinking: message.thinking, signature: message.thinkingSignature ?? "" });
				if (message.content) blocks.push({ type: "text", text: message.content });
				for (const call of message.tool_calls ?? []) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
			}
			if (blocks.length === 0) continue;

			const previous = out.at(-1);
			if (previous && previous.role === "assistant" && Array.isArray(previous.content)) {
				previous.content.push(...blocks);
			} else {
				out.push({ role: "assistant", content: blocks });
			}
			continue;
		}

		if (message.role === "user") {
   if (message.images?.length) {
    const blocks = [{ type: 'text', text: message.content || '[image]' }, ...message.images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }))];
    const previous = out.at(-1);
    if (previous?.role === 'user') { previous.content = [...(Array.isArray(previous.content) ? previous.content : [{ type: 'text', text: previous.content }]), ...blocks]; }
    else out.push({ role: 'user', content: blocks });
    continue;
   }
			const previous = out.at(-1);
			if (previous && previous.role === "user") {
				if (typeof previous.content === "string") {
					previous.content = `${previous.content}\n\n${message.content}`;
				} else if (Array.isArray(previous.content)) {
					previous.content.push({ type: "text", text: message.content });
				}
			} else {
				out.push({ role: "user", content: message.content });
			}
			continue;
		}
	}

	return out;
}

export function geminiRequest(req: ModelRequest, includeToolCallIds: boolean, thinkingFormat?: "budget" | "level", thinkingBudgets?: Partial<Record<ThinkingLevel, number>>): Record<string, unknown> {
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
			if (previous?.role === "user" && previous.parts.some((part) => isRecord(part) && "functionResponse" in part)) previous.parts.push(functionResponse, ...(message.images ?? []).map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } })));
			else contents.push({ role: "user", parts: [functionResponse, ...(message.images ?? []).map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))] });
			continue;
		}
		if (message.role === "assistant") {
			const parts: unknown[] = message.providerReplay?.format === "gemini" ? structuredClone(message.providerReplay.blocks) : [];
			if (message.providerReplay?.format !== "gemini") {
				if (message.content) parts.push({ text: message.content });
				for (const call of message.tool_calls ?? []) parts.push({ functionCall: { ...(includeToolCallIds ? { id: call.id } : {}), name: call.name, args: call.args }, ...(call.thinkingSignature ? { thoughtSignature: call.thinkingSignature } : {}) });
			}
			if (parts.length === 0) continue;
			const previous = contents.at(-1);
			if (previous?.role === "model") {
				previous.parts.push(...parts);
			} else {
				contents.push({ role: "model", parts });
			}
			continue;
		}
		const previous = contents.at(-1);
		if (previous?.role === "user" && !previous.parts.some((part) => isRecord(part) && "functionResponse" in part)) {
			previous.parts.push({ text: message.content }, ...(message.images ?? []).map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } })));
		} else {
			contents.push({ role: "user", parts: [{ text: message.content }, ...(message.images ?? []).map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))] });
		}
	}
	return {
		contents,
		...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
		...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })) }] } : {}),
		...(req.thinkingLevel ? { generationConfig: { thinkingConfig: geminiThinkingConfig(req.thinkingLevel, thinkingFormat, thinkingBudgets) } } : {}),
	};
}

/** 数值预算只能来自显式配置：这些数字会直接写进厂商 wire，Uina 不发明它们。 */
function thinkingBudget(conf: ProviderConfig, level: ThinkingLevel): number {
	const value = conf.thinkingBudgets?.[level];
	if (value === undefined) {
		throw new Error(`provider ${conf.model} 的 thinkingBudgets 缺少档位 ${level}；该数值会写进 Anthropic wire，Uina 不发明 thinking 预算`);
	}
	return value;
}

function requireThinkingBudget(budgets: Partial<Record<ThinkingLevel, number>> | undefined, level: ThinkingLevel): number {
	const value = budgets?.[level];
	if (value === undefined) {
		throw new Error(`thinkingBudgets 缺少档位 ${level}；该数值会写进 Gemini wire，Uina 不发明 thinking 预算`);
	}
	return value;
}

function geminiThinkingConfig(
	level: ThinkingLevel,
	thinkingFormat: "budget" | "level" | undefined,
	budgets: Partial<Record<ThinkingLevel, number>> | undefined,
): Record<string, unknown> {
	if (level === "off") return { includeThoughts: false };
	if (thinkingFormat === undefined) {
		throw new Error("Gemini 声明了 thinkingLevels 却缺少 geminiThinkingFormat；Uina 不根据模型名猜测 wire 控制");
	}
	if (thinkingFormat === "level") return { includeThoughts: true, thinkingLevel: level };
	return { includeThoughts: true, thinkingBudget: requireThinkingBudget(budgets, level) };
}

/** Anthropic /messages 要求 max_tokens；缺失时显式失败，而不是补一个默认值。 */
function maxOutputTokens(conf: ProviderConfig): number {
	if (conf.maxOutputTokens === undefined) {
		throw new Error(`provider ${conf.model} 使用 Anthropic 协议，必须显式配置 maxOutputTokens；Uina 不发明输出上限`);
	}
	return conf.maxOutputTokens;
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
	return next;
}

function usageSnapshot(state: UsageState): Usage {
	return { ...state };
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
	if (candidates !== undefined) patch.output = candidates + (thoughts ?? 0);
	if (cacheRead !== undefined) patch.cacheRead = cacheRead;
	if (thoughts !== undefined) patch.reasoning = thoughts;
	if (totalTokens !== undefined) patch.totalTokens = totalTokens;
	return patch;
}

type AnthropicBlock = { kind: "redacted_thinking" } | { kind: "text" } | { kind: "thinking" } | { kind: "tool_use"; id: string; name: string; args: string; initialArgs?: Record<string, unknown> };

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
	private providers = new Registrations<Provider>();
	private models = new Registrations<Model>();
	private defaultModels = new Map<string, Model>();
	private discovered = new Map<string, DiscoveredModel[]>();
	private config?: UinaConfig;

	constructor(config?: UinaConfig) {
		this.config = config;
		if (config) {
			for (const [name, conf] of Object.entries(config.providers)) {
				const provider = createProvider(name, conf);
				const model = createModel(conf, name);
				this.providers.register(name, provider);
				this.defaultModels.set(name, model);
				this.models.register(model.id, model, { replace: true });
				this.models.register(`${name}/${model.id}`, model);
			}
		}
	}

	listModels(): readonly Model[] { const effective = new Map<string, Model>(); for (const model of this.models.values()) effective.set(`${model.providerId}/${model.id}`, this.getModel(`${model.providerId}/${model.id}`) ?? model); return [...effective.values()]; }

	getProvider(id: string): Provider | undefined {
		return this.providers.get(id);
	}

	getModel(nameOrKey: string): Model | undefined {
		const base = this.models.get(nameOrKey) ?? this.defaultModels.get(nameOrKey);
  return base ? this.models.get(`${base.providerId}/${base.id}`) ?? base : undefined;
	}

	resolve(modelOrProviderName: string): Model {
		const existing = this.getModel(modelOrProviderName);
		if (existing) return existing;

		const slash = modelOrProviderName.indexOf("/");
		if (slash > 0) {
			const providerId = modelOrProviderName.slice(0, slash);
			const modelId = modelOrProviderName.slice(slash + 1);
			const base = this.config?.providers[providerId];
			const discovered = this.discovered.get(providerId)?.find((model) => model.id === modelId);
			if (discovered) {
				if (!discovered.contextWindow) {
					throw new Error(`动态发现的模型 ${modelOrProviderName} 缺少 contextWindow，不可选择`);
				}
				const kind = base?.type ?? "openai-compatible";
				const model: Model = {
					id: modelId,
     imageInput: discovered.imageInput,
					name: modelId,
					providerId,
					contextWindow: Math.min(discovered.contextWindow, base?.maxContextWindow ?? discovered.contextWindow),
					maxContextWindow: base?.maxContextWindow,
					modelContextWindow: discovered.contextWindow,
					thinkingLevels: discovered.thinkingLevels?.filter(level => !base?.thinkingLevels || base.thinkingLevels.includes(level)),
					includeThinking: protocolCarriesThinking(kind, base?.thinkingFormat, discovered.thinkingLevels),
					compat: {
						thinkingFormat: base?.thinkingFormat,
						geminiToolCallIds: base?.geminiToolCallIds,
						geminiThinkingFormat: base?.geminiThinkingFormat,
					},
				};
				this.models.register(modelOrProviderName, model);
				return model;
			}
		}
		throw new Error(`未配置或未注册的模型/Provider: ${modelOrProviderName}`);
	}

	has(name: string): boolean {
		return this.models.has(name) || this.defaultModels.has(name) || this.providers.has(name) || Boolean(this.config?.providers[name]);
	}

 registerProvider(provider: Provider, options?: { replace?: boolean }): () => void {
  return this.providers.register(provider.id, provider, options);
 }
 registerModel(model: Model, options?: { replace?: boolean }): () => void {
  const key = model.providerId + '/' + model.id;
  const remove = this.models.register(key, model, options);
  const alias = this.models.get(model.id);
  const removeAlias = !alias || alias.providerId === model.providerId ? this.models.register(model.id, model, { replace: true }) : undefined;
  return () => { removeAlias?.(); remove(); };
 }
 register(name: string, provider: Provider, options?: { replace?: boolean }): () => void {
  const actualProvider: Provider = provider.id === name ? provider : { ...provider, id: name };
  return this.registerProvider(actualProvider, options);
 }

	groups(): Array<{
		id: string;
		name: string;
		description: string;
		models: Array<{ id: string; name: string; description: string; provider: string }>;
	}> {
		const groupMap = new Map<string, {
			id: string;
			name: string;
			description: string;
			models: Map<string, { id: string; name: string; description: string; provider: string }>;
		}>();

		const ensureGroup = (providerId: string) => {
			let group = groupMap.get(providerId);
			if (!group) {
				const conf = this.config?.providers[providerId];
				const desc = conf?.baseUrl ? conf.baseUrl : (conf?.type ?? providerId);
				group = {
					id: providerId,
					name: providerId,
					description: desc,
					models: new Map(),
				};
				groupMap.set(providerId, group);
			}
			return group;
		};

		// 1. Configured providers & default models。展示 id 统一为 providerId/modelId 复合键：
		// 同名模型跨 provider 时选择器能区分当前项，onPick 回传的键可被 resolve() 精确解析。
		if (this.config) {
			for (const [providerId, conf] of Object.entries(this.config.providers)) {
				const group = ensureGroup(providerId);
				const modelId = conf.model;
				group.models.set(modelId, {
					id: `${providerId}/${modelId}`,
					name: modelId,
					description: `默认配置模型 · ${conf.type ?? "openai-compatible"}`,
					provider: providerId,
				});
			}
		}

		// 2. Explicitly registered models
		for (const model of this.listModels()) {
			const group = ensureGroup(model.providerId);
			if (!group.models.has(model.id)) {
				group.models.set(model.id, {
					id: `${model.providerId}/${model.id}`,
					name: model.name || model.id,
					description: `${model.providerId} 注册模型`,
					provider: model.providerId,
				});
			}
		}

		// 3. Dynamically discovered models
		for (const [providerId, models] of this.discovered.entries()) {
			const group = ensureGroup(providerId);
			for (const m of models) {
				if (m.contextWindow && !group.models.has(m.id)) {
					const ctx = m.contextWindow >= 1000 ? `${Math.round(m.contextWindow / 1000)}k` : `${m.contextWindow}`;
					group.models.set(m.id, {
						id: `${providerId}/${m.id}`,
						name: m.id,
						description: `上下文 ~${ctx}`,
						provider: providerId,
					});
				}
			}
		}

		return Array.from(groupMap.values()).map((g) => ({
			id: g.id,
			name: g.name,
			description: g.description,
			models: Array.from(g.models.values()),
		}));
	}

	choices(): Array<{ id: string; name: string }> {
		return this.groups().flatMap((g) => g.models.map((m) => ({ id: m.id, name: m.name })));
	}

	async stream(
		model: Model,
		req: ModelRequest,
		onDelta: (d: StreamDelta) => void,
		signal?: AbortSignal,
	): Promise<void> {
		assertImageInput(model, req);
		const provider = this.providers.get(model.providerId);
		if (!provider) {
			throw new Error(`找不到模型 ${model.id} 对应的 Provider: ${model.providerId}`);
		}
		return provider.stream(model, req, onDelta, signal);
	}

	async refreshModels(): Promise<void> {
		const failures: string[] = [];
		for (const [id, provider] of this.providers.entriesList()) {
			this.discovered.delete(id);
			try {
				if (provider.refreshModels) {
					this.discovered.set(id, [...await provider.refreshModels()]);
				}
			} catch (error) {
				failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (failures.length > 0) throw new Error(`模型目录刷新失败：${failures.join("；")}`);
	}
}
