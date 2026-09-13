import { imageNotice } from "../core/content.js";
import type { AgentMessage, ChatMsg, Model, ModelStreamFn, ToolDef } from "../core/types.js";
import type { ProviderHooks } from "../runtime/hooks.js";
import { buildContext, estimateContextTokens } from "./context.js";

export interface CompactionSettings {
	contextWindow?: number;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	reserveTokens: 16_384,
	keepRecentTokens: 20_000,
};

export interface CompactionResult {
	summary: string;
	retainedTail: (AgentMessage | ChatMsg)[];
	tokensBefore: number;
}

/** Token 超上限时的自动压缩判据（对齐 Pi shouldCompact）。 */
export function shouldCompact(
	history: readonly (AgentMessage | ChatMsg)[],
	systemPrompt: string,
	tools: readonly ToolDef[],
	settings: CompactionSettings,
	includeThinking = false,
): boolean {
	if (settings.contextWindow === undefined) return false;
	return (
		estimateContextTokens(buildContext({ history: [...history], systemPrompt }), { tools, includeThinking }).tokens >
		settings.contextWindow - settings.reserveTokens
	);
}

// ---------------------------------------------------------------------------
// 逐条消息 token 估算（对齐 Pi estimateTokens：计入文本、思考、工具调用与图片）
// ---------------------------------------------------------------------------

const ESTIMATED_IMAGE_CHARS = 4800;

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function contentChars(message: { content: string; images?: readonly unknown[] }): number {
	return message.content.length + (message.images?.length ?? 0) * ESTIMATED_IMAGE_CHARS;
}

/** 单条消息的保守 token 估算，供切点选择使用。 */
export function estimateMessageTokens(message: AgentMessage | ChatMsg): number {
	let chars: number;
	switch (message.role) {
		case "compactionSummary":
			chars = message.summary.length;
			break;
		case "assistant":
			chars = contentChars(message) + (message.thinking?.length ?? 0);
			if (message.tool_calls?.length) chars += safeJsonStringify(message.tool_calls).length;
			break;
		default:
			chars = contentChars(message);
			break;
	}
	return Math.ceil(chars / 4);
}

// ---------------------------------------------------------------------------
// 切点选择（对齐 Pi findCutPoint）：只在回合边界切开，绝不切断工具调用与结果
// ---------------------------------------------------------------------------

export interface CutPointResult {
	/** 压缩后保留的第一条消息下标。 */
	firstKeptEntryIndex: number;
	/** 当切点落在回合中间时，该回合起点的下标；否则为 -1。 */
	turnStartIndex: number;
	/** 切点是否把某个回合拆成两半。 */
	isSplitTurn: boolean;
}

/** 一回合的起点：用户消息，或扩展注入的 custom 消息。 */
function isTurnStart(message: AgentMessage | ChatMsg | undefined): boolean {
	return message?.role === "user" || message?.role === "custom";
}

/** 可作为切点的消息；tool 与 system 一律不可切。 */
function isCutPoint(message: AgentMessage | ChatMsg): boolean {
	switch (message.role) {
		case "user":
		case "assistant":
		case "custom":
		case "compactionSummary":
			return true;
		default:
			return false;
	}
}

/** 回溯到包含 entryIndex 的那个回合的起点。 */
export function findTurnStartIndex(
	history: readonly (AgentMessage | ChatMsg)[],
	entryIndex: number,
	startIndex: number,
): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isTurnStart(history[i])) return i;
	}
	return -1;
}

