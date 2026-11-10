/**
 * Runtime 投影与持久行：内存态 → RunSummary / RunSnapshot / 数据库行 / 记录值。
 *
 * 唯一定义来源：docs/proposals/mc/modules/runtime.md §5（记录与结算）、§5.1
 * （规范化 JSON）、§5.6（五态投影）；public-api.md §7（readRecord 口径）。
 * 这里全部是纯函数：入参是 state 快照，出参是新对象；不读引擎、不改 state、
 * 不做 I/O。engine 只负责在正确时机调用它们。
 */

import { createHash } from "node:crypto";
import type { DriverExecutionFact, RunSnapshot, RunSummary } from "../contracts/runtime.js";
import type { JsonValue, Outcome, Progress, Ref } from "../contracts/values.js";
import { plain } from "../contracts/values.js";
import type { CallRow, RunRow, SegmentRow } from "./runtime-db-worker.js";
import type { CallState, RunEnvironment, RunState } from "./state.js";

// ---- 规范化与摘要 ----

/** 语义等价比较用的规范化 JSON：对象键排序、数组有序、字符串逐字符保留（§5.1）。 */
export function canonicalJson(value: JsonValue): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] ?? null)}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** 描述符摘要：同一定义在不同实现/不同轮次必须得到同一 digest。 */

// ---- Run 投影 ----

/** 内存 Run 态的对外摘要（§5.6 五态；I1 无 awaiting_decision）。 */
export function projectSummary(state: RunState): RunSummary {
	const base = {
		run: state.run,
		rootRequestId: state.requestId,
		revision: state.revision,
		segment: state.segment,
		record: state.record,
		completion: state.callable.completion,
		progress: plain(state.progress) as Progress,
		progressComplete: true,
		control: state.control,
		unknownEffectCount: state.unknownEffects.length,
		unknownEffects: [...state.unknownEffects],
		unknownEffectsComplete: true,
	};
	if (state.phase === "awaiting_decision")
		return {
			...base,
			phase: "awaiting_decision",
			decision: state.decision!,
			reason: state.decisionRequest!.reason,
			reasonComplete: true,
			completionRef: state.completionRef!,
		};
	if (state.phase === "finished") {
		return {
			...base,
			phase: "finished",
			outcome: state.outcome ?? "unknown",
			completionRef: state.completionRef ?? state.record,
			...(state.error != null ? { error: { ...state.error, messageComplete: true } } : {}),
		};
	}
	if (state.phase === "stopping") return { ...base, phase: "stopping" };
	if (state.phase === "waiting")
		return { ...base, phase: "waiting", waiting: state.waiting ?? { kind: "idle", sinceMs: 0 }, waitingComplete: true };
	return { ...base, phase: state.phase };
}

/**
 * 等待回复用的快照：finished 才带根返回值与被打断的子 Call。
 *
 * 这里按 RunSnapshot 的字段逐项构造，不从 RunSummary 强转：RunSummary 多出的
 * `progressComplete` / `unknownEffectCount` / `waitingComplete` / `reasonComplete`
 * 会随展开运算符漏进快照，消费者读到的形状与类型声明不一致。
 */
export function runSnapshotOf(state: RunState): RunSnapshot {
	const base = {
		run: state.run,
		rootRequestId: state.requestId,
		revision: state.revision,
		segment: state.segment,
		record: state.record,
		completion: state.callable.completion,
		progress: plain(state.progress) as Progress,
		control: state.control,
		unknownEffects: [...state.unknownEffects],
	};
	if (state.phase === "awaiting_decision")
		return {
			...base,
			phase: "awaiting_decision",
			decision: state.decision!,
			reason: state.decisionRequest!.reason,
			checkpoint: state.checkpoint ?? null,
			request: state.decisionRequest,
			completionRef: state.completionRef!,
		};
	if (state.phase === "finished")
		return {
			...base,
			phase: "finished",
			outcome: state.outcome ?? "unknown",
			...(state.value != null ? { value: state.value } : {}),
			...(state.error != null ? { error: { code: state.error.code, message: state.error.message } } : {}),
			completionRef: state.completionRef ?? state.record,
			interruptedChildren: [...state.interruptedChildren],
		};
	if (state.phase === "waiting")
		return { ...base, phase: "waiting", waiting: state.waiting ?? { kind: "idle", sinceMs: 0 } };
	return { ...base, phase: state.phase };
}

