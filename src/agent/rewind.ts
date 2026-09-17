/** 回溯的持久化转换：无事件、无 Subject 状态的纯机制层。
 * Subject 只保留运行安全点调度与事件广播；record 构建、投影推导与 journal
 * 追加都由这里完成，保证持久化纪律单点实现。
 *
 * P6c 裁定：回溯不再携带嵌入压缩（旧 compactProjectionForRewind 退役）。
 * journal 保留全量历史（P6b），presented line 每请求由 capability 的
 * transformContext 无状态裁剪重建——回溯重暴露的超长历史由同一条裁剪路径
 * 收敛（L1 一语义一入口），超限拒绝门随之失去存在理由。旧 journal 中 rewind
 * record 的 compaction 载荷仍由投影解释（legacy 读取器，recovery.ts）。 */
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "../core/types.js";
import { applyRecord, canonicalReplay, checkRecord } from "../session/recovery.js";
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
 * append. Throws before appendRewind on any abort or unusable projection, so
 * the mainline never moves on a failed commit. */
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
	// The projection stays derived from records; context-window pressure after the
	// rewind is the capability's per-request trim concern, not a commit-time cut.
	applyRecord(state, record);
	const history = context.projection.projectHistory(state.entries, state);
	await store.appendRewind(record);
	return { rewindId: record.id, fromId, targetId: record.targetId, history };
}
