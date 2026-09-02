import type {
	ModelProvider,
	ModelRequest,
} from "../core/types.js";
import { parseSSE, ProviderProtocolError } from "./sse.js";

export interface ProviderConf {
	baseUrl: string;
	apiKey: string;
	model: string;
	contextWindow?: number;
}

export function createOpenAIProvider(conf: ProviderConf): ModelProvider {
	const endpoint = `${conf.baseUrl.replace(/\/$/, "")}/chat/completions`;
	return {
		name: conf.model,
		contextWindow: conf.contextWindow,
		async stream(req, onDelta, signal): Promise<void> {
			const response = await fetch(endpoint, {
				method: "POST",
				signal,
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					Authorization: `Bearer ${conf.apiKey}`,
				},
				body: JSON.stringify({
					model: conf.model,
					messages: toWireMessages(req.messages),
					tools: req.tools?.length ? req.tools : undefined,
					stream: true,
				}),
			});

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

interface OpenAIChunk {
	choices?: Array<{
		delta?: {
			content?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
}

export function toWireMessages(messages: ModelRequest["messages"]): unknown[] {
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
