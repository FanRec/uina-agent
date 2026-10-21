/**
 * Runtime 执行引擎：受理、调用组合、身体仲裁、记录结算（I1 子集）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/runtime.md §2（受理）、§3（调用与
 * 身体）、§4.3/§4.4（关闭/停止）、§5（记录与结算）、§5.6（五态）。
 * I1 范围：Entry 只支持原生 call、Schedule 只支持 enqueue；replace_pending/
 * preempt_current 显式 not_accepted；程序/决策/安全介入/交付处置留后续轮次。
 * 不做：逐 Call 等盘（普通子 Call 入队即返回）；恢复自动重放（恢复只读事实
 * 并按 §4.4 表结算未终结 Run）；效果核验器（ctx.verify 对未注册 verifier 如实
 * NOT_FOUND）。owner→effect 关联由引擎经记录队列归属槽建立（§5.4）。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import type { ControlOwner, PlayerPort } from "../contracts/body.js";
import type { BodyCallScope, CallContext, CallableDescriptor, NativeCallable } from "../contracts/capabilities.js";
import type {
	Acceptance,
	RunRequest,
	RunSummary,
	RunWaitReply,
	StopCommand,
	StopReceipt,
	StopTarget,
	SubmissionLookup,
} from "../contracts/runtime.js";
import type { WorldPort } from "../contracts/world.js";
import type {
	CallFailure,
	CallFailureData,
	EffectReceipt,
	JsonSchema,
	JsonValue,
	Progress,
	Ref,
} from "../contracts/values.js";
import { callFailure, plain } from "../contracts/values.js";
import { BodyLeaseQueue, type BodyGrant } from "./body-queue.js";
import { toCallFailure } from "./failure.js";
import { RuntimeRefs } from "./refs.js";
import { RecordQueue } from "./records.js";
import {
	callFromRow,
	canonicalJson,
	callRowOf,
	callValueOf,
	liveEffectValueOf,
	projectSummary,
	recoveredEffectValueOf,
	runRowOf,
	runSnapshotOf,
	segmentFromRow,
	segmentRowOf,
	segmentValueOf,
	snapshotFromRow,
	summaryFromRow,
} from "./rows.js";
import type { CallRow, RecoveredRows, RunRow, SegmentRow, StopIntentRow } from "./runtime-db-worker.js";
import type { BodyLease, CallFrame, CallState, RunState, RunWaiter, SubmissionState } from "./state.js";

// ---- 纯值辅助 ----

/** Ajv 仅由本模块构造（strict 关闭：能力 schema 含开放键；allErrors 全量）。 */
interface AjvLike {
	compile(schema: Record<string, unknown>): ValidateFunction;
	errorsText(errors?: ValidateFunction["errors"]): string;
}
const AjvCtor = createRequire(import.meta.url)("ajv") as new (options: {
	strict: boolean;
	allErrors: boolean;
}) => AjvLike;

function nowIso(): string {
	return new Date().toISOString();
}

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

export interface EngineOptions {
	refs: RuntimeRefs;
	queue: RecordQueue;
	world: WorldPort;
	playerPort: PlayerPort;
	callables: NativeCallable<JsonValue, JsonValue>[];
	worldOwner: Ref;
	environment?: { serverVersion: string; protocol: number };
}

// ---- 引擎 ----

export class RuntimeEngine {
	private readonly refs: RuntimeRefs;
	private readonly queue: RecordQueue;
	private readonly opts: EngineOptions;
	private readonly als = new AsyncLocalStorage<CallFrame>();
	private readonly ajv = new AjvCtor({ strict: false, allErrors: true });
	private readonly validatorCache = new Map<string, ValidateFunction>();
	private readonly byRef = new Map<Ref, NativeCallable<JsonValue, JsonValue>>();
	private readonly byName = new Map<string, NativeCallable<JsonValue, JsonValue>[]>();
	private readonly runs = new Map<Ref, RunState>();
	private readonly submissions = new Map<Ref, SubmissionState>();
	private readonly byRequestId = new Map<Ref, SubmissionState>();
	private readonly submissionBarriers = new Set<Ref>();
	private readonly recordIndex = new Map<Ref, { kind: string; objectRef: Ref }>();
	private readonly stopIntentRows = new Map<Ref, StopIntentRow>();
	// 恢复事实（只读；恢复结算后未终结 Run 已按 §4.4 表落终态）
	private readonly recoveredRuns = new Map<Ref, RunRow>();
	private readonly recoveredSegments = new Map<Ref, SegmentRow>();
	private readonly recoveredCalls = new Map<Ref, CallRow>();
	private readonly recoveredEffects = new Map<Ref, string>();
	private readonly recoveredOwners = new Map<Ref, string>();
	/** effect 身份引用 → 最新已提交效果记录 ref（public-api §7 readRecord 口径）。 */
	private readonly recoveredEffectRecords = new Map<Ref, Ref>();
	// 身体：单槽 FIFO 队列独占 acquire，归属槽与授予/释放配对收在队列内（§3.3.1）
	private readonly bodyLeaseQueue: BodyLeaseQueue;
	// chat 旁路串行化：单写协议通道 + 归属槽无竞争
	private chatGate: Promise<void> = Promise.resolve();

