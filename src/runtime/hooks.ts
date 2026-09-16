import type { ChatMsg, FinishReason, Model, ThinkingLevel, ToolResultStatus } from "../core/types.js";
import type { DeepReadonly, OutputEvent, RuntimeEvent } from "./events.js";

export interface ProviderHooks {
	transformHeaders(provider: string, headers: Readonly<Record<string, string>>): Promise<Record<string, string>>;
	transformPayload(provider: string, payload: DeepReadonly<unknown>): Promise<unknown>;
	observeResponse(input: Readonly<{ provider: string; status: number; headers: Record<string, string> }>): Promise<void>;
}

export interface RuntimeHooks {
	readonly turn: {
		/**
		 * 回合边界准备：可注入消息、改写 systemPrompt，也可直接给出新的 Model 事实
		 * 或 thinking 档位（Subject 在安全点以 setModel 的完整纪律应用：失效 usage 锚、
		 * 广播 model_select）。对应 Pi 的 prepareNextTurn。
		 */
		prepare(input: Readonly<{ prompt: string; systemPrompt: string }>, signal?: AbortSignal): Promise<Readonly<{ messages?: readonly ChatMsg[]; systemPrompt?: string; model?: Model; thinkingLevel?: ThinkingLevel }>>;
		transformContext(messages: readonly DeepReadonly<ChatMsg>[]): Promise<ChatMsg[]>;
		beforeCompact(input: Readonly<{ tokensBefore: number }>): Promise<Readonly<{ cancel?: boolean }>>;
		/**
		 * 回合间停止决策：在工具交换后的续跑点询问；返回 stop 时本轮立即收尾，
		 * 不再发起下一次模型调用。对应 Pi 的 shouldStopAfterTurn。
		 */
		shouldStop(input: Readonly<{ turnNumber: number; finishReason: FinishReason; reply: string; toolCallCount: number }>): Promise<Readonly<{ stop?: boolean }>>;
	};
	readonly tools: {
		beforeCall(input: Readonly<{ callId: string; name: string; args: DeepReadonly<Record<string, unknown>> }>): Promise<Readonly<{ block?: boolean; reason?: string }>>;
		transformResult(input: Readonly<{ callId: string; name: string; args: DeepReadonly<Record<string, unknown>>; result: string; status: ToolResultStatus; images?: readonly import("../core/content.js").ImageContent[]; details?: unknown }>): Promise<Readonly<{ result?: string; status?: ToolResultStatus; images?: readonly import("../core/content.js").ImageContent[]; details?: unknown }>>;
	};
	readonly provider: ProviderHooks;
	readonly events: {
		emit(event: RuntimeEvent): Promise<void>;
		observe(event: OutputEvent): void;
		flush(): Promise<void>;
	};
}