/** 落库行 → 摘要（恢复路径；行里没有的字段按 §5.6 表如实补 unknown）。 */
export function summaryFromRow(row: RunRow): RunSummary {
	const unknownEffects = JSON.parse(row.unknown_effects) as Ref[];
	const base = {
		run: row.run,
		rootRequestId: row.request_id,
		revision: row.revision,
		segment: row.segment ?? "",
		record: row.record,
		completion: {
			scope: row.completion_scope as "execution" | "capability",
			description: row.completion_description,
		},
		progress: JSON.parse(row.progress) as Progress,
		progressComplete: true,
		control: row.control as RunSummary["control"],
		unknownEffectCount: unknownEffects.length,
		unknownEffects,
		unknownEffectsComplete: true,
	};
	if (row.phase === "awaiting_decision" && row.decision) {
		const d = JSON.parse(row.decision);
		return {
			...base,
			phase: "awaiting_decision",
			decision: d.ref,
			reason: d.request.reason,
			reasonComplete: true,
			completionRef: row.completion_ref!,
		};
	}
	if (row.phase === "finished") {
		return {
			...base,
			phase: "finished",
			outcome: (row.outcome ?? "unknown") as Outcome,
			completionRef: row.completion_ref ?? row.record,
			...(row.error != null
				? { error: { ...(JSON.parse(row.error) as { code: string; message: string }), messageComplete: true } }
				: {}),
		};
	}
	if (row.phase === "stopping") return { ...base, phase: "stopping" };
	if (row.phase === "waiting")
		return {
			...base,
			phase: "waiting",
			waiting: JSON.parse(row.waiting ?? '{"kind":"idle","sinceMs":0}'),
			waitingComplete: true,
		};
	return { ...base, phase: row.phase as "queued" | "running" };
}

/** 落库行 → 快照；行缺失时给出显式 unavailable 投影而非抛错。 */
export function snapshotFromRow(row: RunRow | undefined, segment?: SegmentRow): RunSnapshot {
	if (row == null) {
		return {
			run: "unavailable",
			rootRequestId: "unavailable",
			revision: 0,
			segment: null,
			record: "unavailable",
			completion: { scope: "execution", description: "run record payload is unavailable" },
			progress: {},
			control: "unknown",
			unknownEffects: [],
			phase: "finished",
			outcome: "unknown",
			completionRef: "unavailable",
		};
	}
	const summary = summaryFromRow(row);
	if (summary.phase === "awaiting_decision") {
		const d = JSON.parse(row.decision!);
		return {
			...summary,
			completion: {
				scope: row.completion_scope as "execution" | "capability",
				description: row.completion_description,
			},
			checkpoint: d.request.checkpoint,
			request: d.request,
		};
	}
	if (summary.phase !== "finished") return summary as unknown as RunSnapshot;
	return {
		...summary,
		...(row.value != null ? { value: JSON.parse(row.value) as JsonValue } : {}),
		...(segment != null ? { interruptedChildren: JSON.parse(segment.interrupted_children) as Ref[] } : {}),
	} as unknown as RunSnapshot;
}

// ---- 持久行 ----

