import { describe, expect, it } from "vitest";
import { DefaultAgentFactory, type AgentFactory } from "../src/agent/runtime.js";
import type { ModelProvider } from "../src/core/types.js";
import { ToolBroker } from "../src/tools/broker.js";
import { SubagentRegistry } from "../src/extensions/subagents/registry.js";
import { MemorySessionStore } from "../src/session/jsonl-store.js";

function providerFor(reply: (prompt: string) => string | Promise<string>): ModelProvider {
	return {
		name: "child-test",
		thinkingLevels: ["off"],
		async stream(request, emit, signal) {
			const prompt = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
			const text = await reply(prompt);
			if (signal?.aborted) return;
			emit({ kind: "thinking", text: "分析 " });
			emit({ kind: "text", text });
			emit({ kind: "finish", reason: "stop" });
		},
	};
}

function make(provider: ModelProvider, notify?: (text: string, data: Record<string, unknown>) => Promise<void>, factory: AgentFactory = new DefaultAgentFactory()): SubagentRegistry {
	return new SubagentRegistry({
		factory,
		provider,
		createTools: () => new ToolBroker(),
		notify,
	});
}

describe("SubagentRegistry", () => {
	it("starts an independent child, keeps transcript local, and reads output by cursor", async () => {
		const registry = make(providerFor((prompt) => `答复:${prompt}`));
		const started = registry.start({ ownerId: "root", label: "调查", prompt: "第一问" });
		expect(started.id).toMatch(/^subagent-/);
		while (registry.get(started.id, "root").status === "accepted" || registry.get(started.id, "root").status === "running") {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const first = registry.read(started.id, "root");
		expect(first.output.map((item) => item.kind)).toEqual(["thinking", "text"]);
		expect(first.output[1]?.text).toBe("答复:第一问");
		const second = registry.read(started.id, "root", first.cursor);
		expect(second.output).toEqual([]);
		await registry.send(started.id, "root", "第二问");
		const transcript = registry.transcript(started.id, "root");
		expect(transcript.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["第一问", "第二问"]);
		await registry.close();
	});

	it("enforces ownership and reports interruption only after the child settles", async () => {
		let disposed = false;
		const factory: AgentFactory = {
			create(options) {
				const handle = new DefaultAgentFactory().create(options);
				const dispose = handle.dispose.bind(handle);
				handle.dispose = async () => { disposed = true; await dispose(); };
				return handle;
			},
		};
		const registry = make({
			name: "blocking-child",
			thinkingLevels: ["off"],
			async stream(_request, _emit, signal) {
				await new Promise<void>((resolve) => {
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
			},
		}, undefined, factory);
		const started = registry.start({ ownerId: "root", label: "等待", prompt: "工作" });
		expect(() => registry.get(started.id, "other")).toThrow();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const interrupt = registry.interrupt(started.id, "root");
		expect(await interrupt).toBe("interruption-requested");
		expect(registry.get(started.id, "root")).toMatchObject({ status: "settled", terminalStatus: "interrupted", finishedAt: expect.any(Number) });
		expect(disposed).toBe(true);
		expect(await registry.interrupt(started.id, "root")).toBe("already-finished");
	});

	it("rejects new input after interruption admission and settles startup failures", async () => {
		const failing = make({ name: "failing-child", thinkingLevels: ["off"], async stream() { throw new Error("provider down"); } });
		const started = failing.start({ ownerId: "root", label: "失败", prompt: "开始" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(failing.get(started.id, "root")).toMatchObject({ status: "settled", terminalStatus: "failed", detail: "provider down", finishedAt: expect.any(Number) });
		await expect(failing.send(started.id, "root", "晚到的消息")).rejects.toThrow("已结算");
		await failing.close();
	});

	it("delivers a short settlement notice without making child output part of root history", async () => {
		const notices: string[] = [];
		const registry = make(providerFor(() => "完成"), async (text) => { notices.push(text); });
		const started = registry.start({ ownerId: "root", label: "一次工作", prompt: "开始" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(notices).toEqual([]);
		expect(registry.get(started.id, "root").status).toBe("waiting");
		await registry.close();
	});

	it("records notice delivery failure without replacing the child terminal fact", async () => {
		const registry = make({ name: "failing-child", thinkingLevels: ["off"], async stream() { throw new Error("provider down"); } }, async () => {
			throw new Error("parent unavailable");
		});
		const started = registry.start({ ownerId: "root", label: "失败", prompt: "开始" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(registry.get(started.id, "root")).toMatchObject({
			status: "settled",
			terminalStatus: "failed",
			detail: "provider down；通知投递失败：parent unavailable",
		});
		await registry.close();
	});
});

describe("AgentHandle lifecycle", () => {
	it("updates idle state after an unreasoned interrupt and closes its store", async () => {
		let closed = false;
		const store = new MemorySessionStore();
		const originalClose = store.close.bind(store);
		store.close = async () => { closed = true; await originalClose(); };
		const handle = new DefaultAgentFactory().create({ provider: providerFor(() => "ok"), tools: new ToolBroker(), store });
		await handle.send({ id: "input", mode: "followUp", source: { kind: "agent", type: "test" }, text: "开始" });
		await handle.interrupt();
		expect(handle.snapshot().status).toBe("idle");
		await handle.dispose();
		expect(closed).toBe(true);
		await handle.dispose();
	});
});
