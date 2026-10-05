import type { ChatMsg, RequestProjection } from "../../../src/core/types.js";
import type { DeepReadonly } from "../../../src/runtime/events.js";
import {
  buildEventFrameGroup,
  appendTailFrame,
  contentAddressedEventId,
  snapshotNotice,
} from "../../../src/extensions/event-frames/index.js";

export type VoiceFact =
  | { readonly kind: "interrupted"; readonly summary: string }
  | { readonly kind: "delivery_failed"; readonly summary: string }
  | { readonly kind: "delivery_unknown"; readonly summary: string };

/** Voice-owned, one-shot context projection. It is not session history. */
export class VoicePerception {
  private candidate: VoiceFact | null = null;

  record(fact: VoiceFact): VoiceFact {
    this.candidate = fact;
    return fact;
  }

  peek(): VoiceFact | null {
    return this.candidate;
  }

  clear(): void {
    this.candidate = null;
  }

  transform(projection: DeepReadonly<RequestProjection>): RequestProjection {
    if (!this.candidate || projection.messages.length === 0) return projection as unknown as RequestProjection;
    const fact = this.candidate;
    const text = `[语音输出状态] ${fact.summary}`;
    const eventId = contentAddressedEventId("voice:perception", text);
    const tailFrames = buildEventFrameGroup({
      eventId,
      text,
      notice: snapshotNotice("语音输出状态"),
      source: { kind: "runtime", type: "voice-perception", origin: "internal" },
    });
    const appended = appendTailFrame(projection.messages, tailFrames);
    if (!appended) return projection as unknown as RequestProjection;

    return {
      projectionId: projection.projectionId,
      modelKey: projection.modelKey,
      thinkingLevel: projection.thinkingLevel,
      tools: structuredClone(projection.tools),
      messages: appended.messages as ChatMsg[],
    };
  }
}

