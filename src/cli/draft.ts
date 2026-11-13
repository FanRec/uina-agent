/**
 * Draft composition shared by the CLI queue-restore paths. Kept out of app.ts
 * so tests exercise the real rule instead of a copy of it.
 */
export function combineQueuedDraft(
	items: readonly { text: string; displayText?: string }[],
	currentDraft: string,
): string {
	// 撤回/恢复进编辑器的是操作者看到的原始正文（displayText 优先），不是模型展开正文。
	return [...items.map((item) => item.displayText ?? item.text), currentDraft]
		.filter((text) => text.trim())
		.join("\n\n");
}

/** The current editor can only represent human text, so other inputs stay queued. */
export function canEditQueuedDraft(
	items: readonly { images?: readonly unknown[]; source?: { kind: string } }[],
): boolean {
	return items.every((item) => !item.images?.length && (!item.source || item.source.kind === "user"));
}
