import type { BodyEndpoint, BodyState, ExpressiveCueDef } from "../../../src/extensions/world-framework/seams.js";
import { SupersededError } from "./director/director.js";
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
	const resolveCue = (cueId: string): { kind: "motion" | "posture"; name: string } | undefined => {
		const view = runtime.catalogView;
		for (const [name, motion] of view.motions) {
			if (name === cueId || motion.aliases?.includes(cueId)) return { kind: "motion", name };
		}
		if (view.postures.has(cueId)) return { kind: "posture", name: cueId };
		return undefined;
	};

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
			const cues: ExpressiveCueDef[] = [
				...[...view.motions.entries()].map(([id, motion]) => ({
					id,
					description: motion.description,
					...(motion.aliases?.length ? { aliases: motion.aliases } : {}),
				})),
				...[...view.postures.entries()].map(([id, posture]) => ({ id, description: `[姿态] ${posture.description}` })),
			];
			return {
				bodyId: "live2d",
				bodyType: "avatar_2d",
				description: "Live2D 具身身体。cue 来自已发布目录的命名动作与姿态；持续性状态用 state 工具。",
				cues,
			};
		},
		state,
		supportsCue: (cueId) => resolveCue(cueId) !== undefined,
		emitCue: (cueId) => {
			const entry = emitRecord(cueId);
			void (async () => {
				// 受理时代次绑定：执行前目录已更新的按执行时事实拒绝（§3，支持性守卫——同步启动下窗口趋零）。
				const generation = runtime.currentGeneration;
				if (runtime.isPaused) return updateRecord(entry, "rejected", "paused");
				const resolved = resolveCue(cueId);
				if (!resolved) return updateRecord(entry, "rejected", "unknown_cue");
				if (generation !== runtime.currentGeneration) return updateRecord(entry, "rejected", "stale_catalog");
				const director = runtime.director;
				if (!director) return updateRecord(entry, "rejected", "no_engine");
				updateRecord(entry, "started");
				if (resolved.kind === "motion") {
					// cue 优先级固定 Voluntary（§3）；atomic 取目录声明（命名表演默认 true）。
					const motionEntry = runtime.catalogView.motions.get(resolved.name)!;
					const result = await runtime.playMotion(motionEntry);
					const detailReason = (result.details as { reason?: string } | undefined)?.reason;
					if (result.status === "failed" && detailReason) {
						// 工具层拒绝（paused/model_not_ready 等）：执行未开始，记 rejected 而非 finished。
						updateRecord(entry, "rejected", detailReason);
						return;
					}
					const reason = detailReason ?? (result.status === "succeeded" ? undefined : result.status);
					updateRecord(entry, "finished", reason);
					return;
				}
				const posture = runtime.catalogView.postures.get(resolved.name)!;
				try {
					await director.setPosture(posture.values, { durationMs: posture.transitionMs });
					updateRecord(entry, "finished");
				} catch (error) {
					updateRecord(entry, "finished", error instanceof SupersededError ? "superseded" : "failed");
				}
			})();
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
