/** 跨层共享的公共类型：对话消息与模型协议形状。 */

export type Role = "system" | "user" | "assistant" | "tool";

/** 模型流式输出中的一个增量片段（按到达顺序回调） */
export type StreamDelta =
	| { kind: "text"; text: string }
	| { kind: "tool_call"; call: { id: string; name: string; args: string } }
	| { kind: "finish"; reason: string };

/** 发给模型的工具声明（OpenAI function calling 形状） */
export interface ToolDef {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: unknown; // JSON Schema 子集
	};
}

/** 一条完整工具调用（解析后的产物，用于回注消息） */
export interface CompletedToolCall {
	id: string;
	name: string;
	args: unknown;
}

export type ChatMsg =
	| { role: "system" | "user"; content: string }
	| { role: "assistant"; content: string; tool_calls?: CompletedToolCall[] }
	| { role: "tool"; tool_call_id: string; content: string };

export interface ModelRequest {
	messages: ChatMsg[];
	tools?: ToolDef[];
}

export interface ModelProvider {
	readonly name: string;
	/**
	 * 流式对话：逐段回调 onDelta。
	 * 若 delta 解析失败应抛错中断——调用方据此降级。
	 */
	stream(req: ModelRequest, onDelta: (d: StreamDelta) => void): Promise<void>;
}
