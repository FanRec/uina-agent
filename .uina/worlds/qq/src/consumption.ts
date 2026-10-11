import type { FactsJournal } from "./facts-journal.js";
import type { ControlStore } from "./control-store.js";
import type { MessageFact } from "./types.js";

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
