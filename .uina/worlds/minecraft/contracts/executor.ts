/**
 * Uina ↔ Executor：受理、查询、结果与事件合同（lead 固定合同）。
 * 唯一设计来源：docs/proposals/mc/public-api.md §7。
 */

import type { CallableDescriptor } from "./callables.js";
import type { ProgramBinding, ProgramDefinition, WaitRequest } from "./program.js";
import type { Checkpoint, ExactRef, JsonValue, Outcome, Progress, Ref, Selector } from "./values.js";

export interface Origin {
	worldOwner: Ref;
	activation: Ref;
	caller?: Ref;
	invocation?: Ref;
}

export type Entry =
	| { kind: "call"; selector: Selector; input: JsonValue }
	| { kind: "program"; definition: ProgramDefinition; input: JsonValue };

export type Schedule =
	| { kind: "enqueue" }
	| { kind: "replace_pending"; targets?: Ref[] }
	| { kind: "preempt_current"; expectedRun: Ref };

export interface RunRequest {
	requestId: Ref;
	entry: Entry;
	policy: Record<string, JsonValue>;
	schedule: Schedule;
}

export interface GoalState {
	state: "undeclared" | "met" | "not_met" | "unknown";
	contract?: ExactRef;
	evidence: Ref[];
}

export interface RunBase {
	run: Ref;
	rootRequestId: Ref;
	revision: number;
	segment: Ref | null;
	progress: Progress;
	goal: GoalState;
	control: "none" | "active" | "stopping" | "stopped" | "unknown";
	unknownEffects: Ref[];
	record: Ref;
}

export type RunSnapshot = RunBase &
	(
		| { phase: "queued" | "running" | "stopping" }
		| { phase: "waiting"; wait: WaitRequest }
		| { phase: "awaiting_decision"; decision: Ref; reason: string; checkpoint: Checkpoint; completionRef: Ref }
		| {
				phase: "finished";
				outcome: Outcome;
				value?: JsonValue;
				error?: { code: string; message: string };
				completionRef: Ref;
		  }
	);

export type Acceptance =
	| { kind: "accepted"; requestId: Ref; segment: Ref; snapshot: RunSnapshot }
	| { kind: "unknown"; requestId: Ref; reason: string }
	| { kind: "not_accepted"; requestId: Ref; code: string; message: string };

export type SubmissionLookup =
	| { kind: "found"; requestId: Ref; operation: "submit" | "continue"; segment: Ref; snapshot: RunSnapshot }
	| { kind: "not_found"; requestId: Ref }
	| { kind: "unavailable"; reason: string };

export interface Delivery {
	completionRef: Ref;
	run: Ref;
	revision: number;
	snapshot: RunSnapshot;
}

export interface StopReceipt {
	requestId: Ref;
	/** 停止意图的持久性。 */
	intent: "durable" | "unknown";
	snapshot: RunSnapshot | null;
	error?: { code: string; message: string };
}

export type OwnerGate = "disabled" | "emergency" | "owner_lost";

export interface OwnerState {
	attachment: Ref;
	gates: OwnerGate[];
	gateRevision: number;
	validForMs: number;
}

export interface OwnerGateReceipt {
	requestId: Ref;
	state: OwnerState;
	persistence: "confirmed" | "unknown";
	control: "stopping" | "stopped" | "unknown";
	error?: string;
}

export type ContinuedEntry =
	| { kind: "call"; ref: ExactRef; input: JsonValue }
	| { kind: "program"; definition: ProgramDefinition; input: JsonValue };

export type SegmentEntry =
	| { kind: "program"; ref?: ExactRef; definition: ProgramDefinition }
	| { kind: "native"; descriptor: CallableDescriptor & { implementation: "native" }; digest: string };

export interface SegmentRecord {
	run: Ref;
	segment: Ref;
	revision: number;
	record: Ref;
	entry: SegmentEntry;
	input: JsonValue;
	nativeEnvironment: Ref;
	effectiveBindings: ProgramBinding[];
	sourceDigest: string;
	checkpoint: Checkpoint | null;
	value?: JsonValue;
	evidence: Ref[];
}

/** 仅供组合根注入的可信持久记录所有者；不装入 ExecutorClient 或脚本。 */
export interface RuntimeEvidencePort {
	retain(owner: Ref, evidence: Ref[]): Promise<void>;
	release(owner: Ref): Promise<void>;
}

export interface ExecutorClient {
	attach(origin: Origin): Promise<OwnerState>;
	heartbeat(attachment: Ref): Promise<OwnerState>;
	setOwnerGate(request: {
		requestId: Ref;
		attachment: Ref;
		gate: OwnerGate;
		closed: boolean;
		expectedRevision?: number;
	}): Promise<OwnerGateReceipt>;
	submit(origin: Origin, request: RunRequest): Promise<Acceptance>;
	lookup(requestId: Ref): Promise<SubmissionLookup>;
	read(run: Ref): Promise<RunSnapshot>;
	readSegment(run: Ref, segment: Ref): Promise<SegmentRecord>;
	list(filter: { activeOnly: boolean; cursor?: string }): Promise<{ items: RunSnapshot[]; next?: string }>;
	wait(run: Ref, afterRevision: number, signal: AbortSignal): Promise<RunSnapshot>;
	stop(run: Ref, requestId: Ref): Promise<StopReceipt>;
	continue(request: {
		run: Ref;
		decision: Ref;
		requestId: Ref;
		entry: ContinuedEntry;
		environment?: "inherit" | "current";
	}): Promise<Acceptance>;
	pendingDeliveries(): Promise<Delivery[]>;
	acknowledge(completionRef: Ref, receipt: { channel: "tool" | "input"; recordId: Ref }): Promise<void>;
	events(
		listener: (event: { kind: "run_changed"; run: Ref; revision: number; completionRef?: Ref }) => void,
	): () => void;
}

/**
 * 拟增加的通用事实（当前 Uina 源码没有）：完整 canonical tool message append
 * 成功后发布原始 details。Core 不解释 Minecraft completion。属于 Runtime/Core 依赖，未实现前不得伪造。
 */
export interface ToolResultRecordedFact {
	type: "tool_result_recorded";
	recordId: Ref;
	callId: Ref;
	status: Outcome;
	details?: unknown;
}
