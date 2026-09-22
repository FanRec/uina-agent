/**
 * 自动压缩语义：上下文窗口管理归 official compaction capability，
 * 经 turn.transformContext 每请求裁剪——journal 保留全量历史，Subject 内存
 * 视图不被自动截断，摘要以 uina.compaction.summary custom entry 持久化。
 *
 * 回合内暴涨的安全网 = 每请求裁剪本身：工具输出让上下文越过阈值后，
 * 下一次模型调用收到的就是 [历史摘要, 预算内尾部]，而不是超大请求。
 *
 * 基于 Uina Test Kit 迁移，消灭重复的 mkdtemp/rm 样板代码。
 */
import { describe, expect, test } from "./harness/index.js";
import { readFile } from "node:fs/promises";
import type { ModelRequest, StreamDelta } from "../src/core/types.js";
import { estimateStreamTokens } from "../src/extensions/compaction/index.js";
import { openJsonlSession } from "../src/session/jsonl-store.js";
import { UinaTestHarness } from "./harness/host/harness.js";
import { Scenario } from "./harness/provider/scenario.js";
import { IsolatedEnv } from "./harness/environment/isolated-env.js";

// 帧回执（external_event_frame 合成 tool 消息）不算真实工具结果：默认装配下
// 外部输入也会投影为 tool 角色回执，这里只关心模型真实工具调用的结果。
const hasToolResult = (req: ModelRequest): boolean =>
	req.messages.some((m) => m.role === "tool" && m.context?.kind !== "uina.external-event-frame");

const seedHistory = (): { role: "user" | "assistant"; content: string }[] =>
	Array.from({ length: 100 }, (_, index) =>
		index % 2 === 0 ? { role: "user" as const, content: `第${index}问 ${"词".repeat(4_000)}` } : { role: "assistant" as const, content: `第${index}答 ${"词".repeat(4_000)}` },
	);

describe("自动压缩：capability 经 transformContext 每请求裁剪", () => {
	test("同一个回合内上下文越过阈值后，下一次调用收到的是摘要 + 预算内尾部，journal 保留全量历史", async ({ env }) => {
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
			uina.host.subject.addHistory(seedHistory());

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
		scenario
			.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"))
			.reply("ok-tail");
		scenario.fallback(() => [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }]);

		const uina = await UinaTestHarness.create({ env, scenario });
		try {
			await uina.send("第一轮", "direct");
			await uina.waitForIdle();
			const summaryCallsAfterFirst = scenario.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).length;
			expect(summaryCallsAfterFirst).toBeGreaterThanOrEqual(1);

			// 同一宿主再跑一轮：摘要已缓存且仍有效，不再生成第二份。
			await uina.send("第二轮", "direct");
			await uina.waitForIdle();
			const summaryCallsAfterSecond = scenario.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).length;
			expect(summaryCallsAfterSecond).toBe(summaryCallsAfterFirst);

			// 重启：从 journal 重载摘要，裁剪照常生效且不重新生成。
			const scenario2 = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });
			scenario2
				.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"))
				.reply("ok-tail");
			scenario2.fallback(() => [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }]);

			const restarted = await UinaTestHarness.create({ env, scenario: scenario2 });
			try {
				await restarted.send("重启后一轮", "direct");
				await restarted.waitForIdle();
				expect(scenario2.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).length).toBe(0);
				const reloaded = scenario2.calls.at(-1);
				expect(reloaded?.messages.some((m) => m.role === "user" && (m.content ?? "").startsWith("[历史摘要] "))).toBe(true);
			} finally {
				await restarted.dispose();
			}
		} finally {
			await uina.dispose();
		}
	});

	test("手动 /compact：下一请求强制裁剪并携带 instruction；失败广播 session_compact_failed 且请求透传", async ({ env }) => {
		// force 边界按 MANUAL_KEEP_TOKENS(20_000) 计算：种子 ≈ 22.5k tokens 必须超过它。
		const history = Array.from({ length: 30 }, (_, index) =>
			index % 2 === 0 ? { role: "user" as const, content: `问${index} ${"词".repeat(3_000)}` } : { role: "assistant" as const, content: `答${index} ${"词".repeat(3_000)}` },
		);

		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });
		scenario
			.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"))
			.reply("手动摘要内容");
		scenario.fallback(() => [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }]);

		const uina = await UinaTestHarness.create({ env, scenario });
		try {
			// 预算内（自动路径不触发），/compact 强制受理。
			for (const message of history) uina.host.subject.addHistory([message]);
			const before = scenario.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).length;
			await uina.host.commands.dispatch("/compact 关注决策");
			await uina.send("强制一轮", "direct");
			await uina.waitForIdle();

			const summaryCalls = scenario.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"));
			expect(summaryCalls.length).toBe(before + 1);
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

		// 失败路径：摘要生成抛错 → session_compact_failed 广播，请求透传。
		const failEnv = await IsolatedEnv.create();
		const failing = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });
		failing
			.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"))
			.then(() => { throw new Error("compact down"); });
		failing.fallback(() => [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }]);

		const failHarness = await UinaTestHarness.create({ env: failEnv, scenario: failing });
		try {
			for (const message of history) failHarness.host.subject.addHistory([message]);
			await failHarness.host.commands.dispatch("/compact");
			await failHarness.send("失败一轮", "direct");
			await failHarness.waitForIdle();
			expect(failing.calls.at(-1)?.messages.some((m) => (m.content ?? "").startsWith("[历史摘要] "))).toBe(false);
		} finally {
			await failHarness.dispose();
		}
	});

	test("小窗口下手动 /compact：保留量夹取到安全预算，且持久化携带 prefixFingerprint", async ({ env }) => {
		// 窗口仅 6k：手动保留量若仍硬按 MANUAL_KEEP_TOKENS(20_000)，裁剪后尾部就超窗口。
		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 6_000 });
		scenario
			.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"))
			.reply("小窗摘要");
		scenario.fallback(() => [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }]);

		const uina = await UinaTestHarness.create({ env, scenario });
		try {
			const history = Array.from({ length: 30 }, (_, index) =>
				index % 2 === 0 ? { role: "user" as const, content: `问${index} ${"词".repeat(3_000)}` } : { role: "assistant" as const, content: `答${index} ${"词".repeat(3_000)}` },
			);
			for (const message of history) uina.host.subject.addHistory([message]);

			await uina.host.commands.dispatch("/compact");
			await uina.send("小窗一轮", "direct");
			await uina.waitForIdle();

			const last = scenario.calls.at(-1);
			expect(last?.messages.some((m) => (m.content ?? "").startsWith("[历史摘要] "))).toBe(true);
			// 裁剪后整段（system + 摘要 + 保留尾部）必须落在窗口内——证明 keepBudget 被夹取到预算。
			const views = last?.messages.map((m) => ({
				role: m.role,
				content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
				tool_call_id: (m as { tool_call_id?: string }).tool_call_id,
				tool_calls: (m as { tool_calls?: { name: string; args?: unknown }[] }).tool_calls,
			})) ?? [];
			expect(estimateStreamTokens(views)).toBeLessThanOrEqual(6_000);
			// 滚动摘要持久化携带指纹字段（复用门禁的数据来源）。
			const journal = await readFile(env.sessionPath, "utf8");
			expect(journal).toContain("prefixFingerprint");
		} finally {
			await uina.dispose();
		}
	});
});
