import type { AgentHandle } from "../../agent/runtime.js";

export type SubagentStatus = "accepted" | "running" | "waiting" | "interrupted" | "failed" | "settled";

export interface SubagentOutput {
	cursor: number;
	kind: "thinking" | "text" | "tool_start" | "tool_done";
	text: string;
}

export interface SubagentSnapshot {
	id: string;
	ownerId: string;
	parentId?: string;
	label: string;
	status: SubagentStatus;
	/** The factual reason a released child settled, when it did not finish by normal release. */
	terminalStatus?: "failed" | "interrupted";
	detail?: string;
	createdAt: number;
	finishedAt?: number;
	outputCursor: number;
	busy: boolean;
}

export interface SubagentRead {
	cursor: number;
	output: SubagentOutput[];
	outputLost: boolean;
	subagent: SubagentSnapshot;
}

export interface SubagentTranscript {
	subagent: SubagentSnapshot;
	messages: import("../../core/types.js").AgentMessage[];
}

export interface SubagentStartOptions {
	ownerId: string;
	parentId?: string;
	label: string;
	prompt: string;
}

export interface SubagentRecord extends Omit<SubagentSnapshot, "status" | "busy"> {
	status?: "interrupted" | "failed" | "settled";
	handle: AgentHandle;
	outputs: SubagentOutput[];
	/** Cursor that the next appended chunk will receive; lets readers detect
	 * chunks dropped by the per-child output budget. */
	nextCursor: number;
	error?: string;
	settling?: Promise<void>;
}
