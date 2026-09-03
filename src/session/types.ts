import type {
	ChatMsg,
	DeliveryMode,
	ToolResultStatus,
} from "../core/types.js";

export interface SessionHeader {
	kind: "header";
	version: 1;
	id: string;
	cwd: string;
	createdAt: string;
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
	queued: QueuedInput[];
	lastSeq: number;
}

export interface SessionStore {
	readonly path: string;
	appendMessage(message: ChatMsg): Promise<void>;
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
