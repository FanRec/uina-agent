import type { AgentInput } from "../src/agent/loop.js";
import { expect, SubjectHarness, test } from "./harness/index.js";
import { Scenario } from "./harness/provider/scenario.js";

/**
 * 批量受理的唯一判据：多条输入先各自持久入队，全部落队后才调度一次消费。
 * 逐条 `accept()` 会让第一条在 idle 时直启一个完整回合，剩下的只能等它结束——
 * 那正是多份 Completion 串行交付的来源。
 */

function completion(id: string): AgentInput {
	return {
		id,
		mode: "followUp",
		source: {
			kind: "runtime",
			type: "minecraft_completion",
			ref: "minecraft",
			origin: "internal",
			channel: "world",
		},
		text: `完成：${id}`,
	};
}

function scripted(): { harness: SubjectHarness; scenario: Scenario } {
	const scenario = new Scenario();
	scenario.fallback(() => [
		{ kind: "text", text: "收到" },
		{ kind: "finish", reason: "stop" },
	]);
	return { harness: SubjectHarness.create({ scenario }), scenario };
}

test("三条同时到达：先全部入队，再只启动一次消费", async () => {
	const { harness, scenario } = scripted();
	const refs: number[] = [];
	harness.subscribe((event) => {
		if (event.type === "turn_start") refs.push(event.inputRefs?.length ?? 0);
	});
	const outcomes = await harness.subject.acceptBatch([completion("c1"), completion("c2"), completion("c3")]);
	expect(outcomes).toEqual([
		{ id: "c1", accepted: true },
		{ id: "c2", accepted: true },
		{ id: "c3", accepted: true },
	]);
	await harness.waitForIdle();
	// 一次模型请求带走三条：不是"一条独占一个回合"。
	expect(scenario.calls).toHaveLength(1);
	expect(refs).toEqual([3]);
});

test("批量受理不等待模型回合：provider 还卡着时它已经返回", async () => {
	let release: () => void = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const scenario = new Scenario();
	const harness = SubjectHarness.create({
		scenario,
		stream: async (_model, _req, onDelta) => {
			await blocked;
			onDelta({ kind: "text", text: "收到" });
			onDelta({ kind: "finish", reason: "stop" });
		},
	});
	const batch = harness.subject.acceptBatch([completion("c1"), completion("c2")]);
	// 批受理的结算点 = 逐条持久入队完成，不是"这一轮模型跑完"。
	const winner = await Promise.race([
		batch.then((outcomes) => ({ kind: "batch" as const, outcomes })),
		new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 500)),
	]);
	expect(winner.kind).toBe("batch");
	release();
	await new Promise((resolve) => setTimeout(resolve, 20));
	await harness.waitForIdle();
});

test("部分失败：已受理的不回滚，失败项按同一个 id 报告且不可重试", async () => {
	const { harness } = scripted();
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const holding = harness.subject.runActivity(async () => {
		await gate;
	});
	await harness.subject.accept(completion("dup"));
	const outcomes = await harness.subject.acceptBatch([completion("dup"), completion("fresh")]);
	release();
	await holding;
	await harness.waitForIdle();
	expect(outcomes[0]).toMatchObject({ id: "dup", accepted: false, retryable: false });
	expect(outcomes[0]).toMatchObject({ reason: expect.stringContaining("dup") });
	expect(outcomes[1]).toEqual({ id: "fresh", accepted: true });
});

test("一条都没进去时不开空回合", async () => {
	const { harness, scenario } = scripted();
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const holding = harness.subject.runActivity(async () => {
		await gate;
	});
	await harness.subject.accept(completion("taken"));
	const outcomes = await harness.subject.acceptBatch([completion("taken")]);
	release();
	await holding;
	expect(outcomes).toEqual([{ id: "taken", accepted: false, reason: expect.any(String), retryable: false }]);
	expect(scenario.calls).toHaveLength(0);
});

test("用户输入不会被批量入口插队：steer 仍先于普通完成被处理", async () => {
	const scenario = new Scenario();
	scenario.fallback(() => [
		{ kind: "text", text: "收到" },
		{ kind: "finish", reason: "stop" },
	]);
	const harness = SubjectHarness.create({ scenario });
	const seen: string[][] = [];
	harness.subscribe((event) => {
		if (event.type === "turn_start") seen.push([...(event.inputRefs ?? [])]);
	});
	await harness.subject.steer("用户插话");
	await harness.subject.acceptBatch([completion("c1"), completion("c2")]);
	await harness.waitForIdle();
	// steer 单独成批：它不能被普通完成合并进同一次决策。
	expect(seen[0]).toHaveLength(1);
	expect(scenario.calls.length).toBeGreaterThan(1);
});
