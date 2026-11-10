/**
 * 请求前状态帧里的活跃任务段（批41）。
 *
 * 只回答"我已经交代出去的任务里还有哪些没结束"。它不是事件、不推送、不 ACK：
 * 和世界事实在同一个 state.snapshot 里组合，省掉模型为了确认任务在不在而反复调
 * tasks.get。详细执行证据可按需从 tasks.trace 读取。
 *
 * 两段是分别采样的：世界事实来自 facts.sample 的一个提交边界，任务列表来自
 * Runtime 的一次查询。正文里各自标时间，不合成一个"原子快照"。
 */

import type { Entry, RunSummary } from "../contracts/runtime.js";
import { taskHandle, taskIdentity } from "../contracts/task.js";

/** 最多列几条：超出只给数量。状态帧每次请求都会出现，不能变成任务日志。 */
export const MAX_ACTIVE_TASKS = 4;
export interface ActiveTaskFrame {
	items: RunSummary[] | null;
	omitted: number;
	sampledAt: string;
}
/** 单条进度摘要上限：截断处留标，静默截断会让模型把半句话当完整结论。 */
const MAX_SUMMARY = 40;

function clip(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function runLine(run: RunSummary, profileId?: string, entry?: Entry): string {
	// awaiting_decision 是"只有模型能推进"的状态，光给 phase 名不够：得说清下一步用哪个动作。
	const phase = run.phase === "awaiting_decision" ? "needs_input（用 tasks.get 查当前决策）" : String(run.phase);
	const parts = [profileId ? taskHandle(profileId, run.rootRequestId) : run.run];
	const identity = taskIdentity(entry);
	if (profileId || entry) parts.push([identity.label, identity.goal].filter(Boolean).join(" "));
	parts.push(phase);
	const summary = run.progress?.summary;
	if (typeof summary === "string" && summary.trim() !== "") parts.push(clip(summary.trim(), MAX_SUMMARY));
	else if (
		run.progressComplete &&
		entry?.kind === "call" &&
		entry.selector === "collect@1" &&
		typeof run.progress?.acquired === "number"
	)
		parts.push(`已入包 ${run.progress.acquired}`);
	return `- ${parts.join(" · ")}`;
}

/**
 * `runs === null` 表示这次 Runtime 查询没读到，和"查到 0 条"是两回事：后者可以不占
 * 每回合的 token，前者必须写出"未知"。留白会被模型读成"没有活跃任务"，而状态帧里
 * 把缺失当成"没变化"比不给状态更危险（world.md §9.5）。
 */
export function formatActiveRuns(
	runs: readonly RunSummary[] | null,
	sampledAt: string,
	profileId?: string,
	entries?: ReadonlyMap<string, Entry>,
	omitted = 0,
): string | null {
	if (runs === null)
		return [
			`[Minecraft 活跃任务]（观测时间：${sampledAt}；本次查询失败）`,
			"- 本次未能读取任务列表，这不代表没有活跃任务；需要确认请 tasks.list",
		].join("\n");
	if (runs.length === 0) return null;
	const lines = runs.slice(0, MAX_ACTIVE_TASKS).map((run) => runLine(run, profileId, entries?.get(run.rootRequestId)));
	const folded = runs.length - lines.length + omitted;
	return [
		`[Minecraft 活跃任务]（观测时间：${sampledAt}；与世界状态分别采样）`,
		...lines,
		...(folded > 0 ? [`- 其余 ${folded} 条：tasks.list`] : []),
	].join("\n");
}
