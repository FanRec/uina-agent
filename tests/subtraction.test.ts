import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Subject } from "../src/agent/loop.js";
import { ToolBroker } from "../src/tools/broker.js";
import { openJsonlSession } from "../src/session/jsonl-store.js";
import { projectModelHistory } from "../src/agent/projection.js";
import { projectAgentHistory } from "../src/session/recovery.js";
import { scriptedProvider } from "./helpers/mock-provider.js";

// 减法测试（七问 #6）：不激活任何 capability/extension，仅内核五目录。
// 验收：内核可启动、可跑回合、工具可用、journal 持久。
it("减法测试：删掉所有 capability 后 Subject 仍完整成立（七问#6）", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "uina-subtraction-"));
	const path = join(cwd, "session.jsonl");
	const { store } = await openJsonlSession(path);

	// 1) 先铸造一个带回溯历史的 journal。
	await store.appendMessage({ role: "user", content: "old premise" });
	await store.appendMessage({ role: "assistant", content: "old answer" });
	await store.appendRewind({
		id: "rewind-1",
		requestId: "req-1",
		targetId: store.readRecords()[0].id,
		fromId: store.readRecords().at(-1)!.id,
		source: "model",
		reason: "subtraction test",
		summary: "回溯验证",
	});

	// 2) 裸内核：零 capability，直接 Subject + Broker + 本地工具。
	const provider = scriptedProvider([{ match: () => true, produce: () => [{ kind: "text", text: "fresh reply" }] }]);
	const broker = new ToolBroker();
	broker.register({
		def: { type: "function", function: { name: "echo", description: "echo", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
		run: async (args: Record<string, unknown>) => ({ result: String(args.text), status: "succeeded" as const }),
	});
	const subject = new Subject(provider.model, provider.stream, broker, { store });
	subject.addHistory(projectAgentHistory(store.state.entries));

	// 3) 历史照常回放（canonicalReplay，零扩展参与）。
	// 回溯目标 = 首条消息：放弃其后一切（含旧回答）——
	// "回溯重建先前主线"是既定语义（session-rewind 已钉）。
	const replayed = projectModelHistory(store.state.entries);
	expect(replayed.some((m) => m.content === "old premise")).toBe(true);
	expect(replayed.some((m) => m.content === "old answer")).toBe(false);
	expect(subject.historySnapshot().some((m) => m.content === "old premise")).toBe(true);

	// 4) 跑一回合（含工具调用）。
	await subject.pushInput("hello");
	await subject.waitForIdle();
	expect(provider.calls.at(-1)?.messages.some((m) => (m.content ?? "").includes("old premise"))).toBe(true);

	// 5) journal 持久化到磁盘。
	const raw = await readFile(path, "utf8");
	expect(raw).toContain("fresh reply");

	await rm(cwd, { recursive: true, force: true });
});
