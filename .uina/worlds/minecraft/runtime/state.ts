/**
 * Runtime 内存态：受理/Run/Call/身体租约的形状。
 *
 * 唯一定义来源：docs/proposals/mc/modules/runtime.md §2（受理）、§3（调用与身体）。
 * 这些形状被 engine（状态机）与 rows（投影/持久行）共同读取，故独立成模块：
 * 两边只共享形状，不共享行为——投影永远不该回头改状态。
 */

import type { BodySession } from "../contracts/body.js";
import type { CallableDescriptor, NativeCallable } from "../contracts/capabilities.js";
import type { ProgramDiagnostic, ProgramSegmentScope, ResolvedProgram } from "../contracts/program.js";
import type { ControlRetirementNotice, RunRequest, RunWaitReply } from "../contracts/runtime.js";
import type { CallFailureData, JsonValue, Outcome, Progress, Ref } from "../contracts/values.js";

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
			descriptor?: CallableDescriptor;
			recoveryCheck?: import("../contracts/values.js").ExactRef;
	  }
);

/** 身体租约：一次 Call 帧内持有的 Body 会话（§3.3.1 单槽）。 */
export interface BodyLease {
	abort: AbortController;
	session: BodySession;
	activeCall: Ref;
	closed: boolean;
}

/**
 * Call 收尾时传给资源关闭的**真实退出原因**（§5.2）：returned=正常返回、
 * threw=主业务失败、cancelled=Stop/Safety/父关闭、parked=决策/挂起。
 * 资源关闭不得用 abort 后的布尔值反推原因——abort 只负责封闭准入与撤销在途写入资格。
 */
export interface ResourceTeardown {
	reason: "returned" | "threw" | "cancelled" | "parked";
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
	/** 资源关闭器按真实退出原因收尾（§5.2）；无参关闭器兼容旧注册。 */
	resources: Set<(teardown: ResourceTeardown) => Promise<void>>;
	input: JsonValue;
	execution: "running" | "returned" | "threw" | "interrupted";
	outcome: Outcome | null;
	value: JsonValue | null;
	error: CallFailureData | null;
	decisionRequest?: import("../contracts/values.js").DecisionRequest;
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
	operation?: "submit" | "continue";
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
	caller?: Ref;
	run: Ref;
	owner: Ref;
	requestId: Ref;
	segmentRequestId?: Ref;
	started?: boolean;
	everStarted?: boolean;
	priorityRelease?: () => void;
	checkpoint?: import("../contracts/values.js").Checkpoint | null;
	recovery?: import("../contracts/values.js").ProgramRecovery;
	/** 本段是持久挂起的重入：上次落库的等待记录（ctx.checkpoint 与尝试次数来源）。 */
	durableWait?: import("../contracts/values.js").DurableWait;
	decisionRequest?: import("../contracts/values.js").DecisionRequest;
	decision?: Ref;
	environment?: RunEnvironment | null;
	segment: Ref;
	segmentRecord: Ref;
	rootCall: CallState;
	callable: ResolvedInvocation;
	programScope?: ProgramSegmentScope;
	request: RunRequest;
	requestJson: string;
	revision: number;
	phase: "queued" | "running" | "waiting" | "stopping" | "finished" | "awaiting_decision";
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
	/** 第一次真实撤销的不可变起因；只写一次，供 Call/Run 的失败与追踪引用。 */
	retiredBy?: ControlRetirementNotice | null;
	abort: AbortController;
	awaitingBody: number;
	waiters: Set<RunWaiter>;
}

export interface RunWaiter {
	mode: "result" | "changed";
	resolve: (reply: RunWaitReply) => void;
}
