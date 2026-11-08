/**
 * 请求前状态帧里的活跃任务段（批41）。
 *
 * 只回答"我已经交代出去的任务里还有哪些没结束"。它不是事件、不推送、不 ACK：
 * 和世界事实在同一个 state.snapshot 里组合，省掉模型为了确认任务在不在而反复调
 * runs.status。详细进度、effect 与终态仍然只在 runs.record / runs.status 里。
 *
 * 两段是分别采样的：世界事实来自 facts.sample 的一个提交边界，任务列表来自
 * Runtime 的一次查询。正文里各自标时间，不合成一个"原子快照"。
 */

import type { RunSummary } from "../contracts/runtime.js";

/** 最多列几条：超出只给数量。状态帧每次请求都会出现，不能变成任务日志。 */
const MAX_RUNS = 4;
/** 单条进度摘要上限：截断处留标，静默截断会让模型把半句话当完整结论。 */
const MAX_SUMMARY = 40;

function clip(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function runLine(run: RunSummary): string {
	// awaiting_decision 是"只有模型能推进"的状态，光给 phase 名不够：得说清下一步用哪个动作。
	const phase = run.phase === "awaiting_decision" ? "awaiting_decision（用 runs.continue 推进）" : String(run.phase);
	const parts = [run.run, phase];
	const summary = run.progress?.summary;
	if (typeof summary === "string" && summary.trim() !== "") parts.push(clip(summary.trim(), MAX_SUMMARY));
	return `- ${parts.join(" · ")}`;
}

/**
 * `runs === null` 表示这次 Runtime 查询没读到，和"查到 0 条"是两回事：后者可以不占
 * 每回合的 token，前者必须写出"未知"。留白会被模型读成"没有活跃任务"，而状态帧里
 * 把缺失当成"没变化"比不给状态更危险（world.md §9.5）。
 */
export function formatActiveRuns(runs: readonly RunSummary[] | null, sampledAt: string): string | null {
	if (runs === null)
		return [
			`[Minecraft 活跃任务]（观测时间：${sampledAt}；本次查询失败）`,
			"- 本次未能读取任务列表，这不代表没有活跃任务；需要确认请 runs.list",
		].join("\n");
	if (runs.length === 0) return null;
	const lines = runs.slice(0, MAX_RUNS).map(runLine);
	const folded = runs.length - lines.length;
	return [
		`[Minecraft 活跃任务]（观测时间：${sampledAt}；与世界状态分别采样）`,
		...lines,
		...(folded > 0 ? [`- 其余 ${folded} 条：runs.list`] : []),
	].join("\n");
}
