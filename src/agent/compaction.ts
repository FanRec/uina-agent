import type { ChatMsg, ModelProvider, ToolDef } from "../core/types.js";
import type { ProviderHooks } from "../runtime/hooks.js";
import { buildContext, estimateContextTokens, estimateRequestTokens, formatForSummary } from "./context.js";

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
	retainedTail: ChatMsg[];
	tokensBefore: number;
}

export interface PrepareNextTurnContext {
	turnNumber: number;
	history: readonly ChatMsg[];
	provider: ModelProvider;
	systemPrompt: string;
	tools: readonly ToolDef[];
	compaction: CompactionSettings;
	providerHooks: ProviderHooks;
	signal?: AbortSignal;
}

export interface PrepareNextTurnResult {
	history?: ChatMsg[];
	systemPrompt?: string;
	compaction?: CompactionResult;
}

export async function defaultPrepareNextTurn(
	ctx: PrepareNextTurnContext,
	beforeCompact?: (input: { tokensBefore: number }) => Promise<{ cancel?: boolean }>,
): Promise<PrepareNextTurnResult | null> {
	const tokensBefore = Math.ceil(ctx.history.reduce((acc, m) => acc + m.content.length + 16, 0) / 4);
	if (beforeCompact) {
		const decision = await beforeCompact({ tokensBefore });
		if (decision.cancel) return null;
	}
	const result = await compactHistory(
		ctx.history,
		ctx.provider,
		ctx.systemPrompt,
		ctx.tools,
		ctx.compaction,
		ctx.providerHooks,
		ctx.signal,
		ctx.provider.includeThinking,
	);
	if (!result) return null;
	return {
		history: [
			{ role: "user", content: `[历史摘要] ${result.summary}` },
			...result.retainedTail,
		],
		compaction: result,
	};
}

export function shouldCompact(
	history: readonly ChatMsg[],
	systemPrompt: string,
	tools: readonly ToolDef[],
	settings: CompactionSettings,
	includeThinking = false,
): boolean {
	if (settings.contextWindow === undefined) return false;
	if (settings.contextWindow === 0) return true;
	return (
		estimateContextTokens(buildContext({ history: [...history], systemPrompt })).tokens + estimateRequestTokens([], tools, includeThinking) >
		settings.contextWindow - settings.reserveTokens
	);
}

export function findKeepFrom(
	history: readonly ChatMsg[],
	keepRecentTokens: number,
): number {
	let chars = 0;
	let keepFrom = 0;
	for (let i = history.length - 1; i >= 0; i--) {
		const message = history[i];
		chars += message.content.length + 16;
		if (message.role === "assistant" && message.tool_calls) {
			chars += JSON.stringify(message.tool_calls).length;
		}
		if (Math.ceil(chars / 4) >= keepRecentTokens) {
			keepFrom = i;
			break;
		}
	}
	while (keepFrom > 0 && history[keepFrom].role === "tool") keepFrom--;
	return keepFrom;
}

export async function compactHistory(
	history: readonly ChatMsg[],
	provider: ModelProvider,
	systemPrompt: string,
	tools: readonly ToolDef[],
	settings: CompactionSettings,
	providerHooks: ProviderHooks,
	signal?: AbortSignal,
	includeThinking = false,
	instruction?: string,
): Promise<CompactionResult | null> {
	if (!shouldCompact(history, systemPrompt, tools, settings, includeThinking)) return null;
	const keepFrom = findKeepFrom(history, settings.keepRecentTokens);
	if (keepFrom <= 0) return null;

	const oldest = history.slice(0, keepFrom);
	const priorSummary = oldest.find(
		(message) =>
			message.role === "user" && message.content.startsWith("[历史摘要]"),
	);
	const rest = oldest.filter((message) => message !== priorSummary);
	const transcript = (
		(priorSummary ? `[user] ${priorSummary.content}\n` : "") +
		rest.map((message) => `[${message.role}] ${formatForSummary(message)}`).join("\n")
	);

	let summary = "";
	await provider.stream(
		{
			messages: [
				{
					role: "system",
					content:
						instruction ??
						"你是 Uina。把以下历史对话压缩成不超过 200 字的中文摘要：只保留关键事实、用户偏好、未完成事项。不要寒暄。",
				},
				{ role: "user", content: transcript },
			],
			providerHooks,
		},
		(delta) => {
			if (delta.kind === "text") summary += delta.text;
			if (delta.kind === "tool_call") {
				throw new Error("compaction provider 返回了工具调用");
			}
			if (delta.kind === "finish" && delta.reason !== "stop") {
				throw new Error(`compaction 未正常结束: ${delta.reason}`);
			}
		},
		signal,
	);

	const final = summary.trim();
	if (!final) throw new Error("compaction 返回空摘要");
	return {
		summary: final,
		retainedTail: history.slice(keepFrom).map((message) => structuredClone(message)),
		tokensBefore: estimateContextTokens(buildContext({ history: [...history], systemPrompt })).tokens + estimateRequestTokens([], tools, includeThinking),
	};
}
