/**
 * Subject 级不变量回归钉（Batch 1 correctness purification）。
 * 每个用例钉一条硬不变量，而不是具体实现的逐行行为：
 * 1. accepted input 不得无归属地消失（claim 回滚 + 批量 claim 部分成功合同）
 * 2. 回合终止失败不得同时发布 success=true（DecisionOutcome 收口）
 * 3. 未执行的 tool call 不得计为 processed，也不得从事实历史蒸发（预算门 + 落盘）
 * 4. abort 语义在两条流路径上上报一致（agent_end success=false）
 * 5. retry 可观察性全 provider 一致（openai-compatible 不再漏接）
 */
import { describe, expect, it, vi } from "vitest";
import { SubjectHarness, mockTool } from "./harness/index.js";
import { Scenario } from "./harness/provider/scenario.js";
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import type { SessionEventName } from "../src/session/types.js";
import { InputQueues } from "../src/agent/queue.js";
import type { Model, ModelRequest, ModelStreamFn, StreamDelta } from "../src/core/types.js";
import { createOpenAIProvider } from "../src/ai/gateway.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";

const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/** 可注入 queue_restored 持久化故障的 store（其余写路径保持真实落盘）。 */
class FlakyRestoredStore extends MemorySessionStore {
	failOnRestored?: (data: Record<string, unknown>) => boolean;
	override async appendEvent(event: SessionEventName, data: Record<string, unknown>): Promise<void> {
		if (event === "queue_restored" && this.failOnRestored?.(data)) throw new Error("注入的持久化故障");
		await super.appendEvent(event, data);
	}
}

class FlakyInputStore extends MemorySessionStore {
	failOnInputId?: string;
	override async appendInput(input: import("../src/core/types.js").QueuedMessage): Promise<void> {
		if (input.id === this.failOnInputId) throw new Error("注入的输入提交故障");
		await super.appendInput(input);
	}
}

/** 门控流：第一次调用挂起直到 release（其余立即完成）；记录每次请求的末条 user 文本。
 * 注意：pushInput 的 direct 路径会 await 整个回合，首个输入不得在测试中 await。 */
function firstCallGatedStream(log: string[]) {
	let release: (() => void) | undefined;
	let calls = 0;
	const stream: ModelStreamFn = async (_m, req, onDelta, signal) => {
		calls++;
		const last = [...req.messages].reverse().find((m) => m.role === "user");
		log.push(typeof last?.content === "string" ? last.content : "");
		if (calls === 1) {
			await new Promise<void>((resolve) => {
				release = resolve;
				signal?.addEventListener("abort", () => resolve(), { once: true });
			});
		}
		onDelta({ kind: "text", text: "ok" });
		onDelta({ kind: "finish", reason: "stop" });
	};
	return { stream, release: () => release?.() };
}

