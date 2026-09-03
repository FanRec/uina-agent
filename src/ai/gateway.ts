import type {
	ModelProvider,
	ModelRequest,
	ThinkingLevel,
} from "../core/types.js";
import { parseSSE, ProviderProtocolError } from "./sse.js";

export interface ProviderConf {
	baseUrl: string;
	apiKey: string;
	model: string;
	contextWindow?: number;
	maxRetries?: number;
	thinkingFormat?: "openai" | "deepseek" | "qwen";
	thinkingLevels?: readonly ThinkingLevel[];
}

export function createOpenAIProvider(conf: ProviderConf): ModelProvider {
	const endpoint = `${conf.baseUrl.replace(/\/$/, "")}/chat/completions`;
	return {
		name: conf.model,
		contextWindow: conf.contextWindow,
		thinkingLevels: conf.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		includeThinking: conf.thinkingFormat === "deepseek",
		async stream(req, onDelta, signal): Promise<void> {
			let headers: Record<string, string> = {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				Authorization: `Bearer ${conf.apiKey}`,
			};
			let bodyPayload: unknown = {
				model: conf.model,
				messages: toWireMessages(req.messages, conf.thinkingFormat),
				tools: req.tools?.length ? req.tools : undefined,
				stream: true,
				...thinkingRequest(req.thinkingLevel, conf.thinkingFormat),
			};

			if (req.extensionHost) {
				headers = await req.extensionHost.emitBeforeProviderHeaders(conf.model, headers);
				bodyPayload = await req.extensionHost.emitBeforeProviderRequest(conf.model, bodyPayload);
			}

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

			if (req.extensionHost) {
				const respHeaders: Record<string, string> = {};
				response.headers.forEach((v, k) => {
					respHeaders[k] = v;
				});
				await req.extensionHost.emitAfterProviderResponse(conf.model, response.status, respHeaders);
			}

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new Error(
					`模型请求失败 HTTP ${response.status}: ${body.slice(0, 300)}`,
				);
			}
			if (!response.body) throw new ProviderProtocolError("模型响应无 body");

			let finished = false;
			let doneMarker = false;
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
					if (finished) return;
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
					if (!choice) return;
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
						if (choice.finish_reason === "content_filter") {
							throw new Error("模型因 content_filter 终止回复");
						}
						if (
							choice.finish_reason !== "stop" &&
							choice.finish_reason !== "tool_calls" &&
							choice.finish_reason !== "length"
						) {
							throw new ProviderProtocolError(
								`未知 finish_reason: ${choice.finish_reason}`,
								index,
							);
						}
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
			await response.body?.cancel();
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

function thinkingRequest(level: ThinkingLevel | undefined, format = "openai"): Record<string, unknown> {
	if (!level || level === "off") return {};
	if (format === "deepseek") return {};
	if (format === "qwen") return { enable_thinking: true };
	return { reasoning_effort: level === "xhigh" || level === "max" ? "high" : level };
}

export function toWireMessages(messages: ModelRequest["messages"], thinkingFormat?: ProviderConf["thinkingFormat"]): unknown[] {
	return messages.map((message) => {
		if (message.role === "assistant") {
			return {
				role: "assistant",
				content: message.content,
					...(message.tool_calls?.length
					? {
							tool_calls: message.tool_calls.map((call) => ({
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
				...(message.thinking && thinkingFormat === "deepseek" ? { reasoning_content: message.thinking } : {}),
			};
		}
		return message.role === "tool"
			? {
					role: "tool",
					tool_call_id: message.tool_call_id,
					content: message.content,
				}
			: message;
	});
}

function isJsonObject(text: string): boolean {
	try {
		const value = JSON.parse(text);
		return !!value && typeof value === "object" && !Array.isArray(value);
	} catch {
		return false;
	}
}
