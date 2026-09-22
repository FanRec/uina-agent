/**
 * 认知扩展阶段 E / M6：可选整理 worker（手动触发第一版；automaticConsolidation 默认关闭）。
 *
 * 不变量（plan §8 / design §10 / 备忘 §3.6）：
 * 1. 无新材料 → 零模型调用（水位之上的空范围直接完成，不空转"做梦"）；
 * 2. 重复触发只合并水位：水位已覆盖的证据范围不重复调模型；
 * 3. 输出仅限已有记录的 revise/retire patch（第一版不批量造新事实）；
 *    提交经 store 同一 writer（expectedHash 冲突 → conflict，不覆盖前台写入）；
 * 4. 同一 entryId 的重复转述合并为单份证据（重复转述不算多份支持）；
 * 5. generation guard：close() 推进 generation，迟到的 run 结果整批丢弃，
 *    不提交、不假报成功（status=aborted）；
 * 6. Provider 取消语义双轨：close() 向在途 run 发 abort 信号；
 *    响应取消的 Provider 正常结算；不响应的——closeReport 显示"仍在关闭"，
 *    isSettled() 为 false，绝不假报完成，也绝不释放后重开（换人由上层锁语义保护）。
 * 7. 水位持久化到 state/cognition.json（整理状态属扩展运行状态，进同一状态文件）。
 *
 * worker 只读证据（listEvidence 由装配方注入），不持有真实外部动作工具；
 * 迟到模型输出不会直接产生外部副作用。
 */

import { readCognitionState, updateCognitionState } from "./cognition-state.js";
import type { MemoryStore, MemoryWriteResult } from "./memory.js";

export interface ConsolidationEvidence {
	sessionId: string;
	entryId?: string;
	text: string;
}

/** 整理模型的输入：只读证据 + 当前记录（含 hash），不含真实工具。 */
export interface ConsolidationModelInput {
	subjectId: string;
	evidence: ConsolidationEvidence[];
	/** 当前记录快照（供模型核对 expectedHash）。 */
	records: Array<{ id: string; title: string; body: string; hash: string; revision: number; status: string }>;
}

/** 整理输出：仅限 revise/retire（不造新记忆）。 */
export type ConsolidationPatch =
	| { op: "revise"; id: string; expectedHash: string; record: { title?: string; body?: string; pinned?: boolean; rationale?: string } }
	| { op: "retire"; id: string; expectedHash: string; reason: string };

export interface ConsolidationRunResult {
	status: "completed" | "aborted";
	patchesSubmitted: number;
	conflicts: number;
	modelCalls: number;
}

export interface ConsolidationWorkerOptions {
	store: MemoryStore;
	stateRoot: string;
	subjectId?: string;
	/** 证据来源（装配方注入，只读）。 */
	listEvidence: () => ConsolidationEvidence[];
	/** 整理模型调用（独立取消信号；Provider 取消语义由此接缝决定能否安全关闭）。 */
	runModel: (input: ConsolidationModelInput, signal?: AbortSignal) => Promise<ConsolidationPatch[]>;
	/** 模型调用前钩子（测试用：注入前台竞争写入）。 */
	onModelCalled?: () => Promise<void>;
}


export interface ConsolidationWorker {
	run(): Promise<ConsolidationRunResult>;
	close(reason: string): Promise<void>;
	/** run 是否已完全结算（不响应取消的 Provider 会使其保持 false——不假报完成）。 */
	isSettled(): boolean;
	closeReport(): Promise<{ closed: boolean; providerSettled: boolean; message: string }>;
}

