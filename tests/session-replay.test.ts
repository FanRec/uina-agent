/**
 * P3a replay ≡ memory 不变量守卫（执行稿 v6：全量 fold 抽查对照机器化）。
 * 常驻 canonical 状态（增量 reduceRecord 维护）必须与从头 canonicalReplay
 * 折叠严格一致；planRecovery 必须前缀安全 + 幂等（结构保证而非算法自觉）。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySessionStore, openJsonlSession } from "../src/session/jsonl-store.js";
import {
	applyRecord,
	canonicalReplay,
	planRecovery,
	projectAgentHistory,
} from "../src/session/recovery.js";
import type { SessionRecord } from "../src/session/types.js";
import { Subject } from "../src/agent/loop.js";
import { ToolBroker } from "../src/tools/broker.js";
import type { Tool } from "../src/tools/broker.js";
import { scriptedProvider } from "./helpers/mock-provider.js";

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
		await store.appendCompaction("summary", [{ role: "assistant", content: "partial" }], 42);
		assertReplayEqualsMemory(store);

		// auxiliary 登记：turn_failed/turn_aborted 仅入 timeline，不改 semantic state
		await store.appendEvent("turn_failed", { turn: 3 });
		assertReplayEqualsMemory(store);
		await store.appendEvent("turn_aborted", { turn: 4 });
		assertReplayEqualsMemory(store);
		expect(store.state.auxiliary.map((record) => record.event)).toEqual(["turn_failed", "turn_aborted"]);

		// 回溯：合法目标 + 增量 safeTargets 查询一致
		const fromId = store.state.entries.at(-1)!.id;
		await store.appendRewind({ id: "r1", requestId: "q", targetId, fromId, source: "test", reason: "back to root" });
		assertReplayEqualsMemory(store);
		expect(store.state.safeTargets.has(targetId)).toBe(true);

		// 历史间隙结算（P3a 成文偏离：fold 内合成 recovered: 条目）
		await store.appendMessage({ role: "assistant", content: "", tool_calls: [{ id: "c2", name: "probe", args: {} }] });
		assertReplayEqualsMemory(store);
		await store.appendEvent("tool_started", { callId: "c2" });
		assertReplayEqualsMemory(store);
		await store.appendMessage({ role: "user", content: "continue after crash" });
		assertReplayEqualsMemory(store);
		expect(store.state.entries.some((entry) => entry.id.startsWith("recovered:"))).toBe(true);
		// 间隙已在 fold 内闭合：tail 恢复计划为空
		expect(planRecovery(store.state).entries).toHaveLength(0);
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
		const tool: Tool = {
			def: { type: "function", function: { name: "probe", description: "probe", parameters: { type: "object", properties: {} } } },
			run: async () => ({ result: "ok", status: "succeeded" }),
		};
		const broker = new ToolBroker();
		broker.register(tool);
		const provider = scriptedProvider([
			{
				match: (req) => req.messages.some((message) => message.role === "tool"),
				produce: () => [{ kind: "text", text: "done" }, { kind: "finish", reason: "stop" }],
			},
			{
				match: () => true,
				produce: () => [
					{ kind: "tool_call", call: { id: "call-1", name: "probe", args: "{}" } },
					{ kind: "finish", reason: "tool_calls" },
				],
			},
		]);
		const store = new MemorySessionStore();
		const subject = new Subject(provider.model, provider.stream, broker, { store });
		void subject.pushInput("run with tool");
		await subject.pushInput("second", { mode: "followUp" });
		await subject.waitForIdle();

		assertReplayEqualsMemory(store);
		expect(subject.historySnapshot()).toEqual(projectAgentHistory(canonicalReplay(store.readRecords()).entries));
	});
});

describe("jsonl durable recovery identity", () => {
	it("persists recovery once under its stable identity and never regenerates it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "uina-replay-"));
		try {
			const path = join(dir, "session.jsonl");
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
			await rm(dir, { recursive: true, force: true });
		}
	});
});
