import { imageNotice } from "../core/content.js";
import type { AgentMessage, ChatMsg, Model, ModelStreamFn } from "../core/types.js";
import type { ProviderHooks } from "../runtime/hooks.js";
import { CHARS_PER_TOKEN } from "./context.js";

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

/**
 * 压缩会重组上下文，历史消息上残留的 `usage.totalTokens` 是**压缩前**服务端报的绝对总量，
 * 不再等于压缩后的上下文大小。若不清除，`estimateContextTokens` 会锚定这个过期的大值，
 * 让“压缩后依旧超限”反复触发压缩。
 */
export function clearRetainedUsage(
	retainedTail: readonly (AgentMessage | ChatMsg)[],
): (AgentMessage | ChatMsg)[] {
	return retainedTail.map((message) => {
		const cloned = structuredClone(message);
		if (cloned.role === "assistant") delete cloned.usage;
		return cloned;
	});
}

/**
 * Token 超上限时的自动压缩判据（对齐 Pi shouldCompact(contextTokens, contextWindow, settings)）。
 * 上下文估算由调用方完成并传入：本函数不做估算，避免同一份历史在一次体检里被反复扫描。
 */
export function shouldCompact(
	contextTokens: number,
	settings: CompactionSettings,
): boolean {
	if (settings.contextWindow === undefined) return false;
	return contextTokens > settings.contextWindow - settings.reserveTokens;
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
	return Math.ceil(chars / CHARS_PER_TOKEN);
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

/** 收集所有可作为切点的消息下标（升序），tool 与 system 不计入。 */
function collectCutPoints(history: readonly (AgentMessage | ChatMsg)[]): number[] {
	const points: number[] = [];
	history.forEach((message, index) => {
		if (isCutPoint(message)) points.push(index);
	});
	return points;
}

function firstCutPointAtOrAfter(cutPoints: readonly number[], index: number): number | undefined {
	for (const point of cutPoints) {
		if (point >= index) return point;
	}
	return undefined;
}

/** 从末尾往前累计 token，返回预算用尽处的消息下标；未用尽时返回 -1。 */
function indexWhereBudgetIsSpent(history: readonly (AgentMessage | ChatMsg)[], keepRecentTokens: number): number {
	let accumulated = 0;
	for (let i = history.length - 1; i >= 0; i--) {
		const message = history[i];
		if (!message) continue;
		accumulated += estimateMessageTokens(message);
		if (accumulated >= keepRecentTokens) return i;
	}
	return -1;
}

export function findCutPoint(
	history: readonly (AgentMessage | ChatMsg)[],
	keepRecentTokens: number,
	/** 手动压缩即使历史小于保留预算也必须推进；自动压缩不必。 */
	allowShortHistoryFallback = false,
): CutPointResult {
	const cutPoints = collectCutPoints(history);
	if (cutPoints.length === 0) return { firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false };

	const spentAt = indexWhereBudgetIsSpent(history, keepRecentTokens);
	let cutIndex = firstCutPointAtOrAfter(cutPoints, spentAt) ?? cutPoints[0];
	// 历史整体小于保留预算时，Pi 停在 cutPoints[0]（等于不压缩）。手动压缩必须推进，
	// 否则 /compact 会变成空操作：退守到最靠后的合法切点，只保留末尾一小段。
	// 这与被替换的 findKeepFrom（keepFrom = length - 1 再回退越过 tool）结果一致。
	if (allowShortHistoryFallback && cutIndex <= 0 && history.length > 1) {
		for (const point of cutPoints) {
			if (point > 0 && point < history.length) cutIndex = point;
		}
	}
	const isTurnStartCut = isTurnStart(history[cutIndex]);
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

export function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... 已截断 ${text.length - maxChars} 个字符]`;
}

/** 把一个工具调用渲染成 `name(key=value, ...)`，供摘要正文使用。 */
function formatToolCall(call: { name: string; args?: unknown }): string {
	const args = typeof call.args === "object" && call.args !== null ? (call.args as Record<string, unknown>) : {};
	const rendered = Object.entries(args)
		.map(([key, value]) => `${key}=${safeJsonStringify(value)}`)
		.join(", ");
	return `${call.name}(${rendered})`;
}
/**
 * 把消息序列化成纯文本，供摘要提示词使用；工具结果超长时截断。
 *
 * omitToolResults=true 时丢弃工具结果正文（换成一行政明规模的占位），只保留调用名与
 * 参数。这是摘要请求自身超限时的降级：工具结果是膨胀主因，一级降级通常足以让请求
 * 装得下。消息仍会被摘要 —— 丢的是原文，不是事实。
 */
export function serializeConversation(
	messages: readonly (AgentMessage | ChatMsg)[],
	options: { omitToolResults?: boolean } = {},
): string {
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
					parts.push(`[助手工具调用]: ${message.tool_calls.map(formatToolCall).join("; ")}`);
				}
				break;
			}
			case "tool": {
				const content = message.content + imageNotice(message.images);
				if (!content) break;
				parts.push(options.omitToolResults
					? `[工具结果已省略：原 ${content.length} 字符]`
					: `[工具结果]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
				break;
			}
		}
	}
	return parts.join("\n\n");
}

const READ_TOOLS = new Set(["read_file", "read_image"]);
const WRITE_TOOLS = new Set(["write_file"]);