export function runRowOf(state: RunState): RunRow {
	return {
		run: state.run,
		decision: state.decision ? JSON.stringify({ ref: state.decision, request: state.decisionRequest }) : null,
		segment_request_id: state.segmentRequestId ?? state.requestId,
		started: state.started || state.everStarted ? 1 : 0,
		owner: state.owner,
		request_id: state.requestId,
		revision: state.revision,
		segment: state.segment,
		phase: state.phase,
		waiting: state.phase === "waiting" ? JSON.stringify(state.waiting) : null,
		outcome: state.phase === "finished" ? (state.outcome ?? "unknown") : null,
		value: state.phase === "finished" && state.value != null ? JSON.stringify(state.value) : null,
		error: state.error != null ? JSON.stringify(state.error) : null,
		completion_ref: state.completionRef,
		control: state.control,
		unknown_effects: JSON.stringify(state.unknownEffects),
		record: state.record,
		progress: JSON.stringify(plain(state.progress)),
		completion_scope: state.callable.completion.scope,
		completion_description: state.callable.completion.description,
	};
}

export function segmentRowOf(state: RunState, environment: RunEnvironment | null): SegmentRow {
	const root = state.rootCall;
	return {
		segment: state.segment,
		checkpoint: state.checkpoint == null ? null : JSON.stringify(state.checkpoint),
		run: state.run,
		revision: state.phase === "finished" ? 2 : 1,
		record: state.segmentRecord,
		entry: JSON.stringify(
			plain(
				root.callable.kind === "native"
					? { kind: "native", descriptor: root.callable.native.descriptor, digest: root.callable.digest }
					: {
							kind: "program",
							name: root.callable.program.name,
							origin: root.callable.program.origin,
							digest: root.callable.digest,
							snapshot: root.callable.snapshot,
							recovery: state.recovery,
						},
			),
		),
		input: JSON.stringify(root.input),
		environment: environment != null ? JSON.stringify(environment) : null,
		value: state.phase === "finished" && state.value != null ? JSON.stringify(state.value) : null,
		interrupted_children: JSON.stringify(state.interruptedChildren),
		evidence: "[]",
	};
}

export function callRowOf(callState: CallState): CallRow {
	return {
		call: callState.call,
		run: callState.run,
		segment: callState.segment,
		parent: callState.parent,
		record: callState.record,
		ref: callState.callable.ref,
		implementation: callState.callable.kind,
		digest: callState.callable.digest,
		decision_request: callState.decisionRequest ? JSON.stringify(callState.decisionRequest) : null,
		program:
			callState.callable.kind === "program"
				? JSON.stringify({
						name: callState.callable.program.name,
						origin: callState.callable.program.origin,
						digest: callState.callable.digest,
						snapshot: callState.callable.snapshot,
						...(callState.diagnostic ? { diagnostic: callState.diagnostic } : {}),
					})
				: null,
		access: "act",
		input: JSON.stringify(callState.input),
		execution: callState.execution,
		outcome: callState.outcome,
		value: callState.execution === "returned" && callState.value != null ? JSON.stringify(callState.value) : null,
		closed_by_parent: callState.closedByParent != null ? JSON.stringify(callState.closedByParent) : null,
		error: callState.error != null ? JSON.stringify(plain(callState.error)) : null,
		progress: JSON.stringify(plain(callState.progress)),
		effects: JSON.stringify(callState.effects),
		evidence: "[]",
		completion: JSON.stringify(plain(callState.callable.completion)),
	};
}

// ---- 记录值（readRecord 口径） ----

export function segmentValueOf(state: RunState, environment: RunEnvironment | null): Record<string, JsonValue> {
	const row = segmentRowOf(state, environment);
	return {
		run: row.run,
		segment: row.segment,
		revision: row.revision,
		record: row.record,
		entry: JSON.parse(row.entry) as JsonValue,
		input: JSON.parse(row.input) as JsonValue,
		checkpoint: row.checkpoint ? JSON.parse(row.checkpoint) : null,
		...(row.environment != null ? { environment: JSON.parse(row.environment) as JsonValue } : {}),
		...(row.value != null ? { value: JSON.parse(row.value) as JsonValue } : {}),
		interruptedChildren: JSON.parse(row.interrupted_children) as JsonValue,
		evidence: [],
	};
}

