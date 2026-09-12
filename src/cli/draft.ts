/**
 * Draft composition shared by the CLI queue-restore paths. Kept out of app.ts
 * so tests exercise the real rule instead of a copy of it.
 */
export function combineQueuedDraft(items: readonly { text: string }[], currentDraft: string): string {
	return [...items.map((item) => item.text), currentDraft].filter((text) => text.trim()).join("\n\n");
}

/** The current editor can only represent human text, so other inputs stay queued. */
export function canEditQueuedDraft(
	items: readonly { images?: readonly unknown[]; source?: { kind: string } }[],
): boolean {
	return items.every((item) => !item.images?.length && (!item.source || item.source.kind === "user"));
}
