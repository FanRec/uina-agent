/**
 * 自动压缩语义：上下文窗口管理归 official compaction capability，
 * 经 History View（压缩扩展的每请求历史裁剪）——journal 保留全量历史，Subject 内存
 * 视图不被自动截断，摘要以 uina.compaction.summary custom entry 持久化。
 *
 * 回合内暴涨的安全网 = 每请求裁剪本身：工具输出让上下文越过阈值后，
 * 下一次模型调用收到的就是 [历史摘要, 预算内尾部]，而不是超大请求。
 *
 * 基于 Uina Test Kit 迁移，消灭重复的 mkdtemp/rm 样板代码。
 */

import { readFile } from "node:fs/promises";
import { estimateRequestTokens } from "../src/agent/context.js";
import { inputTokenBudget } from "../src/core/model.js";
import type { ModelRequest, StreamDelta } from "../src/core/types.js";
import { estimateStreamTokens } from "../src/extensions/compaction/index.js";
import { openJsonlSession } from "../src/session/jsonl-store.js";
import { IsolatedEnv } from "./harness/environment/isolated-env.js";
import { UinaTestHarness } from "./harness/host/harness.js";
import { describe, expect, test } from "./harness/index.js";
import { Scenario } from "./harness/provider/scenario.js";

// 帧回执（external_event_frame 合成 tool 消息）不算真实工具结果：默认装配下
// 外部输入也会投影为 tool 角色回执，这里只关心模型真实工具调用的结果。
const hasToolResult = (req: ModelRequest): boolean =>
	req.messages.some((m) => m.role === "tool" && m.context?.kind !== "uina.external-event-frame");

const seedHistory = (): { role: "user" | "assistant"; content: string }[] =>
	Array.from({ length: 100 }, (_, index) =>
		index % 2 === 0
			? { role: "user" as const, content: `第${index}问 ${"词".repeat(4_000)}` }
			: { role: "assistant" as const, content: `第${index}答 ${"词".repeat(4_000)}` },
	);

async function persistHistory(
	env: IsolatedEnv,
	history: readonly { role: "user" | "assistant"; content: string }[],
): Promise<void> {
	const opened = await openJsonlSession(env.sessionPath);
	for (const message of history) await opened.store.appendMessage(message);
	await opened.store.close();
}