export function findCutPoint(
	history: readonly (AgentMessage | ChatMsg)[],
	keepRecentTokens: number,
	/** 手动压缩即使历史小于保留预算也必须推进；自动压缩不必。 */
	allowShortHistoryFallback = false,
): CutPointResult {
	const cutPoints: number[] = [];
	history.forEach((message, index) => {
		if (isCutPoint(message)) cutPoints.push(index);
	});
	if (cutPoints.length === 0) return { firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false };

	let accumulated = 0;
	let cutIndex = cutPoints[0];
	for (let i = history.length - 1; i >= 0; i--) {
		const message = history[i];
		if (!message) continue;
		accumulated += estimateMessageTokens(message);
		if (accumulated >= keepRecentTokens) {
			for (const point of cutPoints) {
				if (point >= i) {
					cutIndex = point;
					break;
				}
			}
			break;
		}
	}
	// 历史整体小于保留预算时，Pi 停在 cutPoints[0]（等于不压缩）。手动压缩需要推进，
	// 因此取最后一个合法切点，与 Uina 原有“至少压掉前缀”的行为一致。
	if (allowShortHistoryFallback && cutIndex <= 0 && history.length > 1) {
		for (const point of cutPoints) {
			if (point > 0 && point < history.length) cutIndex = point;
		}
	}
	const cutRole = history[cutIndex]?.role;
	const isTurnStartCut = cutRole === "user" || cutRole === "custom";
	const turnStartIndex = isTurnStartCut ? -1 : findTurnStartIndex(history, cutIndex, 0);
	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isTurnStartCut && turnStartIndex !== -1,
	};
}

// ---------------------------------------------------------------------------
// 压缩准备（对齐 Pi prepareCompaction）
// ---------------------------------------------------------------------------

export interface CompactionPreparation {
	/** 被折叠进历史摘要的消息。 */
	messagesToSummarize: (AgentMessage | ChatMsg)[];
	/** 拆分回合时单独摘要的前缀消息。 */
	turnPrefixMessages: (AgentMessage | ChatMsg)[];
	/** 压缩后原样保留的近期消息。 */
	retainedTail: (AgentMessage | ChatMsg)[];
	isSplitTurn: boolean;
	tokensBefore: number;
	/** 上一次压缩摘要，用于迭代更新。 */
	previousSummary?: string;
}

function findPreviousSummary(messages: readonly (AgentMessage | ChatMsg)[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message) continue;
		if (message.role === "compactionSummary") return message.summary;
		if (message.role === "user" && message.content.startsWith("[历史摘要]")) {
			return message.content.replace(/^\[历史摘要\]\s*/, "");
		}
	}
	return undefined;
}

export function prepareCompaction(
	history: readonly (AgentMessage | ChatMsg)[],
	cut: CutPointResult,
	tokensBefore: number,
): CompactionPreparation {
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const messagesToSummarize = history.slice(0, Math.max(0, historyEnd));
	const turnPrefixMessages = cut.isSplitTurn ? history.slice(cut.turnStartIndex, cut.firstKeptEntryIndex) : [];
	return {
		messagesToSummarize,
		turnPrefixMessages,
		retainedTail: history.slice(cut.firstKeptEntryIndex),
		isSplitTurn: cut.isSplitTurn,
		tokensBefore,
		previousSummary: findPreviousSummary(messagesToSummarize),
	};
}

// ---------------------------------------------------------------------------
// 摘要序列化与文件清单（对齐 Pi serializeConversation / 文件操作追踪）
// ---------------------------------------------------------------------------

const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... 已截断 ${text.length - maxChars} 个字符]`;
}

/** 把消息序列化成纯文本，供摘要提示词使用；工具结果超长时截断。 */
export function serializeConversation(messages: readonly (AgentMessage | ChatMsg)[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		switch (message.role) {
			case "system":
				// 系统提示不进摘要正文。
				break;
			case "user":
			case "custom": {
				const content = message.content + imageNotice(message.images);
				if (content) parts.push(`[用户]: ${content}`);
				break;
			}
			case "compactionSummary":
				parts.push(`[历史摘要]: ${message.summary}`);
				break;
			case "assistant": {
				const thinking = message.thinking?.trim();
				if (thinking) parts.push(`[助手思考]: ${thinking}`);
				if (message.content?.trim()) parts.push(`[助手]: ${message.content}`);
				if (message.tool_calls?.length) {
					const calls = message.tool_calls.map((call) => {
						const args = typeof call.args === "object" && call.args !== null ? (call.args as Record<string, unknown>) : {};
						const rendered = Object.entries(args)
							.map(([key, value]) => `${key}=${safeJsonStringify(value)}`)
							.join(", ");
						return `${call.name}(${rendered})`;
					});
					parts.push(`[助手工具调用]: ${calls.join("; ")}`);
				}
				break;
			}
			case "tool": {
				const content = message.content + imageNotice(message.images);
				if (content) parts.push(`[工具结果]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
				break;
			}
		}
	}
	return parts.join("\n\n");
}

