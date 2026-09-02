/**
 * 模型网关：OpenAI Chat Completions 协议客户端。
 * 兼容任何 OpenAI 风格端点（DeepSeek / OpenAI / 通义 / 本地 Ollama）。
 * 流式解析逐 chunk 回调，不做缓冲——这是对话快路径的地基。
 *
 * 职责边界：内核消息（解析后的对象结构）→ wire 协议形状在这里转换。
 * 例：assistant.tool_calls 内核存 {id,name,args}，协议要求
 * {id,type:"function",function:{name,arguments:JSON字符串}}——不能把内核对象直接发出去。
 */
import type {
	ModelProvider,
	ModelRequest,
	StreamDelta,
} from "../core/types.js";

interface ProviderConf {
	baseUrl: string;
	apiKey: string;
	model: string;
}

export function createOpenAIProvider(conf: ProviderConf): ModelProvider {
	const endpoint = `${conf.baseUrl.replace(/\/$/, "")}/chat/completions`;

	return {
		name: conf.model,
		async stream(
			req: ModelRequest,
			onDelta: (d: StreamDelta) => void,
		): Promise<void> {
			const resp = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${conf.apiKey}`,
				},
				body: JSON.stringify({
					model: conf.model,
					messages: toWireMessages(req.messages),
					tools: req.tools?.length ? req.tools : undefined,
					stream: true,
					stream_options: { include_usage: true },
				}),
			});

			if (!resp.ok) {
				const body = await resp.text().catch(() => "");
				throw new Error(
					`模型请求失败 HTTP ${resp.status}: ${body.slice(0, 300)}`,
				);
			}
			if (!resp.body) throw new Error("模型响应无 body");

			await parseSSE(resp.body, onDelta);
		},
	};
}

/**
 * 内核消息 → wire 协议形状。
 * 唯一需要转换的是 assistant 消息的 tool_calls：内核存解析后的对象
 * {id,name,args(对象)}，OpenAI 协议要求 {id,type:"function",function:{name,arguments(JSON字符串)}}。
 */
function toWireMessages(msgs: ModelRequest["messages"]): unknown[] {
	return msgs.map((m) => {
		if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
			return {
				role: m.role,
				content: m.content,
				tool_calls: m.tool_calls.map((tc) => ({
					id: tc.id,
					type: "function",
					function: {
						name: tc.name,
						arguments:
							typeof tc.args === "string"
								? tc.args
								: JSON.stringify(tc.args ?? {}),
					},
				})),
			};
		}
		return m;
	});
}

/**
 * OpenAI SSE 流解析。
 * tool_call 的 arguments 可能分片到达，按 index 累积拼接，finish 时整段吐出。
 */
async function parseSSE(
	body: ReadableStream<Uint8Array>,
	onDelta: (d: StreamDelta) => void,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const pending = new Map<number, { id: string; name: string; args: string }>();
	let buffer = "";

	const feed = (line: string): void => {
		if (!line.startsWith("data:")) return;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") return;

		let chunk: {
			choices?: {
				delta?: { content?: string; tool_calls?: unknown[] };
				finish_reason?: string;
			}[];
		};
		try {
			chunk = JSON.parse(payload);
		} catch {
			return; // 容忍脏行，不影响已解析内容
		}
		const delta = chunk.choices?.[0]?.delta;
		if (!delta) return;

		if (typeof delta.content === "string" && delta.content.length > 0) {
			onDelta({ kind: "text", text: delta.content });
		}
		if (Array.isArray(delta.tool_calls)) {
			for (const raw of delta.tool_calls) {
				const tc = raw as {
					index?: number;
					id?: string;
					function?: { name?: string; arguments?: string };
				};
				const idx = tc.index ?? 0;
				const fn = tc.function ?? {};
				const cur = pending.get(idx) ?? { id: "", name: "", args: "" };
				if (tc.id) cur.id = tc.id;
				if (typeof fn.name === "string" && fn.name) cur.name += fn.name;
				if (typeof fn.arguments === "string" && fn.arguments)
					cur.args += fn.arguments;
				pending.set(idx, cur);
			}
		}
		const reason = chunk.choices?.[0]?.finish_reason;
		if (reason) {
			// 把滞留的 tool_call 收口发出，再报 finish
			for (const [idx, c] of pending) {
				if (c.id) {
					pending.delete(idx);
					onDelta({ kind: "tool_call", call: c });
				}
			}
			onDelta({ kind: "finish", reason });
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (line.trim()) feed(line.trim());
		}
	}
	if (buffer.trim()) feed(buffer.trim());
	// 流异常中断时的兜底：滞留的 tool_call 仍要发出
	for (const c of pending.values()) {
		if (c.id) onDelta({ kind: "tool_call", call: c });
	}
	onDelta({ kind: "finish", reason: "stream_end" });
}