export function segmentFromRow(row: SegmentRow | undefined): Record<string, JsonValue> {
	if (row == null) return { error: "segment row unavailable" };
	return {
		run: row.run,
		segment: row.segment,
		revision: row.revision,
		record: row.record,
		entry: JSON.parse(row.entry) as JsonValue,
		input: JSON.parse(row.input) as JsonValue,
		checkpoint: row.checkpoint ? JSON.parse(row.checkpoint) : null,
		...(row.environment != null ? { environment: JSON.parse(row.environment) as JsonValue } : {}),
		...(row.value != null ? { value: JSON.parse(row.value) as JsonValue } : {}),
		interruptedChildren: JSON.parse(row.interrupted_children) as JsonValue,
		evidence: JSON.parse(row.evidence) as JsonValue,
	};
}

export function callValueOf(callState: CallState): Record<string, JsonValue> {
	return { ...readCallRow(callRowOf(callState)), evidence: [] };
}

export function callFromRow(row: CallRow | undefined): Record<string, JsonValue> {
	if (row == null) return { error: "call row unavailable" };
	return { ...readCallRow(row), evidence: JSON.parse(row.evidence) as JsonValue };
}

/** Call 行 → 对外记录值（callValueOf / callFromRow 共用，evidence 由调用方补）。 */
function readCallRow(row: CallRow): Record<string, JsonValue> {
	return {
		call: row.call,
		run: row.run,
		segment: row.segment,
		parent: row.parent,
		record: row.record,
		ref: row.ref,
		implementation: row.implementation,
		...(row.program != null ? { program: JSON.parse(row.program) as JsonValue } : {}),
		digest: row.digest,
		access: row.access,
		input: JSON.parse(row.input) as JsonValue,
		...(row.decision_request ? { decisionRequest: JSON.parse(row.decision_request) } : {}),
		execution: row.execution,
		completion: JSON.parse(row.completion) as JsonValue,
		...(row.outcome != null ? { outcome: row.outcome } : {}),
		...(row.value != null ? { value: JSON.parse(row.value) as JsonValue } : {}),
		...(row.closed_by_parent != null ? { closedByParent: JSON.parse(row.closed_by_parent) as JsonValue } : {}),
		...(row.error != null ? { error: JSON.parse(row.error) as JsonValue } : {}),
		progress: JSON.parse(row.progress) as JsonValue,
		effects: JSON.parse(row.effects) as JsonValue,
	};
}

// ---- 效果记录值 ----

/** 现场效果记录值（引擎内存里已有归属与事实）。 */
export function liveEffectValueOf(
	effect: Ref,
	live: { owner: object | null; operation: Ref; record: Ref; facts: DriverExecutionFact[] },
): Record<string, JsonValue> {
	const last = live.facts.length > 0 ? live.facts[live.facts.length - 1] : null;
	return {
		effect,
		owner: live.owner == null ? null : plain(live.owner),
		operation: live.operation,
		record: live.record,
		facts: plain(live.facts),
		verifications: [],
		latest: {
			effect,
			dispatch: last?.dispatch ?? "unknown",
			completion: last?.completion ?? "unknown",
			evidence: last?.evidence ?? [],
		},
	};
}

/** 恢复的效果记录值（只有行；缺字段按 unknown 如实补）。 */
export function recoveredEffectValueOf(
	effect: Ref,
	recovered: { factsJson: string; ownerJson: string | null; record: Ref; verificationsJson?: string },
): Record<string, JsonValue> {
	const facts = JSON.parse(recovered.factsJson) as DriverExecutionFact[];
	const last = facts.length > 0 ? facts[facts.length - 1] : null;
	return {
		effect,
		owner: JSON.parse(recovered.ownerJson ?? "null") as JsonValue,
		operation: facts[0]?.operation ?? "unknown",
		record: recovered.record,
		facts: plain(facts),
		verifications: plain(JSON.parse(recovered.verificationsJson ?? "[]")),
		latest: {
			effect,
			dispatch: last?.dispatch ?? "unknown",
			completion: last?.completion ?? "unknown",
			evidence: last?.evidence ?? [],
		},
	};
}

