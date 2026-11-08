/**
 * 领域目标对账的公共投影：四种工作事实 + 统一的 progress 形状。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §2.15。
 *
 * 这里**不接管**各领域的计划与执行算法——走廊怎么规划、清盒怎么分层、施工怎么分批
 * 仍是各动作自己的事。公共层只做两件在四处被重复实现的事：
 * 1. 把"已完成 / 已确认未达 / 已知阻碍 / 证据不足"折算成同一个 `GoalSummary`；
 * 2. 把明细压成有界样本 + 原因直方图，使 progress 在 2048 字节投影预算内仍然
 *    说明"还剩什么、为什么"。
 *
 * 不建 Goal Engine：可确定的目标由能力闭环，复合目标由 Program/LLM 组合。
 */

import type { GoalState, GoalSummary, JsonValue, Progress, Vec3 } from "../../contracts/values.js";

/** 计划内尚未完成的格/单元；`reason` 是给模型看的归因，不是错误码。 */
export interface GoalOutstanding {
	at?: Vec3;
	target: string;
	reason: string;
}

export interface GoalWorkInput {
	/** 阶段标签（"clearing" / "building" / "walking"），让模型知道卡在哪一段。 */
	phase?: string;
	/** 本次固定目标的规模。四态之和恒等于它。 */
	total: number;
	completed: number;
	blocked?: number;
	uncertain?: number;
	/** 未完成明细的有界样本（调用方自行截断）。 */
	outstanding?: GoalOutstanding[];
	/** 原因直方图；不传时按 outstanding 推导。 */
	reasons?: Record<string, number>;
	/** 固定目标身份摘要（蓝图/设计 digest），防止恢复期静默换设计。 */
	digest?: string;
	/** 当前站位，供"接下来往哪走"的判断使用。 */
	current?: Vec3;
	/** 领域自有计数（dug/placed/mined/...）原样并进 progress。 */
	extra?: Record<string, JsonValue | undefined>;
}

/**
 * 目标状态只按观测证据判定：
 * - satisfied：全部目标都有证据支持已成立；
 * - unknown：一条证据都没有（全部不可观测），不能当失败、也不授权重试；
 * - unsatisfied：其余——计划期读过现场、或执行期确认过差异。
 *
 * 注意它与 Outcome 无关：Run 被取消时目标可能已经成立，旧 Run 的终态不倒改。
 */
export function goalStateOf(work: { total: number; completed: number; uncertain: number }): GoalState {
	if (work.completed >= work.total) return "satisfied";
	if (work.completed === 0 && work.uncertain >= work.total) return "unknown";
	return "unsatisfied";
}

export function goalSummaryOf(input: GoalWorkInput): GoalSummary {
	const completed = Math.max(0, Math.min(input.total, input.completed));
	const blocked = Math.max(0, input.blocked ?? 0);
	const uncertain = Math.max(0, input.uncertain ?? 0);
	return {
		state: goalStateOf({ total: input.total, completed, uncertain }),
		completed,
		remaining: Math.max(0, input.total - completed - blocked - uncertain),
		blocked,
		uncertain,
		total: input.total,
	};
}

function reasonsOf(input: GoalWorkInput, goal: GoalSummary): Record<string, number> {
	if (input.reasons != null) return input.reasons;
	const counts: Record<string, number> = {};
	for (const entry of input.outstanding ?? []) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
	// 明细样本被截断时，直方图仍是全量的：把未列出的部分折成一条。
	const listed = input.outstanding?.length ?? 0;
	const unlisted = goal.remaining + goal.blocked + goal.uncertain - listed;
	if (unlisted > 0) counts.not_listed = (counts.not_listed ?? 0) + unlisted;
	return counts;
}

/**
 * 统一 progress：`goal` 是短摘要（永远在投影预算内），`outstanding` 是有界样本，
 * `reasons` 是全量直方图。完整明细仍在本次 Call 记录里（`runs record` 可读）。
 */
export function goalProgress(input: GoalWorkInput): Progress {
	const goal = goalSummaryOf(input);
	const outstanding = input.outstanding ?? [];
	return {
		...(input.phase != null ? { phase: input.phase } : {}),
		goal: goal as unknown as JsonValue,
		...(outstanding.length > 0 ? { outstanding: outstanding as unknown as JsonValue } : {}),
		reasons: reasonsOf(input, goal),
		...(input.digest != null ? { digest: input.digest } : {}),
		...(input.current != null ? { current: input.current as unknown as JsonValue } : {}),
		...(input.extra ?? {}),
	};
}

/**
 * 明细样本的字节预算：progress 投影上限 2048 字节，摘要本身约 200 字节；
 * 单条明细（坐标 + 目标 + 原因）约 90 字节。取 16 条留足余量。
 */
export const GOAL_SAMPLE_LIMIT = 16;

/** 取前 `limit` 条明细，其余由 reasons 的 not_listed 承担。 */
export function sampleOutstanding(entries: GoalOutstanding[], limit = GOAL_SAMPLE_LIMIT): GoalOutstanding[] {
	return entries.length <= limit ? entries : entries.slice(0, limit);
}
