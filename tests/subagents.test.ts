import { describe, expect, it, vi } from "vitest";
import { DefaultAgentFactory, type AgentFactory } from "../src/agent/runtime.js";
import type { Model, ModelStreamFn } from "../src/core/types.js";
import { ToolBroker, type ToolView } from "../src/tools/broker.js";
import { SubagentRegistry } from "../src/extensions/subagents/registry.js";
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import { JobRegistry } from "../src/extensions/jobs/registry.js";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { activateRuntimeTools, createChildTools } from "../src/extensions/runtime-tools/index.js";
import { scriptedProvider, toolCallDelta } from "./helpers/mock-provider.js";

function providerFor(reply: (prompt: string) => string | Promise<string>): { model: Model; stream: ModelStreamFn } {
	const model: Model = {
		id: "child-test",
		name: "child-test",
		providerId: "mock",
		contextWindow: 128_000,
		thinkingLevels: ["off"],
	};
	const stream: ModelStreamFn = async (_m, request, emit, signal) => {
		const prompt = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
		const text = await reply(prompt);
		if (signal?.aborted) return;
		emit({ kind: "thinking", text: "分析 " });
		emit({ kind: "text", text });
		emit({ kind: "finish", reason: "stop" });
	};
	return { model, stream };
}

function make(
	pair: { model: Model; stream: ModelStreamFn },
	notify?: (text: string, data: Record<string, unknown>, ownerId: string) => Promise<void>,
	factory: AgentFactory = new DefaultAgentFactory(),
): SubagentRegistry {
	return new SubagentRegistry({
		factory,
		model: () => pair.model,
		stream: pair.stream,
		createTools: () => new ToolBroker(),
		notify,
	});
}

describe("SubagentRegistry", () => {
	it("inherits capabilities with child ownership and delivers job completion back to that child", async () => {
		const root = new ToolBroker({ ownerId: "root" });
		const children = new Map<string, ToolView>();
		const jobs = new JobRegistry();
		const rootInputs: unknown[] = [], errors: string[] = [];
		const provider = scriptedProvider([
			{ match: req => req.messages.some(m => m.content.includes("job-notice")), produce: () => [{ kind: "text", text: "received own job" }] },
			{ match: req => req.messages.some(m => m.content === "grandchild"), produce: () => [{ kind: "text", text: "grandchild ready" }] },
			{ match: req => !req.messages.some(m => m.role === "tool"), produce: () => [toolCallDelta("start-job", "exec_command", { command: process.platform === "win32" ? "Write-Output child-result" : "echo child-result", run_in_background: true })] },
			{ match: () => true, produce: () => [{ kind: "text", text: "waiting" }] },
		]);
		const registry = new SubagentRegistry({
			factory: new DefaultAgentFactory(),
			model: () => provider.model,
			stream: provider.stream,
			createTools: ownerId => { const tools = createChildTools(root, { ownerId }); children.set(ownerId, tools); return tools; },
		});
		const runner = new ExtensionRunner({ cwd: process.cwd(), tools: root, onInput: async input => { rootInputs.push(input); }, onError: error => errors.push(error) });
		await runner.activateBuiltin("runtime", activateRuntimeTools({ jobs, subagents: registry }));
		try {
			const child = registry.start({ ownerId: "root", label: "child", prompt: "start" });
			await vi.waitFor(() => expect(registry.transcript(child.id, "root").messages.some(m => m.content.includes("received own job"))).toBe(true), { timeout: 5000 });
			expect(jobs.list(child.id)).toHaveLength(1);
			expect(jobs.list("root")).toEqual([]);
			expect(rootInputs).toEqual([]);
			expect(errors).toEqual([]);
			const tools = children.get(child.id)!;
			const listed = JSON.parse(await tools.run("job_list", {}));
			expect(listed[0].ownerId).toBe(child.id);
			const output = JSON.parse(await tools.run("job_output", { job_id: listed[0].id }));
			expect(output.result).toContain("child-result");
			expect(registry.transcript(child.id, "root").messages.some(m => m.role === "custom" && m.customType === "runtime-input")).toBe(true);
			const grandchild = JSON.parse(await tools.run("subagent_start", { label: "grandchild", prompt: "grandchild" }));
			expect(registry.list(child.id).map(c => c.id)).toEqual([grandchild.id]);
			expect(registry.get(grandchild.id, child.id).parentId).toBe(child.id);
		} finally { await runner.dispose(); }
	});
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
			model: { id: "blocking-child", name: "blocking-child", providerId: "mock", contextWindow: 128_000, thinkingLevels: ["off"] },
			stream: async (_m, _request, _emit, signal) => {
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
		const failing = make({
			model: { id: "failing-child", name: "failing-child", providerId: "mock", contextWindow: 128_000, thinkingLevels: ["off"] },
			stream: async () => { throw new Error("provider down"); },
		});
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
		const registry = make({
			model: { id: "failing-child", name: "failing-child", providerId: "mock", contextWindow: 128_000, thinkingLevels: ["off"] },
			stream: async () => { throw new Error("provider down"); },
		}, async () => {
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
		const pair = providerFor(() => "ok");
		const handle = new DefaultAgentFactory().create({ model: pair.model, stream: pair.stream, tools: new ToolBroker(), store });
		await handle.send({ id: "input", mode: "followUp", source: { kind: "agent", type: "test" }, text: "开始" });
		await handle.interrupt();
		expect(handle.snapshot().status).toBe("idle");
		await handle.dispose();
		expect(closed).toBe(true);
		await handle.dispose();
	});
});
