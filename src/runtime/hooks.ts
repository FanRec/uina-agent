import type { ChatMsg, ToolResultStatus } from "../core/types.js";
import type { DeepReadonly, OutputEvent, RuntimeEvent } from "./events.js";

export interface ProviderHooks {
	transformHeaders(provider: string, headers: Readonly<Record<string, string>>): Promise<Record<string, string>>;
	transformPayload(provider: string, payload: DeepReadonly<unknown>): Promise<unknown>;
	observeResponse(input: Readonly<{ provider: string; status: number; headers: Record<string, string> }>): Promise<void>;
}

export interface RuntimeHooks {
	readonly turn: {
		prepare(input: Readonly<{ prompt: string; systemPrompt: string }>, signal?: AbortSignal): Promise<Readonly<{ messages?: readonly ChatMsg[]; systemPrompt?: string }>>;
		transformContext(messages: readonly DeepReadonly<ChatMsg>[]): Promise<ChatMsg[]>;
		beforeCompact(input: Readonly<{ tokensBefore: number }>): Promise<Readonly<{ cancel?: boolean }>>;
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
