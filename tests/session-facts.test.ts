import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import type { ModelStreamFn, ToolResultStatus } from "../src/core/types.js";
import { ExtensionHost } from "../src/extensions/host.js";
import { createRuntimeHooks } from "../src/extensions/runtime-hooks.js";
import execCommand from "../src/extensions/runtime-tools/exec-command/index.js";
import { MemorySessionStore, openJsonlSession } from "../src/session/jsonl-store.js";
import { projectAgentHistory } from "../src/session/recovery.js";
import { projectModelHistory } from "../src/agent/projection.js";
import type { QueuedInput } from "../src/session/types.js";
import { ToolBroker, type Tool } from "../src/tools/broker.js";
import { InteractiveTUI } from "../src/ui/tui.js";
import { TranscriptContainer, formatToolCardLines } from "../src/ui/components/transcript/index.js";
import { IsolatedEnv, Scenario, mockModel, SubjectHarness, mockTool } from "./harness/index.js";

const envs: IsolatedEnv[] = [];
afterEach(async () => {
	await Promise.all(envs.splice(0).map((env) => env.cleanup()));
});
async function sessionPath() {
	const env = await IsolatedEnv.create();
	envs.push(env);
	return env.resolve("session.jsonl");
}
function providerFor(name: string, args: Record<string, unknown> = {}) {
	return Scenario.create()
		.when(req => !req.messages.some(m => m.role === "tool")).replyWithToolCall("call", name, args)
		.when(() => true).reply("done");
}
const toolWith = (run: Tool["run"]): Tool => mockTool("probe", run);

