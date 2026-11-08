import { expect, test } from "vitest";
import type { RunSummary } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { formatActiveRuns } from "../../.uina/worlds/minecraft/world/run-digest.js";

function run(id: string, phase: RunSummary["phase"], summary?: string): RunSummary {
	return {
		run: id,
		phase,
		progress: summary == null ? null : { summary },
	} as unknown as RunSummary;
}

const at = "2026-11-08T05:00:00.000Z";

test("没有活跃任务时不产生这一段", () => {
	expect(formatActiveRuns([], at)).toBeNull();
});

test("一至三条：run、phase、进度摘要逐条给，并标明与世界状态分别采样", () => {
	const text = formatActiveRuns([run("run:1", "running", "挖铁矿 9/16"), run("run:2", "queued")], at);
	expect(text).toBe(
		[
			`[Minecraft 活跃任务]（观测时间：${at}；与世界状态分别采样）`,
			"- run:1 · running · 挖铁矿 9/16",
			"- run:2 · queued",
		].join("\n"),
	);
});

test("等决策的任务说明下一步用哪个动作，而不是只给一个状态名", () => {
	const text = formatActiveRuns([run("run:3", "awaiting_decision", "要挖哪里")], at);
	expect(text).toContain("awaiting_decision（用 runs.continue 推进）");
	expect(text).toContain("要挖哪里");
});

test("超出上限只给有界前缀和剩余数量，正文不随任务数增长", () => {
	const runs = Array.from({ length: 10 }, (_, index) => run(`run:${index}`, "running", `任务 ${index}`));
	const text = formatActiveRuns(runs, at);
	expect(text?.split("\n").filter((line) => line.startsWith("- run:"))).toHaveLength(4);
	expect(text).toContain("- 其余 6 条：runs.list");
});

test("过长的进度摘要截断处留标，不静默吃掉后半句", () => {
	const long = "x".repeat(60);
	const text = formatActiveRuns([run("run:4", "running", long)], at);
	expect(text).toContain(`${"x".repeat(40)}…`);
	expect(text).not.toContain(long);
});

test("空白摘要当作没有摘要，不产生只有分隔符的空行", () => {
	const text = formatActiveRuns([run("run:5", "running", "   ")], at);
	expect(text?.endsWith("- run:5 · running")).toBe(true);
	expect(text).not.toContain("running ·");
});
