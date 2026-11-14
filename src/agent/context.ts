import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripExpressionTags } from "../core/expression.js";
import type {
	AgentMessage,
	ChatMsg,
	ContextSegments,
	RequestProjection,
	ThinkingReplay,
	TokenMeasurement,
	ToolDef,
	Usage,
} from "../core/types.js";

/** ASCII fallback ratio. Non-ASCII code points are counted separately below. */
export const CHARS_PER_TOKEN = 4;

/** Per-image token estimate for budget arithmetic. Cross-provider middle ground
 * (Claude ~1600/image at the cap, OpenAI high detail ~1105, Gemini ~258/tile);
 * intentionally errs slightly low rather than evicting history early. Images
 * were previously invisible to both the wire measurement and the compaction
 * estimator, so image-heavy sessions could exceed the provider limit unchecked. */
export const IMAGE_TOKEN_ESTIMATE = 1024;

export interface ContextEstimate {
	tokens: number;
	actual: boolean;
}

/** 内置默认主体 System 的打包位置：与调用方模块（src 或 dist/src）同目录的 prompts/system.md。
 * 权威内容来自该文件而不是内联字符串——运行 dist 时读取 dist 中的副本，
 * 仅改源码默认文件而未重新构建不会改变正在运行的 dist。 */
const BUILTIN_SYSTEM_URL = new URL("./prompts/system.md", import.meta.url);

/** 内置默认 System 的编译入口与资源根（= 文件所在打包目录，引用只能落在该目录内）。 */
export function builtinSystemResource(): { entry: string; root: string } {
	return { entry: "system.md", root: fileURLToPath(new URL("./prompts/", import.meta.url)) };
}

/** 内置默认主体 System（启动/测试与裸 Subject 兼容回退读取）。
 * 读取失败必须显式报错：默认正文是发布包随附资源，缺失说明构建或复制不完整。 */
export function defaultSystemPrompt(): string {
	const bytes = readFileSync(fileURLToPath(BUILTIN_SYSTEM_URL));
	const text = new TextDecoder("utf-8", { fatal: true })
		.decode(bytes)
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.trim();
	if (!text) throw new Error(`内置默认 System 文件为空: ${fileURLToPath(BUILTIN_SYSTEM_URL)}`);
	return text;
}

/** Pure projection from agent history stream (including custom messages) to valid LLM messages.
 *
 * 保留为自由函数（History View 的上游，provider 边界的纵深防御）：输入来自 canonical
 * history 投影（含自定义 projectHistory policy 的产物），这里统一清洗（孤儿
 * tool_calls/幽灵 assistant 帧），保证历史以协议合法的形状进入 History View 与 provider。 */
