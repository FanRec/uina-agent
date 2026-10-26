/**
 * Runtime 受理/执行公共合同（I1 首批子集）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §7、§7.1。完整 ExecutorClient
 * 端口由 Executor 工作包引入；本文件只落 Runtime 与组合根/能力实际交换的形状。
 */

import type { CallableDescriptor } from "./capabilities.js";
import type { ControlOwner } from "./body.js";
import type {
	Checkpoint,
	CallFailureData,
	DecisionRequest,
	ExactRef,
	Fact,
	JsonValue,
	Outcome,
	Progress,
	Ref,
	Selector,
} from "./values.js";

export interface Origin {
	worldOwner: Ref;
	activation: Ref;
	caller?: Ref;
	invocation?: Ref;
}

export type Entry =
	| { kind: "call"; selector: Selector; input: JsonValue }
	| { kind: "program"; source: import("./program.js").SourceRequest; input: JsonValue };

export type Schedule =
	| { kind: "enqueue" }
	| { kind: "replace_pending"; targets?: Ref[] }
	| { kind: "preempt_current"; expectedRun: Ref };

export interface RunRequest {
	requestId: Ref;
	entry: Entry;
	schedule: Schedule;
}

export interface ContinueRequest {
	run: Ref;
	decision: Ref;
	requestId: Ref;
	entry: Entry;
	environment?: "inherit" | "current";
}

export interface RunBase {
	run: Ref;
	rootRequestId: Ref;
	revision: number;
	segment: Ref | null;
	/** 当前段入口范围；随报告固定，不认证历史目标。 */
	completion: CallableDescriptor["completion"];
	progress: Progress;
	control: "none" | "active" | "stopping" | "stopped" | "unknown";
	unknownEffects: Ref[];
	record: Ref;
}

/** 只描述"在等什么"，不承诺何时结束；不设墙钟超时。 */
export type WaitState =
	| { kind: "host_call"; method: string; sinceMs: number }
	| { kind: "world_change"; targets: ExactRef[]; sinceMs: number }
	| { kind: "sleep"; sinceMs: number }
	| { kind: "idle"; sinceMs: number };

export type RunSnapshot = RunBase &
	(
		| { phase: "queued" | "running" | "stopping" }
		| { phase: "waiting"; waiting: WaitState }
		| {
				phase: "awaiting_decision";
				decision: Ref;
				reason: string;
				checkpoint: Checkpoint | null;
				request?: DecisionRequest;
				completionRef: Ref;
		  }
		| {
				phase: "finished";
				outcome: Outcome;
				value?: JsonValue;
				error?: { code: string; message: string };
				completionRef: Ref;
				interruptedChildren?: Ref[];
		  }
	);

export interface RunSummaryBase {
	run: Ref;
	rootRequestId: Ref;
	revision: number;
	segment: Ref | null;
	record: Ref;
	completion: Pick<CallableDescriptor["completion"], "scope">;
	progress: Progress;
	progressComplete: boolean;
	control: RunBase["control"];
	unknownEffectCount: number;
	unknownEffects: Ref[];
	unknownEffectsComplete: boolean;
}

/** 已提交完整记录的有界投影；不独立结算。 */
export type RunSummary = RunSummaryBase &
	(
		| { phase: "queued" | "running" | "stopping" }
		| { phase: "waiting"; waiting: WaitState; waitingComplete: boolean }
		| {
				phase: "awaiting_decision";
				decision: Ref;
				reason: string;
				reasonComplete: boolean;
				completionRef: Ref;
		  }
		| {
				phase: "finished";
				outcome: Outcome;
				completionRef: Ref;
				error?: { code: string; message: string; messageComplete: boolean };
		  }
	);

export type RunWaitReply =
	| {
			kind: "result";
			snapshot: Extract<RunSummary, { phase: "finished" | "awaiting_decision" }>;
	  }
	| { kind: "changed" | "timeout"; snapshot: RunSummary };

