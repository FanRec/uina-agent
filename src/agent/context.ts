import type { ChatMsg, ContextSegments, ToolDef } from "../core/types.js";

export interface ContextEstimate { tokens: number; actual: boolean; }

export interface BuildInput {
	history: ChatMsg[];
	systemPrompt?: string;
	includeThinking?: boolean;
	runtimeInputs?: readonly { source: { kind: string; type: string; ref?: string }; text?: string; data?: unknown }[];
}

const DEFAULT_SYSTEM_PROMPT =
	"你是 Uina，一个住在计算机里的独立个体。与人类朋友平等相处：自然说话、有自己的判断、用中文。";

export function defaultSystemPrompt(): string {
	return DEFAULT_SYSTEM_PROMPT;
}

export function buildContext(b: BuildInput): ChatMsg[] {
	const baseSystem = b.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
	const systemContent = b.runtimeInputs?.length
		? `${baseSystem}\n\n<runtime_events>\n${b.runtimeInputs.map(formatRuntimeInput).join("\n")}\n</runtime_events>`
		: baseSystem;

	const toolResponses = new Set<string>();
	for (const msg of b.history) {
		if (msg.role === "tool" && msg.tool_call_id) {
			toolResponses.add(msg.tool_call_id);
		}
	}

	const intermediate: ChatMsg[] = [];
	for (const message of b.history) {
		if (message.role === "assistant") {
			const thinking = b.includeThinking ? message.thinking : undefined;
			const thinkingSignature = b.includeThinking ? message.thinkingSignature : undefined;
			const validToolCalls = message.tool_calls?.filter((call) => toolResponses.has(call.id));
			const tool_calls = validToolCalls && validToolCalls.length > 0 ? validToolCalls : undefined;
			const content = typeof message.content === "string" ? message.content : "";
			const hasContent = content.trim().length > 0;
			const hasToolCalls = Boolean(tool_calls && tool_calls.length > 0);
			const hasThinking = Boolean(thinking && thinking.trim().length > 0);

			if (!hasContent && !hasToolCalls && !hasThinking) {
				continue;
			}

			intermediate.push({
				...message,
				content,
				thinking,
				thinkingSignature,
				tool_calls,
			});
			continue;
		}
		intermediate.push(message);
	}

	const validToolCallIds = new Set<string>();
	for (const msg of intermediate) {
		if (msg.role === "assistant" && msg.tool_calls) {
			for (const call of msg.tool_calls) {
				validToolCallIds.add(call.id);
			}
		}
	}

	const cleaned: ChatMsg[] = [];
	for (const message of intermediate) {
		if (message.role === "tool" && message.tool_call_id && !validToolCallIds.has(message.tool_call_id)) {
			continue;
		}
		cleaned.push(message);
	}

	return [
		{ role: "system", content: systemContent },
		...cleaned,
	];
}

function formatRuntimeInput(input: { source: { kind: string; type: string; ref?: string }; text?: string; data?: unknown }): string {
	const source = `${input.source.kind}/${input.source.type}${input.source.ref ? `:${input.source.ref}` : ""}`;
	const data = input.data === undefined ? "" : ` data=${JSON.stringify(input.data)}`;
	return `[${source}] ${input.text ?? ""}${data}`;
}

/** Approximate token estimate used before a provider request. */
export function estimateRequestTokens(
	messages: readonly ChatMsg[],
	tools: readonly ToolDef[] = [],
	includeThinking = false,
): number {
	let chars = 0;
	for (const message of messages) {
		chars += message.content.length + 16;
		if (includeThinking && message.role === "assistant" && message.thinking) chars += message.thinking.length + 16;
		if (message.role === "assistant" && message.tool_calls) {
			chars += JSON.stringify(message.tool_calls).length;
		}
	}
	chars += JSON.stringify(tools).length;
	return Math.ceil(chars / 4);
}

/** Pi-style: the latest persisted provider usage anchors the immutable prefix; newer content is estimated. */
export function estimateContextTokens(messages: readonly ChatMsg[]): ContextEstimate {
	let anchor = -1;
	let tokens = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && message.usage?.totalTokens && message.usage.totalTokens > 0) { anchor = i; tokens = message.usage.totalTokens; break; }
	}
	const trailing = messages.slice(anchor + 1);
	return { tokens: tokens + estimateRequestTokens(trailing), actual: anchor >= 0 && trailing.length === 0 };
}

export function formatForSummary(message: ChatMsg): string {
	if (message.role === "assistant" && message.tool_calls) {
		return `thinking=${message.thinking ?? ""} tool_calls=${JSON.stringify(message.tool_calls)} ${message.content}`;
	}
	return message.content;
}

/**
 * 严格基于当前上下文消息历史与工具定义计算多段 Token 分布（系统、提示词、助手回复、思考链、工具）。
 * 若提供 totalScaleTokens（如服务端返回的精确真实总 Token 数），则按比例精确映射。
 */
export function calculateContextSegments(
	messages: readonly ChatMsg[],
	tools: readonly ToolDef[] = [],
	totalScaleTokens?: number,
): ContextSegments {
	let systemChars = 0;
	let promptChars = 0;
	let assistantChars = 0;
	let thinkingChars = 0;
	let toolChars = 0;

	for (const message of messages) {
		const baseChars = message.content ? message.content.length + 16 : 16;
		if (message.role === "system") {
			systemChars += baseChars;
		} else if (message.role === "user") {
			promptChars += baseChars;
		} else if (message.role === "assistant") {
			assistantChars += baseChars;
			if (message.thinking) {
				thinkingChars += message.thinking.length + 16;
			}
			if (message.tool_calls) {
				toolChars += JSON.stringify(message.tool_calls).length;
			}
		} else if (message.role === "tool") {
			toolChars += baseChars;
		}
	}

	if (tools.length > 0) {
		toolChars += JSON.stringify(tools).length;
	}

	const totalChars = systemChars + promptChars + assistantChars + thinkingChars + toolChars;
	if (totalChars <= 0) {
		return { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 };
	}

	if (totalScaleTokens !== undefined && totalScaleTokens > 0) {
		const scale = totalScaleTokens / totalChars;
		const sys = Math.round(systemChars * scale);
		const pr = Math.round(promptChars * scale);
		const ast = Math.round(assistantChars * scale);
		const th = Math.round(thinkingChars * scale);
		const tl = Math.max(0, totalScaleTokens - sys - pr - ast - th);
		return {
			system: sys,
			prompt: pr,
			assistant: ast,
			thinking: th,
			tools: tl,
		};
	}

	return {
		system: Math.ceil(systemChars / 4),
		prompt: Math.ceil(promptChars / 4),
		assistant: Math.ceil(assistantChars / 4),
		thinking: Math.ceil(thinkingChars / 4),
		tools: Math.ceil(toolChars / 4),
	};
}