export function convertToLlm(
	messages: readonly (AgentMessage | ChatMsg)[],
	options: {
		thinkingReplay?: ThinkingReplay;
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
				const validToolCalls = msg.tool_calls?.filter((call) => pairedIds.has(call.id));
				const tool_calls = validToolCalls && validToolCalls.length > 0 ? validToolCalls : undefined;
				const replay = options.thinkingReplay ?? "none";
				// DeepSeek thinking 模式逐帧校验 reasoning_content，回放范围由协议决定，
				// 与这一轮有没有工具调用无关。
				const carriesThinking = replay === "all";
				const thinking = carriesThinking ? msg.thinking : undefined;
				const thinkingSignature = carriesThinking ? msg.thinkingSignature : undefined;
				const hasThinking = Boolean(thinking && thinking.trim().length > 0);
				// 模型历史视图（输出表达体系 §6.4）：保留历史需要原样回放签名/provider 原生
				// 块时整段保持原文，不做局部剥离；否则用注解把已识别的表现性标签语义化为
				// 普通文本（不改工具调用、工具结果、用户消息或 canonical），减少旧 Cue 被模仿。
				// 该条件由单次请求的 thinkingReplay 统一决定，同请求内不出现部分改写。
				const expressionAnnotation =
					!carriesThinking && "expression" in msg && msg.expression ? msg.expression : undefined;
				const rawContent = typeof msg.content === "string" ? msg.content : "";
				const content = expressionAnnotation ? stripExpressionTags(rawContent, expressionAnnotation) : rawContent;
				const hasContent = content.trim().length > 0;
				const hasToolCalls = Boolean(tool_calls && tool_calls.length > 0);

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
					providerReplay: carriesThinking ? msg.providerReplay : undefined,
				});
				break;
			}
			case "tool":
				if (msg.tool_call_id && pairedIds.has(msg.tool_call_id)) {
					// 单一规则（信息注入重构 §7）：模型可见结果用 modelView ?? canonical 的
					// 字段级回退；status 永远来自 canonical（执行事实由流水线独占）。
					// modelView.details 只是内部投影信息，与 canonical details 一样不上 Wire。
					const view = msg.modelView;
					result.push({
						...meta,
						role: "tool",
						tool_call_id: msg.tool_call_id,
						content: view?.content ?? msg.content,
						images: view?.images ?? msg.images,
						details: view?.details ?? msg.details,
						status: msg.status,
					});
				}
				break;
		}
	}

	return result;
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
		// 图片按 IMAGE_TOKEN_ESTIMATE 折算成等效 ASCII 字符参与统计，与
		// estimateContextSegments 的图片 token 口径保持同一比例（chars = tokens × 4）。
		const imageChars = (message.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN;
		if (message.role === "custom") {
			seg.prompt += (message.content ? message.content.length + 16 : 16) + imageChars;
			continue;
		}
		const baseChars = message.content ? message.content.length + 16 : 16;
		switch (message.role) {
			case "system":
				seg.system += baseChars + imageChars;
				break;
			case "user":
				seg.prompt += baseChars + imageChars;
				break;
			case "assistant":
				if (message.providerReplay) {
					// wire 只回放 providerReplay 块：content / thinking / tool_calls 不再单独上链，避免重复计数。
					seg.assistant += JSON.stringify(message.providerReplay).length;
					break;
				}
				seg.assistant += baseChars;
				if (message.thinking) {
					seg.thinking += message.thinking.length + 16;
				}
				if (message.tool_calls) {
					seg.tools += JSON.stringify(message.tool_calls).length;
				}
				break;
			case "tool":
				seg.tools += baseChars + imageChars;
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
	countThinking = false,
): number {
	const seg = estimateContextSegments(messages, tools);
	return seg.system + seg.prompt + seg.assistant + (countThinking ? seg.thinking : 0) + seg.tools;
}

/** Measure one complete model-semantic projection. Provider-specific exact
 * measurers may be supplied by the caller; the fallback remains explicitly
 * approximate so UI and budget decisions cannot mistake it for server truth.
 *
 * countThinking 必须与真实发送口径（model.thinkingReplay 是否非 none）一致：
 * thinking 是否上链路由回放范围决定，而不是 thinkingLevel（那只是生成预算档位）。 */
export function measureRequestContext(
	projection: RequestProjection,
	providerMeasure?: (projection: RequestProjection) => TokenMeasurement | undefined,
	options?: { countThinking?: boolean },
): TokenMeasurement {
	const measured = providerMeasure?.(projection);
	if (measured) {
		if (!Number.isSafeInteger(measured.inputTokens) || measured.inputTokens < 0) {
			throw new Error(`上下文测量器返回非法 inputTokens: ${measured.inputTokens}`);
		}
		return measured;
	}
	const countThinking = options?.countThinking ?? false;
	const segments = estimateContextSegments(projection.messages, projection.tools);
	return {
		inputTokens:
			segments.system + segments.prompt + segments.assistant + (countThinking ? segments.thinking : 0) + segments.tools,
		kind: "approximate",
		source: "fallback_estimator",
		segments,
	};
}

export interface EstimateContextOptions {
	tools?: readonly ToolDef[];
	countThinking?: boolean;
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
		tokens: tokens + estimateRequestTokens(trailing, options.tools, options.countThinking),
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
		// assistant 变体虽有 images 字段但 convertToLlm 不发送，按 wire 口径不计。
		const imageTokens = message.role === "assistant" ? 0 : (message.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
		switch (message.role) {
			case "system":
				result.system += contentTokens + imageTokens;
				break;
			case "custom":
			case "user":
				result.prompt += contentTokens + imageTokens;
				break;
			case "assistant":
				if (message.providerReplay) {
					// wire 只回放 providerReplay 块：content / thinking / tool_calls 不再单独上链，避免重复计数。
					result.assistant += estimateTextTokens(JSON.stringify(message.providerReplay));
					break;
				}
				result.assistant += contentTokens;
				if (message.thinking) result.thinking += estimateTextTokens(message.thinking) + 4;
				if (message.tool_calls) result.tools += estimateTextTokens(JSON.stringify(message.tool_calls));
				break;
			case "tool":
				result.tools += contentTokens + imageTokens;
				break;
		}
	}
	if (tools.length > 0) result.tools += estimateTextTokens(JSON.stringify(tools));
	return result;
}
