import type { AgentMessage, ChatMsg, Model, ModelStreamFn, ToolDef } from "../core/types.js";
import type { ProviderHooks } from "../runtime/hooks.js";
import { buildContext, estimateContextTokens, formatForSummary } from "./context.js";

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

export function findKeepFrom(
	history: readonly (AgentMessage | ChatMsg)[],
	keepRecentTokens: number,
	/** Manual compaction must make progress even when the whole history is
	 * smaller than the retention budget; automatic compaction must not. */
	allowShortHistoryFallback = false,
): number {
	let chars = 0;
	let keepFrom = 0;
	for (let i = history.length - 1; i >= 0; i--) {
		const message = history[i];
		const len = message.role === "compactionSummary" ? message.summary.length : (message.content?.length ?? 0);
		chars += len + 16;
		if (message.role === "assistant" && message.tool_calls) {
			chars += JSON.stringify(message.tool_calls).length;
		}
		if (Math.ceil(chars / 4) >= keepRecentTokens) {
			keepFrom = i;
			break;
		}
	}
	if (allowShortHistoryFallback && keepFrom === 0 && history.length > 1) {
		// Manual compaction on a history smaller than the retention budget still
		// has to summarize something: keep only the final message so the prefix
		// can be compacted (Pi's findCutPoint keeps the earliest valid cut point).
		keepFrom = history.length - 1;
	}
	while (keepFrom > 0 && history[keepFrom].role === "tool") keepFrom--;
	return keepFrom;
}

export async function compactHistory(
	history: readonly (AgentMessage | ChatMsg)[],
	model: Model,
	stream: ModelStreamFn,
	preparation: { keepFrom: number; tokensBefore: number; instruction?: string },
	providerHooks: ProviderHooks,
	signal?: AbortSignal,
): Promise<CompactionResult | null> {
	const { keepFrom, tokensBefore, instruction } = preparation;
	if (keepFrom <= 0) return null;

	const oldest = history.slice(0, keepFrom);
	const priorSummary = oldest.find(
		(message) =>
			(message.role === "user" && message.content.startsWith("[历史摘要]")) || message.role === "compactionSummary",
	);
	const rest = oldest.filter((message) => message !== priorSummary);
	const transcript =
		(priorSummary ? `[user] ${formatForSummary(priorSummary)}\n` : "") +
		rest.map((message) => `[${message.role}] ${formatForSummary(message)}`).join("\n");

	let summary = "";
	let finished = false;
	await stream(
		model,
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
			if (finished && delta.kind !== "usage") throw new Error("compaction finish 后仍有内容");
			if (delta.kind === "finish") finished = true;
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

	signal?.throwIfAborted();
	if (!finished) throw new Error("compaction 缺少终止事件");
	const final = summary.trim();
	if (!final) throw new Error("compaction 返回空摘要");
	return {
		summary: final,
		retainedTail: history.slice(keepFrom).map((message) => structuredClone(message)),
		tokensBefore,
	};
}