export function collectFileOperations(
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

export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
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

export const SUMMARIZATION_PROMPT = `上面的消息是一段需要摘要的对话。请生成一份结构化的上下文检查点摘要，供另一个 LLM 继续工作使用。

严格使用以下格式：

## 目标
[用户想要完成什么？如果会话涉及多个任务，可以有多项。]

## 约束与偏好
- [用户提到的任何约束、偏好或要求]
- [如果没有，写“（无）”]

## 进展
### 进行中
- [ ] [当前正在做的工作；用一两行说明此刻的状态]

### 受阻
- [阻碍进展的问题，如果有；没有则写“（无）”]

## 关键决策
- **[决策]**：[理由；重点记录“为什么这样选”和已排除的方案，而不是“做了什么”]

## 下一步
1. [接下来应该做什么，按顺序排列；这是最重要的一节]

## 关键上下文
- [继续工作**必须**知道的事实：目录、配置值、未完成的外部动作、约定]
- [只保留仍然会被用到的文件路径、函数名、错误信息；行号会失效，不要记录行号]
- [如果不适用，写“（无）”]

**长度纪律（重要）**：整份摘要控制在 8000 字符以内。宁可概括，也不要罗列。
- **不要**写改动流水账（“提交 X：改了 Y”）——这些从 git log 就能查到，写进来只是浪费空间。
- **不要**复述用户已经知道、或不再影响下一步操作的内容。
- 优先保留：目标、进行中的状态、阻塞项、未决决策、以及会让后来者重蹈覆辙的教训。`;

export const UPDATE_SUMMARIZATION_PROMPT = `上面的消息是需要合并进 <previous-summary> 标签中已有摘要的新对话。

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
### 进行中
- [ ] [当前状态，按最新进展更新]

### 受阻
- [当前阻碍，已解决则移除；没有则写“（无）”]

## 关键决策
- **[决策]**：[理由]（保留此前的关键决策，补充新的）

## 下一步
1. [按当前状态更新]

## 关键上下文
- [保留仍然有效的重要上下文，需要时补充；删掉已失效的]

**长度纪律（重要）**：整份摘要控制在 8000 字符以内。
- **不要**写改动流水账（“提交 X：改了 Y”）——这些从 git log 就能查到，写进来只是浪费空间。
- **不要**记录行号（会失效）；只保留仍然会被用到的文件路径、函数名、错误信息。
- 优先保留：目标、进行中的状态、阻塞项、未决决策、教训。`;

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
	omitToolResults = false,
): string {
	let prompt = `<conversation>\n${serializeConversation(messages, { omitToolResults })}\n</conversation>\n\n`;
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
	const historyPrompt = (omitToolResults = false) =>
		buildConversationPrompt(
			prepared.messagesToSummarize,
			prepared.previousSummary,
			prepared.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT,
			instruction,
			omitToolResults,
		);

	// 摘要请求自身可能超限：恢复一个用大窗口模型录制的会话后，被折叠段的序列化
	// 结果可以远超当前模型的硬限 —— 那次注定失败的请求会在传输层被切断并重试，
	// 最后以难以定位的 turn_failed 告终（真机事故：182k 上下文压 124k 窗口）。
	// 发出前先量一次：超限先降级（丢工具结果正文，保留调用名与参数），仍超限则
	// 立即以带数字的错误终止 —— 失败可见、可定位，而不是黑盒重试。工具结果是
	// 膨胀主因，一级降级通常已足够；连降级都装不下的形态出现时再议下一步。
	// contextWindow 未知时跳过全部检查 —— 未知就说明未知，不伪造保护。
	let omitToolResults = false;
	if (model.contextWindow !== undefined) {
		// 约束只有一个：prompt + 摘要输出必须装进窗口硬限（reserveTokens 是主线体检的
		// 判据，与这里无关）。输出按长度纪律的上限预留（2000 tokens ≈ 8000 字符），
		// 但封顶窗口一半 —— 小窗口下按比例缩，否则余量吃光预算，任何输入都被拒。
		const outputAllowanceTokens = Math.min(2_000, Math.floor(model.contextWindow / 2));
		const budgetChars = (model.contextWindow - outputAllowanceTokens) * CHARS_PER_TOKEN;
		if (historyPrompt().length > budgetChars) {
			if (historyPrompt(true).length > budgetChars) {
				throw new Error(
					`摘要输入约 ${Math.ceil(historyPrompt(true).length / CHARS_PER_TOKEN)} tokens，超模型窗口 ${model.contextWindow}`,
				);
			}
			omitToolResults = true;
		}
	}

	let summary: string;
	if (prepared.isSplitTurn && prepared.turnPrefixMessages.length > 0) {
		const historyText =
			prepared.messagesToSummarize.length > 0
				? await runSummaryTurn(model, stream, providerHooks, historyPrompt(omitToolResults), signal)
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
		summary = await runSummaryTurn(model, stream, providerHooks, historyPrompt(omitToolResults), signal);
	}

	const { readFiles, modifiedFiles } = collectFileOperations([
		...prepared.messagesToSummarize,
		...prepared.turnPrefixMessages,
	]);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary,
		retainedTail: clearRetainedUsage(prepared.retainedTail),
		tokensBefore,
	};
}