export function createConsolidationWorker(options: ConsolidationWorkerOptions): ConsolidationWorker {
	const { store, stateRoot, listEvidence, runModel, onModelCalled } = options;
	const controller = new AbortController();
	let closed = false;
	let closeReason = "";
	let settled = true; // 无在途 run 时视为已结算

	async function persistWatermark(watermark: number): Promise<void> {
		await updateCognitionState(stateRoot, (state) => ({ ...state, consolidationWatermark: watermark }));
	}

	async function run(): Promise<ConsolidationRunResult> {
		if (closed) throw new Error(`整理 worker 已关闭（${closeReason}），不再接受新任务`);
		settled = false;
		const generation = { aborted: false };
		const onAbort = () => {
			generation.aborted = true;
		};
		controller.signal.addEventListener("abort", onAbort);

		const runTask = (async (): Promise<ConsolidationRunResult> => {
			// 水位合并：只整理水位之上的新材料。
			const watermark = readCognitionState(stateRoot).consolidationWatermark ?? 0;
			const all = listEvidence();
			const pending = all.slice(watermark);
			if (pending.length === 0) {
				return { status: "completed", patchesSubmitted: 0, conflicts: 0, modelCalls: 0 };
			}

			// 重复转述合并：同一 entryId 只算一份证据（重复转述不算多份支持）。
			const seen = new Set<string>();
			const merged: ConsolidationEvidence[] = [];
			for (const item of pending) {
				const key = item.entryId ?? `${item.sessionId}:${item.text}`;
				if (seen.has(key)) continue;
				seen.add(key);
				merged.push(item);
			}

			// 真实记录快照（修 C1：search("") 恒空是自我欺骗；listActive 才是列举接口）。
			const records = (await store.listActive()).map((record) => ({
				id: record.id,
				title: record.title,
				body: record.body,
				hash: record.hash,
				revision: record.revision,
				status: record.status,
			}));

			await onModelCalled?.();
			if (generation.aborted) return { status: "aborted", patchesSubmitted: 0, conflicts: 0, modelCalls: 0 };

			const patches = await runModel({ subjectId: options.subjectId ?? "", evidence: merged, records }, controller.signal);
			if (generation.aborted) return { status: "aborted", patchesSubmitted: 0, conflicts: 0, modelCalls: 1 };

			// 逐条独立提交：部分提交有效，失败不重放旧 patch。
			let patchesSubmitted = 0;
			let conflicts = 0;
			for (const patch of patches) {
				if (generation.aborted) break;
				const change = patch as unknown as Parameters<MemoryStore["write"]>[0];
				if (change.op !== "revise" && change.op !== "retire") continue; // 不造新记忆
				const result: MemoryWriteResult = await store.write(change);
				if (result.status === "committed") patchesSubmitted++;
				else if (result.status === "conflict") conflicts++;
				// rejected：丢弃并继续（前台已遗忘/不存在的目标）
			}

			// 提交后推进水位（水位不能替代实际写成功：仅统计提交/冲突后推进）。
			await persistWatermark(watermark + pending.length);
			return { status: "completed", patchesSubmitted, conflicts, modelCalls: 1 };
		})();

		try {
			const result = await runTask;
			return result;
		} catch (error) {
			if (generation.aborted || closed) {
				// 关闭引发的取消：不假报成功。
				return { status: "aborted", patchesSubmitted: 0, conflicts: 0, modelCalls: 0 };
			}
			throw error;
		} finally {
			controller.signal.removeEventListener("abort", onAbort);
			settled = true;
		}
	}

	async function close(reason: string): Promise<void> {
		if (closed) return;
		closed = true;
		closeReason = reason;
		// 发出取消信号；不 await pending（不响应取消的 Provider 会挂起——由 closeReport 如实报告）。
		controller.abort();
	}

	async function closeReport(): Promise<{ closed: boolean; providerSettled: boolean; message: string }> {
		if (!closed) return { closed: false, providerSettled: settled, message: "运行中" };
		if (settled) return { closed: true, providerSettled: true, message: "已关闭" };
		return { closed: true, providerSettled: false, message: "仍在关闭：Provider 未响应取消" };
	}

	return { run, close, isSettled: () => settled, closeReport };
}