	constructor(opts: EngineOptions) {
		this.opts = opts;
		this.refs = opts.refs;
		this.queue = opts.queue;
		this.bodyLeaseQueue = new BodyLeaseQueue({
			port: opts.playerPort,
			onGrant: (owner) => this.queue.setQualificationOwner(owner),
			onRelease: () => this.queue.setQualificationOwner(null),
			// Run 停止后不再授予；排队/在途期间的停止由授予前复验拦下（§2.2）
			isOwnerLive: (owner) => owner.kind !== "run" || this.runs.get(owner.run)?.stopped !== true,
		});
		for (const callable of opts.callables) {
			const existing = this.byRef.get(callable.descriptor.ref);
			if (existing != null) {
				throw new Error(`duplicate callable ref: ${callable.descriptor.ref}`);
			}
			this.byRef.set(callable.descriptor.ref, callable);
			const name = callable.descriptor.ref.split("@")[0];
			const list = this.byName.get(name) ?? [];
			list.push(callable);
			this.byName.set(name, list);
		}
	}

	// ---- 恢复（只读事实 + 未终结 Run 结算，不自动重放） ----

	recover(rows: RecoveredRows): void {
		for (const row of rows.records) {
			this.recordIndex.set(row.record, { kind: row.kind, objectRef: row.object_ref });
		}
		for (const row of rows.stopIntents) this.stopIntentRows.set(row.record, row);
		for (const row of rows.submissions) {
			const state: SubmissionState = {
				owner: row.owner,
				requestId: row.request_id,
				status: row.status,
				run: row.run,
				segment: row.segment,
				record: row.record,
				requestJson: row.request,
				error: row.error == null ? null : (JSON.parse(row.error) as { code: string; message: string }),
			};
			this.submissions.set(submissionKey(row.owner, row.request_id), state);
			this.byRequestId.set(row.request_id, state);
			if (row.status === "cancelled") this.submissionBarriers.add(row.request_id);
		}
		for (const row of rows.runs) this.recoveredRuns.set(row.run, row);
		for (const row of rows.segments) this.recoveredSegments.set(row.segment, row);
		for (const row of rows.calls) this.recoveredCalls.set(row.call, row);
		for (const row of rows.effects) {
			this.recoveredEffects.set(row.effect, row.facts);
			this.recoveredOwners.set(row.effect, row.owner ?? "null");
			this.recoveredEffectRecords.set(row.effect, row.record);
			this.recordIndex.set(row.record, { kind: "effect", objectRef: row.effect });
		}
		// §4.4 恢复表（I1 子集）：未终结 Run——有停止意图 → cancelled；否则 unknown；
		// 旧控制退役不明 → control unknown。追加为新的不可变截面。
		const unfinished = rows.runs.filter((r) => r.phase !== "finished");
		for (const row of unfinished) {
			const stoppedByIntent = rows.stopIntents.some((si) => {
				let target: StopTarget;
				try {
					target = JSON.parse(si.target) as StopTarget;
				} catch {
					return false;
				}
				return (
					("run" in target && target.run === row.run) || ("request" in target && target.request === row.request_id)
				);
			});
			const next: RunRow = {
				...row,
				revision: row.revision + 1,
				phase: "finished",
				waiting: null,
				outcome: stoppedByIntent ? "cancelled" : "unknown",
				value: null,
				error: stoppedByIntent
					? null
					: JSON.stringify({
							code: "runtime_restart",
							message: "recovered unfinished run after restart; the effect tail may be missing",
						}),
				control: "unknown",
			};
			this.queue.enqueue({ kind: "run", row: next });
			this.recoveredRuns.set(row.run, next);
		}
	}

