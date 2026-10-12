import type { BodyEndpoint, BodyState, ExpressiveCueDef } from "../../../src/extensions/world-framework/seams.js";
import type { Live2DRuntime } from "./runtime.js";

/**
 * Live2D 具身端点（P4-2，边界规范 §3）。
 *
 * - affordance/supportsCue 与目录视图**严格同源**（同一次 catalogView 快照 + 同一解析函数），
 *   未发布时目录视图为空 → 双双为空（边界 #1；2026-09-21 别名 cue 静默丢失缺陷的反面）；
 * - emitCue void、fire-and-forget：受理同步记账并启动执行，终态回调异步落账；
 * - lastCue 记账：{seq, id, state, reason?, at}，seq 世界内单调递增；迟到回调按自身 seq
 *   定位条目更新，结构上不可能覆盖更大 seq 的记录（边界 #14）；
 * - onFocus 幂等：参数失焦冻结、回焦恢复剩余；空间表演失焦取消并归位（边界 #5）；
 * - interrupt 回合打断（P4-8）：取消瞬时动作、口型直清、不进入 paused；thinking 停止随 P4-4 宿主事件接入。
 */

export interface CueRecord {
	readonly seq: number;
	readonly id: string;
	state: "received" | "started" | "finished" | "rejected";
	reason?: string;
	at: string;
}

/** Live2D 端点 = BodyEndpoint 契约 + lastCue 账本只读出口（status/diagnose 消费）。 */
export interface Live2DEndpoint extends BodyEndpoint {
	lastCue(): readonly CueRecord[];
}

/** 账本容量：status/diagnose 输出近期事实，完整历史属于会话记录层。 */
const LAST_CUE_HISTORY = 20;

export function buildLive2DEndpoint(runtime: Live2DRuntime): Live2DEndpoint {
	let seqCounter = 0;
	const ledger: CueRecord[] = [];

	const emitRecord = (id: string): CueRecord => {
		const entry: CueRecord = { seq: ++seqCounter, id, state: "received", at: new Date().toISOString() };
		ledger.push(entry);
		if (ledger.length > LAST_CUE_HISTORY) ledger.splice(0, ledger.length - LAST_CUE_HISTORY);
		return entry;
	};
	// 迟到回调只更新自身 seq 的条目（条目被历史裁剪则丢弃）——不覆盖更大 seq 的记录。
	const updateRecord = (entry: CueRecord, state: CueRecord["state"], reason?: string): void => {
		if (!ledger.includes(entry)) return;
		entry.state = state;
		if (reason === undefined) delete entry.reason;
		else entry.reason = reason;
		entry.at = new Date().toISOString();
	};

	/**
	 * cue 解析：affordance 与 supportsCue 的唯一判定源——与目录视图（含别名）同源。
	 * cue 命中：已发布命名动作（含别名）与姿态；表情/注视不是 cue（走 state 工具）。
	 */
	const resolveCue = (id: string) => runtime.catalogView.resolveCue(id);

	const state = (): BodyState => ({
		online: runtime.connectionOnline && runtime.identityMatched(),
		paused: runtime.isPaused,
		...(runtime.fault ? { fault: runtime.fault } : {}),
	});

	return {
		bodyId: "live2d",
		bodyType: "avatar_2d",
		affordance: () => {
			const view = runtime.catalogView;
   const cues: ExpressiveCueDef[] = [...view.list("motion"), ...view.list("posture")].map(({ name: id, entry, aliases, kind }) => ({ id, description: kind === "posture" ? `[姿态] ${entry.description}` : entry.description, ...(aliases.length ? { aliases } : {}) }));
			return {
				bodyId: "live2d",
				bodyType: "avatar_2d",
				description: "Live2D 具身身体。cue 来自已发布目录的命名动作与姿态；持续性状态用 state 工具。",
				cues,
			};
		},
		state,
		supportsCue: (cueId) => resolveCue(cueId) !== undefined,
  emitCue: (id) => {
   const entry = emitRecord(id);
   void runtime.executeCue(id, () => updateRecord(entry, "started")).then((result) => {
    const reason = (result.details as { reason?: string } | undefined)?.reason ?? (result.status === "succeeded" ? undefined : result.status);
    updateRecord(entry, entry.state === "received" ? "rejected" : "finished", reason);
   }).catch(() => updateRecord(entry, entry.state === "received" ? "rejected" : "finished", "execution_failed"));
  },
		safeStop: () => runtime.safeStop(),
		resume: () => runtime.resume(),
		/** 回合打断（§3）：取消瞬时动作、口型直清、不进入 paused；thinking 停止随 P4-4 宿主事件接入。 */
		interrupt: () => runtime.interrupt(),
		onFocus: (focused) => runtime.setFocused(focused),
		formatStatus: () => runtime.formatStatus(),
		lastCue: () => [...ledger],
	};
}
