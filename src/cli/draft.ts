/**
 * Draft composition shared by the CLI queue-restore paths. Kept out of app.ts
 * so tests exercise the real rule instead of a copy of it.
 */
export function combineQueuedDraft(
	items: readonly { text: string }[],
	currentDraft: string,
): string {
	return [...items.map((item) => item.text), currentDraft].filter((text) => text.trim()).join("\n\n");
}
