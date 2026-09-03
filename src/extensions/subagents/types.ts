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
	messages: import("../../core/types.js").ChatMsg[];
}

export interface SubagentStartOptions {
	ownerId: string;
	parentId?: string;
	label: string;
	prompt: string;
}

export interface SubagentRecord extends SubagentSnapshot {
	handle: AgentHandle;
	outputs: SubagentOutput[];
	error?: string;
}