export type Acceptance =
	| { kind: "accepted"; requestId: Ref; segment: Ref; snapshot: RunSummary }
	| { kind: "unknown"; requestId: Ref; reason: string }
	| { kind: "not_accepted"; requestId: Ref; code: string; message: string };

export type SubmissionLookup =
	| {
			kind: "found";
			requestId: Ref;
			operation: "submit" | "continue";
			segment: Ref;
			snapshot: RunSummary;
			completionRef?: Ref;
	  }
	| { kind: "cancelled"; requestId: Ref; record: Ref }
	| { kind: "not_found"; requestId: Ref }
	| { kind: "unavailable"; reason: string };

export type StopTarget = { run: Ref; request?: never } | { request: Ref; run?: never };

export interface StopCommand {
	requestId: Ref;
	target: StopTarget;
}

export interface StopReceipt {
	requestId: Ref;
	target: StopTarget;
	record: Ref | null;
	intent: "durable" | "unknown";
	/** 当前内存控制事实，不宣称持久。 */
	control: "stopping" | "stopped" | "unknown";
	snapshot: RunSummary | null;
	error?: { code: string; message: string };
}

export interface CallRecord {
	call: Ref;
	run: Ref;
	segment: Ref;
	parent: Ref | null;
	record: Ref;
	/** 原生与子调用为 ExactRef；程序调用为 <name> 或 code:<digest 前 8 位>。 */
	ref: Ref;
	implementation: "native" | "program";
	program?: {
		name: string | null;
		origin: "code" | "library";
		digest: string;
		snapshot: string;
		diagnostic?: import("./program.js").ProgramDiagnostic;
	};
	digest: string;
	access: "act";
	input: JsonValue;
	execution: "running" | "returned" | "threw" | "interrupted";
	completion: CallableDescriptor["completion"];
	outcome?: Outcome;
	value?: JsonValue;
	closedByParent?: {
		call: Ref;
		reason: "returned" | "threw" | "decision" | "cancelled";
	};
	decisionRequest?: DecisionRequest;
	error?: CallFailureData & { dispatch: "not_sent" | "sent" | "unknown" };
	progress: Progress;
	effects: Ref[];
	evidence: Ref[];
}

export interface SegmentRecord {
	run: Ref;
	segment: Ref;
	revision: number;
	record: Ref;
	entry:
		| { kind: "native"; descriptor: CallableDescriptor; digest: string }
		| {
				kind: "program";
				name: string | null;
				origin: "library" | "code";
				digest: string;
				snapshot: Ref;
		  };
	input: JsonValue;
	environment?: { serverVersion: string; protocol: number };
	checkpoint: Checkpoint | null;
	value?: JsonValue;
	interruptedChildren?: Ref[];
	evidence: Ref[];
}

// ---- 可信组合根注入（public-api §7.1）----

export interface DriverExecutionFact {
	/** Trusted Driver attribution, captured with the operation; never supplied by guest. */
	owner?: ControlOwner;
	effect: Ref;
	operation: Ref;
	contract: ExactRef;
	observedAt: string;
	kind: "dispatch" | "receipt" | "cleanup";
	dispatch: "not_sent" | "sent" | "unknown";
	completion: "met" | "not_met" | "unknown";
	evidence: Ref[];
	/** 操作声明的原始回执/缺口，不是 guest 自述。 */
	detail?: JsonValue;
}

export interface RecordTicket {
	instance: Ref;
	sequence: number;
}

/**
 * Runtime 注入并绑定可信 ControlOwner 的效果接收口。
 * record 同步接收不可变事实、非阻塞入队，返回本 writer 实例的 ticket；
 * 无法接收时返回 null、锁存 recorder fault 并封闭新副作用。
 */
export interface DriverExecutionSink {
	record(fact: DriverExecutionFact): RecordTicket | null;
}

/** capture 固定已收到前缀 H；flushThrough(H) 保证 ≤H 材料已提交否则明确失败。 */
export interface RuntimeRecordBarrier {
	capture(): RecordTicket;
	flushThrough(through: RecordTicket): Promise<void>;
}