	// ---- 受理（§2.1，I1 子集） ----

	submit(origin: { worldOwner: Ref; activation: Ref }, request: RunRequest): Acceptance {
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
		// I1 范围检查
		if (request.schedule.kind !== "enqueue") {
			return this.rejectSubmission(owner, request, intentJson, {
				code: "UNSUPPORTED_SCHEDULE",
				message: `schedule ${request.schedule.kind} arrives with the executor/preemption work packages`,
			});
		}
		if (request.entry.kind !== "call") {
			return this.rejectSubmission(owner, request, intentJson, {
				code: "UNSUPPORTED_ENTRY",
				message: "program entries arrive with the program work package",
			});
		}
		// 准备材料（§2.1 步骤 2）：解析 + 校验，失败不受理（确定性错误）
		let callable: NativeCallable<JsonValue, JsonValue>;
		try {
			callable = this.resolveCallable(request.entry.selector);
		} catch (err) {
			const failure = toCallFailure(err);
			return this.rejectSubmission(owner, request, intentJson, { code: failure.code, message: failure.message });
		}
		try {
			this.validateInput(callable.descriptor, request.entry.input);
		} catch (err) {
			const failure = toCallFailure(err);
			return this.rejectSubmission(owner, request, intentJson, { code: failure.code, message: failure.message });
		}
		// 唯一受理映射 + 初始记录
		const run = this.refs.run();
		const segment = this.refs.segment();
		const call = this.refs.call();
		const runRecord = this.refs.record();
		const segmentRecord = this.refs.record();
		const callRecord = this.refs.record();
		const state: RunState = {
			run,
			owner,
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
		this.runs.set(run, state);
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
		this.submissions.set(key, submission);
		this.byRequestId.set(request.requestId, submission);
		this.recordIndex.set(runRecord, { kind: "run", objectRef: run });
		this.recordIndex.set(segmentRecord, { kind: "segment", objectRef: segment });
		this.recordIndex.set(callRecord, { kind: "call", objectRef: call });
		this.queue.enqueueAll([
			{
				kind: "submission",
				row: {
					owner,
					request_id: request.requestId,
					status: "accepted",
					operation: callable.descriptor.ref,
					segment,
					run,
					request: JSON.stringify(plain(request)),
					origin: JSON.stringify(plain(origin)),
					record: runRecord,
					error: null,
				},
			},
			{ kind: "run", row: runRowOf(state) },
			{ kind: "segment", row: segmentRowOf(state, this.opts.environment ?? null) },
			{ kind: "call", row: callRowOf(state.rootCall) },
			{ kind: "record_index", row: { record: runRecord, kind: "run", object_ref: run } },
			{ kind: "record_index", row: { record: segmentRecord, kind: "segment", object_ref: segment } },
			{ kind: "record_index", row: { record: callRecord, kind: "call", object_ref: call } },
		]);
		void this.runRun(state);
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
		return {
			kind: "found",
			requestId,
			operation: "submit",
			segment: submission.segment,
			snapshot,
			...(snapshot.phase === "finished" ? { completionRef: snapshot.completionRef } : {}),
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

	readRecord(ref: Ref): { kind: string; record: Ref; value: JsonValue } {
		const entry = this.recordIndex.get(ref);
		if (entry == null) {
			// 效果记录在队列内存侧（recover 已把持久效果行载入 recordIndex）
			const effect = this.queue.effectByRecord(ref);
			if (effect != null) return { kind: "effect", record: ref, value: this.effectValueOf(effect) };
			// effect 身份引用（eff:）：固定最新已提交效果记录截面（public-api §7 口径）
			const liveAttribution = this.queue.effectRecord(ref);
			if (liveAttribution != null) {
				return { kind: "effect", record: liveAttribution.record, value: this.effectValueOf(ref) };
			}
			const recoveredRecord = this.recoveredEffectRecords.get(ref);
			if (recoveredRecord != null) {
				return { kind: "effect", record: recoveredRecord, value: this.effectValueOf(ref) };
			}
			throw callFailure({
				code: "NOT_FOUND",
				source: "world",
				message: `record ${ref} is not known to this runtime`,
				dispatch: "not_sent",
				effects: [],
				recoverable: false,
			});
		}
		switch (entry.kind) {
			case "run": {
				const live = this.runs.get(entry.objectRef);
				const value = live != null ? runSnapshotOf(live) : snapshotFromRow(this.recoveredRuns.get(entry.objectRef));
				return { kind: "run", record: ref, value: plain(value) };
			}
			case "segment": {
				const live = [...this.runs.values()].find((r) => r.segmentRecord === ref);
				const value =
					live != null
						? segmentValueOf(live, this.opts.environment ?? null)
						: segmentFromRow(this.recoveredSegments.get(entry.objectRef));
				return { kind: "segment", record: ref, value: plain(value) };
			}
			case "call": {
				const live = this.findLiveCall(entry.objectRef);
				const value = live != null ? callValueOf(live) : callFromRow(this.recoveredCalls.get(entry.objectRef));
				return { kind: "call", record: ref, value: plain(value) };
			}
			case "effect":
				return { kind: "effect", record: ref, value: this.effectValueOf(entry.objectRef) };
			case "stop": {
				const row = this.stopIntentRows.get(ref);
				if (row == null) break;
				return {
					kind: "stop",
					record: ref,
					value: plain({
						requestId: row.stop_request_id,
						target: JSON.parse(row.target),
						record: row.record,
						intent: "durable",
						control: row.control,
						snapshot: null,
					}),
				};
			}
		}
		throw callFailure({
			code: "NOT_FOUND",
			source: "world",
			message: `record ${ref} payload is not readable`,
			dispatch: "not_sent",
			effects: [],
			recoverable: false,
		});
	}

	// ---- 停止（§4.4：先内存关门，再持久 stop_intent） ----

	async stop(command: StopCommand): Promise<StopReceipt> {
		const target = command.target;
		const runRef = "run" in target ? target.run : null;
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
				if (submission.run != null) state = this.runs.get(submission.run);
			}
		}
		if (state == null && requestTarget != null) {
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
			this.recordIndex.set(record, { kind: "stop", objectRef: requestTarget });
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
				{ kind: "record_index", row: { record, kind: "stop", object_ref: requestTarget } },
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
		// 内存关门：封闭准入、删除 Body 队列申请、撤销控制
		state.stopped = true;
		state.phase = "stopping";
		state.revision++;
		if (state.control === "active") state.control = "stopping";
		else if (state.control === "none") state.control = "stopped";
		this.bodyLeaseQueue.cancelRun(state.run);
		state.abort.abort();
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
		this.recordIndex.set(record, { kind: "stop", objectRef: state.run });
		this.queue.enqueueAll([
			{ kind: "stop_intent", row },
			{ kind: "run", row: runRowOf(state) },
			{ kind: "record_index", row: { record, kind: "stop", object_ref: state.run } },
		]);
		let intent: "durable" | "unknown" = "unknown";
		try {
			await this.queue.flushThrough(this.queue.capture());
			intent = "durable";
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
			return await this.queue.runWithChatOwner(owner, () => this.opts.playerPort.chat(text, signal));
		} finally {
			release();
		}
	}

	/** 受控独占导航（goto）作用域：独占期内效果事实归属给定 owner。 */
	async runNavigation<T>(owner: ControlOwner, fn: () => Promise<T>): Promise<T> {
		this.queue.setNavigationOwner(owner);
		try {
			return await fn();
		} finally {
			this.queue.setNavigationOwner(null);
		}
	}

	// ---- 运行执行 ----

	private async runRun(state: RunState): Promise<void> {
		const root = state.rootCall;
		try {
			if (state.awaitingBody === 0) this.setPhase(state, "running");
			let rootThrew: CallFailure | null = null;
			try {
				await this.executeCallBody(root, state, null);
			} catch (err) {
				rootThrew = toCallFailure(err);
			}
			// §5.5 5-6：固定 H → flush → 终结论 → flush → 通知
			await this.queue.flushThrough(this.queue.capture());
			state.unknownEffects = this.queue.unknownEffectsFor(state.run);
			state.value = rootThrew == null ? root.value : null;
			state.error = rootThrew != null ? { code: rootThrew.code, message: rootThrew.message } : null;
			// §5.6 五态：根调用结算 + 运行级控制未知 → unknown
			state.outcome = state.control === "unknown" ? "unknown" : (root.outcome ?? "unknown");
			state.completionRef = this.refs.completion();
			state.revision++;
			state.phase = "finished";
			if (state.stopped) state.control = "stopped";
			this.queue.enqueueAll([
				{ kind: "segment", row: segmentRowOf(state, this.opts.environment ?? null) },
				{ kind: "run", row: runRowOf(state) },
			]);
			await this.queue.flushThrough(this.queue.capture());
			this.notifyResult(state);
		} catch (err) {
			// flush/commit 失败：控制已撤销，不得假称持久终结（§5.5 step 7）
			console.error(
				`[mc-runtime] run ${state.run} settlement failed: ${err instanceof Error ? err.message : String(err)}`,
			);
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
		try {
			const raw = await this.als.run({ call: callState, bodyLease: lease }, () =>
				callState.callable.invoke(ctx, callState.input),
			);
			const validate = this.validatorFor(
				callState.callable.descriptor.output,
				`${callState.callable.descriptor.ref}:out`,
			);
			if (!validate(raw)) {
				throw callFailure({
					code: "INTERNAL",
					source: "capability",
					message: `output validation failed for ${callState.callable.descriptor.ref}`,
					dispatch: callState.effects.length > 0 ? "sent" : "not_sent",
					effects: [...callState.effects],
					recoverable: false,
				});
			}
			value = raw as JsonValue;
		} catch (err) {
			threw = toCallFailure(err);
		}
		// §4.3 关闭：封闭准入 → 取消/等待子 Call → 保存原因
		callState.closed = true;
		const cancelled = callState.closedByParent != null || state.stopped;
		const reason: "returned" | "threw" | "cancelled" = threw == null ? "returned" : cancelled ? "cancelled" : "threw";
		const strays = [...callState.children].filter((child) => !child.closed);
		for (const child of strays) {
			child.closedByParent = { call: callState.call, reason };
		}
		if (callState.parent == null) state.interruptedChildren = strays.map((child) => child.call);
		callState.abort.abort();
		await Promise.all(strays.map((child) => child.settled));
		// §5.5 step 4：不可变完成截面入队（不逐 Call 等盘）
		callState.execution =
			threw == null ? "returned" : callState.closedByParent != null || state.stopped ? "interrupted" : "threw";
		if (threw == null) {
			callState.value = value ?? null;
			callState.outcome = this.callHasUnknownEffects(callState) ? "unknown" : "succeeded";
		} else {
			callState.error = failureData(threw);
			callState.outcome = callState.execution === "interrupted" ? "cancelled" : "failed";
		}
		callState.effects = this.queue.effectsForCall(callState.call);
		this.queue.enqueue({ kind: "call", row: callRowOf(callState) });
		callState.settledResolve();
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
		const callable = this.resolveCallable(selector);
		this.validateInput(callable.descriptor, input);
		const call = this.refs.call();
		const record = this.refs.record();
		const child = this.createCallState(parent.run, parent.segment, call, record, parent, callable, input);
		parent.children.add(child);
		this.recordIndex.set(record, { kind: "call", objectRef: call });
		this.queue.enqueueAll([
			{ kind: "call", row: callRowOf(child) },
			{ kind: "record_index", row: { record, kind: "call", object_ref: call } },
		]);
		return this.executeCallBody(child, state, lease);
	}

	private createCallState(
		run: Ref,
		segment: Ref,
		call: Ref,
		record: Ref,
		parent: CallState | null,
		callable: NativeCallable<JsonValue, JsonValue>,
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
				this.queue.enqueue({ kind: "call", row: callRowOf(callState) });
				if (callState.parent == null) {
					state.progress = value;
					state.revision++;
					this.queue.enqueue({ kind: "run", row: runRowOf(state) });
					this.notifyChanged(state);
				}
			},
			world: this.opts.world,
			call: async (selector: string, input: JsonValue) => this.invokeChild(callState, state, lease, selector, input),
			withBody: async <T>(work: (scope: BodyCallScope) => Promise<T>) =>
				this.runWithBody(callState, state, lease, work),
			verify: async (effect: Ref, verifier: Ref): Promise<EffectReceipt> => {
				// I1 无核验器注册表：如实 NOT_FOUND，不追加伪造判断（§5.6）
				throw callFailure({
					code: "NOT_FOUND",
					source: "capability",
					message: `verifier ${verifier} is not registered`,
					hint: "effect verifiers arrive with the capability work packages (K2+)",
					dispatch: "not_sent",
					effects: [effect],
					recoverable: false,
				});
			},
			...(lease != null ? { player: lease.session } : {}),
		} as CallContext & Partial<BodyCallScope>;
		return ctx;
	}

	// ---- 身体申请（§3.3.1 三种情况） ----

	private async runWithBody<T>(
		callState: CallState,
		state: RunState,
		lease: BodyLease | null,
		work: (scope: BodyCallScope) => Promise<T>,
	): Promise<T> {
		// 情况 a：委托谱系复用，重入不排队
		if (lease != null) {
			return work(this.bodyScopeOf(callState, state, lease));
		}
		// 情况 c：本调用谱系后代持 Body（或正在 acquire）→ 派发申请前 CONTROL_CONFLICT
		const blocking = this.bodyLeaseQueue.blockingCall();
		if (blocking != null && this.isDescendantCall(blocking, callState.call)) {
			throw callFailure({
				code: "CONTROL_CONFLICT",
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
			grant = await this.bodyLeaseQueue.request(owner, callState.call, callState.abort.signal);
		} catch (err) {
			state.awaitingBody--;
			throw err;
		}
		state.awaitingBody--;
		if (state.phase === "queued") this.setPhase(state, "running");
		state.control = "active";
		state.revision++;
		this.queue.enqueue({ kind: "run", row: runRowOf(state) });
		try {
			return await work(this.bodyScopeOf(callState, state, { session: grant.session }));
		} finally {
			// §3.3.2 外层退出：等 close 屏障完成才发下一项；清理事实先入队
			try {
				await grant.session.close();
			} catch {
				state.control = "unknown";
			}
			// release 之后队列才授予下一项；归属槽由队列的 onRelease 清空
			grant.release();
			// 释放后不再持有控制；stop 期间保持 stop() 设置的 stopping（finish 时落 stopped）
			if (state.control === "active" && !state.stopped) {
				state.control = "none";
			}
			state.revision++;
			this.queue.enqueue({ kind: "run", row: runRowOf(state) });
		}
	}

	private bodyScopeOf(callState: CallState, state: RunState, lease: BodyLease): BodyCallScope {
		return this.buildContext(callState, state, lease) as BodyCallScope;
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

	private resolveCallable(selector: string): NativeCallable<JsonValue, JsonValue> {
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
			return callable;
		}
		const candidates = this.byName.get(selector) ?? [];
		if (candidates.length === 1) return candidates[0];
		throw callFailure({
			code: candidates.length === 0 ? "NOT_FOUND" : "SELECTOR_INVALID",
			source: "input",
			message:
				candidates.length === 0
					? `no capability matches the name ${selector}`
					: `name ${selector} is ambiguous across ${candidates.length} versions`,
			dispatch: "not_sent",
			effects: [],
			recoverable: false,
		});
	}

	private validateInput(descriptor: CallableDescriptor, input: JsonValue): void {
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
		const validate = this.validatorFor(descriptor.input, `${descriptor.ref}:in`);
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
		for (const effect of callState.effects) {
			const attribution = this.queue.effectRecord(effect);
			if (attribution != null && attribution.latest.completion !== "met") return true;
		}
		return false;
	}

	// ---- 通知 ----

	private setPhase(state: RunState, phase: RunState["phase"]): void {
		if (state.phase === phase) return;
		state.phase = phase;
		state.revision++;
		this.queue.enqueue({ kind: "run", row: runRowOf(state) });
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

	private effectValueOf(effect: Ref): Record<string, JsonValue> {
		const live = this.queue.effectRecord(effect);
		if (live != null) return liveEffectValueOf(effect, live);
		const factsJson = this.recoveredEffects.get(effect);
		if (factsJson != null) {
			return recoveredEffectValueOf(effect, {
				factsJson,
				ownerJson: this.recoveredOwners.get(effect) ?? null,
				record: this.recoveredEffectRecords.get(effect) ?? `rec:effect:${effect}`,
			});
		}
		return { effect, error: "effect facts unavailable" };
	}
}

function submissionKey(owner: Ref, requestId: Ref): string {
	return `${owner}\u0000${requestId}`;
}