/** Display only: omitted fields stay explicit, full data remains in fixed records. */
export function boundedSummary(summary: RunSummary): RunSummary {
	const out = structuredClone(summary);
	const projected = projectProgress(out.progress);
	out.progress = projected.progress;
	if (!projected.complete) out.progressComplete = false;
	out.unknownEffects = out.unknownEffects.slice(0, 8);
	out.unknownEffectsComplete = out.unknownEffectCount <= 8;
	if (out.phase === "finished" && out.error && Buffer.byteLength(out.error.message) > 1024) {
		out.error.message = Buffer.from(out.error.message).subarray(0, 1000).toString("utf8");
		out.error.messageComplete = false;
	}
	if (out.phase === "awaiting_decision" && Buffer.byteLength(out.reason) > 1024) {
		out.reason = Buffer.from(out.reason).subarray(0, 1000).toString("utf8");
		out.reasonComplete = false;
	}
	return out;
}

/** progress 投影预算：与 public-api §7 的"摘要 2048 字节"一致。 */
export const PROGRESS_PROJECTION_BYTES = 2048;

/**
 * 摘要投影必须保住"还剩什么"，只截断明细。
 *
 * 旧实现超预算就整块丢掉 progress，模型只能看到 `progressComplete:false`——
 * 恰恰在最需要续做依据的时候（长任务、剩余几十格）把依据删了。现在改为：
 * 标量与短摘要优先保留，明细数组按预算逐条收，被截掉的部分由 `reasons` 的
 * 全量直方图承担，完整原文仍在本次 Call 记录里（`runs record`）。
 */
export function projectProgress(
	progress: Progress,
	budgetBytes = PROGRESS_PROJECTION_BYTES,
): { progress: Progress; complete: boolean } {
	if (progress == null || typeof progress !== "object") return { progress: {}, complete: true };
	if (Buffer.byteLength(JSON.stringify(progress)) <= budgetBytes) return { progress, complete: true };
	// 留 10% 余量：分隔符与转义让逐条累加的估算偏乐观。
	const limit = Math.floor(budgetBytes * 0.9);
	const cost = (key: string, value: JsonValue): number =>
		Buffer.byteLength(JSON.stringify(key)) + Buffer.byteLength(JSON.stringify(value)) + 2;
	const out: Record<string, JsonValue> = {};
	let used = 2;
	let complete = true;
	const entries = Object.entries(progress).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined);
	const isPrimitive = (value: JsonValue): boolean =>
		value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string";
	// 顺序是有意的：标量 → 短摘要对象 → 明细数组。续做时最不能丢的东西先占位，
	// 明细按剩余预算逐条收——而不是"超了就把整块 progress 删掉"。
	for (const [key, value] of entries) {
		if (!isPrimitive(value)) continue;
		const size = cost(key, value);
		if (used + size > limit) {
			complete = false;
			continue;
		}
		out[key] = value;
		used += size;
	}
	for (const [key, value] of entries) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
		const nested: Record<string, JsonValue> = {};
		let closed = true;
		for (const [innerKey, innerValue] of Object.entries(value)) {
			if (innerValue === undefined) continue;
			const size = cost(innerKey, innerValue as JsonValue);
			if (Array.isArray(innerValue) || used + size > limit) {
				closed = false;
				continue;
			}
			nested[innerKey] = innerValue as JsonValue;
			used += size;
		}
		if (Object.keys(nested).length > 0) out[key] = nested;
		if (!closed) complete = false;
	}
	for (const [key, value] of entries) {
		if (!Array.isArray(value)) continue;
		const kept: JsonValue[] = [];
		let closed = true;
		for (const item of value) {
			const size = cost("", item) + 1;
			if (used + size > limit) {
				closed = false;
				break;
			}
			kept.push(item);
			used += size;
		}
		if (kept.length > 0) out[key] = kept;
		if (!closed) complete = false;
	}
	return { progress: out, complete };
}
