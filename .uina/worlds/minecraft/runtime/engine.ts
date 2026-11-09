/**
 * Runtime 执行引擎：原生/程序受理、调用组合、身体仲裁与记录结算。
 *
 * 唯一定义来源：docs/proposals/mc/modules/runtime.md §2（受理）、§3（调用与
 * 身体）、§4.3/§4.4（关闭/停止）、§5（记录与结算）、§5.6（五态）。
 * 批 9B：原生/Program、多段决策续段、enqueue/replace_pending/preempt_current；
 * 固定报告复用持久回执。安全介入仍由后续玩法工作包接入。
 * 不做：逐 Call 等盘（普通子 Call 入队即返回）；恢复自动重放（恢复只读事实
 * 并按 §4.4 表结算未终结 Run）；效果核验器（ctx.verify 对未注册 verifier 如实
 * NOT_FOUND）。owner→effect 关联由引擎经记录队列归属槽建立（§5.4）。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import type { ControlOwner, PlayerPort } from "../contracts/body.js";
import type {
	BodyCallScope,
	CallContext,
	NativeCallable,
	ProtocolWriteBinding,
	ProtocolWritePort,
} from "../contracts/capabilities.js";
import type { ProgramPort, ResolvedProgram } from "../contracts/program.js";
import { createDecisionError, getDecisionRequest } from "../contracts/program.js";
import type {
	Acceptance,
	ContinueRequest,
	ControlRetirement,
	ControlRetirementCause,
	ControlRetirementNotice,
	EffectVerification,
	EffectVerifier,
	Origin,
	RunRequest,
	RunSummary,
	RunWaitReply,
	StopCommand,
	StopReceipt,
	StopTarget,
	SubmissionLookup,
} from "../contracts/runtime.js";
import type {
	CallFailure,
	CallFailureData,
	DecisionRequest,
	DurableSuspendRequest,
	DurableWait,
	EffectReceipt,
	JsonSchema,
	JsonValue,
	Progress,
	Ref,
} from "../contracts/values.js";
import { callFailure, createSuspendError, getSuspendRequest, plain } from "../contracts/values.js";
import type { WorldPort } from "../contracts/world.js";
import { type BodyGrant, BodyLeaseQueue } from "./body-queue.js";
import { toCallFailure } from "./failure.js";
import { RuntimeOwner } from "./owner.js";
import { createProgramHost } from "./program-host.js";
import { RecordQueue } from "./records.js";
import { RuntimeRefs } from "./refs.js";
import { callRowOf, canonicalJson, projectSummary, runRowOf, segmentRowOf, sha256Hex, summaryFromRow } from "./rows.js";
import type { ApplyItem, RecoveredRows, RunRow, StopIntentRow } from "./runtime-db-worker.js";
import { RuntimeSafety, type SafetyCause } from "./safety.js";
import { scopedBody } from "./scoped-body.js";
import { createScopedProtocolWrite } from "./scoped-protocol.js";
import type {
	BodyLease,
	CallFrame,
	CallState,
	ResolvedInvocation,
	RunState,
	RunWaiter,
	SubmissionState,
} from "./state.js";

// ---- 纯值辅助 ----

/** Ajv 仅由本模块构造（strict 关闭：能力 schema 含开放键；allErrors 全量）。 */
interface AjvLike {
	compile(schema: Record<string, unknown>): ValidateFunction;
	errorsText(errors?: ValidateFunction["errors"]): string;
}
const AjvCtor = createRequire(import.meta.url)("ajv") as new (options: {
	strict: boolean;
	allErrors: boolean;
	addUsedSchema?: boolean;
}) => AjvLike;

function nowIso(): string {
	return new Date().toISOString();
}

/**
 * 只负责"上层不能再等旧 work"。失败内容由调用方在 abort 发生的那一刻从
 * Effect 账本计算：Promise.race 提前结束不等于原动作已退场，更不能据此写死
 * not_sent / effects:[]。退场屏障仍由 BodySession.close() 独立负责。
 */
