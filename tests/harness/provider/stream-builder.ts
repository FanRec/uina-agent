import type { FinishReason, StreamDelta, Usage } from "../../../src/core/types.js";

/**
 * 流式增量生成器（StreamDelta Builder）：
 * 提供类型安全的流式片段链式组装。
 */
export class StreamBuilder {
	private readonly deltas: StreamDelta[] = [];

	text(text: string): this {
		this.deltas.push({ kind: "text", text });
		return this;
	}

	thinking(text: string): this {
		this.deltas.push({ kind: "thinking", text });
		return this;
	}

	thinkingSignature(signature: string): this {
		this.deltas.push({ kind: "thinking_signature", signature });
		return this;
	}

	toolCall(name: string, args: Record<string, unknown> | string, id = `call-${Date.now()}`): this {
		const argsStr = typeof args === "string" ? args : JSON.stringify(args);
		this.deltas.push({
			kind: "tool_call",
			call: { id, name, args: argsStr, argsValid: true },
		});
		return this;
	}

	usage(usage: Usage): this {
		this.deltas.push({ kind: "usage", usage });
		return this;
	}

	finish(reason: FinishReason = "stop"): this {
		this.deltas.push({ kind: "finish", reason });
		return this;
	}

	build(): StreamDelta[] {
		const result = [...this.deltas];
		if (!result.some((d) => d.kind === "finish")) {
			const hasTool = result.some((d) => d.kind === "tool_call");
			result.push({ kind: "finish", reason: hasTool ? "tool_calls" : "stop" });
		}
		return result;
	}
}

export function stream(): StreamBuilder {
	return new StreamBuilder();
}
