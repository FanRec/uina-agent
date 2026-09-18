/** 回溯的持久化转换：无事件、无 Subject 状态的纯机制层。
 * Subject 只保留运行安全点调度与事件广播；record 构建、投影推导与 journal
 * 追加都由这里完成，保证持久化纪律单点实现。
 *
 * 回溯不携带压缩：journal 保留全量历史，presented line 每请求由
 * compaction capability 的 transformContext 无状态裁剪重建——回溯重暴露的
 * 超长历史由同一条裁剪路径收敛（L1 一语义一入口）。
 *
 * candidate 提交序（"投影失败 = 不落盘"）：常驻状态只读 → checkRecord 校验 →
 * 在候选切片上先行投影 → 最后 appendRewind（store 内部 isRecord + checkRecord
 * 复核并落常驻状态；其间若有并发追加，fromId 失配即被拒，语义安全）。
 * 不对 records 做第二次全量 fold——常驻 state 即唯一事实。 */
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "../core/types.js";
import { buildRewindCandidateEntry, checkRecord } from "../session/recovery.js";
import type { RewindRequest, SessionRewindRecord, SessionStore } from "../session/types.js";
import type { ResolvedProjection } from "./projection.js";

/** Projection inputs derived from the owning Subject's current facts. */
export interface RewindProjectionContext {
	/** 投影 Replacement 缝的现役实现（owner = Subject；必填，无静默默认）。 */
	projection: ResolvedProjection;
}

export interface RewindCommit {
	rewindId: string;
	fromId: string;
	targetId: string;
	/** Projected mainline after the rewind — the Subject adopts this as-is. */
	history: AgentMessage[];
}

/** The durable rewind transition: record construction, projection and journal
 * append. Throws before appendRewind on any abort, validation failure or
 * unusable projection, so the mainline never moves on a failed commit. */
export async function commitRewindTransition(
	store: SessionStore,
	pending: { request: RewindRequest; source: string; requestId: string; signal?: AbortSignal },
	context: RewindProjectionContext,
	signal: AbortSignal,
): Promise<RewindCommit> {
	pending.signal?.throwIfAborted();
	signal?.throwIfAborted();
	const state = store.state;
	const fromId = state.entries.at(-1)?.id;
	if (!fromId) {
		throw new Error("会话没有可回溯历史");
	}
	// 占位 seq/timestamp：落盘权威在 store.appendRewind（自赋 seq/timestamp）；
	// 候选 entry 的 meta 仅用于投影输入的完整性，投影输出不外显 seq。
	const record: SessionRewindRecord = {
		...pending.request,
		kind: "rewind",
		id: randomUUID(),
		requestId: pending.requestId,
		source: pending.source,
		fromId,
		seq: state.entries.at(-1)?.seq ?? 0,
		timestamp: new Date().toISOString(),
	};
	// 只读校验：非法目标在此拒绝，常驻状态零触碰。
	checkRecord(state, record);
	const targetIndex = state.entries.findIndex((entry) => entry.id === record.targetId);
	const candidateEntry = buildRewindCandidateEntry(state, record);
	// 投影先行：自定义 policy 抛错时 appendRewind 不执行，主线不动。
	// The projection stays derived from the candidate mainline; context-window
	// pressure after the rewind is the capability's per-request trim concern.
	const history = context.projection.projectHistory(
		[...state.entries.slice(0, targetIndex + 1), candidateEntry],
		state,
	);
	await store.appendRewind(record);
	return { rewindId: record.id, fromId, targetId: record.targetId, history };
}
