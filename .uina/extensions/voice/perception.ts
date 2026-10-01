import type { ChatMsg, RequestProjection } from "../../../src/core/types.js";
import type { DeepReadonly } from "../../../src/runtime/events.js";

export type VoiceFact =
  | { readonly kind: "interrupted"; readonly summary: string }
  | { readonly kind: "delivery_failed"; readonly summary: string }
  | { readonly kind: "delivery_unknown"; readonly summary: string };

export type PerceptionCandidate = {
  readonly causeRef: string;
  readonly version: number;
  readonly fact: VoiceFact;
  readonly deliveredResponseId?: string;
};

/** Voice-owned, one-shot context projection. It is not session history. */
export class VoicePerception {
  private causeRef: string | null = null;
  private candidate: PerceptionCandidate | null = null;
  private version = 0;

  setTurnCause(inputRefs: readonly string[]): void {
    this.causeRef = inputRefs.length > 0 ? inputRefs.join(",") : null;
  }

  record(fact: VoiceFact, causeRef?: string): PerceptionCandidate | null {
    const cause = causeRef ?? this.causeRef;
    if (!cause) return null;
    this.version += 1;
    this.candidate = { causeRef: cause, version: this.version, fact };
    return this.candidate;
  }

  peek(): PerceptionCandidate | null {
    return this.candidate;
  }

  consume(deliveredResponseId: string): PerceptionCandidate | null {
    if (!this.candidate) return null;
    const consumed = { ...this.candidate, deliveredResponseId };
    this.candidate = null;
    return consumed;
  }

  transform(projection: DeepReadonly<RequestProjection>): RequestProjection {
    if (!this.candidate || projection.messages.length === 0) return projection as unknown as RequestProjection;
    const { fact, causeRef } = this.candidate;
    const message: ChatMsg = {
      role: "system",
      content: `[voice perception cause=${causeRef}] ${fact.summary}`,
      context: { kind: "runtime.perception" },
    };
    return {
      projectionId: projection.projectionId,
      modelKey: projection.modelKey,
      thinkingLevel: projection.thinkingLevel,
      tools: structuredClone(projection.tools),
      messages: [...projection.messages].map((item) => structuredClone(item) as ChatMsg).concat(message),
    };
  }
}
