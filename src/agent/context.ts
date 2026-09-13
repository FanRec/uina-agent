import { imageNotice } from "../core/content.js";
import type { AgentMessage, ChatMsg, ContextSegments, ToolDef, Usage } from "../core/types.js";

/**
 * 近似 token 估算使用的字符/token 比。英文约 4，但中文与工具 JSON 的密度更高，
 * 因此该常数偏小会让估算偏低。对齐 Pi 的 CHARS_PER_TOKEN，集中在此便于调整。
 */
export const CHARS_PER_TOKEN = 4;

export interface ContextEstimate { tokens: number; actual: boolean; }

export interface BuildInput {
	history: readonly (AgentMessage | ChatMsg)[];
	systemPrompt?: string;
	includeThinking?: boolean;
	runtimeInputs?: readonly { source: { kind: string; type: string; ref?: string }; text?: string; data?: unknown }[];
}

const DEFAULT_SYSTEM_PROMPT =
	"你是 Uina,你的目标是变得像人类,感受自己，爱护自己。你处于一个harness中作为你与世界交互的媒介。";

export function defaultSystemPrompt(): string {
	return DEFAULT_SYSTEM_PROMPT;
}

/** Pure projection from agent history stream (including custom and compaction messages) to valid LLM messages. */
export function convertToLlm(
	messages: readonly (AgentMessage | ChatMsg)[],
	options: {
		includeThinking?: boolean;
	} = {},
): ChatMsg[] {
	const intermediate: ChatMsg[] = [];
	const toolResponses = new Set<string>();

	for (const msg of messages) {
		if (msg.role === "tool" && msg.tool_call_id) {
			toolResponses.add(msg.tool_call_id);
		}
	}

	for (const msg of messages) {
		switch (msg.role) {
			case "system":
				intermediate.push({ role: "system", content: msg.content, images: msg.images });
				break;
			case "custom":
				intermediate.push({ role: "user", content: msg.content, images: msg.images });
				break;
			case "compactionSummary":
				intermediate.push({ role: "user", content: `[历史摘要] ${msg.summary}` });
				break;
			case "user":
				intermediate.push({ role: "user", content: msg.content, images: msg.images });
				break;
			case "assistant": {
				const thinking = options.includeThinking ? msg.thinking : undefined;
				const thinkingSignature = options.includeThinking ? msg.thinkingSignature : undefined;
				const validToolCalls = msg.tool_calls?.filter((call) => toolResponses.has(call.id));
				const tool_calls = validToolCalls && validToolCalls.length > 0 ? validToolCalls : undefined;
				const content = typeof msg.content === "string" ? msg.content : "";
				const hasContent = content.trim().length > 0;
				const hasToolCalls = Boolean(tool_calls && tool_calls.length > 0);
				const hasThinking = Boolean(thinking && thinking.trim().length > 0);

				// Drop empty / cancelled assistant frames without text, thinking, or tool calls
				if (!hasContent && !hasToolCalls && !hasThinking) {
					continue;
				}

				intermediate.push({
					role: "assistant",
					content,
					thinking,
					thinkingSignature,
					tool_calls,
					status: msg.status,
					usage: msg.usage,
					providerReplay: msg.providerReplay,
				});
				break;
			}
			case "tool":
				intermediate.push({
					role: "tool",
					tool_call_id: msg.tool_call_id,
					content: msg.content,
     images: msg.images,
     details: msg.details,
					status: msg.status,
				});
				break;
		}
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

	return cleaned;
}

export function buildContext(b: BuildInput): ChatMsg[] {
	const baseSystem = b.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
	const systemContent = b.runtimeInputs?.length
		? `${baseSystem}\n\n<runtime_events>\n${b.runtimeInputs.map(formatRuntimeInput).join("\n")}\n</runtime_events>`
		: baseSystem;

	const cleaned = convertToLlm(b.history, {
		includeThinking: b.includeThinking,
	});

	return [
		{ role: "system", content: systemContent },
		...cleaned,
	];
}

function formatRuntimeInput(input: { source: { kind: string; type: string; ref?: string; provenance?: { branchId?: string; abandoned?: boolean } }; text?: string; data?: unknown }): string {
	const prov = input.source.provenance?.abandoned ? " [来自废弃分支]" : "";
	const source = `${input.source.kind}/${input.source.type}${input.source.ref ? `:${input.source.ref}` : ""}${prov}`;
	const data = input.data === undefined ? "" : ` data=${JSON.stringify(input.data)}`;
	return `[${source}] ${input.text ?? ""}${data}`;
}

/**
 * 统计消息历史与工具定义在各分段的原始字符总数。
 * 这是多段 Token 分布与请求级 Token 估算的单一事实来源（单遍遍历）。
 */
export function countContextSegmentChars(
	messages: readonly (AgentMessage | ChatMsg)[],
	tools: readonly ToolDef[] = [],
): ContextSegments {
	const seg: ContextSegments = { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 };
	for (const message of messages) {
		if (message.role === "custom") {
			seg.prompt += message.content ? message.content.length + 16 : 16;
			continue;
		}
		if (message.role === "compactionSummary") {
			seg.prompt += message.summary ? message.summary.length + 32 : 32;
			continue;
		}
		const baseChars = message.content ? message.content.length + 16 : 16;
		switch (message.role) {
			case "system":
				seg.system += baseChars;
				break;
			case "user":
				seg.prompt += baseChars;
				break;
			case "assistant":
				seg.assistant += baseChars;
				if (message.thinking) {
					seg.thinking += message.thinking.length + 16;
				}
				if (message.tool_calls) {
					seg.tools += JSON.stringify(message.tool_calls).length;
				}
				break;
			case "tool":
				seg.tools += baseChars;
				break;
		}
	}

	if (tools.length > 0) {
		seg.tools += JSON.stringify(tools).length;
	}

	return seg;
}

/** Approximate token estimate used before a provider request. */
export function estimateRequestTokens(
	messages: readonly (AgentMessage | ChatMsg)[],
	tools: readonly ToolDef[] = [],
	includeThinking = false,
): number {
	const seg = countContextSegmentChars(messages, tools);
	const totalChars = seg.system + seg.prompt + seg.assistant + (includeThinking ? seg.thinking : 0) + seg.tools;
	return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

export interface EstimateContextOptions {
	tools?: readonly ToolDef[];
	includeThinking?: boolean;
}

/**
 * Total context tokens for a usage block, mirroring Pi `calculateContextTokens`
 * (packages/ai/src/utils/estimate.ts): prefer the provider-reported total, and fall
 * back to the summed parts when a provider omits `totalTokens`.
 */
function contextTokensFromUsage(usage: Usage): number {
	const total = usage.totalTokens;
	if (total !== undefined && total > 0) return total;
	return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/**
 * Pi-style anchor: the latest *trustworthy* provider usage measures the immutable prefix and newer
 * content is estimated. Mirrors Pi `getAssistantUsage` — an aborted or errored turn never reported a
 * complete context, so its usage must not anchor the estimate (Uina's `status` is Pi's `stopReason`).
 */
export function estimateContextTokens(
	messages: readonly (AgentMessage | ChatMsg)[],
	options: EstimateContextOptions = {},
): ContextEstimate {
	let anchor = -1;
	let tokens = 0;
	let exact = false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		if (message.status === "aborted" || message.status === "error") continue;
		if (!message.usage) continue;
		const usageTokens = contextTokensFromUsage(message.usage);
		if (usageTokens <= 0) continue;
		anchor = i;
		tokens = usageTokens;
		// Only a provider-reported total is exact; a part-sum fallback is a good anchor but is
		// still an approximation, so it must not be reported as an actual measurement.
		exact = message.usage.totalTokens !== undefined && message.usage.totalTokens > 0;
		break;
	}
	const trailing = messages.slice(anchor + 1);
	return {
		tokens: tokens + estimateRequestTokens(trailing, options.tools, options.includeThinking),
		actual: anchor >= 0 && trailing.length === 0 && exact,
	};
}

export function formatForSummary(message: AgentMessage | ChatMsg): string {
	if (message.role === "assistant" && message.tool_calls) {
		return `thinking=${message.thinking ?? ""} tool_calls=${JSON.stringify(message.tool_calls)} ${message.content}`;
	}
	if (message.role === "compactionSummary") {
		return `[历史摘要] ${message.summary}`;
	}
	return message.content + imageNotice(message.images);
}

/**
 * 严格基于当前上下文消息历史与工具定义计算多段 Token 分布（系统、提示词、助手回复、思考链、工具）。
 * 若提供 totalScaleTokens（如服务端返回的精确真实总 Token 数），则按比例精确映射。
 */
export function calculateContextSegments(
	messages: readonly (AgentMessage | ChatMsg)[],
	tools: readonly ToolDef[] = [],
	totalScaleTokens?: number,
): ContextSegments {
	const seg = countContextSegmentChars(messages, tools);
	const totalChars = seg.system + seg.prompt + seg.assistant + seg.thinking + seg.tools;
	if (totalChars <= 0) {
		return { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 };
	}

	if (totalScaleTokens !== undefined && totalScaleTokens > 0) {
		const scale = totalScaleTokens / totalChars;
		const sys = Math.round(seg.system * scale);
		const pr = Math.round(seg.prompt * scale);
		const ast = Math.round(seg.assistant * scale);
		const th = Math.round(seg.thinking * scale);
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
		system: Math.ceil(seg.system / CHARS_PER_TOKEN),
		prompt: Math.ceil(seg.prompt / CHARS_PER_TOKEN),
		assistant: Math.ceil(seg.assistant / CHARS_PER_TOKEN),
		thinking: Math.ceil(seg.thinking / CHARS_PER_TOKEN),
		tools: Math.ceil(seg.tools / CHARS_PER_TOKEN),
	};
}