/** 效果核验追加记录（ctx.verify 的结果）。 */
export interface EffectVerification {
	record: Ref;
	observedAt: string;
	verifier: ExactRef;
	completion: "met" | "not_met" | "unknown";
	evidence: Ref[];
	reason?: string;
}

export interface EffectRecord {
	effect: Ref;
	owner: ControlOwner;
	operation: Ref;
	record: Ref;
	facts: DriverExecutionFact[];
	verifications: EffectVerification[];
	/** 本截面的最新判断，不改写原 completion。 */
	latest: import("./values.js").EffectReceipt;
}

/** 安全介入记录形状（I1 预留；实现归属 Runtime 工作包后续条目）。 */
export type SafetyInterventionRecord = {
	intervention: Ref;
	record: Ref;
	policy: ExactRef;
	trigger: {
		kind: "lava" | "drowning" | "low_health_damage";
		sample: Fact<import("./body.js").SelfState>;
		evidence: Ref[];
	};
	thresholds: { oxygen: number; healthRatio: number; maxTimeMs: number };
	interruptedRun: Ref | null;
	startedAt: string;
	effects: Ref[];
	unknownEffects: Ref[];
} & (
	| { finishedAt: null; ended: null; outcome: null }
	| {
			finishedAt: string;
			ended: "safe" | "blocked" | "timeout" | "cancelled" | "invalidated";
			outcome: Outcome;
	  }
);

/** Runtime 所有的独立动作门；解除一项不解除其他原因。 */
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
/** 可信本地升级口；launch 由组合根绑定，不由调用者提供。 */
export interface ControlRetirement {
	source: "runtime" | "driver" | "program";
	subject: Ref | null;
	code: "CONTROL_ISOLATION_FAILED" | "EXECUTION_DOMAIN_UNRETIRED";
	detail: string;
}

/** Fixed reports and their bounded projections. Only Runtime owns their disposition. */
export type CompletionReport =
	| { reportKind: "terminal"; snapshot: Extract<RunSnapshot, { phase: "finished" }> }
	| { reportKind: "decision"; snapshot: Extract<RunSnapshot, { phase: "awaiting_decision" }> };
export interface DeliveryRef {
	completionRef: Ref;
	requestId: Ref;
	run: Ref;
	segment: Ref;
	revision: number;
}
export type Delivery = DeliveryRef & CompletionReport;
export type CompletionHeader = DeliveryRef & { recordBytes: number } & (
		| { reportKind: "terminal"; snapshot: Extract<RunSummary, { phase: "finished" }> }
		| { reportKind: "decision"; snapshot: Extract<RunSummary, { phase: "awaiting_decision" }> }
	);
export type CompletionView = CompletionHeader & {
	content:
		| { kind: "inline"; report: CompletionReport }
		| { kind: "record"; record: Ref }
		| { kind: "unavailable"; record: Ref; error: { code: string; message: string } };
};
export type RunReply = Acceptance | ({ kind: "result" } & CompletionView);
export type DeliveryReceipt = import("../../../../src/core/types.js").HostCommitReceipt;
export interface DeliveryState {
	delivery: CompletionHeader;
	disposition: "pending" | "committed";
	eligible: boolean;
}
export type RuntimeRecord = {
	kind: "run" | "segment" | "call" | "effect" | "completion" | "stop" | "safety";
	record: Ref;
	value: JsonValue;
};
export type RecordFormat = "auto" | "inline" | "file";
export type RecordReply =
	| { kind: "inline"; record: RuntimeRecord }
	| {
			kind: "file";
			record: Ref;
			recordKind: RuntimeRecord["kind"];
			file: { path: string; sha256: string; bytes: number };
	  };
export type CallSummary = Pick<
	CallRecord,
	"call" | "run" | "segment" | "parent" | "record" | "ref" | "implementation" | "access" | "execution" | "outcome"
>;
