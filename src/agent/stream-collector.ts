import type {
	CompletedToolCall,
	FinishReason,
	GenerationTiming,
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
	onUsage?: (usage: Usage, timing?: GenerationTiming) => void;
	onRetry?: (event: Extract<StreamDelta, { kind: "provider_retry" | "provider_recovered" }>) => void;
}

function parseToolArgs(text: string): { value: unknown; valid: boolean } {
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
	private interrupted = false;

	/** 请求发出时刻（本 collector 的生命起点），TTFT 的左端。 */
	private readonly requestedAt = Date.now();
	private firstDeltaAt = 0;
	private lastDeltaAt = 0;

	constructor(
		readonly streamId: string,
		private readonly dispatch: (event: OutputEvent) => void,
		private readonly options?: StreamCollectorOptions,
	) {}

	/** 记录一次内容 delta 的到达时刻；usage/finish 是结算而非生成，不计。 */
	private markDelta(): void {
		const now = Date.now();
		if (this.firstDeltaAt === 0) this.firstDeltaAt = now;
		this.lastDeltaAt = now;
	}

	/** 本步的真实时序：TTFT 与「首个内容 delta → 末个内容 delta」的解码窗口。 */
	private generationTiming(): GenerationTiming | undefined {
		if (this.firstDeltaAt === 0) return undefined;
		return {
			ttftMs: Math.max(0, this.firstDeltaAt - this.requestedAt),
			decodeMs: Math.max(0, this.lastDeltaAt - this.firstDeltaAt),
		};
	}

	handleDelta(delta: StreamDelta): void {
		if (this.interrupted) return;
		if (this.finishReason && delta.kind !== "usage") {
			throw new Error("模型 finish 后仍返回输出事件");
		}

		switch (delta.kind) {
			case "provider_retry":
			case "provider_recovered":
				this.options?.onRetry?.(delta);
				break;
			case "provider_replay":
				this.providerReplay = structuredClone(delta.replay);
				break;

			case "thinking": {
				this.markDelta();
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
				this.markDelta();
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
				this.options?.onUsage?.(delta.usage, this.generationTiming());
				break;

			case "tool_call": {
				this.markDelta();
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
		if (outcome === "interrupted") {
			if (this.interrupted) return;
			this.interrupted = true;
		}
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
