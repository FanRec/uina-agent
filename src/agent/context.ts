import type { AgentMessage, ChatMsg, ContextSegments, RequestProjection, TokenMeasurement, ToolDef, Usage } from "../core/types.js";

/** ASCII fallback ratio. Non-ASCII code points are counted separately below. */
export const CHARS_PER_TOKEN = 4;

export interface ContextEstimate { tokens: number; actual: boolean; }

export interface BuildInput {
	history: readonly (AgentMessage | ChatMsg)[];
	systemPrompt?: string;
	includeThinking?: boolean;
	/** Replacement 缝：memory→provider 形塑（缺省 = convertToLlm 默认实现）。 */
	convertToLlm?: (
		messages: readonly (AgentMessage | ChatMsg)[],
		opts?: { includeThinking?: boolean },
	) => ChatMsg[];
}

const DEFAULT_SYSTEM_PROMPT =
	"你是 Uina。你处于一个 harness 中,这是你与世界交互的媒介。";

export function defaultSystemPrompt(): string {
	return DEFAULT_SYSTEM_PROMPT;
}

/** Pure projection from agent history stream (including custom messages) to valid LLM messages.
 *
 * 保留为自由函数（非管道成员，P2-J 裁定）：provider 边界的纵深防御——输入不只来自
 * journal 投影，还含 turn.prepare 注入的 messages 与自定义 projectHistory policy
 * 的产物，这里统一清洗（孤儿 tool_calls/幽灵 assistant 帧），保证任何来源的
 * 历史都以协议合法的形状到达 provider。 */
export function convertToLlm(
	messages: readonly (AgentMessage | ChatMsg)[],
	options: {
		includeThinking?: boolean;
	} = {},
): ChatMsg[] {
	const responseIds = new Set<string>();
	const callIds = new Set<string>();

	for (const msg of messages) {
		if (msg.role === "tool" && msg.tool_call_id) {
			responseIds.add(msg.tool_call_id);
		} else if (msg.role === "assistant" && msg.tool_calls) {
			for (const call of msg.tool_calls) {
				callIds.add(call.id);
			}
		}
	}

	const pairedIds = new Set<string>();
	for (const id of responseIds) {
		if (callIds.has(id)) pairedIds.add(id);
	}

	const result: ChatMsg[] = [];
	for (const msg of messages) {
		const inherited = "context" in msg ? msg.context : "input" in msg && msg.input ? { input: msg.input } : undefined;
		const entryId = "id" in msg ? msg.id : undefined;
		const context = inherited || entryId ? { ...inherited, ...(entryId ? { entryId } : {}) } : undefined;
        const meta = context ? { context } : {};
		switch (msg.role) {
			case "system":
				result.push({ ...meta, role: "system", content: msg.content, images: msg.images });
				break;
			case "custom":
			case "user":
				result.push({ ...meta, role: "user", content: msg.content, images: msg.images });
				break;
			case "assistant": {
				const thinking = options.includeThinking ? msg.thinking : undefined;
				const thinkingSignature = options.includeThinking ? msg.thinkingSignature : undefined;
				const validToolCalls = msg.tool_calls?.filter((call) => pairedIds.has(call.id));
				const tool_calls = validToolCalls && validToolCalls.length > 0 ? validToolCalls : undefined;
				const content = typeof msg.content === "string" ? msg.content : "";
				const hasContent = content.trim().length > 0;
				const hasToolCalls = Boolean(tool_calls && tool_calls.length > 0);
				const hasThinking = Boolean(thinking && thinking.trim().length > 0);

				// Drop empty / cancelled assistant frames without text, thinking, or tool calls
				if (!hasContent && !hasToolCalls && !hasThinking) {
					continue;
				}

				result.push({
                    ...meta,
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
				if (msg.tool_call_id && pairedIds.has(msg.tool_call_id)) {
					result.push({
                        ...meta,
						role: "tool",
						tool_call_id: msg.tool_call_id,
						content: msg.content,
						images: msg.images,
						details: msg.details,
						status: msg.status,
					});
				}
				break;
		}
	}

	return result;
}

export function buildContext(b: BuildInput): ChatMsg[] {
	// 运行时事件不走 system 拼接：runtime input 经队列落为 runtime-input custom
	// 消息进主线历史（projectInputMessage），由 convertToLlm 统一投影。
	const systemContent = b.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

	const toLlm = b.convertToLlm ?? convertToLlm;
	const cleaned = toLlm(b.history, {
		includeThinking: b.includeThinking,
	});

	return [
		{ role: "system", content: systemContent },
		...cleaned,
	];
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
	const seg = estimateContextSegments(messages, tools);
	return seg.system + seg.prompt + seg.assistant + (includeThinking ? seg.thinking : 0) + seg.tools;
}

/** Measure one complete model-semantic projection. Provider-specific exact
 * measurers may be supplied by the caller; the fallback remains explicitly
 * approximate so UI and budget decisions cannot mistake it for server truth. */
export function measureRequestContext(
	projection: RequestProjection,
	providerMeasure?: (projection: RequestProjection) => TokenMeasurement | undefined,
): TokenMeasurement {
	const measured = providerMeasure?.(projection);
	if (measured) {
		if (!Number.isSafeInteger(measured.inputTokens) || measured.inputTokens < 0) {
			throw new Error(`上下文测量器返回非法 inputTokens: ${measured.inputTokens}`);
		}
		return measured;
	}
	const segments = estimateContextSegments(projection.messages, projection.tools);
	return {
		inputTokens: segments.system + segments.prompt + segments.assistant
			+ (projection.thinkingLevel !== "off" ? segments.thinking : 0) + segments.tools,
		kind: "approximate",
		source: "fallback_estimator",
		segments,
	};
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

/**
 * 严格基于当前上下文消息历史与工具定义计算多段 Token 分布（系统、提示词、助手回复、思考链、工具）。
 * 若提供 totalScaleTokens（如服务端返回的精确真实总 Token 数），则按比例精确映射。
 */
export function calculateContextSegments(
	messages: readonly (AgentMessage | ChatMsg)[],
	tools: readonly ToolDef[] = [],
	totalScaleTokens?: number,
): ContextSegments {
	const estimated = estimateContextSegments(messages, tools);
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

	return estimated;
}

/** Conservative fallback: ASCII text uses the conventional 4 chars/token;
 * every non-ASCII code point counts as one token. This intentionally errs high
 * for CJK and mixed JSON instead of pretending one global ratio is safe. */
export function estimateTextTokens(text: string): number {
	let ascii = 0;
	let nonAscii = 0;
	for (const char of text) {
		if (char.codePointAt(0)! <= 0x7f) ascii++;
		else nonAscii++;
	}
	return Math.ceil(ascii / CHARS_PER_TOKEN) + nonAscii;
}

export function estimateContextSegments(
	messages: readonly (AgentMessage | ChatMsg)[],
	tools: readonly ToolDef[] = [],
): ContextSegments {
	const result: ContextSegments = { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 };
	for (const message of messages) {
		const contentTokens = estimateTextTokens(message.content ?? "") + 4;
		switch (message.role) {
			case "system": result.system += contentTokens; break;
			case "custom":
			case "user": result.prompt += contentTokens; break;
			case "assistant":
				result.assistant += contentTokens;
				if (message.thinking) result.thinking += estimateTextTokens(message.thinking) + 4;
				if (message.tool_calls) result.tools += estimateTextTokens(JSON.stringify(message.tool_calls));
				break;
			case "tool": result.tools += contentTokens; break;
		}
	}
	if (tools.length > 0) result.tools += estimateTextTokens(JSON.stringify(tools));
	return result;
}
