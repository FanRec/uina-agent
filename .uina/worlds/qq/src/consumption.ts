import type { FactsJournal } from "./facts-journal.js";
import type { ControlStore } from "./control-store.js";
import type { MessageFact } from "./types.js";

export const FOLLOW_BACKLOG_LIMIT = 30;
export const FOLLOW_BODY_LIMIT = 14_000;

export function consumptionThrough(
	journal: Pick<FactsJournal, "dispatchedThroughOf">,
	control: Pick<ControlStore, "baselineOf">,
	conversationRef: string,
): number {
	return Math.max(journal.dispatchedThroughOf(conversationRef), control.baselineOf(conversationRef) ?? 0);
}

export function pendingFacts(journal: FactsJournal, control: ControlStore, conversationRef: string): MessageFact[] {
	const through = consumptionThrough(journal, control, conversationRef);
	return (journal.snapshot.messages.get(conversationRef) ?? []).filter(
		(fact) => fact.direction === "in" && fact.sequence > through,
	);
}

export function pendingCountOf(
	journal: Pick<FactsJournal, "dispatchedThroughOf" | "snapshot">,
	control: Pick<ControlStore, "baselineOf">,
	conversationRef: string,
): number {
	const through = consumptionThrough(journal, control, conversationRef);
	return (journal.snapshot.messages.get(conversationRef) ?? []).filter(
		(fact) => fact.direction === "in" && fact.sequence > through,
	).length;
}

export function archivedCountOf(journal: FactsJournal, control: ControlStore, conversationRef: string): number {
	const baseline = control.baselineOf(conversationRef) ?? 0;
	return (journal.snapshot.messages.get(conversationRef) ?? []).filter(
		(fact) => fact.direction === "in" && fact.sequence <= baseline,
	).length;
}

export function followPressure(journal: FactsJournal, control: ControlStore, conversationRef: string): boolean {
	const facts = pendingFacts(journal, control, conversationRef);
	const chars = facts.reduce(
		(total, fact) =>
			total +
			fact.segments.reduce((size, segment) => {
				if (segment.type === "text") return size + segment.text.length;
				if (segment.type === "json" || segment.type === "xml") return size + segment.data.length;
				return size + 32;
			}, 0),
		0,
	);
	return facts.length > FOLLOW_BACKLOG_LIMIT || chars > FOLLOW_BODY_LIMIT;
}

export function pendingConversations(journal: FactsJournal, control: ControlStore): string[] {
	return [...journal.snapshot.messages.keys()]
		.filter((ref) => control.effectivePush(ref).mode !== "off" && pendingCountOf(journal, control, ref) > 0)
		.sort();
}
