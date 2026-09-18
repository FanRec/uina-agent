import { canonicalReplay } from "./recovery.js";
import type { HydratedSessionEntry, SessionAccess, SessionBranchInfo, SessionEntry, SessionNodeInfo, SessionRecord } from "./types.js";

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
	}
	return (text ?? "").slice(0, 160);
}

export function listSessionNodes(
	records: readonly SessionRecord[],
	options: Parameters<SessionAccess["list"]>[0] = {},
): ReturnType<SessionAccess["list"]> {
	const state = canonicalReplay(records);
	const { entries, allEntries } = state;
	const limit = options.limit ?? 50;
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new SessionNavigationError("limit 必须是正整数");
	}
	if (options.scope !== undefined && options.scope !== "all" && options.scope !== "main") {
		throw new SessionNavigationError("scope 必须是 main 或 all");
	}

	const safe = state.safeTargets;
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

/**
 * 消费 list() 的 next 游标，把所有分页取全。
 *
 * list() 的 limit 是**分页页大小**（默认 50），不是“最多返回这么多”。需要完整路径的
 * 消费者必须自行翻页，否则第 51 条起会被静默丢弃 —— 面板还会把截断后的条数当总数印出来。
 */
export function listAllSessionNodes(
	port: Pick<SessionAccess, "list">,
	options: { scope?: "main" | "all" } = {},
): SessionNodeInfo[] {
	const nodes: SessionNodeInfo[] = [];
	let after: string | undefined;
	for (;;) {
		const page = after === undefined ? port.list(options) : port.list({ ...options, after });
		nodes.push(...page.nodes);
		if (!page.next) return nodes;
		after = page.next;
	}
}

export function readSessionNode(records: readonly SessionRecord[], id: string): HydratedSessionEntry {
	const node = canonicalReplay(records).allEntries.find((entry) => entry.id === id);
	if (!node) {
		throw new SessionNavigationError(`未知会话节点: ${id}`);
	}
	return structuredClone(node);
}


/** 一条 rewind 节点；分支信息可直接由它构造，无需重算全部分支。 */
type RewindNode = Extract<HydratedSessionEntry, { kind: "rewind" }>;

/**
 * 取出一条 rewind 所放弃的那段节点：`targetId`（保留的一端）之后，到 `fromId`（切断处）为止。
 * 端点缺失或顺序颠倒时视为没有节点（返回空数组）。
 *
 * 不必再排除 rewind 节点自身：allEntries 按记录顺序（seq 升序）追加，而被放弃段的最后一个节点
 * 就是创建这条 rewind 时的历史末端，rewind 记录必然排在它之后，落在切片上界之外。
 *
 * P1.3：这段切片边界原先在 listSessionBranches 与 readSessionBranch 里各写了一份，
 * 收成唯一实现后，只有一处需要正确。
 */
function branchEntries(
	allEntries: readonly HydratedSessionEntry[],
	targetId: string,
	fromId: string,
): HydratedSessionEntry[] {
	const start = allEntries.findIndex((n) => n.id === targetId);
	const end = allEntries.findIndex((n) => n.id === fromId);
	return start >= 0 && end > start ? allEntries.slice(start + 1, end + 1) : [];
}

/**
 * 由 rewind 节点与其范围内节点数构造分支信息。
 *
 * P1.4：此前 readSessionBranch 会先跑一遍 listSessionBranches 造出全部分支、再 find 出自己那条，
 * 末尾还用 `!` 掩盖「找不到」。但它要的 rewind 记录本来就在手上 —— 直接构造即可，
 * 既省掉整轮重算，也去掉了那个不可能为真的断言。
 */
function toBranchInfo(entry: RewindNode, nodeCount: number): SessionBranchInfo {
	return {
		id: entry.id,
		targetId: entry.record.targetId,
		fromId: entry.record.fromId,
		headId: entry.record.fromId,
		nodeCount,
		createdAt: entry.timestamp,
		reason: entry.record.reason,
	};
}

export function listSessionBranches(records: readonly SessionRecord[]): { branches: SessionBranchInfo[] } {
	const { allEntries } = canonicalReplay(records);
	const branches = allEntries
		.filter((e) => e.kind === "rewind")
		.map((e) => toBranchInfo(e, branchEntries(allEntries, e.record.targetId, e.record.fromId).length));
	return { branches };
}

export function readSessionBranch(records: readonly SessionRecord[], id: string): { branch: SessionBranchInfo; nodes: SessionNodeInfo[] } {
	const { allEntries } = canonicalReplay(records);
	const rewind = allEntries.find((e) => e.kind === "rewind" && e.id === id);
	if (rewind?.kind !== "rewind") {
		throw new SessionNavigationError(`未知会话分支: ${id}`);
	}
	const nodes = branchEntries(allEntries, rewind.record.targetId, rewind.record.fromId);
	return {
		branch: toBranchInfo(rewind, nodes.length),
		nodes: nodes.map((n) => ({
			id: n.id,
			parentId: n.parentId,
			seq: n.seq,
			kind: n.kind,
			active: false,
			canRewind: false,
			preview: formatNodePreview(n),
		})),
	};
}

/**
 * 把分支列表投影成面板可直接渲染的节点行：一条 rewind 记录 = 一行。
 *
 * 面板的列表渲染器只认 SessionNodeInfo，所以分支在这里被映射成该形状。各字段按
 * "只读的分支行"解释：
 * - id 取分支 id：面板据此进入该分支的节点视图，不必再查一次分支列表；
 * - parentId 取被保留的那一端（targetId）；
 * - seq 是节点概念，分支没有对应量，用 0 占位；
 * - active / canRewind 恒为 false —— 分支在主线之外，且这个视图不提供动作。
 */
export function listBranchNodes(branches: readonly SessionBranchInfo[]): SessionNodeInfo[] {
	return branches.map((branch) => ({
		id: branch.id,
		parentId: branch.targetId,
		seq: 0,
		kind: "rewind",
		active: false,
		canRewind: false,
		preview: formatBranchPreview(branch),
	}));
}

/** 分支行的一行摘要：短 id、节点数、回溯原因。 */
function formatBranchPreview(branch: SessionBranchInfo): string {
	return `分支 ${branch.id.slice(0, 6)} · ${branch.nodeCount} 节点 · ${branch.reason}`;
}
