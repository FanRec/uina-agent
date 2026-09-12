import type {
	Model,
	ModelRequest,
	Provider,
	ThinkingLevel,
	ThinkingWireFormat,
	Usage,
} from "../core/types.js";
import { parseSSE, ProviderProtocolError } from "./sse.js";
import { copyValue, readonlySnapshot } from "../runtime/guard.js";

export interface OpenAIEndpointConf {
	baseUrl: string;
	apiKey: string;
	maxRetries?: number;
}

export function createOpenAIProvider(id: string, conf: OpenAIEndpointConf): Provider {
	const endpoint = `${conf.baseUrl.replace(/\/$/, "")}/chat/completions`;
	return {
		id,
		baseUrl: conf.baseUrl,
		async refreshModels() {
			const response = await fetch(`${conf.baseUrl.replace(/\/$/, "")}/models`, { headers: { Authorization: `Bearer ${conf.apiKey}` } });
			if (!response.ok) throw new Error(`模型目录请求失败 HTTP ${response.status}`);
			const payload = await response.json() as { data?: Array<{ id?: string }> };
			return (payload.data ?? []).flatMap((model) => typeof model.id === "string" ? [{ id: model.id }] : []);
		},
		async stream(model: Model, req, onDelta, signal): Promise<void> {
			if (model.providerId !== id) {
				throw new Error(`模型 ${model.id} 的 providerId (${model.providerId}) 与端点 id (${id}) 不匹配`);
			}
			const thinkingFormat = model.compat?.thinkingFormat;
			let headers: Record<string, string> = {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				Authorization: `Bearer ${conf.apiKey}`,
			};
			let bodyPayload: unknown = {
				model: model.id,
				messages: toWireMessages(req.messages, thinkingFormat),
				tools: req.tools?.length ? req.tools : undefined,
				stream: true,
				stream_options: { include_usage: true },
				...thinkingRequest(model.thinkingLevels?.length ? req.thinkingLevel : undefined, thinkingFormat),
			};

			headers = copyValue(await req.providerHooks.transformHeaders(model.providerId, readonlySnapshot(headers)));
			bodyPayload = copyValue(await req.providerHooks.transformPayload(model.providerId, readonlySnapshot(bodyPayload)));

			const response = await fetchWithRetry(endpoint, {
				maxRetries: conf.maxRetries ?? 2,
				signal,
				request: {
					method: "POST",
					signal,
					headers,
					body: JSON.stringify(bodyPayload),
				},
			});

			const respHeaders: Record<string, string> = {};
			response.headers.forEach((v, k) => {
				respHeaders[k] = v;
			});
			await req.providerHooks.observeResponse(readonlySnapshot({ provider: model.providerId, status: response.status, headers: respHeaders }));

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new Error(
					`模型请求失败 HTTP ${response.status}: ${body.slice(0, 300)}`,
				);
			}
			if (!response.body) throw new ProviderProtocolError("模型响应无 body");

			let finished = false;
			let doneMarker = false;
			let usageState: Partial<Usage> = {};
			const pending = new Map<number, { id: string; name: string; args: string }>();

			await parseSSE(
				response.body,
				(data, index) => {
					if (data === "[DONE]") {
						doneMarker = true;
						if (!finished) {
							throw new ProviderProtocolError(
								"模型流在 finish_reason 前结束",
								index,
							);
						}
						return;
					}
					if (doneMarker) throw new ProviderProtocolError("[DONE] 后出现额外事件", index);
					let chunk: OpenAIChunk;
					try {
						chunk = JSON.parse(data) as OpenAIChunk;
					} catch (error) {
						throw new ProviderProtocolError(
							`SSE 第 ${index + 1} 个事件不是合法 JSON: ${String(error)}`,
							index,
						);
					}

					const choice = chunk.choices?.[0];
					if (chunk.usage) {
						const usage = mergeOpenAIUsage(usageState, chunk.usage, index, model.id);
						if (usage) {
							usageState = usage;
							onDelta({ kind: "usage", usage: usageSnapshot(usageState) });
						}
					}
					if (!choice) return;
					if (finished) throw new ProviderProtocolError("finish_reason 后出现额外内容", index);
					const delta = choice.delta ?? {};
					if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
						onDelta({ kind: "thinking", text: delta.reasoning_content });
					}
					if (typeof delta.thinking === "string" && delta.thinking.length > 0) {
						onDelta({ kind: "thinking", text: delta.thinking });
					}
					if (typeof delta.content === "string" && delta.content.length > 0) {
						onDelta({ kind: "text", text: delta.content });
					}

					for (const raw of delta.tool_calls ?? []) {
						const indexValue = raw.index ?? 0;
						const current = pending.get(indexValue) ?? {
							id: "",
							name: "",
							args: "",
						};
						if (raw.id) current.id = raw.id;
						if (raw.function?.name) current.name += raw.function.name;
						if (raw.function?.arguments) current.args += raw.function.arguments;
						pending.set(indexValue, current);
					}

					if (typeof choice.finish_reason === "string" && choice.finish_reason) {
						if (choice.finish_reason === "content_filter") {
							throw new ProviderProtocolError(`模型 ${model.id} 因 content_filter 终止回复`, index);
						}
						if (
							choice.finish_reason !== "stop" &&
							choice.finish_reason !== "tool_calls" &&
							choice.finish_reason !== "length"
						) {
							throw new ProviderProtocolError(`模型 ${model.id} 未知 finish_reason: ${choice.finish_reason}`, index);
						}
						if (choice.finish_reason === "stop" && pending.size > 0) {
							throw new ProviderProtocolError(`模型 ${model.id} 返回 stop，但仍有未完成 tool call`, index);
						}
						for (const [toolIndex, call] of [...pending.entries()].sort(
							([a], [b]) => a - b,
						)) {
							if (!call.id || !call.name) {
								throw new ProviderProtocolError(
									`tool call ${toolIndex} 缺少 id 或 name`,
									index,
								);
							}
							const argsValid = isJsonObject(call.args || "{}");
							if (!argsValid && choice.finish_reason !== "length") {
								throw new ProviderProtocolError(
									`tool call ${call.name} 参数不是完整 JSON`,
									index,
								);
							}
							onDelta({
								kind: "tool_call",
								call: { ...call, args: call.args || "{}", argsValid },
							});
						}
						pending.clear();
						finished = true;
						onDelta({ kind: "finish", reason: choice.finish_reason });
					}
				},
				signal,
			);

			if (!finished || !doneMarker) {
				throw new ProviderProtocolError(
					!finished
						? "模型流结束时缺少 finish_reason"
						: "模型流结束时缺少 [DONE]",
				);
			}
		},
	};
}

