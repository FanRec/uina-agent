import type { ChatMsg, ToolDef } from "../core/types.js";

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
	const runtime = b.runtimeInputs?.length
		? [{
			role: "system" as const,
			content: `<runtime_events>\n${b.runtimeInputs.map(formatRuntimeInput).join("\n")}\n</runtime_events>`,
		}]
		: [];
	return [
		{ role: "system", content: b.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
		...b.history.map((message) =>
			message.role === "tool"
				? message
				: message.role === "assistant"
					? b.includeThinking ? message : { ...message, thinking: undefined, thinkingSignature: undefined }
				: message,
		),
		...runtime,
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

export function formatForSummary(message: ChatMsg): string {
	if (message.role === "assistant" && message.tool_calls) {
		return `thinking=${message.thinking ?? ""} tool_calls=${JSON.stringify(message.tool_calls)} ${message.content}`;
	}
	return message.content;
}
