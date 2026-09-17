/** 回溯的持久化转换与投影压缩：无事件、无 Subject 状态的纯机制层。
 * Subject 只保留运行安全点调度与事件广播；record 构建、投影推导、超限压缩
 * 与 journal 追加都由这里完成，保证"先测量、后落盘"的持久化纪律单点实现。 */
import { randomUUID } from "node:crypto";
import type { Compactor } from "../core/compaction.js";
import type { AgentMessage, Model, ModelStreamFn, ToolDef } from "../core/types.js";
import type { ProviderHooks } from "../runtime/hooks.js";
import { applyRecord, canonicalReplay, checkRecord, projectAgentHistory } from "../session/recovery.js";
import type { RewindRequest, SessionRewindRecord, SessionStore } from "../session/types.js";
import {
	resolveCompactionResult,
	findCutPoint,
	type CompactionResult,
} from "./compaction.js";
import { buildContext, estimateContextTokens } from "./context.js";

/** One wording for every way an oversized rewind is refused; the mainline never moves in these cases. */
export const OVERSIZED_REWIND = "回溯后的上下文估算超过模型上限；主线未改变，请选择其他目标或纠错方式";

/** Projection/compaction inputs derived from the owning Subject's current facts. */
export interface RewindProjectionContext {
	model: Model;
	systemPrompt: string;
	tools: readonly ToolDef[];
	keepRecentTokens: number;
	compactor?: Compactor;
	/** 默认压缩算法的传输与 hooks；仅在投影超限触发压缩时使用。 */
	stream: ModelStreamFn;
	providerHooks: ProviderHooks;
}

export interface RewindCommit {
	rewindId: string;
	fromId: string;
	targetId: string;
	/** Projected mainline after the rewind (and its optional compaction) — the Subject adopts this as-is. */
	history: AgentMessage[];
	compacted: CompactionResult | null;
}

/**
 * A rewind can re-expose history that was already compacted away, so the projected main line is
 * measured before it is persisted. Returns a fitting compaction, or null when the projection
 * already fits the model window; throws when compaction cannot bring it back under the window.
 */
export async function compactProjectionForRewind(
	history: AgentMessage[],
	estimated: number,
	context: RewindProjectionContext,
	signal: AbortSignal,
): Promise<CompactionResult | null> {
	const contextWindow = context.model.contextWindow;
	if (contextWindow === undefined || estimated <= contextWindow) return null;
	const cutPoint = findCutPoint(history, context.keepRecentTokens, false);
	if (cutPoint.firstKeptEntryIndex <= 0) throw new Error(OVERSIZED_REWIND);
	const proposal = await context.compactor?.(
		{
			reason: "automatic",
			history,
			suggestedKeepFrom: cutPoint.firstKeptEntryIndex,
			tokensBefore: estimated,
			model: context.model,
			instruction: "由于回溯使历史重新展开导致上下文超限，请压缩前期历史",
		},
		signal,
	);
	let prepared: CompactionResult | null;
	// 指令只约束外部 compactor；默认算法在回溯路径保持与压缩前一致的无指令行为。
	prepared = await resolveCompactionResult(proposal, history, cutPoint, estimated, {
		model: context.model,
		stream: context.stream,
		providerHooks: context.providerHooks,
		signal,
	});
	if (!prepared) throw new Error(OVERSIZED_REWIND);
	signal.throwIfAborted();
	const after = estimateContextTokens(
		buildContext({
			history: [
				{
					role: "compactionSummary",
					summary: prepared.summary,
					content: "[历史摘要] " + prepared.summary,
					tokensBefore: prepared.tokensBefore,
				},
				...prepared.retainedTail,
			],
			systemPrompt: context.systemPrompt,
		}),
		{ tools: context.tools, includeThinking: context.model.includeThinking },
	).tokens;
	if (after > contextWindow) {
		throw new Error(
			`${OVERSIZED_REWIND}：压缩后仍约 ${after} tokens，模型上限 ${contextWindow}`,
		);
	}
	return prepared;
}

/** The durable rewind transition: record construction, projection, pre-persist
 * compaction and journal append. Throws before appendRewind on any abort or
 * unusable projection, so the mainline never moves on a failed commit. */
export async function commitRewindTransition(
	store: SessionStore,
	pending: { request: RewindRequest; source: string; requestId: string; signal?: AbortSignal },
	context: RewindProjectionContext,
	signal: AbortSignal,
): Promise<RewindCommit> {
	pending.signal?.throwIfAborted();
	signal?.throwIfAborted();
	const records = [...store.readRecords()];
	// 回溯提交是校验路径：全量 fold 一次，之后 check/apply 两相推进候选状态。
	const state = canonicalReplay(records);
	const fromId = state.entries.at(-1)?.id;
	if (!fromId) {
		throw new Error("会话没有可回溯历史");
	}
	const record: SessionRewindRecord = {
		...pending.request,
		kind: "rewind",
		id: randomUUID(),
		requestId: pending.requestId,
		source: pending.source,
		fromId,
		seq: (records.at(-1)?.seq ?? 0) + 1,
		timestamp: new Date().toISOString(),
	};
	checkRecord(state, record);
	// The projection stays derived from records; an oversized rewind is compacted before it is
	// persisted so a committed rewind never leaves an unusable context behind.
	applyRecord(state, record);
	const history = projectAgentHistory(state.entries);
	const estimated = estimateContextTokens(
		buildContext({ history, systemPrompt: context.systemPrompt }),
		{ tools: context.tools, includeThinking: context.model.includeThinking },
	).tokens;
	const compacted = await compactProjectionForRewind(history, estimated, context, pending.signal ?? signal);

	pending.signal?.throwIfAborted();
	signal?.throwIfAborted();
	// Persist rewind and its optional compaction as one durable transition.
	// 嵌入压缩只改变同一条回溯记录的持久形态，合法性已由 checkRecord 覆盖。
	let finalHistory = history;
	if (compacted) {
		const finalRecord = { ...record, compaction: compacted };
		const finalState = canonicalReplay(records);
		applyRecord(finalState, finalRecord);
		finalHistory = projectAgentHistory(finalState.entries);
		await store.appendRewind(finalRecord);
	} else {
		await store.appendRewind(record);
	}
	return { rewindId: record.id, fromId, targetId: record.targetId, history: finalHistory, compacted };
}
