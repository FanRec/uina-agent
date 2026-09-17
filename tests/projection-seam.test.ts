/**
 * P3c 投影 Replacement 缝守卫（执行稿 v6：projectHistory / convertToLlm 可注入，
 * Replacement 单 owner，先只做测试双实现）。
 * - 默认路径逐字节等价（无 policy 时解析结果 ≡ 现役自由函数）；
 * - convertToLlm 双实现：provider 边界收到的消息经 policy 形塑；
 * - projectHistory 双实现：journal→memory 投影（回溯采用路径）经 policy 形塑。
 * 不做 contributor chain、不造 ProjectorPipeline（L6 明禁）。
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Subject } from "../src/agent/loop.js";
import { ToolBroker } from "../src/tools/broker.js";
import { MemorySessionStore, openJsonlSession } from "../src/session/jsonl-store.js";
import { projectAgentHistory } from "../src/session/recovery.js";
import { convertToLlm } from "../src/agent/context.js";
import { projectModelHistory, resolveProjectionPolicy } from "../src/agent/projection.js";
import { UinaHost } from "../src/host/host.js";
import { mockModel, scriptedProvider } from "./helpers/mock-provider.js";

async function idle(subject: Subject, timeoutMs = 5000): Promise<void> {
	const started = Date.now();
	while (subject.isBusy()) {
		if (Date.now() - started > timeoutMs) throw new Error("等待主体空闲超时");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("projection Replacement seam (P3c)", () => {
	it("keeps the default pipeline equivalent when no policy is given", async () => {
		const store = new MemorySessionStore();
		await store.appendMessage({ role: "user", content: "task" });
		await store.appendMessage({ role: "assistant", content: "reply" });
		const resolved = resolveProjectionPolicy();
		expect(resolved.projectHistory(store.state.entries, store.state)).toEqual(projectAgentHistory(store.state.entries));
		const messages = projectAgentHistory(store.state.entries);
		expect(resolved.convertToLlm(messages)).toEqual(convertToLlm(messages));
		expect(projectModelHistory(store.state.entries)).toEqual(convertToLlm(projectAgentHistory(store.state.entries)));
	});

	it("routes provider-bound shaping through the injected convertToLlm policy", async () => {
		const provider = scriptedProvider([
			{ match: () => true, produce: () => [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }] },
		]);
		const subject = new Subject(provider.model, provider.stream, new ToolBroker(), {
			projection: {
				convertToLlm: (messages, opts) =>
					convertToLlm(messages, opts).map((m) => ({ ...m, content: `[shaped] ${m.content}` })),
			},
		});
		await subject.pushInput("hello");
		await idle(subject);

		expect(provider.calls).toHaveLength(1);
		const seen = provider.calls[0]!.messages.filter((m) => m.role !== "system");
		expect(seen.length).toBeGreaterThan(0);
		for (const m of seen) expect(m.content).toMatch(/^\[shaped\]/);
	});

	it("routes journal→memory projection through the injected projectHistory policy on rewind", async () => {
		const store = new MemorySessionStore();
		await store.appendMessage({ role: "user", content: "task 1" });
		await store.appendMessage({ role: "assistant", content: "reply 1" });
		const targetId = store.readRecords()[1]!.id;
		await store.appendMessage({ role: "user", content: "task 2" });

		const subject = new Subject(
			mockModel(),
			async (_m, _r, emit) => {
				emit({ kind: "text", text: "ok" });
				emit({ kind: "finish", reason: "stop" });
			},
			new ToolBroker(),
			{
				store,
				projection: {
					projectHistory: (entries) =>
						projectAgentHistory(entries).map((m) => ({ ...m, content: `${m.content} [projected]` })),
				},
			},
		);
		await subject.requestRewind({ targetId, reason: "wrong premise" }, "test");

		const history = subject.historySnapshot();
		// 回溯采用的主线整体来自 policy 形塑；被放弃切片不回归主线。
		expect(history.some((m) => m.content.includes("reply 1 [projected]"))).toBe(true);
		expect(history.some((m) => m.content.includes("task 2"))).toBe(false);
		// 缝边界：回溯后新回合产生的 assistant 回复是全新运行时事实，
		// 不经 journal→memory 投影，天然不被 projectHistory policy 形塑。
		expect(history.some((m) => m.content === "ok")).toBe(true);
	});

	it("routes host-level policy through the startup restore path", async () => {
		const dir = await mkdtemp(join(tmpdir(), "uina-host-proj-"));
		try {
			const path = join(dir, "session.jsonl");
			const initial = await openJsonlSession(path);
			await initial.store.appendMessage({ role: "user", content: "restore-me" });
			await initial.store.appendMessage({ role: "assistant", content: "restored reply" });
			await initial.store.close();

			const probe = scriptedProvider([
				{ match: () => true, produce: () => [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }] },
			]);
			const host = await UinaHost.create({
				cwd: dir,
				provider: probe,
				model: probe.model,
				sessionPath: path,
				projection: {
					projectHistory: (entries) =>
						projectAgentHistory(entries).map((m) => ({ ...m, content: `${m.content} [projected]` })),
				},
			});
			await host.start();

			const history = host.subject.historySnapshot();
			expect(history.some((m) => m.content.includes("restore-me [projected]"))).toBe(true);
			expect(history.some((m) => m.content.includes("restored reply [projected]"))).toBe(true);
			await host.dispose();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
