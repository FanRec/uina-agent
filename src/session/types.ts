import type { AgentMessage, ChatMsg, QueuedMessage } from "../core/types.js";
import type { CanonicalState } from "./recovery.js";

export interface SessionHeader {
	kind: "header";
	version: 3;
	id: string;
	cwd: string;
	createdAt: string;
}

/** Extension-authored model-visible content. */
export interface SessionCustomMessageRecord {
	kind: "custom_message";
	id: string;
	seq: number;
	timestamp: string;
	customType: string;
	content: string;
 images?: import("../core/content.js").ImageContent[];
	display?: boolean;
	details?: unknown;
}

/** Extension-authored transcript/session content which must never reach a provider. */
export interface SessionCustomEntryRecord {
	kind: "custom_entry";
	id: string;
	seq: number;
	timestamp: string;
	customType: string;
	data?: unknown;
}

export interface SessionMessageRecord {
	kind: "message";
	id: string;
	seq: number;
	timestamp: string;
	message: AgentMessage | ChatMsg;
}

/** One durable transition from a pending queue item to accepted session input. */
export interface SessionInputRecord {
	kind: "input";
	id: string;
	seq: number;
	timestamp: string;
	input: QueuedInput;
}

export type SessionEventName =
	| "queue_enqueued"
	| "queue_restored"
	| "tool_started"
	| "tool_finished"
	| "turn_failed"
	| "turn_aborted";

export interface SessionEventRecord {
	kind: "event";
	id: string;
	seq: number;
	timestamp: string;
	event: SessionEventName;
	data: Record<string, unknown>;
}

export interface RewindRequest { targetId: string; reason: string; summary?: string; }
export interface SessionRewindRecord extends RewindRequest {
	kind: "rewind"; id: string; seq: number; timestamp: string; fromId: string; source: string; requestId: string;
}
export interface RewindResult { requestId: string; status: "scheduled" | "committed"; rewindId?: string; }
export interface SessionBranchInfo { id: string; targetId: string; fromId: string; headId: string; nodeCount: number; createdAt: string; reason: string; }
export interface SessionAccess {
	list(options?: { scope?: "main" | "all"; after?: string; limit?: number }): { nodes: SessionNodeInfo[]; next?: string; headId?: string };
	listBranches(): { branches: SessionBranchInfo[] };
	readBranch(id: string): { branch: SessionBranchInfo; nodes: SessionNodeInfo[] };
	read(id: string): HydratedSessionEntry;
	requestRewind(request: RewindRequest, source: string, signal?: AbortSignal): Promise<RewindResult>;
}
export interface SessionNodeInfo { id: string; parentId: string | null; seq: number; kind: SessionEntry["kind"]; active: boolean; canRewind: boolean; preview: string; }

export type SessionRecord =
	| SessionRewindRecord
	| SessionInputRecord
	| SessionMessageRecord
	| SessionCustomMessageRecord
	| SessionCustomEntryRecord
	| SessionEventRecord;

export interface SessionEntryMeta {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: string;
}

/**
 * 被放弃历史切片的外部效果清单。条目是工具自行声明的通用 ToolEffect；
 * Session Core 只聚合与展示，不理解任何具体 effectType 的语义。
 */
export interface AbandonedEffects {
	readonly effects: readonly import("../core/types.js").ToolEffect[];
}

export type SessionEntryPayload =
	| { kind: "rewind"; record: SessionRewindRecord; notice: string; carriedInputs: AgentMessage[]; effects?: AbandonedEffects }
	| { kind: "input"; input: QueuedInput }
	| { kind: "message"; message: AgentMessage | ChatMsg }
	| {
			kind: "custom_message";
			customType: string;
			content: string;
			images?: import("../core/content.js").ImageContent[];
			display?: boolean;
			details?: unknown;
	  };

/** Hydrated, durable session entry with confirmed node identity and topological lineage. */
export type HydratedSessionEntry = SessionEntryMeta & SessionEntryPayload;

/** An ordered session entry, which may be unhydrated before journal persistence
 * or fully hydrated when recovered from a store. */
export type SessionEntry = Partial<SessionEntryMeta> & SessionEntryPayload;

export type QueuedInput = QueuedMessage;

export interface SessionSnapshot {
	header: SessionHeader;
	records: SessionRecord[];
	entries: HydratedSessionEntry[];
	queued: QueuedInput[];
	lastSeq: number;
}

export interface SessionStore {
	readonly path: string;
	/** 常驻 canonical 状态：派生查询一律从它计算，禁止对 records 再写第二个 walker。 */
	readonly state: CanonicalState;
	readRecords(): readonly SessionRecord[];
	appendRewind(record: Omit<SessionRewindRecord, "kind" | "seq" | "timestamp">): Promise<void>;
	appendInput(input: QueuedInput): Promise<void>;
	/** id 用于恢复事实带稳定身份落盘（planRecovery → recovered:${originId}:${callId}）。 */
	appendMessage(message: AgentMessage | ChatMsg, id?: string): Promise<void>;
	appendCustomMessage(message: { customType: string; content: string; images?: import("../core/content.js").ImageContent[]; display?: boolean; details?: unknown }): Promise<void>;
	appendCustomEntry(entry: { customType: string; data?: unknown }): Promise<void>;
	appendEvent(
		event: SessionEventName,
		data: Record<string, unknown>,
	): Promise<void>;
	close(): Promise<void>;
}
