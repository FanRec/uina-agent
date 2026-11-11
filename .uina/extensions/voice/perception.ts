import type { ChatMsg, RequestProjection } from "../../../src/core/types.js";
import type { DeepReadonly } from "../../../src/runtime/events.js";
import { appendEventFrame, contentAddressedEventId } from "../../../src/extensions/event-frames/index.js";

export type VoiceFact =
	| { readonly kind: "interrupted"; readonly summary: string }
	| { readonly kind: "delivery_failed"; readonly summary: string }
	| { readonly kind: "delivery_unknown"; readonly summary: string };
type Candidate = { fact: VoiceFact; version: number };

/** Voice-owned, one-shot context projection. It is not session history. */
export class VoicePerception {
	private readonly candidates = new Map<string, Candidate>();
	private version = 0;
	private prepared: Map<string, number> | null = null;
	private readonly projections = new Map<string, Map<string, number>>();

	record(fact: VoiceFact, causeRef: string = fact.kind): VoiceFact {
		const previous = this.candidates.get(causeRef);
		if (previous?.fact.kind === fact.kind && previous.fact.summary === fact.summary) return previous.fact;
		this.candidates.set(causeRef, { fact, version: ++this.version });
		return fact;
	}

	peek(): VoiceFact | null {
		return [...this.candidates.values()].at(-1)?.fact ?? null;
	}

	clear(): void {
		this.candidates.clear();
		this.prepared = null;
		this.projections.clear();
	}

	prepare(projection: DeepReadonly<RequestProjection>): void {
		this.prepared = new Map();
		for (const message of projection.messages) {
			for (const [cause, version] of this.projections.get(message.context?.input?.eventId ?? "") ?? [])
				this.prepared.set(cause, version);
		}
	}

	consume(): void {
		for (const [cause, version] of this.prepared ?? [])
			if (this.candidates.get(cause)?.version === version) this.candidates.delete(cause);
		this.prepared = null;
		this.projections.clear();
	}

	resolve(causeRef: string): void {
		this.candidates.delete(causeRef);
	}

	transform(projection: DeepReadonly<RequestProjection>): RequestProjection {
		if (!this.candidates.size || projection.messages.length === 0) return projection as unknown as RequestProjection;
		const summaries = new Map<string, number>();
		for (const candidate of this.candidates.values())
			summaries.set(candidate.fact.summary, (summaries.get(candidate.fact.summary) ?? 0) + 1);
		const text = `[声音] ${[...summaries].map(([summary, count]) => (count > 1 ? `${count} 段发声出现同一情况：${summary}` : summary)).join("；")}`;
		const versions = new Map([...this.candidates].map(([cause, candidate]) => [cause, candidate.version]));
		const eventId = contentAddressedEventId("voice:perception", JSON.stringify([...versions]) + text);
		this.projections.set(eventId, versions);
		return {
			projectionId: projection.projectionId,
			modelKey: projection.modelKey,
			thinkingLevel: projection.thinkingLevel,
			tools: structuredClone(projection.tools),
			messages: appendEventFrame(projection.messages, {
				eventId,
				text,
				// 发声状态是运行时自己的情况：标签说清楚，别让它读成用户说了什么。
				label: "声音观察 · 运行时",
				source: { kind: "runtime", type: "runtime.perception", origin: "internal" },
			}) as ChatMsg[],
		};
	}
}
