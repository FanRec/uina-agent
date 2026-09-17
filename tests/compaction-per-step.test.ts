/**
 * 自动压缩语义切换（P6b）：上下文窗口管理归 official compaction capability，
 * 经 turn.transformContext 每请求裁剪——journal 保留全量历史，Subject 内存
 * 视图不被自动截断，摘要以 uina.compaction.summary custom entry 持久化。
 *
 * 回合内暴涨的安全网 = 每请求裁剪本身：工具输出让上下文越过阈值后，
 * 下一次模型调用收到的就是 [历史摘要, 预算内尾部]，而不是超大请求。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, ModelRequest, ModelStreamFn, StreamDelta } from "../src/core/types.js";
import { mockModel, scriptedProvider, type ScriptRule } from "./helpers/mock-provider.js";

// 预算 = contextWindow(50_000) - RESERVE_TOKENS(16_384) = 33_616 tokens；
// CHARS_PER_TOKEN = 4，"词".repeat(4_000) ≈ 1_000 tokens/条。
const MODEL: Model = mockModel({ id: "mock", name: "mock", contextWindow: 50_000 });

const hasToolResult = (req: ModelRequest): boolean => req.messages.some((m) => m.role === "tool");

const seedHistory = (): { role: "user" | "assistant"; content: string }[] =>
	Array.from({ length: 100 }, (_, index) =>
		index % 2 === 0 ? { role: "user" as const, content: `第${index}问 ${"词".repeat(4_000)}` } : { role: "assistant" as const, content: `第${index}答 ${"词".repeat(4_000)}` },
	);

describe("自动压缩：capability 经 transformContext 每请求裁剪", () => {
	it("同一个回合内上下文越过阈值后，下一次调用收到的是摘要 + 预算内尾部，journal 保留全量历史", async () => {
		const { UinaHost } = await import("../src/host/host.js");
		const calls: ModelRequest[] = [];
		const stream: ModelStreamFn = async (_model, req, onDelta) => {
			calls.push(req);
			const isSummaryCall = (req.messages[0]?.content ?? "").includes("上下文摘要助手");
			const deltas: StreamDelta[] = isSummaryCall
				? [{ kind: "text", text: "早期对话围绕长文本输入展开" }]
				: hasToolResult(req)
					? [{ kind: "text", text: "收到工具结果，处理完成" }]
					: [{ kind: "tool_call", call: { id: "c1", name: "no_such_tool", args: "{}" } }];
			for (const delta of deltas) onDelta(delta);
			onDelta({ kind: "finish", reason: deltas.some((d) => d.kind === "tool_call") ? "tool_calls" : "stop" });
		};

		const cwd = await mkdtemp(join(tmpdir(), "uina-trim-"));
		try {
			const sessionPath = join(cwd, "session.jsonl");
			const host = await UinaHost.create({ cwd, provider: { id: "mock", name: "mock", model: MODEL, stream } as never, model: MODEL, sessionPath });
			await host.start();

			host.subject.addHistory(seedHistory());

			await host.submitText("跑两轮", "direct");
			await host.waitForIdle();

			// 第二次调用（带工具结果的那次）已被裁剪：摘要消息开头。
			expect(calls.length).toBeGreaterThanOrEqual(2);
			const trimmedRequest = calls.find((req) => hasToolResult(req));
			expect(trimmedRequest).toBeDefined();
			// leading system 保留，摘要消息紧随其后。
			const first = trimmedRequest?.messages[1];
			expect(first?.role).toBe("user");
			expect((first?.content ?? "").startsWith("[历史摘要] ")).toBe(true);

			// Subject 内存视图不被自动截断：全量历史仍在，无 canonical 截断产物。
			const memory = host.subject.historySnapshot();
			expect(memory.some((message) => message.role === "compactionSummary")).toBe(false);
			expect(memory.some((message) => (message.content as string)?.includes("第0问"))).toBe(true);

			// journal 持久化了滚动摘要（uina.compaction.summary custom entry，
			// 经 pi.emitEvent → 扩展事件总线广播 session_compact，与旧 manual 路径同可见性）。
			const journal = await readFile(sessionPath, "utf8");
			expect(journal).toContain("uina.compaction.summary");
			await host.dispose();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("重启后从 journal 重载滚动摘要，不重复生成", async () => {
		const { UinaHost } = await import("../src/host/host.js");
		const { openJsonlSession } = await import("../src/session/jsonl-store.js");
		const rules: ScriptRule[] = [
			{ match: (req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"), produce: () => [{ kind: "text", text: "ok-tail" }] },
			{ match: () => true, produce: () => [{ kind: "text", text: "ok" }] },
		];
		const provider = scriptedProvider(rules, { contextWindow: 50_000 });
		const cwd = await mkdtemp(join(tmpdir(), "uina-reload-"));
		try {
			const sessionPath = join(cwd, "session.jsonl");
			// 种子先落盘（addHistory 只进内存）：重启后主线仍超预算，裁剪才有前提。
			const seeded = await openJsonlSession(sessionPath);
			for (const message of seedHistory()) await seeded.store.appendMessage(message);
			const host = await UinaHost.create({ cwd, provider, model: provider.model, sessionPath });
			await host.start();
			await host.submitText("第一轮", "direct");
			await host.waitForIdle();
			const summaryCallsAfterFirst = provider.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).length;
			expect(summaryCallsAfterFirst).toBeGreaterThanOrEqual(1);

			// 同一宿主再跑一轮：摘要已缓存且仍有效，不再生成第二份。
			await host.submitText("第二轮", "direct");
			await host.waitForIdle();
			const summaryCallsAfterSecond = provider.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).length;
			expect(summaryCallsAfterSecond).toBe(summaryCallsAfterFirst);
			await host.dispose();

			// 重启：从 journal 重载摘要，裁剪照常生效且不重新生成。
			const provider2 = scriptedProvider(rules, { contextWindow: 50_000 });
			const host2 = await UinaHost.create({ cwd, provider: provider2, model: provider2.model, sessionPath });
			await host2.start();
			await host2.submitText("重启后一轮", "direct");
			await host2.waitForIdle();
			expect(provider2.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).length).toBe(0);
			const reloaded = provider2.calls.at(-1);
			expect(reloaded?.messages.some((m) => m.role === "user" && (m.content ?? "").startsWith("[历史摘要] "))).toBe(true);
			await host2.dispose();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("手动 /compact：下一请求强制裁剪并携带 instruction；失败广播 session_compact_failed 且请求透传", async () => {
		const { UinaHost } = await import("../src/host/host.js");
		// force 边界按 MANUAL_KEEP_TOKENS(20_000) 计算：种子 ≈ 22.5k tokens 必须超过它。
		const history = Array.from({ length: 30 }, (_, index) =>
			index % 2 === 0 ? { role: "user" as const, content: `问${index} ${"词".repeat(3_000)}` } : { role: "assistant" as const, content: `答${index} ${"词".repeat(3_000)}` },
		);
		const rules: ScriptRule[] = [
			{ match: (req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"), produce: () => [{ kind: "text", text: "手动摘要内容" }] },
			{ match: () => true, produce: () => [{ kind: "text", text: "ok" }] },
		];
		const provider = scriptedProvider(rules, { contextWindow: 50_000 });
		const cwd = await mkdtemp(join(tmpdir(), "uina-manual-"));
		try {
			const host = await UinaHost.create({ cwd, provider, model: provider.model, sessionPath: join(cwd, "session.jsonl") });
			await host.start();

			// 预算内（自动路径不触发），/compact 强制受理。
			for (const message of history) host.subject.addHistory([message]);
			const before = provider.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).length;
			await host.commands.dispatch("/compact 关注决策");
			await host.submitText("强制一轮", "direct");
			await host.waitForIdle();

			const summaryCalls = provider.calls.filter((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"));
			expect(summaryCalls.length).toBe(before + 1);
			// instruction 注入摘要提示词。
			expect(summaryCalls.at(-1)?.messages.at(-1)?.content).toContain("额外关注：关注决策");
			// 下一次请求以摘要开头（leading system 原位）。
			const last = provider.calls.at(-1);
			expect(last?.messages[1]?.content).toBe("[历史摘要] 手动摘要内容");
			// 内存视图与 journal 仍全量：无 canonical 截断。
			expect(host.subject.historySnapshot().some((m) => m.content === "[历史摘要] 手动摘要内容")).toBe(false);
			const { readFile: rf } = await import("node:fs/promises");
			expect(await rf(join(cwd, "session.jsonl"), "utf8")).toContain("uina.compaction.summary");
			await host.dispose();

			// 失败路径：摘要生成抛错 → session_compact_failed 广播，请求透传。
			const failing = scriptedProvider([
				{ match: (req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"), produce: () => { throw new Error("compact down"); } },
				{ match: () => true, produce: () => [{ kind: "text", text: "ok" }] },
			], { contextWindow: 50_000 });
			const failDir = await mkdtemp(join(tmpdir(), "uina-manual-fail-"));
			const host2 = await UinaHost.create({ cwd: failDir, provider: failing, model: failing.model, sessionPath: join(failDir, "session.jsonl") });
			await host2.start();
			for (const message of history) host2.subject.addHistory([message]);
			await host2.commands.dispatch("/compact");
			await host2.submitText("失败一轮", "direct");
			await host2.waitForIdle();
			// 摘要失败 → 强制路径透传原上下文（无摘要消息），事件可见性由
			// extension-composition 的 capability 事件契约测试钉住。
			expect(failing.calls.at(-1)?.messages.some((m) => (m.content ?? "").startsWith("[历史摘要] "))).toBe(false);
			await host2.dispose();
			await rm(failDir, { recursive: true, force: true });
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
