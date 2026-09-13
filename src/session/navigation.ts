import { safeRewindTargets, recoverRecords } from "./recovery.js";
import type { HydratedSessionEntry, SessionAccess, SessionEntry, SessionNodeInfo, SessionRecord } from "./types.js";

export class SessionNavigationError extends Error {

	constructor(message: string) {
		super(message);
		this.name = "SessionNavigationError";
	}
}

function formatNodePreview(entry: SessionEntry): string {
	let text: string | undefined;
	switch (entry.kind) {
		case "message": {
			if (entry.message.content) {
				text = entry.message.content;
			} else if (entry.message.role === "assistant" && entry.message.tool_calls?.length) {
				text = entry.message.tool_calls.map((call) => `[调用 ${call.name}]`).join(" ");
			} else {
				text = `[${entry.message.role}]`;
			}
			break;
		}
		case "input":
			text = entry.input.text;
			break;
		case "custom_message":
			text = entry.content;
			break;
		case "rewind":
			text = entry.notice;
			break;
		case "compaction":
			text = entry.summary;
			break;
		case "custom_entry":
			text = entry.customType;
			break;
	}
	return (text ?? "").slice(0, 160);
}

export function listSessionNodes(
	records: readonly SessionRecord[],
	options: Parameters<SessionAccess["list"]>[0] = {},
): ReturnType<SessionAccess["list"]> {
	const { entries, allEntries } = recoverRecords([...records], false);
	const limit = options.limit ?? 50;
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new SessionNavigationError("limit 必须是正整数");
	}
	if (options.scope !== undefined && options.scope !== "all" && options.scope !== "main") {
		throw new SessionNavigationError("scope 必须是 main 或 all");
	}

	const safe = safeRewindTargets(entries);
	const active = new Set(entries.map((entry) => entry.id));
	const selected = options.scope === "all" ? allEntries : entries;

	const after = options.after;
	const start = after === undefined ? -1 : selected.findIndex((entry) => entry.id === after);
	if (after !== undefined && start < 0) {
		throw new SessionNavigationError("分页节点不在所选路径，请重新查询");
	}

	const source = selected.slice(start + 1);
	const page = source.slice(0, limit);
	const headId = entries.at(-1)?.id;

	const nodes: SessionNodeInfo[] = page.map((entry) => {
		const isHead = entry.id === headId;
		const isActive = active.has(entry.id);
		return {
			id: entry.id,
			parentId: entry.parentId,
			seq: entry.seq,
			kind: entry.kind,
			active: isActive,
			canRewind: isActive && !isHead && safe.has(entry.id),
			preview: formatNodePreview(entry),
		};
	});

	const nextPageId = source.length > page.length && page.length > 0
		? page[page.length - 1].id
		: undefined;

	return {
		nodes,
		headId,
		...(nextPageId ? { next: nextPageId } : {}),
	};
}

export function readSessionNode(records: readonly SessionRecord[], id: string): HydratedSessionEntry {
	const node = recoverRecords([...records], false).allEntries.find((entry) => entry.id === id);
	if (!node) {
		throw new SessionNavigationError(`未知会话节点: ${id}`);
	}
	return structuredClone(node);
}


export function listSessionBranches(records: readonly SessionRecord[]): { branches: import("./types.js").SessionBranchInfo[] } {
 const { allEntries } = recoverRecords([...records], false);
 const branches = allEntries.filter((e) => e.kind === "rewind").map(e => {
  const start = allEntries.findIndex(n => n.id === e.record.targetId); const end = allEntries.findIndex(n => n.id === e.record.fromId);
  const nodes = start >= 0 && end > start ? allEntries.slice(start + 1, end + 1).filter(n => n.id !== e.id) : [];
  return { id: e.id, targetId: e.record.targetId, fromId: e.record.fromId, headId: e.record.fromId, nodeCount: nodes.length, createdAt: e.timestamp, reason: e.record.reason };
 });
 return { branches };
}

export function readSessionBranch(records: readonly SessionRecord[], id: string): { branch: import("./types.js").SessionBranchInfo; nodes: SessionNodeInfo[] } {
 const { allEntries } = recoverRecords([...records], false); const rewind = allEntries.find(e => e.kind === "rewind" && e.id === id);
 if (!rewind || rewind.kind !== "rewind") throw new SessionNavigationError(`未知会话分支: ${id}`);
 const start = allEntries.findIndex(n => n.id === rewind.record.targetId); const end = allEntries.findIndex(n => n.id === rewind.record.fromId);
 const nodes = start >= 0 && end > start ? allEntries.slice(start + 1, end + 1).filter(n => n.id !== id) : [];
 const { branches } = listSessionBranches(records); const branch = branches.find(b => b.id === id)!;
 return { branch, nodes: nodes.map(n => ({ id:n.id, parentId:n.parentId, seq:n.seq, kind:n.kind, active:false, canRewind:false, preview:formatNodePreview(n) })) };
}
