import type {
	AgentMessage,
	ChatMsg,
	DeliveryMode,
} from "../core/types.js";

export interface SessionHeader {
	kind: "header";
	version: 2;
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

export interface SessionCompactionRecord {
	kind: "compaction";
	id: string;
	seq: number;
	timestamp: string;
	summary: string;
	retainedTail: (AgentMessage | ChatMsg)[];
	tokensBefore: number;
}

export type SessionEventName =
	| "queue_enqueued"
	| "queue_consumed"
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

export type SessionRecord =
	| SessionInputRecord
	| SessionMessageRecord
	| SessionCustomMessageRecord
	| SessionCustomEntryRecord
	| SessionCompactionRecord
	| SessionEventRecord;

/** Ordered durable session content. Operational events are replayed into state,
 * while these entries retain their original journal order for model and UI projections. */
export type SessionEntry =
	| { kind: "input"; input: QueuedInput }
	| { kind: "message"; message: AgentMessage | ChatMsg }
	| {
			kind: "custom_message";
			customType: string;
			content: string;
			display?: boolean;
			details?: unknown;
	  }
	| { kind: "custom_entry"; customType: string; data?: unknown }
	| {
			kind: "compaction";
			summary: string;
			retainedTail: (AgentMessage | ChatMsg)[];
			tokensBefore: number;
	  };

export interface QueuedInput {
	id: string;
	order: number;
	mode: Exclude<DeliveryMode, "direct">;
	text: string;
	source?: { kind: "user" | "runtime" | "agent"; type: string; ref?: string };
	data?: unknown;
}

export interface SessionSnapshot {
	header: SessionHeader;
	entries: SessionEntry[];
	queued: QueuedInput[];
	lastSeq: number;
}

export interface SessionStore {
	readonly path: string;
	appendInput(input: QueuedInput): Promise<void>;
	appendMessage(message: AgentMessage | ChatMsg): Promise<void>;
	appendCustomMessage(message: { customType: string; content: string; display?: boolean; details?: unknown }): Promise<void>;
	appendCustomEntry(entry: { customType: string; data?: unknown }): Promise<void>;
	appendCompaction(
		summary: string,
		retainedTail: (AgentMessage | ChatMsg)[],
		tokensBefore: number,
	): Promise<void>;
	appendEvent(
		event: SessionEventName,
		data: Record<string, unknown>,
	): Promise<void>;
	close(): Promise<void>;
}
