/**
 * 可编程 mock provider：模拟 LLM 的流式输出与工具调用，用于离线验证链路。
 * 按消息内容决定行为（确定性脚本），不调用任何真实模型。
 * 注意：这只证明本仓库代码链路正确，不证明任何真实模型的集成效果。
 */
import type {
	ModelProvider,
	ModelRequest,
	StreamDelta,
} from "../../src/core/types.js";

interface ScriptRule {
	match: (req: ModelRequest) => boolean;
	produce: () => StreamDelta[];
}

export function scriptedProvider(
	rules: ScriptRule[],
): ModelProvider & { calls: ModelRequest[] } {
	const calls: ModelRequest[] = [];
	return {
		name: "mock",
		calls,
		async stream(req, onDelta) {
			calls.push(req);
			const rule = rules.find((r) => r.match(req));
			const deltas = rule
				? rule.produce()
				: [
						{
							kind: "text" as const,
							text: "（mock 无匹配规则，回复默认文本）",
						},
					];
			for (const d of deltas) onDelta(d);
			onDelta({ kind: "finish", reason: "stop" });
		},
	};
}

/** 消息文本：取最后一条 user 内容 */
export function lastUser(req: ModelRequest): string {
	const u = [...req.messages].reverse().find((m) => m.role === "user");
	return typeof u?.content === "string" ? u.content : "";
}

/** 是否最后一条是某工具的结果 */
export function lastToolName(req: ModelRequest): string | null {
	const t = [...req.messages].reverse().find((m) => m.role === "tool");
	return t && "tool_call_id" in t ? String(t.tool_call_id) : null;
}

/** 构造一个工具调用 delta */
export function toolCallDelta(
	id: string,
	name: string,
	args: Record<string, unknown>,
): StreamDelta {
	return { kind: "tool_call", call: { id, name, args: JSON.stringify(args) } };
}