function firstCallGatedToolStream() {
	let release: (() => void) | undefined;
	let calls = 0;
	const stream: ModelStreamFn = async (_m, _req, onDelta, signal) => {
		calls++;
		if (calls === 1) {
			await new Promise<void>((resolve) => {
				release = resolve;
				signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			onDelta({ kind: "tool_call", call: { id: "tc1", name: "echo", args: "{}" } });
			onDelta({ kind: "finish", reason: "tool_calls" });
			return;
		}
		onDelta({ kind: "text", text: "done" });
		onDelta({ kind: "finish", reason: "stop" });
	};
	return { stream, release: () => release?.() };
}

describe("不变量：accepted input 不得无归属地消失", () => {
	it("队列年龄以持久化 receivedAt 为唯一时间来源，回滚和恢复不会重置", () => {
		const q = new InputQueues();
		const receivedAt = new Date(Date.now() - 5_000).toISOString();
		const item = q.create("old", "followUp", { receivedAt });
		q.add(item);

		expect(q.oldestAgeMs(Date.parse(receivedAt) + 5_000)).toBe(5_000);
		const claimed = q.remove(item.id);
		expect(claimed?.id).toBe(item.id);
		q.add(claimed!);
		expect(q.oldestAgeMs(Date.parse(receivedAt) + 5_000)).toBe(5_000);

		const restored = new InputQueues();
		restored.seed([item]);
		expect(restored.oldestAgeMs(Date.parse(receivedAt) + 5_000)).toBe(5_000);
	});

	it("InputQueues.add 回滚插入不改同 mode 消费顺序（peek 原始序）", () => {
		const q = new InputQueues();
		const a = q.create("a", "steer");
		const b = q.create("b", "steer");
		const c = q.create("c", "steer");
		q.add(a);
		q.add(b);
		q.add(c);
		q.remove(b.id); // claim 摘除
		q.add(b); // 持久化失败回滚
		expect(q.peek("steer")?.text).toBe("a");
		q.remove(a.id);
		expect(q.peek("steer")?.text).toBe("b");
		q.remove(b.id);
		expect(q.peek("steer")?.text).toBe("c");
	});

	it("InputQueues.all 在线性归并两个有序队列，并返回独立数组快照", () => {
		const q = new InputQueues();
		const steer1 = q.create("steer-1", "steer");
		const followUp = q.create("follow-up", "followUp");
		const steer2 = q.create("steer-2", "steer");
		q.add(steer1);
		q.add(followUp);
		q.add(steer2);

		const snapshot = q.all();
		expect(snapshot.map((item) => item.text)).toEqual(["steer-1", "follow-up", "steer-2"]);
		snapshot.shift();
		expect(q.peek("steer")?.text).toBe("steer-1");
	});

	it("InputQueues.oldestAgeMs 只看两个队列头，不受后续条目影响", () => {
		const q = new InputQueues();
		const olderSteer = q.create("older", "steer", { receivedAt: new Date(1_000).toISOString() });
		const newerFollowUp = q.create("newer", "followUp", { receivedAt: new Date(2_000).toISOString() });
		q.add(olderSteer);
		q.add(newerFollowUp);

		expect(q.oldestAgeMs(6_000)).toBe(5_000);
	});

	it("InputQueues.oldestAgeMs 按 receivedAt 而不是 order 选择最老头部", () => {
		const q = new InputQueues();
		const newerSteer = q.create("newer", "steer", { receivedAt: new Date(2_000).toISOString() });
		const olderFollowUp = q.create("older", "followUp", { receivedAt: new Date(1_000).toISOString() });
		q.add(newerSteer);
		q.add(olderFollowUp);

		expect(q.oldestAgeMs(6_000)).toBe(5_000);
	});

	it("claimQueued 持久化失败：条目回滚入队且抛错，journal 无 queue_restored", async () => {
		const store = new FlakyRestoredStore();
		const log: string[] = [];
		const { stream } = firstCallGatedStream(log);
		const h = SubjectHarness.create({ stream, store });
		h.pushInput("first"); // direct 路径 await 整回合，不能 await；挂起期间排队
		await wait(20);
		await h.pushInput("a", { mode: "steer" });
		await h.pushInput("b", { mode: "steer" });
		await h.pushInput("c", { mode: "steer" });
		h.interrupt();
		await h.waitForIdle();

		const bId = h.queuedSnapshot()[1]!.id;
		store.failOnRestored = () => true;
		await expect(h.claimQueued(bId)).rejects.toThrow("注入的持久化故障");
		// 所有权仍在 Subject：三条都还在队列
		expect(h.queuedSnapshot().map((i) => i.text)).toEqual(["a", "b", "c"]);
		expect(h.records.filter((r) => r.kind === "event" && r.event === "queue_restored")).toHaveLength(0);

		// 故障解除后继续消费：真实消费顺序保持原 order
		store.failOnRestored = undefined;
		await h.subject.resumePending();
		await h.waitForIdle();
		expect(log.slice(1)).toEqual(["a", "b", "c"]);
	});

	it("claimAllQueued 部分失败：已持久化前缀移交 caller，其余留在队列", async () => {
		const store = new FlakyRestoredStore();
		const log: string[] = [];
		const { stream } = firstCallGatedStream(log);
		const h = SubjectHarness.create({ stream, store });
		h.pushInput("first");
		await wait(20);
		await h.pushInput("a", { mode: "steer" });
		await h.pushInput("b", { mode: "steer" });
		await h.pushInput("c", { mode: "steer" });
		h.interrupt();
		await h.waitForIdle();

		const [a, b] = h.queuedSnapshot();
		store.failOnRestored = (data) => data.id === b!.id;
		const claim = await h.claimAllQueued();
		expect(claim.kind).toBe("partial");
		if (claim.kind !== "partial") return;
		// 已提交前缀必须实际返回给 caller，而不是随异常蒸发
		expect(claim.claimed.map((i) => i.text)).toEqual(["a"]);
		expect(claim.failedId).toBe(b!.id);
		expect((claim.error as Error).message).toContain("注入的持久化故障");
		// 未持久化的仍归 Subject
		expect(h.queuedSnapshot().map((i) => i.text)).toEqual(["b", "c"]);
		// journal 事实：只有 a 完成了 canonical 移交
		const restored = h.records.filter((r) => r.kind === "event" && r.event === "queue_restored");
		expect(restored).toHaveLength(1);
		expect((restored[0] as { data: { id: string } }).data.id).toBe(a!.id);
	});

	it("批量消费的边界事件失败时恢复当前项和后续项", async () => {
		const { stream, release } = firstCallGatedToolStream();
		let failed = false;
		const runtimeHooks: typeof NO_RUNTIME_HOOKS = {
			...NO_RUNTIME_HOOKS,
			events: {
				...NO_RUNTIME_HOOKS.events,
				emit: async (event) => {
					if (event.type === "turn_end" && !failed) {
						failed = true;
						throw new Error("注入的边界事件故障");
					}
				},
			},
		};
		const h = SubjectHarness.create({ stream, store: new MemorySessionStore(), runtimeHooks, tools: [mockTool("echo")] });
		h.pushInput("first");
		await wait(20);
		await h.pushInput("a", { mode: "steer" });
		await h.pushInput("b", { mode: "steer" });
		release();
		await h.waitForIdle();

		expect(h.queuedSnapshot().map((item) => item.text)).toEqual(["a", "b"]);
	});

	it("批量消费的当前项提交失败时只恢复一次", async () => {
		const store = new FlakyInputStore();
		const { stream, release } = firstCallGatedToolStream();
		const h = SubjectHarness.create({ stream, store, tools: [mockTool("echo")] });
		h.pushInput("first");
		await wait(20);
		await h.pushInput("a", { mode: "steer" });
		await h.pushInput("b", { mode: "steer" });
		const [a] = h.queuedSnapshot();
		store.failOnInputId = a!.id;
		release();
		await h.waitForIdle();

		expect(h.queuedSnapshot().map((item) => item.text)).toEqual(["a", "b"]);
		expect(h.records.filter((record) => record.kind === "input" && record.input.id === a!.id)).toHaveLength(0);
	});
});

describe("不变量：终局事实单一（completed / aborted / terminated）", () => {
	function toolCallScenario() {
		let n = 0;
		const scenario = new Scenario()
			.when(() => true)
			.then(() => [
				{ kind: "tool_call" as const, call: { id: `tc${++n}`, name: "echo", args: "{}" } },
				{ kind: "finish" as const, reason: "tool_calls" as const },
			]);
		return scenario;
	}

	it("预算门：processed 口径整批拒绝，Provider 事实落盘 + not_started，turn 以 turn_failed 收口且 agent_end success=false", async () => {
		const store = new MemorySessionStore();
		const agentEnds: Array<{ success: boolean; error?: string }> = [];
		const h = SubjectHarness.create({
			scenario: toolCallScenario(),
			maxConsecutiveToolCalls: 2,
			tools: [mockTool("echo", () => "ok")],
			store,
		});
		h.subscribe((event) => {
			if ((event as { type?: string }).type === "agent_end") {
				agentEnds.push(event as { success: boolean; error?: string });
			}
		});
		await h.pushInput("开始");
		await h.waitForIdle();

		// 恰好等于上限的 2 个调用真正进入流水线；第 3 批被整批拒绝
		const toolMessages = h.history.filter((m) => m.role === "tool");
		expect(toolMessages.filter((m) => m.status === "succeeded")).toHaveLength(2);
		const rejected = toolMessages.filter((m) => m.status === "not_started");
		expect(rejected).toHaveLength(1);
		expect(rejected[0] && JSON.parse(rejected[0].content).error).toContain("已达工具调用上限 2");
		// 模型说过的 tool_calls 不蒸发：3 条 assistant(tool_calls)
		expect(h.history.filter((m) => m.role === "assistant" && m.tool_calls)).toHaveLength(3);
		// journal 唯一收口：turn_failed 带 reason code；agent_end 不再谎报成功
		const turnFailed = h.records.find((r) => r.kind === "event" && r.event === "turn_failed") as
			| { data: { reason?: string; error?: string } }
			| undefined;
		expect(turnFailed?.data.reason).toBe("tool_call_limit");
		expect(turnFailed?.data.error).toContain("已处理 2 次工具调用");
		expect(agentEnds).toHaveLength(1);
		expect(agentEnds[0]!.success).toBe(false);
		expect(agentEnds[0]!.error).toContain("已处理 2 次工具调用");
	});

	it("中断（流正常 resolve 路径）：agent_end success=false，journal 只有 turn_aborted", async () => {
		const agentEnds: Array<{ success: boolean }> = [];
		const h = SubjectHarness.create({
			store: new MemorySessionStore(),
			stream: async (_m, _req, onDelta, signal) => {
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
				onDelta({ kind: "text", text: "partial" });
				onDelta({ kind: "finish", reason: "stop" });
			},
		});
		h.subscribe((event) => {
			if ((event as { type?: string }).type === "agent_end") agentEnds.push(event as { success: boolean });
		});
		h.pushInput("go");
		await wait(20);
		h.interrupt();
		await h.waitForIdle();
		expect(agentEnds).toHaveLength(1);
		expect(agentEnds[0]!.success).toBe(false);
		expect(h.records.some((r) => r.kind === "event" && r.event === "turn_aborted")).toBe(true);
		expect(h.records.some((r) => r.kind === "event" && r.event === "turn_failed")).toBe(false);
	});

	it("中断（流抛错路径）：与 resolve 路径上报一致，agent_end success=false", async () => {
		const agentEnds: Array<{ success: boolean }> = [];
		const h = SubjectHarness.create({
			store: new MemorySessionStore(),
			stream: async (_m, _req, _onDelta, signal) => {
				await new Promise<void>((_, reject) =>
					signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }),
				);
			},
		});
		h.subscribe((event) => {
			if ((event as { type?: string }).type === "agent_end") agentEnds.push(event as { success: boolean });
		});
		h.pushInput("go");
		await wait(20);
		h.interrupt();
		await h.waitForIdle();
		expect(agentEnds).toHaveLength(1);
		expect(agentEnds[0]!.success).toBe(false);
		expect(h.records.some((r) => r.kind === "event" && r.event === "turn_aborted")).toBe(true);
		expect(h.records.some((r) => r.kind === "event" && r.event === "turn_failed")).toBe(false);
	});
});

	describe("不变量：回合外前台活动与 post-turn 生命周期", () => {
		it("afterEnd 仍属于 activeRun，interrupt 可取消但不回改已完成回合", async () => {
			let resolveAfterEnd!: () => void;
			let afterEndEntered = false;
			const afterEndStarted = new Promise<void>((resolve) => { resolveAfterEnd = resolve; });
			let afterEndAborted = false;
			const runtimeHooks = {
				...NO_RUNTIME_HOOKS,
				turn: {
					...NO_RUNTIME_HOOKS.turn,
					afterEnd: async ({ signal }: { signal: AbortSignal }) => {
						afterEndEntered = true;
						resolveAfterEnd();
						await new Promise<void>((resolve) => {
							if (signal.aborted) {
								afterEndAborted = true;
								resolve();
								return;
							}
							signal.addEventListener("abort", () => {
								afterEndAborted = true;
								resolve();
							}, { once: true });
						});
					},
				},
			};
			const h = SubjectHarness.create({
				runtimeHooks,
				stream: async (_model, _request, onDelta) => {
					onDelta({ kind: "text", text: "done" });
					onDelta({ kind: "finish", reason: "stop" });
				},
			});
			const run = h.subject.pushInput("go");
			await afterEndStarted;
			expect(afterEndEntered).toBe(true);
			expect(h.subject.isBusy()).toBe(true);
			h.subject.interrupt();
			await expect(run).resolves.toBeUndefined();
			await expect(h.subject.waitForIdle()).resolves.toBeUndefined();
			expect(afterEndAborted).toBe(true);
			expect(h.subject.isBusy()).toBe(false);
		});
		it("runActivity 独占主体、可中断、waitForIdle 等待且异常释放", async () => {
			const h = SubjectHarness.create({ store: new MemorySessionStore(), stream: async () => {} });
			let entered = false;
			let release!: () => void;
			const run = h.subject.runActivity(async (signal) => {
				entered = true;
				expect(h.subject.isBusy()).toBe(true);
				await new Promise<void>((resolve) => {
					release = resolve;
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
			});
			await vi.waitFor(() => expect(entered).toBe(true));
			expect(h.subject.isBusy()).toBe(true);
			await expect(h.subject.runActivity(async () => {})).rejects.toThrow("Subject 忙碌");
		const idle = h.subject.waitForIdle();
		h.subject.interrupt();
		await expect(run).resolves.toBeUndefined();
		await expect(idle).resolves.toBeUndefined();
		expect(h.subject.isBusy()).toBe(false);
		// 释放函数保留在这里仅防止测试 fixture 变成悬挂 Promise；abort 已使主体完成。
		release?.();
	});
	});

	describe("不变量：retry 可观察性全 provider 一致", () => {
	it("openai-compatible provider 发出 provider_retry / provider_recovered delta", async () => {
		let calls = 0;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			calls++;
			if (calls === 1) return new Response("down", { status: 503 });
			const sse = [
				`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}`,
				"data: [DONE]",
				"",
			].join("\n\n");
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		try {
			const provider = createOpenAIProvider("retry-prov", { baseUrl: "http://unavailable.test/v1", apiKey: "k" });
			const model: Model = { id: "gpt", name: "gpt", providerId: "retry-prov", contextWindow: 1000 };
			const req = { messages: [{ role: "user" as const, content: "hi" }], providerHooks: NO_RUNTIME_HOOKS.provider } as unknown as ModelRequest;
			const deltas: StreamDelta[] = [];
			await provider.stream(model, req, (d) => deltas.push(d));
			const retry = deltas.find((d) => d.kind === "provider_retry") as
				| { kind: string; attempt: number; status?: number }
				| undefined;
			const recovered = deltas.find((d) => d.kind === "provider_recovered") as
				| { kind: string; attempt: number }
				| undefined;
			expect(retry?.attempt).toBe(1);
			expect(retry?.status).toBe(503);
			expect(recovered?.attempt).toBe(1);
			expect(calls).toBe(2);
		} finally {
			fetchMock.mockRestore();
		}
	});
});
