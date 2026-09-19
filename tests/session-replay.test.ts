/**
 * replay ≡ memory 不变量守卫：全量 fold 抽查对照机器化。
 * 常驻 canonical 状态（增量 reduceRecord 维护）必须与从头 canonicalReplay
 * 折叠严格一致；planRecovery 必须前缀安全 + 幂等（结构保证而非算法自觉）。
 */
import { describe, expect, it } from "vitest";
import { MemorySessionStore, openJsonlSession } from "../src/session/jsonl-store.js";
import {
	applyRecord,
	canonicalReplay,
	planRecovery,
	projectAgentHistory,
} from "../src/session/recovery.js";
import type { SessionRecord } from "../src/session/types.js";
import { IsolatedEnv, Scenario, SubjectHarness, mockTool } from "./harness/index.js";

/** 每个提交点后的机器守卫：常驻状态 ≡ 全量 fold。 */
function assertReplayEqualsMemory(store: MemorySessionStore): void {
	expect(store.state).toEqual(canonicalReplay(store.readRecords()));
}

describe("replay ≡ memory invariants", () => {
	it("keeps resident state equal to a full fold after every commit, across all record kinds", async () => {
		const store = new MemorySessionStore();
		await store.appendMessage({ role: "user", content: "task" });
		assertReplayEqualsMemory(store);
		const targetId = store.readRecords()[0]!.id;

		await store.appendMessage({ role: "assistant", content: "", tool_calls: [{ id: "c1", name: "probe", args: {} }] });
		assertReplayEqualsMemory(store);
		await store.appendEvent("tool_started", { callId: "c1" });
		assertReplayEqualsMemory(store);
		await store.appendEvent("tool_finished", { callId: "c1", status: "succeeded", result: "ok" });
		assertReplayEqualsMemory(store);
		await store.appendMessage({ role: "tool", tool_call_id: "c1", content: "ok", status: "succeeded" });
		assertReplayEqualsMemory(store);

		// 队列生命周期：enqueued → input（input 记录自身闭合队列项）
		await store.appendEvent("queue_enqueued", { id: "q1", order: 1, mode: "followUp", text: "steer task" });
		assertReplayEqualsMemory(store);
		await store.appendInput({ id: "q1", order: 1, mode: "followUp", text: "steer task" });
		assertReplayEqualsMemory(store);
		expect(store.state.queued.size).toBe(0);

		await store.appendCustomMessage({ customType: "probe", content: "visible", display: true, details: { a: 1 } });
		assertReplayEqualsMemory(store);
		await store.appendCustomEntry({ customType: "private", data: { x: 1 } });
		assertReplayEqualsMemory(store);

		// auxiliary 登记：turn_failed/turn_aborted 仅入 timeline，不改 semantic state
		await store.appendEvent("turn_failed", { turn: 3 });
		assertReplayEqualsMemory(store);
		await store.appendEvent("turn_aborted", { turn: 4 });
		assertReplayEqualsMemory(store);
		expect(store.state.auxiliary.filter((r): r is import("../src/session/types.js").SessionEventRecord => r.kind === "event").map((record) => record.event)).toEqual(["turn_failed", "turn_aborted"]);

		// 回溯：合法目标 + 增量 safeTargets 查询一致
		const fromId = store.state.entries.at(-1)!.id;
		await store.appendRewind({ id: "r1", requestId: "q", targetId, fromId, source: "test", reason: "back to root" });
		assertReplayEqualsMemory(store);
		expect(store.state.safeTargets.has(targetId)).toBe(true);

		// 历史间隙（fold 零合成，replay 不制造事实；恢复只能经持久化落盘）
		await store.appendMessage({ role: "assistant", content: "", tool_calls: [{ id: "c2", name: "probe", args: {} }] });
		assertReplayEqualsMemory(store);
		await store.appendEvent("tool_started", { callId: "c2" });
		assertReplayEqualsMemory(store);
		// L3 unresolved-operation detection：未决期间写入事实记录非法
		// （MemorySessionStore 语义为同步抛出，与既有测试钉点一致）
		expect(() => store.appendMessage({ role: "user", content: "premature" })).toThrow(/未结算/);
		// 恢复经 planRecovery → 带稳定身份落盘（启动恢复语义），之后事实记录恢复合法
		const plan = planRecovery(store.state);
		await store.appendMessage(plan.entries[0]!.message, plan.entries[0]!.id);
		assertReplayEqualsMemory(store);
		expect(store.state.entries.some((entry) => entry.id.startsWith("recovered:"))).toBe(true);
		expect(planRecovery(store.state).entries).toHaveLength(0);
		await store.appendMessage({ role: "user", content: "continue after crash" });
		assertReplayEqualsMemory(store);
	});

	it("makes planRecovery idempotent via the reducer's identity index", async () => {
		const store = new MemorySessionStore();
		await store.appendMessage({ role: "user", content: "task" });
		await store.appendMessage({ role: "assistant", content: "", tool_calls: [{ id: "c1", name: "probe", args: {} }] });
		const originId = store.readRecords()[1]!.id; // 未决调用的 originId = assistant 记录 id

		const plan = planRecovery(store.state);
		expect(plan.entries).toHaveLength(1);
		expect(plan.entries[0]!.id).toBe(`recovered:${originId}:c1`);
		expect(plan.entries[0]!.message).toMatchObject({ role: "tool", tool_call_id: "c1", status: "not_started" });

		// 恢复事实带稳定身份落盘 → 计划收窄为空（幂等）
		await store.appendMessage(plan.entries[0]!.message, plan.entries[0]!.id);
		expect(planRecovery(store.state).entries).toHaveLength(0);
		// reducer 的身份索引拒绝重复恢复记录（结构保证，非算法自觉）
		expect(() => store.appendMessage(plan.entries[0]!.message, plan.entries[0]!.id)).toThrow(/重复记录 id/);
	});

	it("keeps a multi-entry plan resumable from any persisted prefix", () => {
		// 直接以 reduceRecord 语义构造两条未决调用的状态（稳定 originId 经记录 id 进入身份）
		const state = canonicalReplay([
			{ kind: "message", id: "assistant-1", seq: 1, timestamp: "t", message: { role: "user", content: "task" } },
			{
				kind: "message", id: "assistant-2", seq: 2, timestamp: "t",
				message: { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "probe", args: {} }, { id: "c2", name: "probe", args: {} }] },
			},
		] satisfies SessionRecord[]);
		const plan = planRecovery(state);
		expect(plan.entries.map((entry) => entry.id)).toEqual([
			"recovered:assistant-2:c1",
			"recovered:assistant-2:c2",
		]);

		// 任意前缀落盘后再 crash：计划恰好收窄为剩余条目（前缀安全）
		const first = plan.entries[0]!;
		applyRecord(state, { kind: "message", id: first.id, seq: 3, timestamp: "t", message: first.message });
		expect(planRecovery(state).entries).toEqual([plan.entries[1]!]);
		const second = plan.entries[1]!;
		applyRecord(state, { kind: "message", id: second.id, seq: 4, timestamp: "t", message: second.message });
		expect(planRecovery(state).entries).toHaveLength(0);
	});

	it("holds for a real subject run: fold equals resident state and projection equals history", async () => {
		const tool = mockTool("probe", async () => ({ result: "ok", status: "succeeded" }));
		const scenario = Scenario.create()
			.when((req) => req.messages.some((message) => message.role === "tool")).reply("done")
			.when(() => true).replyWithToolCall("call-1", "probe", {});
		const store = new MemorySessionStore();
		const harness = SubjectHarness.create({
			scenario,
			tools: [tool],
			store,
		});
		void harness.pushInput("run with tool");
		await harness.pushInput("second", { mode: "followUp" });
		await harness.waitForIdle();

		assertReplayEqualsMemory(store);
		expect(harness.historySnapshot()).toEqual(projectAgentHistory(canonicalReplay(store.readRecords()).entries));
	});
});

describe("jsonl durable recovery identity", () => {
	it("persists recovery once under its stable identity and never regenerates it", async () => {
		const env = await IsolatedEnv.create();
		try {
			const path = env.resolve("session.jsonl");
			const first = await openJsonlSession(path);
			await first.store.appendMessage({ role: "user", content: "hello" });
			await first.store.appendMessage({ role: "assistant", content: "", tool_calls: [{ id: "call-1", name: "x", args: {} }] });
			await first.store.close();

			const reopened = await openJsonlSession(path);
			const recoveryRecords = reopened.store.readRecords().filter((record) => record.id.startsWith("recovered:"));
			expect(recoveryRecords).toHaveLength(1);
			expect(reopened.store.state.entries.at(-1)!.id).toBe(recoveryRecords[0]!.id);
			const recordCountAfterRecovery = reopened.store.readRecords().length;
			await reopened.store.close();

			// 幂等：再次打开不追加任何新恢复记录
			const again = await openJsonlSession(path);
			expect(again.store.readRecords()).toHaveLength(recordCountAfterRecovery);
			expect(again.store.readRecords().filter((record) => record.id.startsWith("recovered:"))).toHaveLength(1);
			await again.store.close();
		} finally {
			await env.cleanup();
		}
	});
});