const READ_TOOLS = new Set(["read_file", "read_image"]);
const WRITE_TOOLS = new Set(["write_file"]);

function collectFileOperations(
	messages: readonly (AgentMessage | ChatMsg)[],
): { readFiles: string[]; modifiedFiles: string[] } {
	const read = new Set<string>();
	const written = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !message.tool_calls?.length) continue;
		for (const call of message.tool_calls) {
			if (typeof call.args !== "object" || call.args === null) continue;
			const path = (call.args as Record<string, unknown>).path;
			if (typeof path !== "string") continue;
			if (READ_TOOLS.has(call.name)) read.add(path);
			else if (WRITE_TOOLS.has(call.name)) written.add(path);
		}
	}
	return {
		readFiles: [...read].filter((file) => !written.has(file)).sort(),
		modifiedFiles: [...written].sort(),
	};
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// 摘要生成（对齐 Pi：结构化检查点摘要 + 拆分回合的前缀摘要）
// ---------------------------------------------------------------------------

const SUMMARIZATION_SYSTEM_PROMPT = `你是上下文摘要助手。你的任务是阅读用户与 AI 助手之间的对话，然后严格按照指定格式输出结构化摘要。

不要继续对话。不要回答对话中的任何问题。只输出结构化摘要。`;

const SUMMARIZATION_PROMPT = `上面的消息是一段需要摘要的对话。请生成一份结构化的上下文检查点摘要，供另一个 LLM 继续工作使用。

严格使用以下格式：

## 目标
[用户想要完成什么？如果会话涉及多个任务，可以有多项。]

## 约束与偏好
- [用户提到的任何约束、偏好或要求]
- [如果没有，写“（无）”]

## 进展
### 已完成
- [x] [已完成的任务/改动]

### 进行中
- [ ] [当前工作]

### 受阻
- [阻碍进展的问题，如果有]

## 关键决策
- **[决策]**：[简要理由]

## 下一步
1. [接下来应该做什么，按顺序排列]

## 关键上下文
- [继续所需的数据、示例或引用]
- [如果不适用，写“（无）”]

每一节保持简洁。保留精确的文件路径、函数名和错误信息。`;

const UPDATE_SUMMARIZATION_PROMPT = `上面的消息是需要合并进 <previous-summary> 标签中已有摘要的新对话。

用新信息更新已有结构化摘要。规则：
- 保留已有摘要中的全部信息
- 添加新消息中的进展、决策和上下文
- 更新“进展”部分：已完成的项目从“进行中”移到“已完成”
- 根据已完成的工作更新“下一步”
- 保留精确的文件路径、函数名和错误信息
- 不再相关的内容可以删除

严格使用以下格式：

## 目标
[保留已有目标，任务扩展时补充新目标]

## 约束与偏好
- [保留已有，补充新发现的]

## 进展
### 已完成
- [x] [包含此前已完成项与新完成项]

### 进行中
- [ ] [当前工作，按进展更新]

### 受阻
- [当前阻碍，已解决则移除]

## 关键决策
- **[决策]**：[简要理由]（保留此前全部，补充新的）

## 下一步
1. [按当前状态更新]

## 关键上下文
- [保留重要上下文，需要时补充]

每一节保持简洁。保留精确的文件路径、函数名和错误信息。`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `这是某个因过大而无法完整保留的回合的“前缀”。该回合的“后缀”（最近的工作）已被保留。

请摘要这个前缀，为保留的后缀提供上下文：

## 原始请求
[用户在这个回合中要求了什么？]

## 早期进展
- [前缀中的关键决策和已完成的工作]

## 供后缀使用的上下文
- [理解所保留的近期工作所需的信息]

保持简洁。聚焦于理解所保留后缀所需的内容。`;