describe("S1 durable session facts", () => {
	it("reopens a blocked call without execution, while a started unfinished call stays unknown", async () => {
		const path = await sessionPath();
		const { store } = await openJsonlSession(path);
		let executions = 0;
		const host = new ExtensionHost();
		host.onHook("tools.beforeCall", () => ({ block: true, reason: "extension decision" }));
		const harness = SubjectHarness.create({
			scenario: providerFor("probe"),
			store,
			runtimeHooks: createRuntimeHooks(host),
			tools: [toolWith(async () => { executions++; return { result: "ok", status: "succeeded" }; })],
		});
		await harness.run("run");
		await store.appendMessage({ role: "assistant", content: "", tool_calls: [{ id: "unfinished", name: "probe", args: {} }] });
		await store.appendEvent("tool_started", { callId: "unfinished", name: "probe" });
		await store.close();
		const reopened = await openJsonlSession(path);
		await reopened.store.close();
		const results = projectAgentHistory(reopened.snapshot.entries).filter(m => m.role === "tool");
		expect(executions).toBe(0);
		expect(results.map(m => m.status)).toEqual(["not_started", "unknown"]);
		expect(results[0]?.content).toContain("extension decision");
		expect((await readFile(path, "utf8")).split("\n").filter(l => l.includes('"tool_started"'))).toHaveLength(1);
	});

	it("reopens domain custom messages without promoting custom entries", async () => {
		const path = await sessionPath();
		const { store } = await openJsonlSession(path);
		await store.appendMessage({ role: "user", content: "before" });
		await store.appendCustomEntry({ customType: "private", data: { secret: "not model content" } });
		await store.appendCustomMessage({ customType: "observation", content: "observed", display: false, details: { origin: "fixture" } });
		await store.appendMessage({ role: "assistant", content: "after" });
		await store.close();
		const reopened = await openJsonlSession(path);
		await reopened.store.close();
		expect(projectAgentHistory(reopened.snapshot.entries).map((m) => m.content)).toEqual(["before", "observed", "after"]);
		expect(JSON.stringify(projectModelHistory(reopened.snapshot.entries))).not.toContain("not model content");
		// custom_entry 是 Auxiliary：不进主线 entries，只登记在 auxiliary timeline。
		expect(reopened.snapshot.entries.some((entry) => (entry as { kind: string }).kind === "custom_entry")).toBe(false);
		expect(reopened.store.state.auxiliary.some((record) => record.kind === "custom_entry" && record.customType === "private")).toBe(true);
	});

	it.each(["user", "runtime"] as const)("gives %s input one owner before and after its commit", async kind => {
		const path = await sessionPath();
		const { store } = await openJsonlSession(path);
		const input: QueuedInput = { id: "input-1", order: 1, mode: "followUp", text: "queued", source: { kind, type: "fixture" }, data: { value: 7 } };
		await store.appendEvent("queue_enqueued", { ...input });
		const before = await readFile(path, "utf8");
		await store.appendInput(input);
		await store.close();
		const after = await readFile(path, "utf8");
		const currentEnv = envs[envs.length - 1]!;
		for (const [index, contents] of [before, after].entries()) {
			const cutPath = currentEnv.resolve(`cut-${index}.jsonl`);
			await writeFile(cutPath, contents);
			const reopened = await openJsonlSession(cutPath);
			await reopened.store.close();
			const { queued, entries } = reopened.snapshot;
			const accepted = entries.filter(e => e.kind === "input" && e.input.id === input.id);
			expect(queued.length + accepted.length).toBe(1);
			expect(queued.length).toBe(index === 0 ? 1 : 0);
			if (index === 1) expect(accepted).toMatchObject([{ kind: "input", input }]);
			const userMessages = projectAgentHistory(entries).filter(m => m.role === "user");
			expect(userMessages).toHaveLength(index === 1 && kind === "user" ? 1 : 0);
		}
	});

	it("commits idle accept input as durable input record without short-circuiting metadata", async () => {
		const path = await sessionPath();
		const { store } = await openJsonlSession(path);
		const harness = SubjectHarness.create({
			scenario: Scenario.create().reply("acknowledged"),
			store,
		});
		await harness.subject.accept({
			id: "idle-input-123",
			mode: "followUp",
			source: { kind: "agent", type: "subagent-start", ref: "sub-1" },
			text: "task from child",
			data: { trace: "abc" },
		});
		await harness.waitForIdle();
		await store.close();

		const rawLines = (await readFile(path, "utf8")).trim().split("\n");
		expect(rawLines.some(l => l.includes('"queue_enqueued"') && l.includes('"idle-input-123"'))).toBe(true);

		const reopened = await openJsonlSession(path);
		await reopened.store.close();
		const inputEntries = reopened.snapshot.entries.filter(e => e.kind === "input");
		expect(inputEntries).toHaveLength(1);
		expect(inputEntries[0]).toMatchObject({
			kind: "input",
			input: {
				id: "idle-input-123",
				order: 1,
				mode: "followUp",
				text: "task from child",
				source: { kind: "agent", type: "subagent-start", ref: "sub-1" },
				data: { trace: "abc" },
			},
		});
		const history = projectAgentHistory(reopened.snapshot.entries);
		expect(history[0]).toMatchObject({
			role: "user",
			id: "idle-input-123",
			content: "task from child",
		});
	});

	it("commits queued steer and followUp once during a normal continuation", async () => {
		const path = await sessionPath();
		const { store } = await openJsonlSession(path);
		let release!: () => void;
		let entered!: () => void;
		const waiting = new Promise<void>(resolve => { entered = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		let calls = 0;
		const model = mockModel({ id: "fixture", name: "fixture" });
		const stream: ModelStreamFn = async (_m, _req, delta) => {
			if (++calls === 1) { entered(); await gate; }
			delta({ kind: "text", text: "done" }); delta({ kind: "finish", reason: "stop" });
		};
		const harness = SubjectHarness.create({ model, stream, store });
		harness.pushInput("first");
		await waiting;
		await harness.subject.steer("steer");
		await harness.subject.followUp("follow");
		release();
		await harness.waitForIdle();
		await store.close();
		const reopened = await openJsonlSession(path);
		await reopened.store.close();
		expect(reopened.snapshot.queued).toEqual([]);
		expect(projectAgentHistory(reopened.snapshot.entries)).toEqual(harness.historySnapshot());
		expect(harness.historySnapshot().filter(m => m.role === "user").map(m => m.content)).toEqual(["first", "steer", "follow"]);
		expect(reopened.snapshot.entries.filter(e => e.kind === "input")).toHaveLength(3);
	});

	it("leaves input pending and reports a failed commit without automatic retry", async () => {
		const store = new MemorySessionStore();
		let attempts = 0;
		store.appendInput = async () => { attempts++; throw new Error("commit failed"); };
		const errors: string[] = [];
		const p1 = Scenario.create().reply("done");
		const harness = SubjectHarness.create({ scenario: p1, store });
		harness.subscribe((e) => { if (e.type === "error") errors.push(e.text); });
		harness.pushInput("first");
		await harness.subject.followUp("pending");
		await harness.waitForIdle();
		expect(attempts).toBe(1);
		expect(errors.join("\n")).toContain("commit failed");
		expect(harness.queuedSnapshot().map(i => i.text)).toEqual(["first", "pending"]);
		expect(harness.historySnapshot().some(m => m.content === "pending")).toBe(false);
	});

	it("resumes a recovered queue through the same input commit", async () => {
		const path = await sessionPath();
		const original = await openJsonlSession(path);
		await original.store.appendEvent("queue_enqueued", { id: "pending-id", order: 1, mode: "followUp", text: "pending" });
		await original.store.close();
		const resumed = await openJsonlSession(path);
		const p2 = Scenario.create().reply("done");
		const harness = SubjectHarness.create({ scenario: p2, store: resumed.store });
		harness.subject.seedQueue(resumed.snapshot.queued);
		await harness.run("continue");
		await resumed.store.close();
		const reopened = await openJsonlSession(path);
		await reopened.store.close();
		expect(reopened.snapshot.queued).toEqual([]);
		expect(projectAgentHistory(reopened.snapshot.entries)).toEqual(harness.historySnapshot());
		expect(harness.historySnapshot().filter(m => m.role === "user").map(m => m.content)).toEqual(["pending", "continue"]);
	});
});

describe("S1 tool outcome propagation", () => {
	it.each(["succeeded", "failed", "cancelled", "unknown", "not_started"] as ToolResultStatus[])("preserves %s through hooks, live UI and JSONL replay", async status => {
		const path = await sessionPath();
		const { store } = await openJsonlSession(path);
		const host = new ExtensionHost();
		const observed: ToolResultStatus[] = [];
		host.onHook("tools.transformResult", input => { observed.push(input.status); return { result: `[hook] ${input.result}` }; });
		const tui = new InteractiveTUI();
		const harness = SubjectHarness.create({
			scenario: providerFor("probe"),
			store,
			runtimeHooks: createRuntimeHooks(host),
			tools: [toolWith(async () => ({ result: "opaque content", status }))],
		});
		harness.subscribe((e) => tui.render(e));
		await harness.run("run");
		tui.host.transcript.finishTurn();
		await store.close();
		const reopened = await openJsonlSession(path);
		await reopened.store.close();
		const replay = new TranscriptContainer();
		replay.loadSession(reopened.snapshot.entries);
		for (const transcript of [tui.host.transcript, replay]) {
			const tool = transcript.getHistory().flatMap(t => t.items).find(i => i.kind === "tool");
			// 阶段 D/M7：canonical 历史（journal/UI/回放）存原始执行正文；hook 改写只作用于模型可见投影。
			expect(tool).toMatchObject({ status, result: "opaque content" });
		}
		expect(observed).toEqual([status]);
		expect(projectAgentHistory(reopened.snapshot.entries).find(m => m.role === "tool")).toMatchObject({ status });
	});

	it("records a real shell exit 7 as failed in the hook, event and message", async () => {
		const path = await sessionPath();
		const { store } = await openJsonlSession(path);
		const host = new ExtensionHost();
		const seen: ToolResultStatus[] = [];
		host.onHook("tools.transformResult", input => { seen.push(input.status); });
		const harness = SubjectHarness.create({
			scenario: providerFor(execCommand.def.function.name, { command: "exit 7" }),
			store,
			runtimeHooks: createRuntimeHooks(host),
			tools: [execCommand],
		});
		await harness.run("run");
		await store.close();
		const records = (await readFile(path, "utf8")).trim().split("\n").map(l => JSON.parse(l));
		expect(seen).toEqual(["failed"]);
		expect(records.find(r => r.event === "tool_finished").data.status).toBe("failed");
	});

	it("records a failing external process command as failed", async () => {
		const path = await sessionPath();
		const { store } = await openJsonlSession(path);
		const host = new ExtensionHost();
		const seen: ToolResultStatus[] = [];
		host.onHook("tools.transformResult", input => { seen.push(input.status); });
		const harness = SubjectHarness.create({
			scenario: providerFor(execCommand.def.function.name, { command: "git checkout --nonexistent-probe-flag-12345" }),
			store,
			runtimeHooks: createRuntimeHooks(host),
			tools: [execCommand],
		});
		await harness.run("run");
		await store.close();
		const records = (await readFile(path, "utf8")).trim().split("\n").map(l => JSON.parse(l));
		expect(seen).toEqual(["failed"]);
		expect(records.find((r: any) => r.event === "tool_finished").data.status).toBe("failed");
		expect(records.find((r: any) => r.message?.role === "tool").message.status).toBe("failed");
	});

	it("trusts explicit outcomes after cancellation and keeps unconfirmed exceptions unknown", async () => {
		for (const outcome of ["succeeded", "cancelled", "throw"] as const) {
			const broker = new ToolBroker(); const controller = new AbortController();
			broker.register(toolWith(async () => { controller.abort(); if (outcome === "throw") throw new Error("stopped"); return { result: "confirmed", status: outcome }; }));
			expect((await broker.execute(broker.prepare("probe", {}), controller.signal)).status).toBe(outcome === "throw" ? "unknown" : outcome);
		}
		for (const [status, label] of [["cancelled", "已取消"], ["unknown", "结果未知"], ["not_started", "未执行"]] as const) {
			expect(formatToolCardLines("probe", "opaque", 0, 80, status).join("\n")).toContain(label);
		}
	});
});

describe("SessionStore schema 边界", () => {
	it("append 拒绝 schema 无效的记录（防可写不可读）", async () => {
		const store = new MemorySessionStore();
		// 兼容两种拒绝形态：Memory 同步抛、Jsonl 返回 rejected promise。
		const rejects = (fn: () => unknown) => expect(Promise.resolve().then(fn)).rejects.toThrow();
		await rejects(() => store.appendMessage({ role: "user", content: 123 } as unknown as never));
		expect(store.readRecords()).toHaveLength(0);
		await rejects(() => store.appendEvent("queue_enqueued", { id: "x" } as unknown as Record<string, unknown>));
		expect(store.readRecords()).toHaveLength(0);
		await rejects(() => store.appendCustomMessage({ customType: "", content: "x" }));
		expect(store.readRecords()).toHaveLength(0);
	});
});
