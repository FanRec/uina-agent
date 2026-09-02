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
		...b.history.map((message) =>
			message.role === "tool"
				? { ...message, content: projectToolResult(message.content) }
				: message,
		),
	];
}

function projectToolResult(value: string): string {
	const limit = 2000;
	if (value.length <= limit) return value;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const projected = { ...parsed };
			for (const key of ["stdout", "stderr", "result"]) {
				if (typeof projected[key] === "string") projected[key] = projected[key].slice(0, 500);
			}
			const json = JSON.stringify(projected);
			if (json.length <= limit) return `${json}…[tool result truncated]`;
		}
	} catch { /* retain a plain text prefix */ }
	return `${value.slice(0, limit)}…[tool result truncated]`;
}

/** Approximate token estimate used before a provider request. */
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
