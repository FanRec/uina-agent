import type { AgentMessage, ChatMsg, ToolAgentMessage, ToolEffect } from "./types.js";
/**
 * 工具结果 details.effects 约定的唯一读取点：工具（Extension 层）在自己的
 * 结果 details 里声明通用效果事实，Core/Session/默认压缩器都经由这里读取，
 * 保证"声明在工具、读取用同一契约"不漂移。Core 不解释 effectType 语义。
 */
export function isToolEffect(value: unknown): value is ToolEffect {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.effectType === "string" &&
		candidate.effectType.trim().length > 0 &&
		(candidate.externalOperationId === undefined || typeof candidate.externalOperationId === "string") &&
		(candidate.label === undefined || typeof candidate.label === "string")
	);
}

export function readDeclaredEffects(message: AgentMessage | ChatMsg): readonly ToolEffect[] {
	if (message.role !== "tool") return [];
	const details = (message as ToolAgentMessage).details as { effects?: unknown } | undefined;
	const declared = details && typeof details === "object" && Array.isArray(details.effects) ? details.effects : undefined;
	if (!declared) return [];
	return declared.filter(isToolEffect);
}
