/**
 * 展示事实层：Host 事件流与会话 journal 的规范化形状。
 *
 * 本层只描述"发生了什么"，不携带任何布局、宽度、颜色或终端假设。
 * `at` 缺失表示时间未知，绝不以当前时钟补齐。
 */

import type { ImageContent } from "../core/content.js";
import type {
	ContextSnapshot,
	InputSource,
	QueuedMessage,
	RequestUsage,
	ThinkingLevel,
	ToolResultStatus,
} from "../core/types.js";
import type { DeepReadonly, InjectionProvenance } from "../runtime/events.js";

export type FactOrigin = "live" | "replay";

export interface FactMeta {
	readonly seq: number;
	readonly origin: FactOrigin;
	/** Unix 毫秒；未知时保持 undefined，禁止以当前时钟补齐。 */
	readonly at?: number;
}

/** 压缩阶段（RuntimeEvent 的原始词汇；文案在 Surface 与 copy 层生成）。 */
export type CompactionPhase = "queued" | "planning" | "summarizing" | "applying" | "measuring";

/** 事实载荷（不含 Store 分配的序号与来源）。 */
export type FactPayload =
	| {
			readonly kind: "turn.started";
			readonly turn: number;
			readonly userText: string;
			readonly images?: readonly ImageContent[];
	  }
	| { readonly kind: "turn.ended"; readonly turn: number; readonly usage?: RequestUsage }
	| { readonly kind: "turn.aborted"; readonly turn: number }
	| { readonly kind: "thinking.delta"; readonly text: string }
	| { readonly kind: "assistant.delta"; readonly text: string }
	| {
			readonly kind: "tool.started";
			readonly callId: string;
			readonly name: string;
			readonly args?: unknown;
			readonly invocationId?: string;
	  }
	| {
			readonly kind: "tool.finished";
			readonly callId: string;
			readonly name: string;
			readonly args?: unknown;
			readonly status: ToolResultStatus;
			readonly result: string;
			readonly details?: unknown;
			readonly images?: readonly ImageContent[];
	  }
	| { readonly kind: "usage.reported"; readonly usage: RequestUsage; readonly estimated: boolean }
	| { readonly kind: "context.updated"; readonly snapshot: ContextSnapshot }
	| {
			readonly kind: "context.prepared";
			readonly turn: number;
			readonly systemPrompt: string;
			readonly injections: readonly InjectionProvenance[];
	  }
	| { readonly kind: "model.selected"; readonly model: string }
	| { readonly kind: "thinking.selected"; readonly level: ThinkingLevel }
	| { readonly kind: "compaction.started"; readonly operationId: string }
	| {
			readonly kind: "compaction.progress";
			readonly operationId: string;
			readonly phase: CompactionPhase;
			readonly detail?: string;
	  }
	| {
			readonly kind: "compaction.ended";
			readonly operationId: string;
			readonly status: "completed" | "failed" | "cancelled" | "noop";
			readonly summary?: string;
			readonly error?: string;
			readonly tokensBefore?: number;
			readonly tokensAfter?: number;
			readonly retainedTail?: number;
	  }
	| {
			readonly kind: "notice";
			readonly level: "info" | "warning" | "error";
			readonly text: string;
			readonly dedupeKey?: string;
	  }
	| {
			readonly kind: "retry";
			readonly provider: string;
			readonly attempt: number;
			readonly delayMs: number;
			readonly status?: number;
			readonly reason: string;
	  }
	| { readonly kind: "retry.recovered"; readonly provider: string; readonly attempt: number }
	| { readonly kind: "queue"; readonly items: readonly DeepReadonly<QueuedMessage>[] }
	| {
			readonly kind: "external";
			readonly inputId: string;
			readonly source?: InputSource;
			readonly receivedAt: string;
			readonly text: string;
			readonly images?: readonly ImageContent[];
	  }
	| {
			readonly kind: "custom.message";
			readonly customType: string;
			readonly content: string;
			readonly images?: readonly ImageContent[];
			readonly display?: boolean;
			readonly details?: unknown;
	  }
	| { readonly kind: "error"; readonly text: string }
	| {
			readonly kind: "rewind";
			readonly fromId?: string;
			readonly targetId?: string;
			readonly toEntrySeq: number;
	  };

/** 供 ingest 产出的草稿：序号由 FactStore 分配。 */
export type FactDraft = FactPayload & { readonly origin: FactOrigin; readonly at?: number };

export type PresentationFact = FactPayload & FactMeta;

export class FactStore {
	private facts: PresentationFact[] = [];
	private sequence = 0;

	append(draft: FactDraft): PresentationFact {
		const fact = { ...draft, seq: ++this.sequence } as PresentationFact;
		this.facts.push(fact);
		return fact;
	}

	/** 会话恢复与回溯：整段替换，序号从头开始。 */
	replaceAll(drafts: readonly FactDraft[]): void {
		this.facts = [];
		this.sequence = 0;
		for (const draft of drafts) this.append(draft);
	}

	clear(): void {
		this.facts = [];
		this.sequence = 0;
	}

	list(): readonly PresentationFact[] {
		return this.facts;
	}
}