async function runSummaryTurn(
	model: Model,
	stream: ModelStreamFn,
	providerHooks: ProviderHooks,
	userPrompt: string,
	signal?: AbortSignal,
): Promise<string> {
	let text = "";
	let finished = false;
	await stream(
		model,
		{
			messages: [
				{ role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
				{ role: "user", content: userPrompt },
			],
			providerHooks,
		},
		(delta) => {
			if (finished && delta.kind !== "usage") throw new Error("compaction finish 后仍有内容");
			if (delta.kind === "finish") finished = true;
			if (delta.kind === "text") text += delta.text;
			if (delta.kind === "tool_call") throw new Error("compaction provider 返回了工具调用");
			if (delta.kind === "finish" && delta.reason !== "stop") {
				throw new Error(`compaction 未正常结束: ${delta.reason}`);
			}
		},
		signal,
	);
	signal?.throwIfAborted();
	if (!finished) throw new Error("compaction 缺少终止事件");
	const final = text.trim();
	if (!final) throw new Error("compaction 返回空摘要");
	return final;
}

function buildConversationPrompt(
	messages: readonly (AgentMessage | ChatMsg)[],
	previousSummary: string | undefined,
	basePrompt: string,
	instruction: string | undefined,
): string {
	let prompt = `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n`;
	if (previousSummary) prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	prompt += basePrompt;
	if (instruction?.trim()) prompt += `\n\n额外关注：${instruction.trim()}`;
	return prompt;
}

export async function compactHistory(
	history: readonly (AgentMessage | ChatMsg)[],
	model: Model,
	stream: ModelStreamFn,
	preparation: { cut: CutPointResult; tokensBefore: number; instruction?: string },
	providerHooks: ProviderHooks,
	signal?: AbortSignal,
): Promise<CompactionResult | null> {
	const { cut, tokensBefore, instruction } = preparation;
	// 保留位置为 0 等于不压缩；接受它只会持久化“摘要 + 它所摘要的全部内容”。
	if (cut.firstKeptEntryIndex <= 0) return null;

	const prepared = prepareCompaction(history, cut, tokensBefore);
	const historyPrompt = () =>
		buildConversationPrompt(
			prepared.messagesToSummarize,
			prepared.previousSummary,
			prepared.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT,
			instruction,
		);

	let summary: string;
	if (prepared.isSplitTurn && prepared.turnPrefixMessages.length > 0) {
		const historyText =
			prepared.messagesToSummarize.length > 0
				? await runSummaryTurn(model, stream, providerHooks, historyPrompt(), signal)
				: "无更早历史。";
		const prefixText = await runSummaryTurn(
			model,
			stream,
			providerHooks,
			buildConversationPrompt(prepared.turnPrefixMessages, undefined, TURN_PREFIX_SUMMARIZATION_PROMPT, undefined),
			signal,
		);
		summary = `${historyText}\n\n---\n\n**本轮上下文（拆分回合）：**\n\n${prefixText}`;
	} else {
		summary = await runSummaryTurn(model, stream, providerHooks, historyPrompt(), signal);
	}

	const { readFiles, modifiedFiles } = collectFileOperations([
		...prepared.messagesToSummarize,
		...prepared.turnPrefixMessages,
	]);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary,
		retainedTail: prepared.retainedTail.map((message) => structuredClone(message)),
		tokensBefore,
	};
}
