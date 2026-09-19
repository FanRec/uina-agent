import type { SessionRecord, SessionStore } from "../../../src/session/types.js";
import type { MemorySessionStore } from "../../../src/session/jsonl-store.js";

/**
 * 快速向 SessionStore 注入初始对话历史
 */
export async function seedSession(
	store: SessionStore,
	messages: Array<{ role: "user" | "assistant"; content: string } | string>,
): Promise<readonly SessionRecord[]> {
	for (let i = 0; i < messages.length; i++) {
		const item = messages[i]!;
		if (typeof item === "string") {
			const role = i % 2 === 0 ? "user" : "assistant";
			await store.appendMessage({ role, content: item });
		} else {
			await store.appendMessage(item);
		}
	}
	if ("readRecords" in store && typeof (store as any).readRecords === "function") {
		return (store as MemorySessionStore).readRecords();
	}
	return (store.state.allEntries as unknown as readonly SessionRecord[]) ?? [];
}

/**
 * 快速向 SessionStore 追加一条规范的回溯记录
 */
export async function rewindTo(
	store: SessionStore,
	targetId: string,
	options: {
		fromId?: string;
		reason?: string;
		source?: string;
		requestId?: string;
		id?: string;
	} = {},
): Promise<string> {
	const records = ("readRecords" in store && typeof (store as any).readRecords === "function")
		? (store as MemorySessionStore).readRecords()
		: (store.state.allEntries as unknown as readonly SessionRecord[]);

	const fromId = options.fromId ?? records.at(-1)?.id ?? targetId;
	const id = options.id ?? `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const requestId = options.requestId ?? `q-${Date.now()}`;
	const source = options.source ?? "user";
	const reason = options.reason ?? "test rewind";

	await store.appendRewind({
		id,
		requestId,
		targetId,
		fromId,
		source,
		reason,
	});

	return id;
}
