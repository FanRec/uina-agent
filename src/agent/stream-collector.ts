import type {
	CompletedToolCall,
	FinishReason,
	ProviderReplay,
	StreamDelta,
	Usage,
} from "../core/types.js";
import type { OutputEvent } from "../runtime/events.js";

export interface StreamCollectorResult {
	reply: string;
	thinking: string;
	thinkingSignature?: string;
	usage?: Usage;
	providerReplay?: ProviderReplay;
	toolCalls: CompletedToolCall[];
	finishReason: FinishReason;
}

export interface StreamCollectorOptions {
	onUsage?: (usage: Usage) => void;
}

export function parseToolArgs(text: string): { value: unknown; valid: boolean } {
	try {
		const value = JSON.parse(text || "{}");
		return {
			value,
			valid: !!value && typeof value === "object" && !Array.isArray(value),
		};
	} catch {
		return { value: {}, valid: false };
	}
}

/** Collects streamed deltas from model provider and manages live output lifecycle events. */
export class TurnStreamCollector {
	private readonly toolCalls: CompletedToolCall[] = [];
	private reply = "";
	private thinking = "";
	private thinkingSignature?: string;
	private usage?: Usage;
	private providerReplay?: ProviderReplay;
	private finishReason: FinishReason | null = null;

	private textOffset = 0;
	private thinkingOffset = 0;
	private hasEmittedContentStart = false;
	private hasEmittedThinkingStart = false;

	constructor(
		readonly streamId: string,
		private readonly dispatch: (event: OutputEvent) => void,
		private readonly options?: StreamCollectorOptions,
	) {}

	handleDelta(delta: StreamDelta): void {
		if (this.finishReason && delta.kind !== "usage") {
			throw new Error("模型 finish 后仍返回输出事件");
		}

		switch (delta.kind) {
			case "provider_replay":
				this.providerReplay = structuredClone(delta.replay);
				break;

			case "thinking": {
				this.thinking += delta.text;
				if (!this.hasEmittedThinkingStart) {
					this.hasEmittedThinkingStart = true;
					this.dispatch({ type: "output_start", streamId: this.streamId, channel: "thinking" });
				}
				this.thinkingOffset += delta.text.length;
				this.dispatch({
					type: "output_update",
					streamId: this.streamId,
					offset: this.thinkingOffset,
					channel: "thinking",
					text: delta.text,
				});
				break;
			}

			case "thinking_signature":
				this.thinkingSignature = delta.signature;
				break;

			case "text": {
				this.reply += delta.text;
				if (!this.hasEmittedContentStart) {
					this.hasEmittedContentStart = true;
					this.dispatch({ type: "output_start", streamId: this.streamId, channel: "content" });
				}
				this.textOffset += delta.text.length;
				this.dispatch({
					type: "output_update",
					streamId: this.streamId,
					offset: this.textOffset,
					channel: "content",
					text: delta.text,
				});
				break;
			}

			case "usage":
				this.usage = delta.usage;
				this.options?.onUsage?.(delta.usage);
				break;

			case "tool_call": {
				const parsed = parseToolArgs(delta.call.args);
				this.toolCalls.push({
					id: delta.call.id,
					name: delta.call.name,
					args: parsed.value,
					argsValid: delta.call.argsValid !== false && parsed.valid,
					...(delta.call.thinkingSignature ? { thinkingSignature: delta.call.thinkingSignature } : {}),
				});
				break;
			}

			default:
				if (!this.finishReason) {
					this.finishReason = delta.reason;
				}
				break;
		}
	}

	closeOutput(outcome: "end" | "interrupted", reason?: "cancelled" | "error"): void {
		if (this.hasEmittedThinkingStart) {
			this.dispatch(
				outcome === "end"
					? { type: "output_end", streamId: this.streamId, channel: "thinking" }
					: { type: "output_interrupted", streamId: this.streamId, channel: "thinking", reason: reason! },
			);
			this.hasEmittedThinkingStart = false;
		}
		if (this.hasEmittedContentStart) {
			this.dispatch(
				outcome === "end"
					? { type: "output_end", streamId: this.streamId, channel: "content" }
					: {
							type: "output_interrupted",
							streamId: this.streamId,
							channel: "content",
							reason: reason!,
							spokenUntil: this.textOffset,
					  },
			);
			this.hasEmittedContentStart = false;
		}
	}

	getPartialOutput(): {
		reply: string;
		thinking: string;
		thinkingSignature?: string;
		usage?: Usage;
		providerReplay?: ProviderReplay;
	} {
		return {
			reply: this.reply,
			thinking: this.thinking,
			thinkingSignature: this.thinkingSignature,
			usage: this.usage,
			providerReplay: this.providerReplay,
		};
	}

	validateAndFinalize(): StreamCollectorResult {
		if (!this.finishReason) {
			this.closeOutput("interrupted", "error");
			throw new Error("模型返回未知或缺失 finish reason: " + (this.finishReason ?? "none"));
		}
		if (this.finishReason === "tool_calls" && this.toolCalls.length === 0) {
			this.closeOutput("interrupted", "error");
			throw new Error("模型声明了 tool_calls，但没有返回工具调用");
		}
		this.closeOutput("end");
		return {
			reply: this.reply,
			thinking: this.thinking,
			thinkingSignature: this.thinkingSignature,
			usage: this.usage,
			providerReplay: this.providerReplay,
			toolCalls: this.toolCalls,
			finishReason: this.finishReason,
		};
	}
}