export async function fetchWithRetry(
	url: string,
	options: { request: RequestInit; signal?: AbortSignal; maxRetries: number },
): Promise<Response> {
	let attempt = 0;
	while (true) {
		try {
			const response = await fetch(url, { ...options.request, signal: options.signal });
			if (response.ok || !isRetryableStatus(response.status) || attempt >= options.maxRetries) return response;
			await response.body?.cancel().catch(() => undefined);
			const delay = retryAfter(response.headers.get("retry-after")) ?? 250 * 2 ** attempt;
			await abortableDelay(Math.min(delay, 60_000), options.signal);
		} catch (error) {
			if (options.signal?.aborted || attempt >= options.maxRetries || !isNetworkError(error)) throw error;
			await abortableDelay(Math.min(250 * 2 ** attempt, 60_000), options.signal);
		}
		attempt++;
	}
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isNetworkError(error: unknown): boolean {
	return error instanceof TypeError || (error instanceof Error && error.name === "FetchError");
}

function retryAfter(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		const abort = (): void => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
		signal?.addEventListener("abort", abort, { once: true });
	});
}

interface OpenAIChunk {
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
	choices?: Array<{
			delta?: {
				content?: string | null;
				reasoning_content?: string | null;
				thinking?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
}

function mergeOpenAIUsage(state: Partial<Usage>, raw: NonNullable<OpenAIChunk["usage"]>, index: number, provider: string): Partial<Usage> | undefined {
	const values = [raw.prompt_tokens, raw.completion_tokens, raw.total_tokens, raw.prompt_tokens_details?.cached_tokens, raw.completion_tokens_details?.reasoning_tokens];
	if (!values.some((value) => value !== undefined && value !== null)) return undefined;
	const count = (value: number | undefined, field: string): number | undefined => {
		if (value === undefined || value === null) return undefined;
		if (!Number.isSafeInteger(value) || value < 0) throw new ProviderProtocolError(`模型 ${provider} usage ${field} 不是非负整数`, index);
		return value;
	};
	const next: Partial<Usage> = { ...state };
	const cacheRead = count(raw.prompt_tokens_details?.cached_tokens, "cached_tokens");
	const prompt = count(raw.prompt_tokens, "prompt_tokens");
	const output = count(raw.completion_tokens, "completion_tokens");
	const reasoning = count(raw.completion_tokens_details?.reasoning_tokens, "reasoning_tokens");
	if (cacheRead !== undefined) next.cacheRead = cacheRead;
	const promptTotal = prompt ?? (state.input !== undefined ? state.input + (state.cacheRead ?? 0) : undefined);
	if (promptTotal !== undefined) {
		if ((next.cacheRead ?? 0) > promptTotal) throw new ProviderProtocolError("cached_tokens 大于 prompt_tokens", index);
		next.input = promptTotal - (next.cacheRead ?? 0);
	}
	if (output !== undefined) next.output = output;
	if (reasoning !== undefined) next.reasoning = reasoning;
	// Only report a total the provider actually sent. Synthesizing one would let
	// the UI present a derived number as measured usage.
	const total = count(raw.total_tokens, "total_tokens");
	next.totalTokens = total;
	return next;
}

function usageSnapshot(state: Partial<Usage>): Usage { return { ...state }; }

function thinkingRequest(level: ThinkingLevel | undefined, format: ThinkingWireFormat = "openai"): Record<string, unknown> {
 if (!level) return {};
 if (format === "deepseek") return { thinking: { type: level === "off" ? "disabled" : "enabled" }, ...(level === "off" ? {} : { reasoning_effort: level }) };
 if (format === "qwen") return { enable_thinking: level !== "off" };
 return { reasoning_effort: level === "off" ? "none" : level };
}

export function toWireMessages(messages: ModelRequest["messages"], thinkingFormat?: ThinkingWireFormat): unknown[] {
	const wire: unknown[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			const hasToolCalls = Boolean(message.tool_calls && message.tool_calls.length > 0);
			const hasThinking = Boolean(message.thinking && thinkingFormat === "deepseek");
			const content = typeof message.content === "string" ? message.content : "";
			const hasContent = content.trim().length > 0;

			if (!hasContent && !hasToolCalls && !hasThinking) {
				continue;
			}

			wire.push({
				role: "assistant",
				content: message.content ?? "",
				...(hasToolCalls
					? {
							tool_calls: message.tool_calls!.map((call) => ({
								id: call.id,
								type: "function",
								function: {
									name: call.name,
									arguments:
										typeof call.args === "string"
											? call.args
											: JSON.stringify(call.args ?? {}),
								},
							})),
						}
					: {}),
				...(hasThinking ? { reasoning_content: message.thinking } : {}),
			});
			continue;
		}
		if (message.role === "tool") {
			wire.push({
				role: "tool",
				tool_call_id: message.tool_call_id,
				content: message.content,
			});
			continue;
		}
		wire.push(message);
	}
	return wire;
}

function isJsonObject(text: string): boolean {
	try {
		const value = JSON.parse(text);
		return !!value && typeof value === "object" && !Array.isArray(value);
	} catch {
		return false;
	}
}
