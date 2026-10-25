/**
 * Runtime 内存态：受理/Run/Call/身体租约的形状。
 *
 * 唯一定义来源：docs/proposals/mc/modules/runtime.md §2（受理）、§3（调用与身体）。
 * 这些形状被 engine（状态机）与 rows（投影/持久行）共同读取，故独立成模块：
 * 两边只共享形状，不共享行为——投影永远不该回头改状态。
 */

import type { BodySession } from "../contracts/body.js";
import type { NativeCallable } from "../contracts/capabilities.js";
import type { RunRequest, RunWaitReply } from "../contracts/runtime.js";
import type { CallFailureData, JsonValue, Outcome, Progress, Ref } from "../contracts/values.js";
import type { ProgramSegmentScope, ResolvedProgram, ProgramDiagnostic } from "../contracts/program.js";
import type { CallableDescriptor } from "../contracts/capabilities.js";

export type ResolvedInvocation = {
	ref: string;
	digest: string;
	completion: CallableDescriptor["completion"];
	inputSchema: import("../contracts/values.js").JsonSchema;
	outputSchema: import("../contracts/values.js").JsonSchema;
} & (
	| { kind: "native"; native: NativeCallable<JsonValue, JsonValue> }
	| {
			kind: "program";
			program: ResolvedProgram;
			snapshot: string;
	  }
);

/** 身体租约：一次 Call 帧内持有的 Body 会话（§3.3.1 单槽）。 */
export interface BodyLease {
	session: BodySession;
	activeCall: Ref;
	closed: boolean;
}

export interface CallFrame {
	call: CallState;
	bodyLease: BodyLease | null;
}

export interface CallState {
	call: Ref;
	run: Ref;
	segment: Ref;
	parent: Ref | null;
	record: Ref;
	callable: ResolvedInvocation;
	diagnostic?: ProgramDiagnostic;
	resources: Set<() => Promise<void>>;
	input: JsonValue;
	execution: "running" | "returned" | "threw" | "interrupted";
	outcome: Outcome | null;
	value: JsonValue | null;
	error: CallFailureData | null;
	closedByParent: { call: Ref; reason: "returned" | "threw" | "decision" | "cancelled" } | null;
	progress: Progress;
	effects: Ref[];
	closed: boolean;
	abort: AbortController;
	children: Set<CallState>;
	settled: Promise<void>;
	settledResolve: () => void;
}

export interface SubmissionState {
	owner: Ref;
	requestId: Ref;
	status: "accepted" | "cancelled" | "rejected";
	run: Ref | null;
	segment: Ref | null;
	record: Ref | null;
	requestJson: string;
	error: { code: string; message: string } | null;
}

/** 段记录里固化的运行环境（不属于状态机，但随段一起落库）。 */
export interface RunEnvironment {
	serverVersion: string;
	protocol: number;
}

export interface RunState {
	run: Ref;
	owner: Ref;
	requestId: Ref;
	segment: Ref;
	segmentRecord: Ref;
	rootCall: CallState;
	callable: ResolvedInvocation;
	programScope?: ProgramSegmentScope;
	request: RunRequest;
	requestJson: string;
	revision: number;
	phase: "queued" | "running" | "waiting" | "stopping" | "finished";
	waiting?: import("../contracts/runtime.js").WaitState;
	outcome: Outcome | null;
	value: JsonValue | null;
	error: { code: string; message: string } | null;
	completionRef: Ref | null;
	control: "none" | "active" | "stopping" | "stopped" | "unknown";
	unknownEffects: Ref[];
	interruptedChildren: Ref[];
	record: Ref;
	progress: Progress;
	stopped: boolean;
	abort: AbortController;
	awaitingBody: number;
	waiters: Set<RunWaiter>;
}

export interface RunWaiter {
	mode: "result" | "changed";
	resolve: (reply: RunWaitReply) => void;
}
