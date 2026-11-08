/**
 * 领域目标对账（capabilities §2.12）：四态语义与摘要投影。
 *
 * 两件事必须成立，否则模型在长任务中断后拿不到续做依据：
 * 1. 四态计数之和恒等于 total，`state` 只按观测证据判定；
 * 2. progress 超预算时截断明细而不是整块丢弃——计数与目标状态必须活下来。
 */

import { describe, expect, test } from "vitest";
import {
	GOAL_SAMPLE_LIMIT,
	goalProgress,
	goalStateOf,
	goalSummaryOf,
	sampleOutstanding,
} from "../../.uina/worlds/minecraft/capabilities/shared/goal.js";
import { PROGRESS_PROJECTION_BYTES, projectProgress } from "../../.uina/worlds/minecraft/runtime/rows.js";

describe("goal state", () => {
	test("全部目标都有证据 → satisfied", () => {
		expect(goalStateOf({ total: 4, completed: 4, uncertain: 0 })).toBe("satisfied");
	});

	test("一条证据都没有 → unknown（不能当失败，也不授权重试）", () => {
		expect(goalStateOf({ total: 4, completed: 0, uncertain: 4 })).toBe("unknown");
	});

	test("有未达或部分证据 → unsatisfied", () => {
		expect(goalStateOf({ total: 4, completed: 1, uncertain: 0 })).toBe("unsatisfied");
		expect(goalStateOf({ total: 4, completed: 0, uncertain: 1 })).toBe("unsatisfied");
	});
});

describe("goal summary", () => {
	test("四态之和恒等于 total，且计数被夹在合法区间", () => {
		const goal = goalSummaryOf({ total: 10, completed: 4, blocked: 3, uncertain: 2 });
		expect(goal).toEqual({
			state: "unsatisfied",
			completed: 4,
			remaining: 1,
			blocked: 3,
			uncertain: 2,
			total: 10,
		});
		expect(goal.completed + goal.remaining + goal.blocked + goal.uncertain).toBe(goal.total);
	});

	test("超额计数不会把 remaining 算成负数", () => {
		const goal = goalSummaryOf({ total: 3, completed: 9, blocked: 9 });
		expect(goal.completed).toBe(3);
		expect(goal.remaining).toBe(0);
	});
});

describe("goal progress", () => {
	test("reasons 从明细推导；样本截断时补 not_listed", () => {
		const outstanding = Array.from({ length: GOAL_SAMPLE_LIMIT + 4 }, (_, index) => ({
			at: { x: index, y: 64, z: 0 },
			target: "air",
			reason: index < 2 ? "holds water/lava" : "not attempted yet",
		}));
		const progress = goalProgress({
			phase: "digging",
			total: 30,
			completed: 2,
			blocked: 2,
			outstanding: sampleOutstanding(outstanding),
			extra: { dug: 2 },
		});
		expect(progress.phase).toBe("digging");
		expect(progress.dug).toBe(2);
		expect(progress.goal).toMatchObject({ completed: 2, blocked: 2, total: 30 });
		// 只给样本时直方图按样本推导，未列出的部分折进 not_listed（全量直方图由调用方传 reasons）。
		expect(progress.reasons).toMatchObject({ "holds water/lava": 2, "not attempted yet": 14, not_listed: 12 });
		expect((progress.outstanding as unknown[]).length).toBe(GOAL_SAMPLE_LIMIT);
	});
});

describe("progress projection", () => {
	test("预算内原样返回", () => {
		const progress = { goal: { state: "satisfied" }, dug: 3 };
		const projected = projectProgress(progress, 512);
		expect(projected.complete).toBe(true);
		expect(projected.progress).toEqual(progress);
	});

	test("超预算时保住计数与目标状态，只截断明细", () => {
		const outstanding = Array.from({ length: 200 }, (_, index) => ({
			at: { x: index, y: 64, z: index },
			target: "oak_planks",
			reason: "not attempted yet",
		}));
		const progress = goalProgress({
			phase: "building",
			total: 300,
			completed: 100,
			outstanding,
			extra: { placed: 100, cleared: 0, skipped: 0 },
		});
		expect(Buffer.byteLength(JSON.stringify(progress))).toBeGreaterThan(PROGRESS_PROJECTION_BYTES);
		const projected = projectProgress(progress);
		expect(projected.complete).toBe(false);
		// 这正是旧实现丢掉的东西：目标状态与四态计数。
		expect(projected.progress.goal).toMatchObject({ completed: 100, remaining: 200, total: 300 });
		expect(projected.progress.placed).toBe(100);
		expect(projected.progress.phase).toBe("building");
		expect((projected.progress.outstanding as unknown[]).length).toBeLessThan(200);
		expect(Buffer.byteLength(JSON.stringify(projected.progress))).toBeLessThanOrEqual(PROGRESS_PROJECTION_BYTES);
	});

	test("极端长的字符串也撑不破预算", () => {
		const progress = { summary: "x".repeat(4000), goal: { state: "unsatisfied" }, dug: 1 };
		const projected = projectProgress(progress);
		expect(projected.complete).toBe(false);
		expect(Buffer.byteLength(JSON.stringify(projected.progress))).toBeLessThanOrEqual(PROGRESS_PROJECTION_BYTES);
		expect(projected.progress.dug).toBe(1);
	});
});
