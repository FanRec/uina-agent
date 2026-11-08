import { describe, expect, it } from "vitest";
import { InputQueues, MAX_TURN_CHARS, MAX_TURN_ITEMS } from "../src/agent/queue.js";

/**
 * 「一回合带哪些排队输入」的边界全在队列这一处。
 * 这里用纯函数级夹具钉住五条：优先级、来源边界、世界边界、条数预算、字符预算
 * （含单条超长必须放行的反向边界——没有它，超长条目会永远留在队列里）。
 */

type Draft = { text: string; mode: "steer" | "followUp"; source: Record<string, unknown> };

const runtime = (ref: string) => ({ kind: "runtime", type: "probe", ref, origin: "external" });
const user = { kind: "user", type: "user-input" };

function queues(...drafts: Draft[]): InputQueues {
	const instance = new InputQueues();
	for (const draft of drafts) instance.add(instance.create(draft.text, draft.mode, { source: draft.source as never }));
	return instance;
}

describe("一回合的排队输入批量", () => {
	it("空队列没有可领的东西", () => {
		expect(new InputQueues().batchForTurn()).toBeUndefined();
	});

	it("steer 先走，而且单独成批（它是立刻改变方向的一句话）", () => {
		const instance = queues(
			{ text: "排队的事实", mode: "followUp", source: runtime("minecraft") },
			{ text: "插队的话", mode: "steer", source: runtime("minecraft") },
		);
		expect(instance.batchForTurn()!.map((item) => item.text)).toEqual(["插队的话"]);
	});

	it("用户发言不和任何东西合批", () => {
		const instance = queues(
			{ text: "用户说的", mode: "followUp", source: user },
			{ text: "世界事实", mode: "followUp", source: runtime("minecraft") },
		);
		expect(instance.batchForTurn()!.length).toBe(1);
	});

	it("同一世界的运行时事实合批，条数不超过预算", () => {
		const instance = queues(
			...Array.from({ length: MAX_TURN_ITEMS + 4 }, (_, index) => ({
				text: `事实 ${index}`,
				mode: "followUp" as const,
				source: runtime("minecraft"),
			})),
		);
		expect(instance.batchForTurn()!.length).toBe(MAX_TURN_ITEMS);
	});

	it("字符预算先到就先停，后面的留队", () => {
		const per = Math.floor(MAX_TURN_CHARS / 2) + 1;
		const instance = queues(
			{ text: "x".repeat(per), mode: "followUp", source: runtime("minecraft") },
			{ text: "y".repeat(per), mode: "followUp", source: runtime("minecraft") },
			{ text: "z".repeat(10), mode: "followUp", source: runtime("minecraft") },
		);
		expect(instance.batchForTurn()!.length).toBe(1);
	});

	it("单条就超预算时也必须放行，否则它永远出不去", () => {
		const instance = queues({ text: "x".repeat(MAX_TURN_CHARS * 2), mode: "followUp", source: runtime("minecraft") });
		expect(instance.batchForTurn()!.length).toBe(1);
	});

	it("到了另一个世界就停：两个世界的事不能合成一次决策", () => {
		const instance = queues(
			{ text: "mc-1", mode: "followUp", source: runtime("minecraft") },
			{ text: "qq-1", mode: "followUp", source: runtime("qq") },
			{ text: "mc-2", mode: "followUp", source: runtime("minecraft") },
		);
		expect(instance.batchForTurn()!.map((item) => item.text)).toEqual(["mc-1"]);
	});

	it("只算不改：队列里的条目原样保留（所有权转移仍归 startRun 的移除点）", () => {
		const instance = queues(
			{ text: "a", mode: "followUp", source: runtime("minecraft") },
			{ text: "b", mode: "followUp", source: runtime("minecraft") },
		);
		instance.batchForTurn();
		expect(instance.size).toBe(2);
	});
});