describe("自动压缩：经 History View 每请求裁剪", () => {
	test("滚动摘要按已有摘要动态取下一块，所有摘要请求均不超输入预算", async ({ env }) => {
		await persistHistory(
			env,
			Array.from({ length: 30 }, (_, index) => ({
				role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content: `历史${index} ${"词".repeat(4_000)}`,
			})),
		);
		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });
		scenario.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).reply("摘".repeat(4_000));
		scenario.fallback(() => [
			{ kind: "text", text: "ok" },
			{ kind: "finish", reason: "stop" },
		]);
		const uina = await UinaTestHarness.create({ env, scenario });
		try {
			await uina.host.commands.dispatch("/compact");
			const summaryRequests = scenario.calls.filter((req) =>
				(req.messages[0]?.content ?? "").includes("上下文摘要助手"),
			);
			expect(summaryRequests.length).toBeGreaterThan(1);
			for (const request of summaryRequests) {
				expect(estimateRequestTokens(request.messages, request.tools ?? [])).toBeLessThanOrEqual(
					inputTokenBudget(scenario.model)!,
				);
			}
			expect(await readFile(env.sessionPath, "utf8")).toContain("uina.compaction.summary");
		} finally {
			await uina.dispose();
		}
	});

	test("单个超长回合分片摘要，checkpoint 仍只覆盖完整回合", async ({ env }) => {
		await persistHistory(env, [
			{ role: "user", content: "问".repeat(20_000) },
			{ role: "assistant", content: "答".repeat(20_000) },
			{ role: "user", content: "保留的下一回合" },
			{ role: "assistant", content: "保留的答复" },
		]);
		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 16_000 });
		scenario.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).reply("分片完成");
		const uina = await UinaTestHarness.create({ env, scenario, hostOptions: { workspaceTools: false } });
		try {
			await uina.host.commands.dispatch("/compact");
			const requests = scenario.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"));
			expect(requests.length).toBeGreaterThan(1);
			expect(requests.some((req) => req.messages[1]?.content.includes("[同一语义单元分片]"))).toBe(true);
			for (const req of requests)
				expect(estimateRequestTokens(req.messages, req.tools ?? [])).toBeLessThanOrEqual(
					inputTokenBudget(scenario.model)!,
				);
			const journal = await readFile(env.sessionPath, "utf8");
			expect(journal).toContain("uina.compaction.summary");
		} finally {
			await uina.dispose();
		}
	});

	test("压缩后超长摘要超出可用预算时确定性截断保底，压缩成功且重建请求落入预算", async ({ env }) => {
		await persistHistory(
			env,
			Array.from({ length: 30 }, (_, index) => ({
				role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content: `历史${index} ${"词".repeat(1_000)}`,
			})),
		);
		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 30_000 });
		scenario.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).reply("摘".repeat(3_000));
		scenario.fallback(() => [
			{ kind: "text", text: "ok" },
			{ kind: "finish", reason: "stop" },
		]);
		const uina = await UinaTestHarness.create({ env, scenario, hostOptions: { workspaceTools: false } });
		try {
			await uina.host.commands.dispatch("/compact");
			const journal = await readFile(env.sessionPath, "utf8");
			expect(journal).toContain("uina.compaction.summary");
			expect(journal).toContain("[摘要已截断]");
			// 重建请求按构造落入预算。
			await uina.send("压缩后一轮", "direct");
			await uina.waitForIdle();
			const last = scenario.calls.at(-1)!;
			const summaryMessage = last.messages.find((m) => (m.content ?? "").startsWith("[历史摘要] "));
			expect(summaryMessage?.content).toContain("[摘要已截断]");
			expect(estimateRequestTokens(last.messages, last.tools ?? [])).toBeLessThanOrEqual(
				inputTokenBudget(scenario.model)!,
			);
		} finally {
			await uina.dispose();
		}
	});

	test("自动压缩保留目标对齐 20k，释放充裕跑道且后续调用不反复触发压缩", async ({ env }) => {
		await persistHistory(
			env,
			Array.from({ length: 50 }, (_, index) => ({
				role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content: `历史${index} ${"词".repeat(1_000)}`,
			})),
		);
		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 60_000 });
		scenario.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).reply("历史摘要内容");
		scenario.fallback(() => [
			{ kind: "text", text: "ok" },
			{ kind: "finish", reason: "stop" },
		]);
		const uina = await UinaTestHarness.create({ env, scenario, hostOptions: { workspaceTools: false } });
		try {
			// 第一轮：历史约 50k tokens，超过 60k - 16k = 44k 预算，触发自动压缩
			await uina.send("触发自动压缩的第一轮", "direct");
			await uina.waitForIdle();

			const summaryCallsFirst = scenario.calls.filter((req) =>
				(req.messages[0]?.content ?? "").includes("上下文摘要助手"),
			);
			expect(summaryCallsFirst.length).toBe(1);

			// 自动压缩执行后，保留尾部约为 20k tokens，留出了几十 k 的空余空间。
			// 连续跑第二轮、第三轮，绝不应再次触发压缩！
			await uina.send("第二轮", "direct");
			await uina.waitForIdle();

			await uina.send("第三轮", "direct");
			await uina.waitForIdle();

			const summaryCallsTotal = scenario.calls.filter((req) =>
				(req.messages[0]?.content ?? "").includes("上下文摘要助手"),
			);
			// 依然只有 1 次摘要调用，彻底消除了过几轮就重复压缩的颠簸
			expect(summaryCallsTotal.length).toBe(1);
		} finally {
			await uina.dispose();
		}
	});
	test("同一个回合内上下文越过阈值后，下一次调用收到的是摘要 + 预算内尾部，journal 保留全量历史", async ({ env }) => {
		await persistHistory(env, seedHistory());
		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });

		scenario.fallback((req) => {
			const isSummaryCall = (req.messages[0]?.content ?? "").includes("上下文摘要助手");
			const deltas: StreamDelta[] = isSummaryCall
				? [{ kind: "text", text: "早期对话围绕长文本输入展开" }]
				: hasToolResult(req)
					? [{ kind: "text", text: "收到工具结果，处理完成" }]
					: [{ kind: "tool_call", call: { id: "c1", name: "no_such_tool", args: "{}" } }];
			return [
				...deltas,
				{ kind: "finish", reason: deltas.some((d) => d.kind === "tool_call") ? "tool_calls" : "stop" },
			];
		});

		const uina = await UinaTestHarness.create({ env, scenario });
		try {
			await uina.send("跑两轮", "direct");
			await uina.waitForIdle();

			// 第二次调用（带工具结果的那次）已被裁剪：摘要消息开头。
			expect(scenario.calls.length).toBeGreaterThanOrEqual(2);
			const trimmedRequest = scenario.calls.find((req) => hasToolResult(req));
			expect(trimmedRequest).toBeDefined();
			// leading system 保留，摘要消息紧随其后。
			const first = trimmedRequest?.messages[1];
			expect(first?.role).toBe("user");
			expect((first?.content ?? "").startsWith("[历史摘要] ")).toBe(true);

			// Subject 内存视图不被自动截断：全量历史仍在，无 canonical 截断产物。
			const memory = uina.host.subject.historySnapshot();
			expect(memory.some((message) => (message.content as string)?.includes("第0问"))).toBe(true);

			// journal 持久化了滚动摘要（uina.compaction.summary custom entry）。
			const journal = await readFile(env.sessionPath, "utf8");
			expect(journal).toContain("uina.compaction.summary");
		} finally {
			await uina.dispose();
		}
	});

	test("重启后从 journal 重载滚动摘要，不重复生成", async ({ env }) => {
		// 种子先落盘（addHistory 只进内存）：重启后主线仍超预算，裁剪才有前提。
		const seeded = await openJsonlSession(env.sessionPath);
		for (const message of seedHistory()) await seeded.store.appendMessage(message);
		await seeded.store.close();

		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });
		scenario.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).reply("ok-tail");
		scenario.fallback(() => [
			{ kind: "text", text: "ok" },
			{ kind: "finish", reason: "stop" },
		]);

		const uina = await UinaTestHarness.create({ env, scenario });
		try {
			await uina.send("第一轮", "direct");
			await uina.waitForIdle();
			const summaryCallsAfterFirst = scenario.calls.filter((req) =>
				(req.messages[0]?.content ?? "").includes("上下文摘要助手"),
			).length;
			expect(summaryCallsAfterFirst).toBeGreaterThanOrEqual(1);

			// 同一宿主再跑一轮：摘要已缓存且仍有效，不再生成第二份。
			await uina.send("第二轮", "direct");
			await uina.waitForIdle();
			const summaryCallsAfterSecond = scenario.calls.filter((req) =>
				(req.messages[0]?.content ?? "").includes("上下文摘要助手"),
			).length;
			expect(summaryCallsAfterSecond).toBe(summaryCallsAfterFirst);

			// 重启：从 journal 重载摘要，裁剪照常生效且不重新生成。
			const scenario2 = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });
			scenario2.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).reply("ok-tail");
			scenario2.fallback(() => [
				{ kind: "text", text: "ok" },
				{ kind: "finish", reason: "stop" },
			]);

			const restarted = await UinaTestHarness.create({ env, scenario: scenario2 });
			try {
				await restarted.send("重启后一轮", "direct");
				await restarted.waitForIdle();
				expect(
					scenario2.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).length,
				).toBe(0);
				const reloaded = scenario2.calls.at(-1);
				expect(reloaded?.messages.some((m) => m.role === "user" && (m.content ?? "").startsWith("[历史摘要] "))).toBe(
					true,
				);
			} finally {
				await restarted.dispose();
			}
		} finally {
			await uina.dispose();
		}
	});

	test("手动 /compact：立即/排队执行、携带 instruction；失败由 session_compact 终态表达且请求透传", async ({ env }) => {
		// force 边界按 MANUAL_KEEP_TOKENS(20_000) 计算：种子 ≈ 22.5k tokens 必须超过它。
		const history = Array.from({ length: 30 }, (_, index) =>
			index % 2 === 0
				? { role: "user" as const, content: `问${index} ${"词".repeat(3_000)}` }
				: { role: "assistant" as const, content: `答${index} ${"词".repeat(3_000)}` },
		);

		await persistHistory(env, history);
		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });
		scenario.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).reply("手动摘要内容");
		scenario.fallback(() => [
			{ kind: "text", text: "ok" },
			{ kind: "finish", reason: "stop" },
		]);

		const uina = await UinaTestHarness.create({ env, scenario });
		try {
			// 预算内（自动路径不触发），/compact 强制受理。
			const before = scenario.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).length;
			await uina.host.commands.dispatch("/compact 关注决策");
			await uina.send("强制一轮", "direct");
			await uina.waitForIdle();

			const summaryCalls = scenario.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"));
			expect(summaryCalls.length).toBeGreaterThan(before);
			// instruction 注入摘要提示词。
			expect(summaryCalls.at(-1)?.messages.at(-1)?.content).toContain("额外关注：关注决策");
			// 下一次请求以摘要开头（leading system 原位）。
			const last = scenario.calls.at(-1);
			expect(last?.messages[1]?.content).toBe("[历史摘要] 手动摘要内容");
			// 内存视图与 journal 仍全量：无 canonical 截断。
			expect(uina.host.subject.historySnapshot().some((m) => m.content === "[历史摘要] 手动摘要内容")).toBe(false);
			expect(await readFile(env.sessionPath, "utf8")).toContain("uina.compaction.summary");
		} finally {
			await uina.dispose();
		}

		// 失败路径：摘要生成抛错 → session_compact(status=failed) 广播，请求透传。
		const failEnv = await IsolatedEnv.create();
		await failEnv.writeExtension(
			"compact-failure-observer.mjs",
			`
			export default function activate(pi) {
				pi.on("session_compact", (event) => {
					if (event.status === "failed") globalThis.__compactFailure = event.error;
				});
			}
		`,
		);
		const failing = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });
		failing
			.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"))
			.then(() => {
				throw new TypeError("terminated", {
					cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
				});
			});
		failing.fallback(() => [
			{ kind: "text", text: "ok" },
			{ kind: "finish", reason: "stop" },
		]);

		await persistHistory(failEnv, history);
		const failHarness = await UinaTestHarness.create({ env: failEnv, scenario: failing });
		try {
			await failHarness.host.commands.dispatch("/compact");
			await failHarness.send("失败一轮", "direct");
			await failHarness.waitForIdle();
			expect(failing.calls.at(-1)?.messages.some((m) => (m.content ?? "").startsWith("[历史摘要] "))).toBe(false);
			const failure = (globalThis as { __compactFailure?: string }).__compactFailure ?? "";
			expect(failure).toContain("摘要模型请求失败：terminated");
			expect(failure).toContain("UND_ERR_SOCKET: socket closed");
			expect(failHarness.events.errors.some((event) => event.text.includes("/compact 执行失败"))).toBe(false);
		} finally {
			delete (globalThis as { __compactFailure?: unknown }).__compactFailure;
			await failHarness.dispose();
		}
	});

	test("小窗口下手动 /compact：保留量夹取到安全预算，且持久化携带 prefixFingerprint", async ({ env }) => {
		// 窗口仅 12k：扣除输出预留和内置工具 schema 后仍能容纳一个完整尾部事务，
		// 但手动保留量若仍硬按 MANUAL_KEEP_TOKENS(20_000)，裁剪后一定超窗口。
		const history = Array.from({ length: 30 }, (_, index) =>
			index % 2 === 0
				? { role: "user" as const, content: `问${index} ${"词".repeat(800)}` }
				: { role: "assistant" as const, content: `答${index} ${"词".repeat(800)}` },
		);
		await persistHistory(env, history);
		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 12_000 });
		scenario.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).reply("小窗摘要");
		scenario.fallback(() => [
			{ kind: "text", text: "ok" },
			{ kind: "finish", reason: "stop" },
		]);

		const uina = await UinaTestHarness.create({ env, scenario });
		try {
			await uina.host.commands.dispatch("/compact");
			await uina.send("小窗一轮", "direct");
			await uina.waitForIdle();

			const last = scenario.calls.at(-1);
			expect(last?.messages.some((m) => (m.content ?? "").startsWith("[历史摘要] "))).toBe(true);
			// 裁剪后整段（system + 摘要 + 保留尾部）必须落在窗口内——证明 keepBudget 被夹取到预算。
			const views =
				last?.messages.map((m) => ({
					role: m.role,
					content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
					tool_call_id: (m as { tool_call_id?: string }).tool_call_id,
					tool_calls: (m as { tool_calls?: { name: string; args?: unknown }[] }).tool_calls,
				})) ?? [];
			expect(estimateStreamTokens(views)).toBeLessThanOrEqual(12_000);
			// 滚动摘要持久化携带指纹字段（复用门禁的数据来源）。
			const journal = await readFile(env.sessionPath, "utf8");
			expect(journal).toContain("prefixFingerprint");
		} finally {
			await uina.dispose();
		}
	});

	test("忙碌时 /compact 在 agent_end 全部分发后执行，并在排队回合前完成", async ({ env }) => {
		await env.writeExtension(
			"agent-end-observer.mjs",
			`
			export default function activate(uina) {
				globalThis.__compactionOrder = [];
				uina.on("turn_start", () => globalThis.__compactionOrder.push("turn_start"));
				uina.on("agent_end", async () => {
					await new Promise((resolve) => setTimeout(resolve, 5));
					globalThis.__agentEndObserverDone = true;
					globalThis.__compactionOrder.push("agent_end_done");
				});
				uina.on("session_compact_progress", (event) => {
					if (event.phase === "summarizing") globalThis.__compactionOrder.push("summarizing");
				});
				uina.on("session_compact", (event) => {
					if (event.status === "completed") globalThis.__compactionOrder.push("completed");
				});
			}
		`,
		);
		let enterFirst!: () => void;
		const firstEntered = new Promise<void>((resolve) => {
			enterFirst = resolve;
		});
		let releaseFirst!: () => void;
		const firstRelease = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let normalCalls = 0;
		let summarySawAgentEnd = false;
		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });
		scenario
			.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"))
			.thenStream(async (_model, _request, emit) => {
				summarySawAgentEnd = (globalThis as { __agentEndObserverDone?: boolean }).__agentEndObserverDone === true;
				emit({ kind: "text", text: "排队压缩摘要" });
				emit({ kind: "finish", reason: "stop" });
			});
		scenario
			.when((req) => !(req.messages[0]?.content ?? "").includes("上下文摘要助手"))
			.thenStream(async (_model, _request, emit) => {
				normalCalls++;
				if (normalCalls === 1) {
					enterFirst();
					await firstRelease;
				}
				emit({ kind: "text", text: "ok" });
				emit({ kind: "finish", reason: "stop" });
			});

		const history = Array.from({ length: 12 }, (_, index) =>
			index % 2 === 0
				? { role: "user" as const, content: `问${index} ${"词".repeat(2_000)}` }
				: { role: "assistant" as const, content: `答${index} ${"词".repeat(2_000)}` },
		);
		await persistHistory(env, history);

		const uina = await UinaTestHarness.create({ env, scenario });
		try {
			const firstRun = uina.send("当前回合", "direct");
			await firstEntered;
			await uina.host.commands.dispatch("/compact");
			await uina.send("排队回合", "followUp");
			releaseFirst();
			await firstRun;
			await uina.waitForIdle();

			const order = (globalThis as { __compactionOrder?: string[] }).__compactionOrder ?? [];
			const agentEnd = order.indexOf("agent_end_done");
			const summarizing = order.indexOf("summarizing");
			const completed = order.indexOf("completed");
			const secondTurn = order.lastIndexOf("turn_start");

			expect(summarySawAgentEnd).toBe(true);
			expect(agentEnd).toBeGreaterThanOrEqual(0);
			expect(summarizing).toBeGreaterThan(agentEnd);
			expect(completed).toBeGreaterThan(summarizing);
			expect(secondTurn).toBeGreaterThan(completed);
		} finally {
			delete (globalThis as { __agentEndObserverDone?: unknown }).__agentEndObserverDone;
			delete (globalThis as { __compactionOrder?: unknown }).__compactionOrder;
			await uina.dispose();
		}
	});

	test("多步工具调用链在当前回合内累积触顶上下文时，自动触发回合内平滑压缩并成功完成任务", async ({ env }) => {
		await env.writeExtension(
			"big-tool.mjs",
			`
			export default function activate(pi) {
				pi.registerTool({
					def: {
						type: "function",
						function: {
							name: "heavy_task",
							description: "模拟产出较大结果的工具",
							parameters: { type: "object", properties: {} },
						},
					},
					async run() {
						return {
							result: "执行中间结果数据 ".repeat(300),
							status: "succeeded",
						};
					},
				});
			}
		`,
		);

		let stepCount = 0;
		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 20_000 });
		scenario.fallback((req) => {
			const isSummaryCall = (req.messages[0]?.content ?? "").includes("上下文摘要助手");
			if (isSummaryCall) {
				return [
					{ kind: "text", text: "已完成前序工具调用步骤，获取到中间数据" },
					{ kind: "finish", reason: "stop" },
				];
			}
			stepCount++;
			if (stepCount <= 4) {
				return [
					{ kind: "tool_call", call: { id: `call-${stepCount}`, name: "heavy_task", args: "{}" } },
					{ kind: "finish", reason: "tool_calls" },
				];
			}
			return [
				{ kind: "text", text: "所有工具步骤处理完成，任务收敛" },
				{ kind: "finish", reason: "stop" },
			];
		});

		const uina = await UinaTestHarness.create({ env, scenario, hostOptions: { workspaceTools: false } });
		try {
			await uina.send("开始多步工具执行任务", "direct");
			await uina.waitForIdle();

			// 验证摘要调用确实在当前回合内被触发过
			const summaryCalls = scenario.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"));
			expect(summaryCalls.length).toBeGreaterThanOrEqual(1);

			// 最终发给模型的最后一次请求中，包含了历史摘要，且成功完成了任务
			const finalRequest = scenario.calls.at(-1);
			expect(finalRequest?.messages.some((m) => m.role === "user" && (m.content ?? "").startsWith("[历史摘要] "))).toBe(
				true,
			);

			// 会话正常结束，未发生 turn_failed，且持久化了 checkpoint
			const journal = await readFile(env.sessionPath, "utf8");
			expect(journal).toContain("uina.compaction.summary");
			expect(journal).not.toContain("turn_failed");
		} finally {
			await uina.dispose();
		}
	});

	test("超长工具调用链触发多次连续回合内压缩，滚动摘要级联更新且任务顺利完成", async ({ env }) => {
		await env.writeExtension(
			"batch-tool.mjs",
			`
			export default function activate(pi) {
				pi.registerTool({
					def: {
						type: "function",
						function: {
							name: "chunk_task",
							description: "模拟分批产生较大数据",
							parameters: { type: "object", properties: {} },
						},
					},
					async run() {
						return {
							result: "批量数据块 ".repeat(250),
							status: "succeeded",
						};
					},
				});
			}
		`,
		);

		let stepCount = 0;
		// 紧凑窗口 12_000，每2~3步工具即会触顶
		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 12_000 });
		scenario.fallback((req) => {
			const isSummaryCall = (req.messages[0]?.content ?? "").includes("上下文摘要助手");
			if (isSummaryCall) {
				return [
					{ kind: "text", text: "已阶段性总结前序数据块并更新当前进展" },
					{ kind: "finish", reason: "stop" },
				];
			}
			stepCount++;
			if (stepCount <= 7) {
				return [
					{ kind: "tool_call", call: { id: `chunk-call-${stepCount}`, name: "chunk_task", args: "{}" } },
					{ kind: "finish", reason: "tool_calls" },
				];
			}
			return [
				{ kind: "text", text: "全部长链路批次执行完毕" },
				{ kind: "finish", reason: "stop" },
			];
		});

		const uina = await UinaTestHarness.create({ env, scenario, hostOptions: { workspaceTools: false } });
		try {
			await uina.send("开始7轮批处理任务", "direct");
			await uina.waitForIdle();

			const summaryCalls = scenario.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"));
			// 验证在单次回合内触发了不止一次（至少2次）压缩
			expect(summaryCalls.length).toBeGreaterThanOrEqual(2);

			const finalRequest = scenario.calls.at(-1);
			expect(finalRequest?.messages.some((m) => m.role === "user" && (m.content ?? "").startsWith("[历史摘要] "))).toBe(
				true,
			);

			const journal = await readFile(env.sessionPath, "utf8");
			expect(journal).not.toContain("turn_failed");
		} finally {
			await uina.dispose();
		}
	});

	test("thinking 重量级历史：压缩估算与 preflight 测量同口径，超预算时自动压缩而非 noop-fail", async ({ env }) => {
		// 回归背景：estimateStreamTokens 曾硬编码不计 thinking，而 preflight 测量在
		// thinkingLevel≠off 时计入——上下文越预算时压缩器认为"消息本体仍 fit"报 noop，
		// preflight 直接 fail 杀死回合（真实事故：~108k tokens 的 deepseek 高思考会话）。
		// 本用例钉住 thinking 必须参与压缩边界估算。
		const history = Array.from({ length: 12 }, (_, index) =>
			index % 2 === 0
				? { role: "user" as const, content: `问${index} ${"词".repeat(100)}` }
				: {
						role: "assistant" as const,
						content: `答${index}`,
						thinking: `推理${index} ${"思".repeat(2000)}`,
						status: "complete" as const,
					},
		);
		await persistHistory(env, history);

		const scenario = new Scenario({
			id: "mock",
			name: "mock",
			contextWindow: 12_000,
			thinkingReplay: "all",
			thinkingLevels: ["off", "low", "high"],
		});
		scenario.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).reply("摘".repeat(300));
		scenario.fallback(() => [
			{ kind: "text", text: "ok" },
			{ kind: "finish", reason: "stop" },
		]);

		const uina = await UinaTestHarness.create({
			env,
			scenario,
			hostOptions: { thinkingLevel: "high", workspaceTools: false },
		});
		try {
			await uina.send("触发预算检查", "direct");
			await uina.waitForIdle();

			// 自动压缩确实发生：摘要请求出现过，下一次请求以摘要开头，checkpoint 已持久化。
			expect(scenario.calls.some((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"))).toBe(true);
			const last = scenario.calls.at(-1);
			expect(last?.messages.some((m) => (m.content ?? "").startsWith("[历史摘要] "))).toBe(true);
			const journal = await readFile(env.sessionPath, "utf8");
			expect(journal).toContain("uina.compaction.summary");
			expect(journal).not.toContain("turn_failed");
		} finally {
			await uina.dispose();
		}
	});
});
