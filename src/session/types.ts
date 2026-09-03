import type {
	ChatMsg,
	DeliveryMode,
	ToolResultStatus,
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
	message: ChatMsg;
}

export interface SessionCompactionRecord {
	kind: "compaction";
	id: string;
	seq: number;
	timestamp: string;
	summary: string;
	retainedTail: ChatMsg[];
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
	| SessionMessageRecord
	| SessionCustomMessageRecord
	| SessionCustomEntryRecord
	| SessionCompactionRecord
	| SessionEventRecord;

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
	messages: ChatMsg[];
	customMessages: Array<{ customType: string; content: string; display?: boolean; details?: unknown }>;
	customEntries: Array<{ customType: string; data?: unknown }>;
	queued: QueuedInput[];
	lastSeq: number;
}

export interface SessionStore {
	readonly path: string;
	appendMessage(message: ChatMsg): Promise<void>;
	appendCustomMessage(message: { customType: string; content: string; display?: boolean; details?: unknown }): Promise<void>;
	appendCustomEntry(entry: { customType: string; data?: unknown }): Promise<void>;
	appendCompaction(
		summary: string,
		retainedTail: ChatMsg[],
		tokensBefore: number,
	): Promise<void>;
	appendEvent(
		event: SessionEventName,
		data: Record<string, unknown>,
	): Promise<void>;
	close(): Promise<void>;
}

export interface ToolLifecycleData {
	turnId: number;
	callId: string;
	name: string;
	args: unknown;
	status?: ToolResultStatus;
	result?: string;
}
