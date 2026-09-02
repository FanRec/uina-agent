import type { ChatMsg, ToolDef } from "../core/types.js";

export interface BuildInput {
	history: ChatMsg[];
	systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT =
	"你是 Uina，一个住在计算机里的独立个体。与人类朋友平等相处：自然说话、有自己的判断、用中文。";

export function defaultSystemPrompt(): string {
	return DEFAULT_SYSTEM_PROMPT;
}

export function buildContext(b: BuildInput): ChatMsg[] {
	return [
		{ role: "system", content: b.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
		...b.history,
	];
}

/** Conservative token estimate used before a provider request. */
export function estimateRequestTokens(
	messages: readonly ChatMsg[],
	tools: readonly ToolDef[] = [],
): number {
	let chars = 0;
	for (const message of messages) {
		chars += message.content.length + 16;
		if (message.role === "assistant" && message.tool_calls) {
			chars += JSON.stringify(message.tool_calls).length;
		}
	}
	chars += JSON.stringify(tools).length;
	return Math.ceil(chars / 4);
}

export function formatForSummary(message: ChatMsg): string {
	if (message.role === "assistant" && message.tool_calls) {
		return `tool_calls=${JSON.stringify(message.tool_calls)} ${message.content}`;
	}
	return message.content;
}