async function interruptible<T>(work: Promise<T>, signal: AbortSignal, retired: () => CallFailure): Promise<T> {
	let abort!: () => void;
	const interrupted = new Promise<never>((_resolve, reject) => {
		abort = () => reject(retired());
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
	try {
		return await Promise.race([work, interrupted]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

const RETIREMENT_HINT: Record<ControlRetirementCause, string> = {
	safety:
		"safety intervention retired the old body; re-read world facts and acquire a new qualification before continuing",
	user_stop: "the user stopped this run; do not resume automatically",
	run_preempted: "another run took the body; re-observe before continuing",
	disconnect: "connection or world generation changed; re-read facts in a new session",
	control_fault: "old control isolation could not be proved; wait for the close barrier and re-observe",
	world_disabled: "the world is shutting down; remaining work is not confirmed",
	unknown: "old writes may still be in flight; wait for the close barrier and re-observe before any new write",
};

/**
 * 持久挂起的重入次数上限（§5.9）：能力反复 wake→check→wait 时，Runtime 必须有
 * 自己的收口预算，否则一个永远观察不到的条件会无限续段。到顶按 unknown 结案。
 */
const MAX_DURABLE_WAKE_ATTEMPTS = 16;

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value === "object" && value != null) {
		return Object.values(value).every(isJsonValue);
	}
	return false;
}

function failureData(err: CallFailure): CallFailureData & { dispatch: CallFailureData["dispatch"] } {
	return {
		code: err.code,
		source: err.source,
		message: err.message,
		hint: err.hint,
		dispatch: err.dispatch,
		progress: err.progress,
		effects: err.effects,
		recoverable: err.recoverable,
	};
}

/** 落库的 `runs.decision` → 决策 ref 与持久等待；不是持久挂起就返回 null。 */
function parseWait(decision: string): { decision: Ref; wait: DurableWait } | null {
	try {
		const parsed = JSON.parse(decision) as { ref?: unknown; request?: { wait?: unknown } };
		if (typeof parsed.ref !== "string" || parsed.request?.wait == null) return null;
		return { decision: parsed.ref, wait: parsed.request.wait as DurableWait };
	} catch {
		return null;
	}
}

export interface EngineOptions {
	evidence?: import("../contracts/world.js").WorldEvidencePort;
	onSafetyChanged?: (
		record: import("../contracts/runtime.js").SafetyInterventionRecord,
		cause: SafetyCause | null,
	) => void;
	commitAdmission?: (command: import("./runtime-db-worker.js").AdmissionCommand) => Promise<void>;
	/** ctx.verify 注册表（G4）：组合根随能力工作包注入，不预建框架。 */
	verifiers?: ReadonlyMap<import("../contracts/values.js").ExactRef, EffectVerifier>;
	refs: RuntimeRefs;
	queue: RecordQueue;
	world: WorldPort;
	playerPort: PlayerPort;
	callables: NativeCallable<JsonValue, JsonValue>[];
	program?: ProgramPort;
	queryRefs?: string[];
	worldOwner: Ref;
	ownerLifetimeMs?: number;
	monotonicNow?: () => number;
	unclean?: boolean;
	oldControlRetired?: boolean;
	requireRetirement?: (notice: ControlRetirement) => void;
	environment?: { serverVersion: string; protocol: number };
	/**
	 * 受控协议写入派发器（addon 自定义 Payload）。只在 BodyScope 内注入 CallContext，
	 * 且每个 Scope 拿到的是绑定本次 Call/Lease/连接身份的独立端口，不是共享对象。
	 */
	protocol?: import("../contracts/capabilities.js").ProtocolWriteDispatcher;
}

// ---- 引擎 ----

export class RuntimeEngine {
	private readonly refs: RuntimeRefs;
	private readonly queue: RecordQueue;
	private readonly opts: EngineOptions;
	private readonly als = new AsyncLocalStorage<CallFrame>();
	private readonly ajv = new AjvCtor({ strict: false, allErrors: true, addUsedSchema: false });
	private readonly validatorCache = new Map<string, ValidateFunction>();
	private readonly byRef = new Map<Ref, NativeCallable<JsonValue, JsonValue>>();
	private readonly runs = new Map<Ref, RunState>();
	private readonly submissions = new Map<Ref, SubmissionState>();
	private readonly byRequestId = new Map<Ref, SubmissionState>();
	private readonly submissionBarriers = new Set<Ref>();
	private readonly stopIntentRows = new Map<Ref, StopIntentRow>();
	// 恢复事实（只读；恢复结算后未终结 Run 已按 §4.4 表落终态）
	private readonly recoveredRuns = new Map<Ref, RunRow>();
	/** effect 身份引用 → 最新已提交效果记录 ref（public-api §7 readRecord 口径）。 */
	// 身体：单槽 FIFO 队列独占 acquire，归属槽与授予/释放配对收在队列内（§3.3.1）
	private readonly bodyLeaseQueue: BodyLeaseQueue;
	// chat 旁路串行化：单写协议通道 + 归属槽无竞争
	readonly owner: RuntimeOwner;
	private readonly pendingSubmissions = new Map<string, { intent: string; promise: Promise<Acceptance> }>();
	private readonly uncertainSubmissions = new Set<string>();
	private readonly activeRuns = new Set<Promise<void>>();
	private readonly startedRuns = new Set<Ref>();
	private readonly stoppedRuns = new Set<Ref>();
	private readonly segmentCompletions = new Map<Ref, Ref>();
	private admissionTail: Promise<unknown> = Promise.resolve();
	private readonly recoveredSegments = new Map<Ref, import("./runtime-db-worker.js").SegmentRow>();
	private readonly stopBarriers = new Set<Promise<StopReceipt>>();
	private shutdownPromise: Promise<void> | null = null;
	private wakeTimer: ReturnType<typeof setInterval> | null = null;
	private wakeScanning = false;
	private wakeClosed = false;
	private isolationFailed = false;
	private chatGate: Promise<void> = Promise.resolve();
	readonly safety: RuntimeSafety;
	private activeBody: { run: Ref; interrupt(notice?: ControlRetirementNotice): Promise<void> } | null = null;

	constructor(opts: EngineOptions) {
		this.opts = opts;
		this.refs = opts.refs;
		this.queue = opts.queue;
		this.bodyLeaseQueue = new BodyLeaseQueue({
			port: opts.playerPort,
			onGrant: (owner) => this.queue.setQualificationOwner(owner),
			onRelease: () => this.queue.setQualificationOwner(null),
			// Run 停止后不再授予；排队/在途期间的停止由授予前复验拦下（§2.2）
			isOwnerLive: (owner) =>
				owner.kind === "safety" ? this.safety.isLive(owner.intervention) : this.runs.get(owner.run)?.stopped !== true,
		});
		this.safety = new RuntimeSafety({
			refs: this.refs,
			queue: this.queue,
			bodies: this.bodyLeaseQueue,
			guard: () => this.assertActionAllowed(),
			interrupt: async () => {
				if (this.activeBody) {
					const active = this.activeBody;
					const notice = this.notice("safety", "runtime:safety", active.run);
					this.retire(active.run, notice);
					await active.interrupt(notice);
					return active.run;
				}
				const id = this.bodyLeaseQueue.blockingCall();
				const call = id ? this.findLiveCall(id) : undefined;
				if (call) {
					call.abort.abort();
					await call.settled;
					return call.run;
				}
				return null;
			},
			retain: opts.evidence?.retain.bind(opts.evidence),
			changed: opts.onSafetyChanged,
		});
		this.owner = new RuntimeOwner({
			worldOwner: opts.worldOwner,
			queue: opts.queue,
			lifetimeMs: opts.ownerLifetimeMs,
			now: opts.monotonicNow,
			onClose: () => this.stopAll(),
			control: () => this.controlState(),
		});
		for (const callable of opts.callables) {
			const existing = this.byRef.get(callable.descriptor.ref);
			if (existing != null) {
				throw new Error(`duplicate callable ref: ${callable.descriptor.ref}`);
			}
			this.byRef.set(callable.descriptor.ref, callable);
		}
	}

	// ---- 恢复（只读事实 + 未终结 Run 结算，不自动重放） ----

	recover(rows: RecoveredRows): void {
		this.safety.recover(
			rows.safety ?? [],
			this.opts.oldControlRetired === true,
			JSON.parse(rows.ownerState?.gates ?? "[]").length > 0,
			rows.effects,
		);
		for (const report of rows.completions ?? [])
			if (!this.segmentCompletions.has(report.segment))
				this.segmentCompletions.set(report.segment, report.completionRef);
		this.owner.recover(rows.ownerState, this.opts.unclean === true);
		for (const row of rows.stopIntents) this.stopIntentRows.set(row.record, row);
		for (const row of rows.submissions) {
			const state: SubmissionState = {
				operation: row.operation === "continue" ? "continue" : "submit",
				owner: row.owner,
				requestId: row.request_id,
				status: row.status,
				run: row.run,
				segment: row.segment,
				record: row.record,
				requestJson:
					row.status === "cancelled"
						? row.request
						: canonicalJson(
								plain(
									(() => {
										const request = JSON.parse(row.request) as RunRequest;
										return row.operation === "continue"
											? request
											: { entry: request.entry, schedule: request.schedule };
									})(),
								),
							),
				error: row.error == null ? null : (JSON.parse(row.error) as { code: string; message: string }),
			};
			this.submissions.set(submissionKey(row.owner, row.request_id), state);
			this.byRequestId.set(row.request_id, state);
			if (row.status === "cancelled") this.submissionBarriers.add(row.request_id);
		}
		for (const row of rows.runs) this.recoveredRuns.set(row.run, row);
		for (const row of rows.segments) this.recoveredSegments.set(row.segment, row);
		// 既往会话的效果行：facts/verifications 都是已提交事实，装入队列供 ctx.verify 复查（G4）。
		for (const row of rows.effects) this.queue.restoreEffect(row);
		// §4.4 恢复表（I1 子集）：未终结 Run——有停止意图 → cancelled；否则 unknown；
		// 旧控制退役不明 → control unknown。追加为新的不可变截面。
		const unfinished = rows.runs.filter((r) => r.phase !== "finished" && r.phase !== "awaiting_decision");
		for (const row of unfinished) {
			const stoppedByIntent = rows.stopIntents.some((si) => {
				let target: StopTarget;
				try {
					target = JSON.parse(si.target) as StopTarget;
				} catch {
					return false;
				}
				return (
					("run" in target && target.run === row.run) ||
					("request" in target &&
						(target.request === row.request_id ||
							(target.request !== undefined && this.byRequestId.get(target.request)?.run === row.run)))
				);
			});
			const next: RunRow = {
				...row,
				revision: row.revision + 1,
				record: this.refs.record(),
				completion_ref: this.refs.completion(),
				phase: "finished",
				waiting: null,
				outcome:
					row.started !== 1
						? "not_started"
						: stoppedByIntent && this.opts.oldControlRetired === true
							? "cancelled"
							: "unknown",
				value: null,
				error: stoppedByIntent
					? null
					: JSON.stringify({
							code: "runtime_restart",
							message: "recovered unfinished run after restart; the effect tail may be missing",
						}),
				control: this.opts.oldControlRetired === true ? "stopped" : "unknown",
			};
			this.queue.enqueue({ kind: "run", row: next });
			this.recoveredRuns.set(row.run, next);
		}
	}

	// ---- 受理（§2.1，I1 子集） ----
	private serializeAdmission<T>(work: () => Promise<T>): Promise<T> {
		const result = this.admissionTail.then(work);
		this.admissionTail = result.catch(() => {});
		return result;
	}
	private async commitAdmission(
		origin: Origin,
		requestId: Ref,
		mutations: ApplyItem["mutation"][],
		continuation?: import("./runtime-db-worker.js").AdmissionCommand["continuation"],
		scheduling?: { replacements?: string[]; preemption?: string },
	): Promise<void> {
		if (this.opts.commitAdmission)
			await this.opts.commitAdmission({
				owner: origin.worldOwner,
				requestId,
				gateRevision: this.owner.state().gateRevision,
				mutations,
				continuation,
				...scheduling,
			});
		else {
			this.queue.enqueueAll(mutations);
			await this.queue.flushThrough(this.queue.capture());
		}
	}
	continue(origin: Origin, request: ContinueRequest): Promise<Acceptance> {
		const key = submissionKey(origin.worldOwner, request.requestId);
		const captured = {
			...(plain(request) as unknown as ContinueRequest),
			environment: request.environment ?? ("inherit" as const),
		};
		const intent = canonicalJson(plain(captured));
		const pending = this.pendingSubmissions.get(key);
		if (pending)
			return pending.intent === intent
				? pending.promise
				: Promise.resolve({
						kind: "not_accepted",
						requestId: request.requestId,
						code: "REQUEST_CONFLICT",
						message: "requestId is preparing another intent",
					});
		const promise = this.serializeAdmission(() => this.continuePrepared(origin, captured, intent)).catch(
			(error): Acceptance => {
				this.uncertainSubmissions.add(key);
				return { kind: "unknown", requestId: request.requestId, reason: String(error) };
			},
		);
		this.pendingSubmissions.set(key, { intent, promise });
		void promise.finally(() => this.pendingSubmissions.delete(key));
		return promise;
	}
	private async continuePrepared(origin: Origin, request: ContinueRequest, intent: string): Promise<Acceptance> {
		const reject = (code: string, message: string): Acceptance => ({
			kind: "not_accepted",
			requestId: request.requestId,
			code,
			message,
		});
		const key = submissionKey(origin.worldOwner, request.requestId),
			prior = this.submissions.get(key) ?? this.byRequestId.get(request.requestId);
		if (this.submissionBarriers.has(request.requestId) || prior?.status === "cancelled")
			return reject("REQUEST_CANCELLED", "request was stopped before admission");
		if (prior) {
			if (prior.requestJson !== intent || prior.operation !== "continue")
				return reject("REQUEST_CONFLICT", "requestId already has another intent");
			if (prior.run && prior.segment)
				return {
					kind: "accepted",
					requestId: request.requestId,
					segment: prior.segment,
					snapshot: this.read(prior.run),
				};
			return reject(prior.error?.code ?? "REQUEST_CONFLICT", prior.error?.message ?? "request unavailable");
		}
		let generation: number;
		try {
			this.assertActionAllowed();
			generation = this.owner.capture(origin);
		} catch (error) {
			const f = toCallFailure(error);
			return reject(f.code, f.message);
		}
		const old = this.runs.get(request.run),
			row = this.recoveredRuns.get(request.run);
		const summary = old ? projectSummary(old) : row ? summaryFromRow(row) : undefined;
		if (summary?.phase !== "awaiting_decision" || summary.decision !== request.decision)
			return reject("DECISION_STALE", "decision is no longer pending");
		const previousSegment = row?.segment ? this.recoveredSegments.get(row.segment) : undefined;
		const environment =
			old?.environment ??
			(previousSegment?.environment ? JSON.parse(previousSegment.environment) : (this.opts.environment ?? null));
		if (
			request.environment !== "current" &&
			canonicalJson(plain(environment)) !== canonicalJson(plain(this.opts.environment ?? null))
		)
			return reject("WRONG_STATE", "inherited environment is no longer available; explicitly choose current");
		let callable: ResolvedInvocation;
		try {
			callable =
				request.entry.kind === "program"
					? await this.prepareProgram(await this.requireProgram().resolve(request.entry.source), request.run)
					: await this.resolveCallable(request.entry.selector, request.run);
			this.validateInput(callable, request.entry.input);
			this.owner.assertGeneration(origin, generation);
		} catch (error) {
			const f = toCallFailure(error);
			return reject(f.code, f.message);
		}
		if (this.submissionBarriers.has(request.requestId))
			return reject("REQUEST_CANCELLED", "request stopped during preparation");
		if (old?.stopped || this.read(request.run).phase !== "awaiting_decision")
			return reject("DECISION_STALE", "decision was stopped during preparation");
		const decisionRequest = (old?.decisionRequest ?? JSON.parse(row!.decision!).request) as DecisionRequest;
		const wait = decisionRequest.wait;
		// 有待恢复的持久挂起时，入口必须是挂起的那一个：换能力等于把它不认识的检查点喂进去
		// （smelt 的炉位交给 craft 会重新装料），Program 入口同理不能接这份检查点。
		// 没有 wait 的普通决策不受限——Host 有权决定"不接着写，改做别的"。
		if (wait != null && callable.kind !== "native")
			return reject("CHECKPOINT_INVALID", "a durable native wait cannot be resumed by a program entry");
		if (wait != null && wait.resume.selector !== callable.ref)
			return reject("CHECKPOINT_INVALID", `the pending durable wait belongs to ${wait.resume.selector}`);
		const checkpoint = callable.kind === "program" ? decisionRequest.checkpoint : null;
		const segment = this.refs.segment(),
			abort = new AbortController();
		const state: RunState = {
			run: request.run,
			everStarted: old?.everStarted ?? old?.started ?? row?.started === 1,
			owner: origin.worldOwner,
			requestId: summary.rootRequestId,
			segmentRequestId: request.requestId,
			segment,
			segmentRecord: this.refs.record(),
			rootCall: this.createCallState(
				request.run,
				segment,
				this.refs.call(),
				this.refs.record(),
				null,
				callable,
				request.entry.input,
			),
			callable,
			request: { requestId: request.requestId, entry: request.entry, schedule: { kind: "enqueue" } },
			requestJson: intent,
			revision: summary.revision + 1,
			phase: "queued",
			outcome: null,
			value: null,
			error: null,
			completionRef: null,
			control: "none",
			unknownEffects: [...summary.unknownEffects],
			interruptedChildren: [],
			record: this.refs.record(),
			progress: {},
			stopped: false,
			abort,
			awaitingBody: 0,
			waiters: old?.waiters ?? new Set(),
			checkpoint,
			...(wait != null ? { durableWait: wait } : {}),
			environment: request.environment === "current" ? (this.opts.environment ?? null) : environment,
		};
		if (this.opts.program)
			state.programScope = this.opts.program.openSegment({
				run: state.run,
				segment,
				signal: abort.signal,
				...(callable.kind === "program" ? { entry: callable.program } : {}),
			});
		abort.signal.addEventListener("abort", () => state.rootCall.abort.abort(), { once: true });
		const submission: SubmissionState = {
			operation: "continue",
			owner: origin.worldOwner,
			requestId: request.requestId,
			status: "accepted",
			run: state.run,
			segment,
			record: state.record,
			requestJson: intent,
			error: null,
		};
		try {
			await this.commitAdmission(
				origin,
				request.requestId,
				[
					{
						kind: "submission",
						row: {
							owner: origin.worldOwner,
							request_id: request.requestId,
							status: "accepted",
							operation: "continue",
							run: state.run,
							segment,
							request: JSON.stringify(request),
							origin: JSON.stringify(origin),
							record: state.record,
							error: null,
						},
					},
					this.segmentMutation(state),
					this.callMutation(state.rootCall),
					this.runMutation(state),
				],
				{ run: state.run, decision: request.decision, revision: summary.revision },
			);
		} catch (error) {
			await state.programScope?.close("failed");
			const e = error as { code?: string; message: string; acknowledged?: boolean };
			if (e.acknowledged && e.code) return reject(e.code, e.message);
			throw error;
		}
		this.runs.set(state.run, state);
		this.recoveredRuns.delete(state.run);
		this.submissions.set(key, submission);
		this.byRequestId.set(request.requestId, submission);
		if (old?.stopped || this.stoppedRuns.has(state.run) || this.submissionBarriers.has(request.requestId))
			this.sealRun(state);
		const execution = this.runRun(state);
		this.activeRuns.add(execution);
		void execution.finally(() => this.activeRuns.delete(execution));
		return { kind: "accepted", requestId: request.requestId, segment, snapshot: projectSummary(state) };
	}

	submit(origin: Origin, request: RunRequest): Promise<Acceptance> {
		const key = submissionKey(origin.worldOwner, request.requestId);
		const intent = canonicalJson(plain({ entry: request.entry, schedule: request.schedule }));
		const pending = this.pendingSubmissions.get(key);
		if (pending != null) {
			if (pending.intent !== intent)
				return Promise.resolve({
					kind: "not_accepted",
					requestId: request.requestId,
					code: "REQUEST_CONFLICT",
					message: "requestId is preparing a different intent",
				});
			return pending.promise;
		}
		const promise = this.serializeAdmission(() => this.submitPrepared(origin, request)).catch(
			(err: unknown): Acceptance => {
				this.uncertainSubmissions.add(key);
				return { kind: "unknown", requestId: request.requestId, reason: String(err) };
			},
		);
		this.pendingSubmissions.set(key, { intent, promise });
		void promise.finally(() => this.pendingSubmissions.delete(key));
		return promise;
	}

	private async submitPrepared(origin: Origin, request: RunRequest): Promise<Acceptance> {
		const owner = origin.worldOwner;
		const key = submissionKey(owner, request.requestId);
		const intentJson = canonicalJson(plain({ entry: request.entry, schedule: request.schedule }));
		// 持久撤销屏障（§4.4）
		if (
			this.submissionBarriers.has(request.requestId) &&
			this.byRequestId.get(request.requestId)?.status === "cancelled"
		) {
			return {
				kind: "not_accepted",
				requestId: request.requestId,
				code: "REQUEST_CANCELLED",
				message: "a durable stop barrier exists for this requestId",
			};
		}
		const existing = this.submissions.get(key);
		if (existing != null) {
			if (existing.requestJson !== intentJson) {
				return {
					kind: "not_accepted",
					requestId: request.requestId,
					code: "REQUEST_CONFLICT",
					message: "requestId already accepted with a different intent",
				};
			}
			if (this.uncertainSubmissions.has(key))
				return { kind: "unknown", requestId: request.requestId, reason: "acceptance commit could not be confirmed" };
			if (existing.status === "rejected" && existing.error != null) {
				return { kind: "not_accepted", requestId: request.requestId, ...existing.error };
			}
			if (existing.status === "cancelled") {
				return {
					kind: "not_accepted",
					requestId: request.requestId,
					code: "REQUEST_CANCELLED",
					message: "requestId was stopped before acceptance",
				};
			}
			const state = existing.run != null ? this.runs.get(existing.run) : undefined;
			if (state != null) {
				return {
					kind: "accepted",
					requestId: request.requestId,
					segment: existing.segment ?? "",
					snapshot: projectSummary(state),
				};
			}
			const recovered = existing.run != null ? this.recoveredRuns.get(existing.run) : undefined;
			if (recovered != null && existing.segment != null) {
				return {
					kind: "accepted",
					requestId: request.requestId,
					segment: existing.segment,
					snapshot: summaryFromRow(recovered),
				};
			}
			return { kind: "unknown", requestId: request.requestId, reason: "accepted submission without a readable run" };
		}
		let generation: number;
		try {
			this.assertActionAllowed();
			generation = this.owner.capture(origin);
		} catch (err) {
			const failure = toCallFailure(err);
			return { kind: "not_accepted", requestId: request.requestId, code: failure.code, message: failure.message };
		}
		// 准备材料（§2.1 步骤 2）：解析 + 校验，失败不受理（确定性错误）
		const run = this.refs.run();
		let callable: ResolvedInvocation;
		try {
			callable =
				request.entry.kind === "program"
					? await this.prepareProgram(await this.requireProgram().resolve(request.entry.source), run)
					: await this.resolveCallable(request.entry.selector, run);
		} catch (err) {
			const failure = toCallFailure(err);
			return this.rejectSubmission(owner, request, intentJson, { code: failure.code, message: failure.message });
		}
		try {
			this.validateInput(callable, request.entry.input);
		} catch (err) {
			const failure = toCallFailure(err);
			return this.rejectSubmission(owner, request, intentJson, { code: failure.code, message: failure.message });
		}
		// 唯一受理映射 + 初始记录
		const segment = this.refs.segment();
		const call = this.refs.call();
		const runRecord = this.refs.record();
		const segmentRecord = this.refs.record();
		const callRecord = this.refs.record();
		const state: RunState = {
			run,
			owner,
			caller: origin.caller,
			requestId: request.requestId,
			segment,
			segmentRecord,
			rootCall: this.createCallState(run, segment, call, callRecord, null, callable, request.entry.input),
			callable,
			request,
			requestJson: intentJson,
			revision: 1,
			phase: "queued",
			outcome: null,
			value: null,
			error: null,
			completionRef: null,
			control: "none",
			unknownEffects: [],
			interruptedChildren: [],
			record: runRecord,
			progress: {},
			stopped: false,
			abort: new AbortController(),
			awaitingBody: 0,
			waiters: new Set(),
		};

		if (this.opts.program)
			state.programScope = this.opts.program.openSegment({
				run,
				segment,
				signal: state.abort.signal,
				...(callable.kind === "program" ? { entry: callable.program } : {}),
			});
		// Preparation awaited file/Worker I/O. A concurrent stop must still prevent acceptance.
		if (this.submissionBarriers.has(request.requestId)) {
			this.runs.delete(run);
			await state.programScope?.close("stop");
			return {
				kind: "not_accepted",
				requestId: request.requestId,
				code: "REQUEST_CANCELLED",
				message: "request stopped during preparation",
			};
		}
		try {
			this.owner.assertGeneration(origin, generation);
		} catch (e) {
			this.runs.delete(run);
			await state.programScope?.close("stop");
			const f = toCallFailure(e);
			return this.rejectSubmission(owner, request, intentJson, { code: f.code, message: f.message });
		}
		// run 取消级联到根调用（§4.4 stop：内存关门先撤销控制）
		state.abort.signal.addEventListener("abort", () => state.rootCall.abort.abort(), { once: true });
		const submission: SubmissionState = {
			owner,
			requestId: request.requestId,
			status: "accepted",
			run,
			segment,
			record: runRecord,
			requestJson: intentJson,
			error: null,
		};
		const schedule = request.schedule;
		let replaced: RunState[] = [];
		let preempted: RunState | undefined;
		if (schedule.kind === "replace_pending") {
			if (!schedule.targets && !origin.caller) {
				await state.programScope?.close("failed");
				return this.rejectSubmission(owner, request, intentJson, {
					code: "REPLACE_SCOPE_REQUIRED",
					message: "explicit targets are required without a trusted caller",
				});
			}
			replaced = schedule.targets
				? schedule.targets.map((ref) => this.runs.get(ref)!).filter(Boolean)
				: [...this.runs.values()].filter(
						(r) =>
							r.owner === owner &&
							r.caller === origin.caller &&
							!r.started &&
							!r.everStarted &&
							!r.stopped &&
							r.phase !== "finished",
					);
			if (
				(schedule.targets &&
					(new Set(schedule.targets).size !== schedule.targets.length ||
						replaced.length !== schedule.targets.length)) ||
				replaced.some((r) => r.owner !== owner || r.started || r.everStarted || r.stopped || r.phase === "finished")
			) {
				await state.programScope?.close("failed");
				return this.rejectSubmission(owner, request, intentJson, {
					code: "REPLACE_TARGET_INVALID",
					message: "every replacement target must be an owned never-started run",
				});
			}
		}
		if (schedule.kind === "preempt_current") {
			preempted = this.runs.get(schedule.expectedRun);
			if (!preempted || preempted.owner !== owner || preempted.control !== "active" || preempted.stopped) {
				await state.programScope?.close("failed");
				return this.rejectSubmission(owner, request, intentJson, {
					code: "CONTROL_CHANGED",
					message: "expectedRun does not own current control",
				});
			}
		}
		const mutations: ApplyItem["mutation"][] = [
			{
				kind: "submission",
				row: {
					owner,
					request_id: request.requestId,
					status: "accepted",
					operation: "submit",
					segment,
					run,
					request: JSON.stringify(plain(request)),
					origin: JSON.stringify(plain(origin)),
					record: runRecord,
					error: null,
				},
			},
			this.runMutation(state),
			this.segmentMutation(state),
			this.callMutation(state.rootCall),
		];
		const replacedRows = replaced.map((old) => {
			const next = {
				...old,
				phase: "finished" as const,
				outcome: "not_started" as const,
				stopped: true,
				completionRef: this.refs.completion(),
				revision: old.revision + 1,
				record: this.refs.record(),
			};
			mutations.push({ kind: "run", row: runRowOf(next) });
			return next;
		});
		if (preempted)
			mutations.unshift({
				kind: "stop_intent",
				row: {
					record: this.refs.stopIntent(),
					stop_request_id: request.requestId,
					owner,
					target: JSON.stringify({ run: preempted.run }),
					control: "stopping",
					created_at: nowIso(),
				},
			});
		const releaseReservation = preempted ? this.bodyLeaseQueue.reserve() : () => {};
		try {
			await this.commitAdmission(origin, request.requestId, mutations, undefined, {
				replacements: replaced.map((r) => r.run),
				preemption: preempted?.run,
			});
		} catch (error) {
			releaseReservation();
			await state.programScope?.close("failed");
			const f = error as { code?: string; message: string; acknowledged?: boolean };
			if (f.acknowledged && f.code) {
				const rejected: SubmissionState = {
					owner,
					requestId: request.requestId,
					status: "rejected",
					run: null,
					segment: null,
					record: null,
					requestJson: intentJson,
					error: { code: f.code, message: f.message },
				};
				this.submissions.set(key, rejected);
				this.byRequestId.set(request.requestId, rejected);
				return { kind: "not_accepted", requestId: request.requestId, code: f.code, message: f.message };
			}
			throw error;
		}
		this.runs.set(run, state);
		this.submissions.set(key, submission);
		this.byRequestId.set(request.requestId, submission);
		for (let i = 0; i < replaced.length; i++) {
			const old = replaced[i]!;
			Object.assign(old, replacedRows[i]);
			if (old.completionRef) this.segmentCompletions.set(old.segment, old.completionRef);
			old.abort.abort();
			await old.programScope?.close("stop");
			this.notifyResult(old);
		}
		if (preempted) {
			this.sealRun(preempted);
			this.bodyLeaseQueue.prioritize(state.run);
			await preempted.rootCall.settled;
			state.priorityRelease = releaseReservation;
		} else releaseReservation();
		this.runs.set(run, state);
		this.submissions.set(key, submission);
		this.byRequestId.set(request.requestId, submission);
		if (this.submissionBarriers.has(request.requestId)) this.sealRun(state);
		try {
			this.owner.assertGeneration(origin, generation);
		} catch {
			this.sealRun(state);
		}
		const execution = this.runRun(state);
		this.activeRuns.add(execution);
		void execution.finally(() => this.activeRuns.delete(execution));
		return { kind: "accepted", requestId: request.requestId, segment, snapshot: projectSummary(state) };
	}

	private rejectSubmission(
		owner: Ref,
		request: RunRequest,
		intentJson: string,
		error: { code: string; message: string },
	): Acceptance {
		const record = this.refs.record();
		const submission: SubmissionState = {
			owner,
			requestId: request.requestId,
			status: "rejected",
			run: null,
			segment: null,
			record,
			requestJson: intentJson,
			error,
		};
		this.submissions.set(submissionKey(owner, request.requestId), submission);
		this.byRequestId.set(request.requestId, submission);
		this.queue.enqueue({
			kind: "submission",
			row: {
				owner,
				request_id: request.requestId,
				status: "rejected",
				operation: null,
				segment: null,
				run: null,
				request: JSON.stringify(plain(request)),
				origin: "{}",
				record,
				error: JSON.stringify(error),
			},
		});
		return { kind: "not_accepted", requestId: request.requestId, ...error };
	}

	// ---- 查询面 ----

	lookup(requestId: Ref): SubmissionLookup {
		const key = submissionKey(this.opts.worldOwner, requestId);
		if (this.pendingSubmissions.has(key) || this.uncertainSubmissions.has(key))
			return { kind: "unavailable", reason: "submission commit is not confirmed" };
		const submission = this.byRequestId.get(requestId);
		if (submission == null) return { kind: "not_found", requestId };
		if (submission.status === "cancelled") {
			return { kind: "cancelled", requestId, record: submission.record ?? requestId };
		}
		if (submission.status === "rejected" || submission.run == null || submission.segment == null) {
			// 被拒准备无 Run 可寻；重放同键 submit 可得原拒绝（§2.1 幂等）。
			return { kind: "not_found", requestId };
		}
		const live = this.runs.get(submission.run);
		const snapshot = live != null ? projectSummary(live) : this.summaryFromRecovered(submission.run);
		if (snapshot == null) return { kind: "unavailable", reason: `run ${submission.run} record not readable` };
		const completionRef = this.segmentCompletions.get(submission.segment);
		return {
			kind: "found",
			requestId,
			operation: submission.operation ?? "submit",
			segment: submission.segment,
			snapshot,
			...(completionRef
				? { completionRef }
				: (snapshot.phase === "finished" || snapshot.phase === "awaiting_decision") &&
						snapshot.segment === submission.segment
					? { completionRef: snapshot.completionRef }
					: {}),
		};
	}

	read(run: Ref): RunSummary {
		const live = this.runs.get(run);
		if (live != null) return projectSummary(live);
		const summary = this.summaryFromRecovered(run);
		if (summary == null) {
			throw callFailure({
				code: "NOT_FOUND",
				source: "world",
				message: `run ${run} is not known to this runtime`,
				dispatch: "not_sent",
				effects: [],
				recoverable: false,
			});
		}
		return summary;
	}

	async wait(
		run: Ref,
		options: { afterRevision?: number; timeoutMs?: number } | undefined,
		signal: AbortSignal | undefined,
	): Promise<RunWaitReply> {
		const live = this.runs.get(run);
		if (live == null) {
			const recovered = this.summaryFromRecovered(run);
			if (recovered == null) {
				throw callFailure({
					code: "NOT_FOUND",
					source: "world",
					message: `run ${run} is not known to this runtime`,
					dispatch: "not_sent",
					effects: [],
					recoverable: false,
				});
			}
			return recovered.phase === "finished" || recovered.phase === "awaiting_decision"
				? { kind: "result", snapshot: recovered }
				: { kind: "changed", snapshot: recovered };
		}
		const snapshot = projectSummary(live);
		if (snapshot.phase === "finished" || snapshot.phase === "awaiting_decision") {
			return { kind: "result", snapshot };
		}
		if (options?.afterRevision != null && live.revision > options.afterRevision) {
			return { kind: "changed", snapshot };
		}
		return new Promise<RunWaitReply>((resolve, reject) => {
			let done = false;
			const waiter: RunWaiter = {
				mode: options?.afterRevision != null ? "changed" : "result",
				resolve: (reply) => {
					if (done) return;
					done = true;
					cleanup();
					resolve(reply);
				},
			};
			const timer =
				options?.timeoutMs != null
					? setTimeout(() => {
							if (done) return;
							done = true;
							cleanup();
							resolve({ kind: "timeout", snapshot: projectSummary(live) });
						}, options.timeoutMs)
					: null;
			const onAbort = () => {
				if (done) return;
				done = true;
				cleanup();
				const err = new Error("wait aborted");
				err.name = "AbortError";
				reject(err);
			};
			const cleanup = () => {
				live.waiters.delete(waiter);
				if (timer != null) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			live.waiters.add(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	// ---- 停止（§4.4：先内存关门，再持久 stop_intent） ----

	async stop(command: StopCommand): Promise<StopReceipt> {
		const target = command.target;
		let runRef = "run" in target ? target.run : null;
		const requestTarget = "request" in target ? target.request : null;
		let state: RunState | undefined;
		if (runRef != null) state = this.runs.get(runRef);
		if (state == null && requestTarget != null) {
			const submission = this.byRequestId.get(requestTarget);
			if (submission != null) {
				if (submission.status === "cancelled") {
					return {
						requestId: command.requestId,
						target,
						record: submission.record,
						intent: "durable",
						control: "stopped",
						snapshot: null,
					};
				}
				if (submission.run != null) {
					runRef = submission.run;
					state = this.runs.get(submission.run);
				}
			}
		}
		if (runRef != null) this.stoppedRuns.add(runRef);
		if (state == null && requestTarget != null && runRef == null) {
			// 未受理：持久撤销屏障（§4.4），lookup=cancelled，无虚构 Run。
			const record = this.refs.stopIntent();
			const row: StopIntentRow = {
				record,
				stop_request_id: command.requestId,
				owner: this.opts.worldOwner,
				target: JSON.stringify(plain(target)),
				control: "stopped",
				created_at: nowIso(),
			};
			this.stopIntentRows.set(record, row);
			const submission: SubmissionState = {
				owner: this.opts.worldOwner,
				requestId: requestTarget,
				status: "cancelled",
				run: null,
				segment: null,
				record,
				requestJson: JSON.stringify(plain({ requestId: requestTarget })),
				error: null,
			};
			this.byRequestId.set(requestTarget, submission);
			this.submissionBarriers.add(requestTarget);
			this.queue.enqueueAll([
				{ kind: "stop_intent", row },
				{
					kind: "submission",
					row: {
						owner: this.opts.worldOwner,
						request_id: requestTarget,
						status: "cancelled",
						operation: null,
						segment: null,
						run: null,
						request: submission.requestJson,
						origin: "{}",
						record,
						error: null,
					},
				},
			]);
			let intent: "durable" | "unknown" = "unknown";
			try {
				await this.queue.flushThrough(this.queue.capture());
				intent = "durable";
			} catch {
				// 持久失败仍保持内存关闭；不声称跨重启保证（§4.4）
			}
			return { requestId: command.requestId, target, record, intent, control: "stopped", snapshot: null };
		}
		if (state == null && runRef != null) {
			// 恢复截面中的 Run 已持久终结：stop 不改历史，如实回执（§4.4）
			const recovered = this.recoveredRuns.get(runRef);
			if (recovered != null) {
				if (recovered.phase === "awaiting_decision") {
					const intent: StopIntentRow = {
						record: this.refs.stopIntent(),
						stop_request_id: command.requestId,
						owner: this.opts.worldOwner,
						target: JSON.stringify(target),
						control: "stopped",
						created_at: nowIso(),
					};
					const next = {
						...recovered,
						phase: "finished",
						outcome: "cancelled",
						completion_ref: this.refs.completion(),
						control: "stopped",
						revision: recovered.revision + 1,
						record: this.refs.record(),
					};
					this.recoveredRuns.set(runRef, next);
					this.queue.enqueueAll([
						{ kind: "stop_intent", row: intent },
						{ kind: "run", row: next },
					]);
					await this.queue.flushThrough(this.queue.capture());
					return {
						requestId: command.requestId,
						target,
						record: next.record,
						intent: "durable",
						control: "stopped",
						snapshot: summaryFromRow(next),
					};
				}
				return {
					requestId: command.requestId,
					target,
					record: recovered.record,
					intent: "durable",
					control: "stopped",
					snapshot: summaryFromRow(recovered),
				};
			}
		}
		if (state == null) {
			return {
				requestId: command.requestId,
				target,
				record: null,
				intent: "unknown",
				control: "unknown",
				snapshot: null,
				error: { code: "NOT_FOUND", message: "target run not found" },
			};
		}
		if (state.phase === "finished") {
			// finished Run 不被 stop 改历史（§4.4）
			return {
				requestId: command.requestId,
				target,
				record: state.record,
				intent: "durable",
				control: "stopped",
				snapshot: projectSummary(state),
			};
		}
		const wasDecision = state.phase === "awaiting_decision";
		// 用户 Stop 是明确的撤销发起点：先写一次不可变起因，再关门。
		this.retire(state.run, this.notice("user_stop", "host:stop", state.run));
		// 内存关门：封闭准入、删除 Body 队列申请、撤销控制
		state.stopped = true;
		state.phase = "stopping";
		state.revision++;
		if (state.control === "active") state.control = "stopping";
		else if (state.control === "none") state.control = "stopped";
		this.bodyLeaseQueue.cancelRun(state.run);
		state.abort.abort();
		this.releasePriority(state);
		this.notifyChanged(state);
		// 持久 stop_intent
		const record = this.refs.stopIntent();
		const row: StopIntentRow = {
			record,
			stop_request_id: command.requestId,
			owner: this.opts.worldOwner,
			target: JSON.stringify(plain(target)),
			control: state.control,
			created_at: nowIso(),
		};
		this.stopIntentRows.set(record, row);
		if (wasDecision) {
			state.phase = "finished";
			state.outcome = "cancelled";
			state.completionRef = this.refs.completion();
			state.control = "stopped";
		}
		this.queue.enqueueAll([{ kind: "stop_intent", row }, this.runMutation(state)]);
		let intent: "durable" | "unknown" = "unknown";
		try {
			await this.queue.flushThrough(this.queue.capture());
			intent = "durable";
			if (wasDecision) this.notifyResult(state);
		} catch {
			// 数据库坏了仍实际停止（§4.4）
		}
		return {
			requestId: command.requestId,
			target,
			record,
			intent,
			control: state.control === "stopping" ? "stopping" : "stopped",
			snapshot: projectSummary(state),
		};
	}

	assertActionAllowed(): void {
		this.owner.assertAllowed();
		if (this.isolationFailed)
			throw callFailure({
				code: "CONTROL_ISOLATION_FAILED",
				source: "environment",
				message: "old control isolation could not be proved",
				dispatch: "not_sent",
				effects: [],
				recoverable: false,
			});
	}
	controlState(): StopReceipt["control"] {
		if (this.safety.inspect().active) return "stopping";
		if (this.isolationFailed || [...this.runs.values()].some((state) => state.control === "unknown")) return "unknown";
		return [...this.runs.values()].some((state) => state.phase !== "finished" && state.stopped)
			? "stopping"
			: "stopped";
	}
	private sealRun(state: RunState): void {
		state.stopped = true;
		state.rootCall.closed = true;
		if (state.phase !== "finished") state.phase = "stopping";
		if (state.control === "active") state.control = "stopping";
		this.bodyLeaseQueue.cancelRun(state.run);
		state.abort.abort();
		this.releasePriority(state);
	}
	private stopAll(): void {
		this.safety.cancel();
		const closing: Promise<void>[] = [];
		for (const state of this.runs.values()) {
			if (state.phase === "finished" || state.phase === "awaiting_decision" || state.stopped) continue;
			// stop performs its control closure before its first await.
			if (this.startedRuns.has(state.run)) closing.push(state.rootCall.settled);
			const stopping = this.stop({ requestId: this.refs.stopIntent(), target: { run: state.run } });
			this.stopBarriers.add(stopping);
			void stopping.finally(() => this.stopBarriers.delete(stopping));
		}
		if (closing.length !== 0) {
			const timer = setTimeout(() => {
				this.isolationFailed = true;
				this.opts.requireRetirement?.({
					source: "runtime",
					subject: null,
					code: "CONTROL_ISOLATION_FAILED",
					detail: "stopped calls did not retire within the control isolation deadline",
				});
			}, 2000);
			timer.unref();
			void Promise.all(closing).then(() => clearTimeout(timer));
		}
	}
	async invalidateControl(): Promise<void> {
		// 起因是连接身份变了：这条失效会由 connection/death 事件同时告诉模型，
		// 所以宿主侧可以据此省略重复提醒。其余失效路径没有这个承担者，必须自己上报。
		this.safety.cancel("invalidated", "connection");
		if (this.activeBody) {
			const active = this.activeBody;
			const notice = this.notice("disconnect", "host:invalidateControl", active.run);
			this.retire(active.run, notice);
			await active.interrupt(notice);
		} else {
			const id = this.bodyLeaseQueue.blockingCall();
			const call = id ? this.findLiveCall(id) : null;
			call?.abort.abort();
		}
	}
	// ---- 持久等待：落库形状与唤醒扫描（§5.9） ----
	//
	// 一个持久挂起就是"停在 awaiting_decision 但不等 Host 决策"：decision 列里带
	// `wait`，Runtime 自己按 earliestCheckAt 重查、按原能力入口续段。死线与次数
	// 预算都锚在第一次挂起上——反复 wake→check→wait 不重置它们，否则永远到不了头。

	private durableDecisionOf(state: RunState, suspend: DurableSuspendRequest, wait: DurableWait): DecisionRequest {
		return {
			code: "NEEDS_DECISION",
			reason: suspend.reason,
			checkpoint: null,
			origin: { call: state.rootCall.call, program: null, digest: state.callable.digest },
			wait,
		};
	}

	private durableWaitFor(state: RunState, suspend: DurableSuspendRequest): DurableWait | null {
		const previous = state.durableWait;
		const attempts = (previous?.attempts ?? 0) + 1;
		if (attempts > MAX_DURABLE_WAKE_ATTEMPTS) return null;
		const now = Date.now();
		// 静默预算是从"最后一次世界推进"起算的总预算，不是每次复查都续期。
		const lastProgressAt = previous?.lastProgressAt ?? new Date(now).toISOString();
		return {
			attempts,
			earliestCheckAt: new Date(now + Math.max(0, suspend.recheckAfterMs)).toISOString(),
			lastProgressAt,
			deadlineAt: new Date(Date.parse(lastProgressAt) + Math.max(0, suspend.deadlineAfterMs)).toISOString(),
			resume: { selector: state.callable.ref, input: plain(state.rootCall.input) },
			checkpoint: plain(suspend.checkpoint),
		};
	}

	/**
	 * 起唤醒扫描：recover 之后、ready 之前调用一次。定时器 unref 并随 shutdown 清理，
	 * 不为一个"可能很久才到点"的等待拖住进程退役。扫描只做"到点再看一眼"，
	 * 单次认领仍由 continue 的受理 CAS 保证。
	 */
	startDurableWakes(intervalMs = 1000): void {
		if (this.wakeTimer != null || this.wakeClosed) return;
		this.wakeTimer = setInterval(() => void this.recheckDurableWaits(), intervalMs);
		this.wakeTimer.unref();
		void this.recheckDurableWaits();
	}

	/** 复查所有到点的持久等待，各认领一次续段；返回本轮真正受理的唤醒数。 */
	async recheckDurableWaits(now = new Date()): Promise<number> {
		if (this.wakeScanning || this.wakeClosed) return 0;
		this.wakeScanning = true;
		try {
			const due = this.dueWaits(now);
			if (due.length === 0) return 0;
			// 没有合法绑定就没有可信 Origin：等 Host 重新 attach 并开门，下一轮再试。
			const owner = this.owner.state();
			if (owner.activation === "" || owner.gates.length !== 0) return 0;
			const origin: Origin = { worldOwner: this.opts.worldOwner, activation: owner.activation };
			let claimed = 0;
			for (const item of due) {
				const acceptance = await this.continue(origin, {
					run: item.run,
					decision: item.decision,
					requestId: `${item.run}~wake~${item.revision}`,
					entry: { kind: "call", selector: item.wait.resume.selector, input: item.wait.resume.input },
					environment: "inherit",
				});
				if (acceptance.kind === "accepted") claimed++;
				else if (acceptance.kind === "unknown")
					console.error(`[mc-runtime] durable wake for ${item.run} was not confirmed: ${acceptance.reason}`);
			}
			return claimed;
		} finally {
			this.wakeScanning = false;
		}
	}

	private dueWaits(now: Date): { run: Ref; decision: Ref; revision: number; wait: DurableWait }[] {
		const at = now.toISOString();
		const due: { run: Ref; decision: Ref; revision: number; wait: DurableWait }[] = [];
		for (const state of this.runs.values()) {
			const wait = state.phase === "awaiting_decision" ? state.decisionRequest?.wait : undefined;
			if (wait == null || state.decision == null || state.stopped || wait.earliestCheckAt > at) continue;
			due.push({ run: state.run, decision: state.decision, revision: state.revision, wait });
		}
		for (const row of this.recoveredRuns.values()) {
			if (row.phase !== "awaiting_decision" || row.decision == null) continue;
			const parsed = parseWait(row.decision);
			if (parsed == null || parsed.wait.earliestCheckAt > at) continue;
			due.push({ run: row.run, decision: parsed.decision, revision: row.revision, wait: parsed.wait });
		}
		return due;
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise != null) return this.shutdownPromise;
		this.wakeClosed = true;
		if (this.wakeTimer != null) clearInterval(this.wakeTimer);
		this.wakeTimer = null;
		this.owner.shutdown();
		this.shutdownPromise = (async () => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const complete = Promise.all([...this.pendingSubmissions.values()].map((item) => item.promise)).then(async () => {
				await this.safety.close();
				await Promise.all([...this.activeRuns, ...this.stopBarriers]);
				await this.chatGate;
			});
			try {
				await Promise.race([
					complete,
					new Promise<never>((_, reject) => {
						timeout = setTimeout(() => reject(new Error("active execution did not retire during shutdown")), 2000);
					}),
				]);
				if (this.isolationFailed) throw new Error("control isolation could not be proved");
			} catch (err) {
				this.isolationFailed = true;
				this.opts.requireRetirement?.({
					source: "runtime",
					subject: null,
					code: "EXECUTION_DOMAIN_UNRETIRED",
					detail: String(err),
				});
				throw err;
			} finally {
				if (timeout != null) clearTimeout(timeout);
			}
		})();
		return this.shutdownPromise;
	}

	// ---- 能力接入接缝（组合根注入能力实现） ----

	/**
	 * chat 旁路（不占 Body）：归属取当前调用 frame，串行化保证归属槽无竞争。
	 */
	async chat(text: string, signal: AbortSignal): Promise<EffectReceipt> {
		const frame = this.als.getStore();
		if (frame == null) {
			throw callFailure({
				code: "INTERNAL",
				source: "capability",
				message: "chat requires an active call frame (use runtime.act.chat inside a callable)",
				dispatch: "not_sent",
				effects: [],
				recoverable: false,
			});
		}
		const owner: ControlOwner = {
			kind: "run",
			run: frame.call.run,
			segment: frame.call.segment,
			callId: frame.call.call,
		};
		const previous = this.chatGate;
		let release: () => void = () => {};
		this.chatGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			this.assertActionAllowed();
			if (frame.call.closed || frame.call.abort.signal.aborted || signal.aborted)
				throw callFailure({
					code: "INTERRUPTED",
					source: "environment",
					message: "chat call is closed",
					dispatch: "not_sent",
					effects: [],
					recoverable: false,
				});
			return await this.queue.runWithChatOwner(owner, () => this.opts.playerPort.chat(text, signal));
		} finally {
			release();
		}
	}

	/** 受控独占导航（goto）作用域：独占期内效果事实归属给定 owner。 */
	async runNavigation<T>(owner: ControlOwner, fn: () => Promise<T>): Promise<T> {
		const frame = this.als.getStore();
		if (!frame || owner.kind !== "run" || owner.callId !== frame.call.call)
			throw this.scopeError("ACCESS_DENIED", "navigation requires the current call identity");
		this.assertCallLive(frame.call);
		const blocking = this.bodyLeaseQueue.blockingCall();
		if (
			frame.bodyLease ||
			(blocking &&
				(this.isDescendantCall(blocking, frame.call.call) || this.isDescendantCall(frame.call.call, blocking)))
		)
			throw this.scopeError("CONTROL_CONFLICT", "delegated body cannot start independent navigation");
		const state = this.runs.get(owner.run)!;
		this.prioritizeIfRequested(state);
		const pending = this.bodyLeaseQueue.requestNavigation(owner, owner.callId, frame.call.abort.signal);
		this.releasePriority(state);
		const grant = await pending;
		try {
			this.assertCallLive(frame.call);
			this.queue.setNavigationOwner(owner);
			state.control = "active";
			state.revision++;
			this.queue.enqueue(this.runMutation(state));
			return await fn();
		} finally {
			this.queue.setNavigationOwner(null);
			if (state.control === "active") {
				state.control = state.stopped ? "stopped" : "none";
				state.revision++;
				this.queue.enqueue(this.runMutation(state));
			}
			grant.release();
		}
	}

	// ---- 运行执行 ----

	private async runRun(state: RunState): Promise<void> {
		const root = state.rootCall;
		try {
			if (state.phase === "finished") return;
			await this.serializeAdmission(async () => {
				if (state.stopped || state.phase === "finished") return;
				state.started = true;
				state.everStarted = true;
				if (state.awaitingBody === 0) this.setPhase(state, "running");
				await this.queue.flushThrough(this.queue.capture());
			});
			if (projectSummary(state).phase === "finished") return;
			let rootThrew: CallFailure | null = null;
			let decision: DecisionRequest | undefined;
			let suspend: DurableSuspendRequest | undefined;
			try {
				this.startedRuns.add(state.run);
				await this.executeCallBody(root, state, null);
			} catch (err) {
				decision = getDecisionRequest(err);
				suspend = getSuspendRequest(err);
				if (!decision && suspend == null) rootThrew = toCallFailure(err);
			}
			await state.programScope?.close(state.stopped ? "stop" : decision ? "decide" : rootThrew ? "failed" : "finished");
			// §5.5 5-6：固定 H → flush → 终结论 → flush → 通知
			await this.queue.flushThrough(this.queue.capture());
			state.unknownEffects = this.queue.unknownEffectsFor(state.run);
			state.value = rootThrew == null ? root.value : null;
			state.error = rootThrew != null ? { code: rootThrew.code, message: rootThrew.message } : null;
			// 失败终态同样要带可信进度。调用侧在错误里点明了"做到哪一步"（collect 采到
			// 9/16 才放弃），丢掉它会让模型把半件事读成零件事、按 0 重做。
			if (rootThrew?.progress != null) state.progress = rootThrew.progress;
			// §5.6 五态：根调用结算 + 运行级控制未知 → unknown
			state.outcome =
				!state.started && !state.everStarted
					? "not_started"
					: state.control === "unknown"
						? "unknown"
						: (root.outcome ?? "unknown");
			state.completionRef = this.refs.completion();
			state.revision++;
			const parked = decision != null || suspend != null;
			state.phase = parked && !state.stopped ? "awaiting_decision" : "finished";
			if (parked && !state.stopped) {
				const wait = suspend == null ? undefined : this.durableWaitFor(state, suspend);
				if (suspend != null && wait == null) {
					// 挂起次数预算用尽：不再排新的唤醒，按 unknown 如实收口，不假装还在等。
					state.phase = "finished";
					state.outcome = "unknown";
					state.error = {
						code: "WAIT_BUDGET_EXHAUSTED",
						message: `durable wait exceeded ${MAX_DURABLE_WAKE_ATTEMPTS} wake attempts; the world condition never became observable`,
					};
				} else {
					state.decision = this.refs.record();
					state.decisionRequest = decision ?? this.durableDecisionOf(state, suspend!, wait!);
					state.checkpoint = decision?.checkpoint ?? null;
					if (wait != null) state.durableWait = wait;
					state.outcome = null;
					state.error = null;
				}
			}
			if (state.stopped && state.control !== "unknown") state.control = "stopped";
			this.queue.enqueueAll([this.segmentMutation(state), this.runMutation(state)]);
			await this.queue.flushThrough(this.queue.capture());
			if (!this.segmentCompletions.has(state.segment)) this.segmentCompletions.set(state.segment, state.completionRef);
			this.notifyResult(state);
		} catch (err) {
			// flush/commit 失败：控制已撤销，不得假称持久终结（§5.5 step 7）
			console.error(
				`[mc-runtime] run ${state.run} settlement failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			this.releasePriority(state);
		}
	}

	private async executeCallBody(callState: CallState, state: RunState, lease: BodyLease | null): Promise<JsonValue> {
		if (state.phase === "queued" && state.awaitingBody === 0) this.setPhase(state, "running");
		if (state.stopped && state.phase !== "finished") {
			state.phase = "stopping";
		}
		const ctx = this.buildContext(callState, state, lease);
		let value: JsonValue | undefined;
		let threw: CallFailure | null = null;
		let decision: DecisionRequest | undefined;
		let suspend: DurableSuspendRequest | undefined;
		try {
			this.assertActionAllowed();
			if (state.stopped || callState.abort.signal.aborted || callState.closed)
				throw callFailure({
					code: "INTERRUPTED",
					source: "environment",
					message: "call stopped before execution",
					dispatch: "not_sent",
					effects: [],
					recoverable: false,
				});
			const invocation = callState.callable;
			const raw = await this.als.run({ call: callState, bodyLease: lease }, async () => {
				if (invocation.kind === "native") {
					return invocation.native.invoke(ctx, callState.input);
				}
				const host = createProgramHost(ctx, callState.resources, (selector) =>
					this.byRef.has(selector) ? "act" : this.opts.queryRefs?.includes(selector) ? "read" : undefined,
				);
				for (const method of ["watch", "sleep"] as const) {
					const invoke = host[method];
					Object.assign(host, {
						[method]: (args: never) => {
							const result = invoke(args);
							this.releasePriority(state);
							return result;
						},
					});
				}
				const result = await state.programScope!.invoke({
					call: callState.call,
					program: invocation.program,
					input: callState.input,
					checkpoint: callState.parent === null && state.checkpoint?.kind === "program" ? state.checkpoint.value : null,
					signal: callState.abort.signal,
					host,
				});
				if (result.kind === "returned") return result.value;
				if (result.kind === "decision") throw createDecisionError(result.request);
				if ("scope" in result.failure) callState.diagnostic = result.failure;
				const f = result.failure;
				throw callFailure({
					...f,
					dispatch: "dispatch" in f ? f.dispatch : "not_sent",
					effects: "effects" in f ? f.effects : [],
					recoverable: "recoverable" in f ? f.recoverable : true,
				});
			});
			const validate = this.validatorFor(callState.callable.outputSchema, `${callState.callable.digest}:out`);
			if (!validate(raw)) {
				throw callFailure({
					code: "INTERNAL",
					source: "capability",
					message: `output validation failed for ${callState.callable.ref}`,
					dispatch: callState.effects.length > 0 ? "sent" : "not_sent",
					effects: [...callState.effects],
					recoverable: false,
				});
			}
			value = raw as JsonValue;
		} catch (err) {
			decision = getDecisionRequest(err);
			suspend = getSuspendRequest(err);
			if (!decision && suspend == null) threw = toCallFailure(err);
			// 挂起只对根原生调用成立：子调用挂起时父帧已经不在，恢复入口对不上，
			// 静默"续"会把检查点喂给错误的调用栈。如实拒绝，让调用方单独提交一次。
			if (suspend != null && callState.parent != null) {
				threw = callFailure({
					code: "SUSPEND_NOT_ROOT",
					source: "capability",
					message: `${callState.callable.ref} asked for a durable wait inside another call; submit it as its own run instead`,
					dispatch: callState.effects.length > 0 ? "sent" : "not_sent",
					effects: [...callState.effects],
					recoverable: false,
				});
				suspend = undefined;
			}
			// 非 interruptible 路径（例如 stop 让 scopedBody 先抛）也要带上真实撤销起因，
			// 不能让"谁拿走了身体"在 Call 记录里退化成一句 body scope retired。
			if (threw != null && (threw.code === "INTERRUPTED" || threw.code === "CANCELLED") && state.retiredBy != null) {
				const notice = state.retiredBy;
				threw = callFailure({
					code: threw.code,
					source: threw.source,
					message: `body scope retired by ${notice.cause} (${notice.initiator})`,
					hint: RETIREMENT_HINT[notice.cause],
					dispatch: threw.dispatch,
					effects: [...threw.effects],
					// 不改写业务 progress 快照：那是能力/程序自己的领域进度，
					// 控制层起因只放在 message/hint 与内存态 retiredBy 里。
					progress: threw.progress,
					recoverable: notice.cause === "safety",
				});
			}
		}
		// §4.3 关闭：封闭准入 → 取消/等待子 Call → 保存原因
		callState.closed = true;
		const cancelled = callState.closedByParent != null || state.stopped;
		const parked = decision != null || suspend != null;
		const reason = cancelled ? "cancelled" : parked ? "decision" : threw == null ? "returned" : "threw";
		// closed seals admissions; execution remains running until descendant cleanup settles.
		const strays = [...callState.children].filter((child) => child.execution === "running");
		for (const child of strays) {
			child.closedByParent = { call: callState.call, reason };
		}
		if (callState.parent == null) state.interruptedChildren = strays.map((child) => child.call);
		callState.abort.abort();
		await Promise.allSettled([...callState.resources].map((close) => close()));
		await Promise.all(strays.map((child) => child.settled));
		// §5.5 step 4：不可变完成截面入队（不逐 Call 等盘）
		const interrupted = callState.closedByParent != null || state.stopped;
		callState.execution = interrupted ? "interrupted" : parked ? "threw" : threw == null ? "returned" : "threw";
		callState.decisionRequest = decision;
		callState.effects = this.queue.effectsForCall(callState.call);
		if (interrupted) {
			callState.outcome = "cancelled";
			if (threw != null) callState.error = failureData(threw);
		} else if (parked) {
			callState.outcome = null;
		} else if (threw == null) {
			callState.value = value ?? null;
			callState.outcome = this.callHasUnknownEffects(callState) ? "unknown" : "succeeded";
		} else {
			callState.error = failureData(threw);
			callState.outcome = "failed";
		}
		this.queue.enqueue(this.callMutation(callState));
		callState.settledResolve();
		if (decision && !interrupted) throw createDecisionError(decision);
		if (suspend != null && !interrupted) throw createSuspendError(suspend);
		if (threw != null) throw threw;
		return value as JsonValue;
	}

	// ---- 子调用与上下文 ----

	private async invokeChild(
		parent: CallState,
		state: RunState,
		lease: BodyLease | null,
		selector: string,
		input: JsonValue,
	): Promise<JsonValue> {
		if (parent.closed) {
			throw callFailure({
				code: "INTERRUPTED",
				source: "capability",
				message: "parent call scope is closed; new admissions are sealed",
				dispatch: "not_sent",
				effects: [],
				recoverable: false,
			});
		}
		if (lease != null && lease.activeCall !== parent.call)
			throw this.scopeError("BODY_BUSY", "another delegation is active");
		const resolved = this.resolveCallable(selector, state.run, state);
		const callable = resolved instanceof Promise ? await resolved : resolved;
		this.validateInput(callable, input);
		this.assertCallLive(parent);
		if (lease != null && lease.activeCall !== parent.call)
			throw this.scopeError("BODY_BUSY", "another delegation is active");
		const call = this.refs.call();
		const record = this.refs.record();
		const child = this.createCallState(parent.run, parent.segment, call, record, parent, callable, input);
		parent.children.add(child);
		this.queue.enqueueAll([this.callMutation(child)]);
		if (lease == null) return this.executeCallBody(child, state, null);
		const previous = lease.activeCall;
		lease.activeCall = child.call;
		try {
			return await this.executeCallBody(child, state, lease);
		} finally {
			lease.activeCall = previous;
		}
	}

	private createCallState(
		run: Ref,
		segment: Ref,
		call: Ref,
		record: Ref,
		parent: CallState | null,
		callable: ResolvedInvocation,
		input: JsonValue,
	): CallState {
		let settledResolve: () => void = () => {};
		const settled = new Promise<void>((resolve) => {
			settledResolve = resolve;
		});
		const state: CallState = {
			call,
			run,
			segment,
			parent: parent?.call ?? null,
			record,
			callable,
			resources: new Set(),
			input,
			execution: "running",
			outcome: null,
			value: null,
			error: null,
			closedByParent: null,
			progress: {},
			effects: [],
			closed: false,
			abort: new AbortController(),
			children: new Set(),
			settled,
			settledResolve,
		};
		if (parent != null) {
			// 祖先取消级联（§3.2）
			parent.abort.signal.addEventListener("abort", () => state.abort.abort(), { once: true });
		}
		return state;
	}

	private buildContext(
		callState: CallState,
		state: RunState,
		lease: BodyLease | null,
	): CallContext & Partial<BodyCallScope> {
		const ctx = {
			run: callState.run,
			segment: callState.segment,
			callId: callState.call,
			signal: callState.abort.signal,
			progress: async (value: Progress) => {
				callState.progress = value;
				this.queue.enqueue(this.callMutation(callState));
				if (callState.parent == null) {
					state.progress = value;
					state.revision++;
					this.queue.enqueue(this.runMutation(state));
					this.notifyChanged(state);
				}
			},
			world: this.opts.world,
			// 只有根调用可能是持久挂起的重入；子调用拿到 null，避免把别人的检查点
			// 当成"我上次做到这里"。
			checkpoint: callState.parent == null ? (state.durableWait?.checkpoint ?? null) : null,
			call: async (selector: string, input: JsonValue) => this.invokeChild(callState, state, lease, selector, input),
			withBody: async <T>(work: (scope: BodyCallScope) => Promise<T>) =>
				this.runWithBody(callState, state, lease, work),
			verify: async (effect: Ref, verifier: Ref, input: JsonValue): Promise<EffectReceipt> =>
				this.verifyEffect(effect, verifier, input),
			...(lease != null ? { player: lease.session } : {}),
			// 写端口只在 body scope 内出现，且每次建立上下文都新建一份：
			// 绑定本 Call / 本 Lease / 建立时的连接身份，保存旧引用无法再发。
			...(lease != null && this.opts.protocol != null ? { protocol: this.scopedProtocol(callState, lease) } : {}),
		} as CallContext & Partial<BodyCallScope>;
		return ctx;
	}

	/**
	 * §6.1：每个持 Lease 的调用上下文一份专属写端口。绑定值在此定稿，之后每次
	 * send 由 createScopedProtocolWrite 逐次跑 assertLease 与身份一致性检查。
	 */
	private scopedProtocol(callState: CallState, lease: BodyLease): ProtocolWritePort {
		const dispatcher = this.opts.protocol;
		if (dispatcher == null) throw new Error("scoped protocol write requires a dispatcher");
		const identity = dispatcher.identity();
		const binding: ProtocolWriteBinding = {
			run: callState.run,
			segment: callState.segment,
			call: callState.call,
			body: lease.session.body,
			owner: { kind: "run", run: callState.run, segment: callState.segment, callId: callState.call },
			connection: identity?.connection ?? null,
			incarnation: identity?.incarnation ?? null,
		};
		return createScopedProtocolWrite({
			dispatcher,
			binding,
			guard: () => this.assertLease(callState, lease),
		});
	}

	/**
	 * ctx.verify（G4）：已注册核验器按效果事实 + 当前世界状态给出追加判断。
	 * append-only：EffectVerification 追加到原 Effect，原 completion 与历史报告不改写；
	 * 返回 receipt 是"该效果当前最新判断"（dispatch 沿用原事实，completion 取核验结论）。
	 */
	private async verifyEffect(effect: Ref, verifier: Ref, input: JsonValue): Promise<EffectReceipt> {
		const attribution = this.queue.effectRecord(effect);
		if (attribution == null) {
			throw callFailure({
				code: "NOT_FOUND",
				source: "capability",
				message: `effect ${effect} has no recorded facts in this runtime`,
				hint: "verify applies to effects this runtime has recorded (this session or restored from runtime.db)",
				dispatch: "not_sent",
				effects: [],
				recoverable: false,
			});
		}
		const impl = this.opts.verifiers?.get(verifier as import("../contracts/values.js").ExactRef);
		if (impl == null) {
			const known = [...(this.opts.verifiers?.keys() ?? [])].join(", ");
			throw callFailure({
				code: "NOT_FOUND",
				source: "capability",
				message: `verifier ${verifier} is not registered`,
				hint: known.length > 0 ? `registered verifiers: ${known}` : "no verifiers registered",
				dispatch: "not_sent",
				effects: [effect],
				recoverable: false,
			});
		}
		const verdict = await impl.check(
			{ effect, operation: attribution.operation, facts: attribution.facts },
			this.opts.world,
			input,
		);
		const verification: EffectVerification = {
			record: this.refs.record(),
			observedAt: nowIso(),
			verifier: verifier as import("../contracts/values.js").ExactRef,
			completion: verdict.completion,
			evidence: verdict.evidence,
			...(verdict.reason != null ? { reason: verdict.reason } : {}),
		};
		this.queue.appendVerification(effect, verification);
		return {
			effect,
			dispatch: attribution.latest.dispatch,
			completion: verdict.completion,
			evidence: verdict.evidence,
		};
	}

	// ---- 身体申请（§3.3.1 三种情况） ----

	/** G9：显式优先级 Run 的申请先于普通等待者入队（一次性原语，逐次申请重设；safety 仍最前）。 */
	private prioritizeIfRequested(state: RunState): void {
		const schedule = state.request.schedule;
		if (schedule.kind === "enqueue" && schedule.priority === true) this.bodyLeaseQueue.prioritize(state.run);
	}

	private async runWithBody<T>(
		callState: CallState,
		state: RunState,
		lease: BodyLease | null,
		work: (scope: BodyCallScope) => Promise<T>,
	): Promise<T> {
		this.assertActionAllowed();
		// 情况 a：委托谱系复用，重入不排队
		if (lease != null) {
			this.assertLease(callState, lease);
			return this.runBodyWork(callState, state, lease, work);
		}
		// 情况 c：本调用谱系后代持 Body（或正在 acquire）→ 派发申请前 CONTROL_CONFLICT
		const blocking = this.bodyLeaseQueue.blockingCall();
		if (
			blocking != null &&
			(this.isDescendantCall(blocking, callState.call) || this.isDescendantCall(callState.call, blocking))
		) {
			throw callFailure({
				code:
					callState.callable.kind === "program" ||
					(blocking !== callState.call && this.isDescendantCall(callState.call, blocking))
						? "BODY_SCOPE_ACTIVE"
						: "CONTROL_CONFLICT",
				source: "capability",
				message:
					"a descendant call of this scope currently holds the body; use the delegated scope instead of acquiring again",
				hint: "capture the BodyCallScope from withBody, or delegate via scope.call",
				dispatch: "not_sent",
				effects: [],
				recoverable: false,
			});
		}
		// 情况 a（独立）：FIFO 排队，只有选中项进入 Driver.acquire
		const owner: ControlOwner = {
			kind: "run",
			run: callState.run,
			segment: callState.segment,
			callId: callState.call,
		};
		state.awaitingBody++;
		let grant: BodyGrant;
		try {
			this.prioritizeIfRequested(state);
			const requested = this.bodyLeaseQueue.request(owner, callState.call, callState.abort.signal);
			this.releasePriority(state);
			grant = await requested;
		} catch (err) {
			state.awaitingBody--;
			throw err;
		}
		state.awaitingBody--;
		if (state.phase === "queued") this.setPhase(state, "running");
		state.control = "active";
		state.revision++;
		this.queue.enqueue(this.runMutation(state));
		const owned: BodyLease = {
			session: grant.session,
			activeCall: callState.call,
			closed: false,
			abort: new AbortController(),
		};
		let closing: Promise<void> | undefined;
		const close = (explicit?: ControlRetirementNotice): Promise<void> =>
			(closing ??= (async () => {
				owned.closed = true;
				// 真实发起点优先；否则读 stop()/safety 写下的那一次起因；都没有才 unknown。
				const retirement =
					explicit ??
					state.retiredBy ??
					(this.safety.inspect().active ? this.notice("safety", "runtime:safety", state.run) : undefined);
				owned.abort.abort(retirement);
				// §3.3.2 外层退出：等 close 屏障完成才发下一项；清理事实先入队
				try {
					await grant.session.close();
				} catch (err) {
					state.control = "unknown";
					this.isolationFailed = true;
					this.opts.requireRetirement?.({
						source: "runtime",
						subject: state.run,
						code: "CONTROL_ISOLATION_FAILED",
						detail: String(err),
					});
				}
				// release 之后队列才授予下一项；归属槽由队列的 onRelease 清空
				grant.release();
				// 释放后不再持有控制；stop 期间保持 stop() 设置的 stopping（finish 时落 stopped）
				if (state.control === "active" && !state.stopped) {
					state.control = "none";
				}
				state.revision++;
				this.queue.enqueue(this.runMutation(state));
			})());
		const active = { run: state.run, interrupt: (notice?: ControlRetirementNotice) => close(notice) };
		this.activeBody = active;
		try {
			return await this.runBodyWork(callState, state, owned, work);
		} finally {
			await close();
			if (this.activeBody === active) this.activeBody = null;
		}
	}

	private async runBodyWork<T>(
		callState: CallState,
		state: RunState,
		lease: BodyLease,
		work: (scope: BodyCallScope) => Promise<T>,
	): Promise<T> {
		const ctx = this.buildContext(callState, state, lease) as BodyCallScope;
		const signal = AbortSignal.any([callState.abort.signal, lease.abort.signal]);
		const body = scopedBody(lease.session, {
			signal,
			owner: { kind: "run", run: state.run, segment: state.segment, callId: callState.call },
			guard: () => this.assertLease(callState, lease),
		});
		callState.resources.add(body.close);
		try {
			const reason = (): ControlRetirementNotice | null => {
				const value = lease.abort.signal.reason;
				return value != null && typeof value === "object" && "cause" in value && "initiator" in value
					? (value as ControlRetirementNotice)
					: null;
			};
			return await interruptible(work({ ...ctx, signal, player: body.player }), lease.abort.signal, () =>
				this.retirementFailure(callState, state, reason()),
			);
		} finally {
			await body.close();
			callState.resources.delete(body.close);
		}
	}

	/** 在真实撤销发起点写一次不可变起因；不从错误字符串反推。 */
	private notice(
		cause: ControlRetirementCause,
		initiator: string,
		run?: Ref,
		detail?: string,
	): ControlRetirementNotice {
		return Object.freeze({
			cause,
			initiator,
			at: nowIso(),
			...(run !== undefined ? { run } : {}),
			...(detail !== undefined ? { detail } : {}),
		});
	}
	private retire(run: Ref, notice: ControlRetirementNotice): void {
		const state = this.runs.get(run);
		if (state && state.retiredBy == null) state.retiredBy = notice;
	}

	/**
	 * body 资格被撤销时的失败内容，从 Effect 账本现算：race 提前结束只意味着
	 * 上层不能再等旧 work，不证明它没有派发。只有"已记录且明确 not_sent"才算没派发；
	 * 这里保守取 unknown / sent，并把已有 effect refs 全部保留。
	 */
	private retirementFailure(
		callState: CallState,
		state: RunState,
		explicit: ControlRetirementNotice | null,
	): CallFailure {
		const notice = explicit ?? state.retiredBy ?? this.notice("unknown", "runtime:interrupt", state.run);
		const refs: Ref[] = [];
		const collect = (call: CallState): void => {
			refs.push(...this.queue.effectsForCall(call.call));
			for (const child of call.children) collect(child);
		};
		collect(callState);
		const dispatched = refs.some((ref) => {
			const entry = this.queue.effectRecord(ref);
			return entry != null && entry.latest.dispatch !== "not_sent";
		});
		return callFailure({
			code: "INTERRUPTED",
			message: `body scope retired by ${notice.cause} (${notice.initiator})`,
			source: "environment",
			dispatch: dispatched ? "sent" : "unknown",
			effects: refs,
			progress: { cause: notice.cause, retiredAt: notice.at, ...(notice.run ? { run: notice.run } : {}) },
			hint: RETIREMENT_HINT[notice.cause],
			// 只有 safety 允许后续在新资格 + 重新观察下继续；user_stop 绝不自动续跑。
			recoverable: notice.cause === "safety",
		});
	}

	private scopeError(code: string, message: string): CallFailure {
		return callFailure({ code, message, source: "capability", dispatch: "not_sent", effects: [], recoverable: true });
	}
	private assertCallLive(call: CallState): void {
		this.assertActionAllowed();
		if (call.closed || call.abort.signal.aborted) throw this.scopeError("INTERRUPTED", "call scope is closed");
	}
	private assertLease(call: CallState, lease: BodyLease): void {
		this.assertCallLive(call);
		if (lease.closed) throw this.scopeError("CONTROL_INVALID", "body scope is closed");
		if (lease.activeCall !== call.call) throw this.scopeError("BODY_SUSPENDED", "body delegated to a descendant call");
	}
	sealProgramCalls(calls: string[], _reason: string): void {
		for (const id of calls) {
			const call = this.findLiveCall(id);
			if (call) {
				call.closed = true;
				call.abort.abort();
			}
		}
	}
	programChanged(): void {
		const calls = this.opts.program?.capacity().calls ?? [];
		for (const state of this.runs.values()) {
			if (state.phase === "finished" || state.phase === "awaiting_decision" || !state.started || state.stopped)
				continue;
			const root = calls.find((c) => c.call === state.rootCall.call);
			const waiting = root?.waiting;
			if (waiting?.kind === "idle" || waiting?.kind === "sleep" || waiting?.kind === "world_change")
				this.releasePriority(state);
			const phase =
				state.awaitingBody > 0 && waiting?.method === "acquireBody" ? "queued" : waiting ? "waiting" : "running";
			if (
				state.phase === phase &&
				state.waiting?.kind === waiting?.kind &&
				(state.waiting?.kind !== "world_change" ||
					JSON.stringify([...state.waiting.targets].sort()) === JSON.stringify([...(waiting?.targets ?? [])].sort())) &&
				(state.waiting?.kind !== "host_call" || state.waiting.method === waiting?.method)
			)
				continue;
			state.phase = phase;
			state.waiting =
				waiting?.kind === "host_call"
					? { kind: "host_call", method: waiting.method ?? "call", sinceMs: waiting.sinceMs }
					: waiting?.kind === "world_change"
						? {
								kind: "world_change",
								targets: (waiting.targets ?? []) as import("../contracts/values.js").ExactRef[],
								sinceMs: waiting.sinceMs,
							}
						: waiting?.kind === "sleep"
							? { kind: "sleep", sinceMs: waiting.sinceMs }
							: waiting
								? { kind: "idle", sinceMs: waiting.sinceMs }
								: undefined;
			state.revision++;
			this.queue.enqueue(this.runMutation(state));
			this.notifyChanged(state);
		}
	}

	private releasePriority(state: RunState): void {
		const release = state.priorityRelease;
		state.priorityRelease = undefined;
		if (release) this.bodyLeaseQueue.clearPriority(state.run);
		release?.();
	}

	private isDescendantCall(candidateDescendant: Ref, ancestor: Ref): boolean {
		let current = this.findLiveCall(candidateDescendant);
		while (current != null) {
			if (current.call === ancestor) return true;
			current = current.parent != null ? this.findLiveCall(current.parent) : null;
		}
		return false;
	}

	private findLiveCall(call: Ref): CallState | null {
		for (const state of this.runs.values()) {
			if (state.rootCall.call === call) return state.rootCall;
			const found = this.searchChildren(state.rootCall, call);
			if (found != null) return found;
		}
		return null;
	}

	private searchChildren(node: CallState, call: Ref): CallState | null {
		for (const child of node.children) {
			if (child.call === call) return child;
			const found = this.searchChildren(child, call);
			if (found != null) return found;
		}
		return null;
	}

	// ---- 解析与校验 ----

	private resolveCallable(
		selector: string,
		run: string,
		state?: RunState,
	): ResolvedInvocation | Promise<ResolvedInvocation> {
		if (this.opts.queryRefs?.includes(selector)) throw this.scopeError("USE_MC_READ", "query capabilities use mc.read");
		if (selector.includes("@")) {
			const callable = this.byRef.get(selector);
			if (callable == null) {
				throw callFailure({
					code: "NOT_FOUND",
					source: "capability",
					message: `capability ${selector} is not registered`,
					hint: "programs are not callable in I1; use a registered native capability ref",
					dispatch: "not_sent",
					effects: [],
					recoverable: false,
				});
			}
			return {
				kind: "native",
				native: callable,
				ref: callable.descriptor.ref,
				digest: sha256Hex(canonicalJson(plain(callable.descriptor))),
				completion: callable.descriptor.completion,
				inputSchema: callable.descriptor.input,
				outputSchema: callable.descriptor.output,
			};
		}
		const program = state?.programScope
			? state.programScope.resolve(selector)
			: this.requireProgram().resolve({ name: selector });
		return program.then((p) => this.prepareProgram(p, run));
	}
	private requireProgram(): ProgramPort {
		if (!this.opts.program) throw this.scopeError("PROGRAM_UNAVAILABLE", "Program is not installed in this Runtime");
		return this.opts.program;
	}
	private async prepareProgram(program: ResolvedProgram, run: string): Promise<ResolvedInvocation> {
		const port = this.requireProgram();
		const validation = await port.validate(program);
		if (!validation.ok) throw this.scopeError(validation.code, validation.message);
		const snapshot = await port.writeSnapshot({ run, program });
		return {
			kind: "program",
			program,
			snapshot: snapshot.path,
			ref: program.name ?? `code:${program.digest.slice(0, 8)}`,
			digest: program.digest,
			completion: {
				scope: "execution",
				description: "program returned; world goals depend on its actions and observations",
			},
			inputSchema: program.header.input ?? {},
			outputSchema: program.header.output ?? {},
		};
	}

	private validateInput(descriptor: ResolvedInvocation, input: JsonValue): void {
		if (!isJsonValue(input)) {
			throw callFailure({
				code: "INVALID_INPUT",
				source: "input",
				message: "input is not a JSON value (non-finite numbers or circular structures are rejected)",
				dispatch: "not_sent",
				effects: [],
				recoverable: true,
			});
		}
		const validate = this.validatorFor(descriptor.inputSchema, `${descriptor.digest}:in`);
		if (!validate(input)) {
			const message = this.ajv.errorsText(validate.errors);
			throw callFailure({
				code: "INVALID_INPUT",
				source: "input",
				message: `input does not match ${descriptor.ref} schema: ${message}`,
				dispatch: "not_sent",
				effects: [],
				recoverable: true,
			});
		}
	}

	private validatorFor(schema: JsonSchema, cacheKey: string): ValidateFunction {
		const cached = this.validatorCache.get(cacheKey);
		if (cached != null) return cached;
		const validate = this.ajv.compile(schema as Record<string, unknown>);
		this.validatorCache.set(cacheKey, validate);
		return validate;
	}

	// ---- 五态与效果归属 ----

	private callHasUnknownEffects(callState: CallState): boolean {
		// Query current receipts instead of child outcomes: a handled failure does not erase
		// its effects, and a later confirmed receipt may resolve an earlier unknown one.
		for (const effect of this.queue.effectsForCall(callState.call)) {
			const attribution = this.queue.effectRecord(effect);
			if (attribution != null && attribution.latest.completion !== "met") return true;
		}
		for (const child of callState.children) {
			if (this.callHasUnknownEffects(child)) return true;
		}
		return false;
	}

	private runMutation(state: RunState): ApplyItem["mutation"] {
		state.record = this.refs.record();
		return { kind: "run", row: runRowOf(state) };
	}
	private segmentMutation(state: RunState): ApplyItem["mutation"] {
		state.segmentRecord = this.refs.record();
		return {
			kind: "segment",
			row: segmentRowOf(state, state.environment === undefined ? (this.opts.environment ?? null) : state.environment),
		};
	}
	private callMutation(state: CallState): ApplyItem["mutation"] {
		state.record = this.refs.record();
		return { kind: "call", row: callRowOf(state) };
	}

	// ---- 通知 ----

	private setPhase(state: RunState, phase: RunState["phase"]): void {
		if (state.phase === phase) return;
		state.phase = phase;
		state.revision++;
		this.queue.enqueue(this.runMutation(state));
		this.notifyChanged(state);
	}

	private notifyChanged(state: RunState): void {
		const snapshot = projectSummary(state);
		for (const waiter of [...state.waiters]) {
			if (waiter.mode === "changed") waiter.resolve({ kind: "changed", snapshot });
		}
	}

	private notifyResult(state: RunState): void {
		const snapshot = projectSummary(state);
		for (const waiter of [...state.waiters]) {
			waiter.mode === "result"
				? waiter.resolve({ kind: "result", snapshot: snapshot as Extract<RunSummary, { phase: "finished" }> })
				: waiter.resolve({ kind: "changed", snapshot });
		}
	}

	// ---- 投影（纯值构建在 rows.ts；这里只负责现场/恢复查表） ----

	private summaryFromRecovered(run: Ref): RunSummary | null {
		const row = this.recoveredRuns.get(run);
		return row == null ? null : summaryFromRow(row);
	}
}

function submissionKey(owner: Ref, requestId: Ref): string {
	return `${owner}\u0000${requestId}`;
}
