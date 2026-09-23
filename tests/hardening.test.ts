import { describe, expect, it, vi } from "vitest";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { IsolatedEnv, mockTool, SubjectHarness, Scenario } from "./harness/index.js";
import { JsonlSessionStore, openJsonlSession } from "../src/session/jsonl-store.js";
import { JobRegistry } from "../src/extensions/jobs/registry.js";
import { SubagentRegistry } from "../src/extensions/subagents/registry.js";
import { DefaultAgentFactory } from "../src/agent/runtime.js";
import { ToolBroker, type Tool } from "../src/tools/broker.js";
import { createChildTools } from "../src/extensions/runtime-tools/index.js";
import { createPrintUI, ExtensionRunner } from "../src/extensions/runner.js";
import { Key, matchesKey } from "../src/ui/core/keys.js";
import { MainScreenRenderer } from "../src/ui/core/renderer.js";
import type { ProcessTerminal } from "../src/ui/core/terminal.js";
import { visibleWidth } from "../src/ui/core/utils.js";

const tool = (name: string): Tool => mockTool(name, async () => ({ result: "ok", status: "succeeded" }));

describe("hardening: session write queue", () => {
	it.each(["append", "sync"])("rolls back a failed %s before accepting the next record", async (stage) => {
		const env = await IsolatedEnv.create();
		const path = env.resolve("session.jsonl");
		try {
			const initial = await openJsonlSession(path);
			await initial.store.close();
			const handle = await open(path, "r+");
			const store = new JsonlSessionStore(path, handle, 0);
			await store.appendMessage({ role: "user", content: "before" });
			if (stage === "append") {
				const write = handle.write.bind(handle);
				vi.spyOn(handle, "write").mockImplementationOnce(async (...args: unknown[]) => {
					await write(args[0] as Uint8Array, args[1] as number, 25, args[3] as number);
					throw new Error("disk full after partial append");
				});
			} else vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("sync failed"));
			await expect(store.appendMessage({ role: "user", content: "failed" })).rejects.toThrow();
			await store.appendMessage({ role: "user", content: "after" });
			await store.close();
			const reopened = await openJsonlSession(path);
			expect(reopened.snapshot.entries.filter(e => e.kind === "message").map(e => e.message.content)).toEqual(["before", "after"]);
			await reopened.store.close();
		} finally { await env.cleanup(); }
	});

	it("rejects later writes if rollback cannot restore the file boundary", async () => {
		const write = vi.fn().mockRejectedValue(new Error("partial write"));
		const store = new JsonlSessionStore(":test:", {
			stat: async () => ({ size: 0 }), write,
			truncate: async () => { throw new Error("rollback failed"); }, close: async () => {},
		} as unknown as FileHandle, 0);
		await expect(store.appendMessage({ role: "user", content: "first" })).rejects.toThrow("追加及回滚失败");
		await expect(store.appendMessage({ role: "user", content: "second" })).rejects.toThrow("重新打开");
		expect(write).toHaveBeenCalledTimes(1);
		await store.close();
	});
});

describe("hardening: job output accounting", () => {
	it("reports outputLost on the first read when old chunks were dropped", () => {
		const jobs = new JobRegistry();
		let observe!: (chunk: { text: string }) => void;
		const id = jobs.start({
			ownerId: "root",
			label: "chatter",
			source: { extension: "test" },
			start: (context) => { observe = context.observe; return { cancel() {}, done: new Promise(() => {}) }; },
		});
		for (let i = 0; i < 40; i++) observe({ text: `chunk-${i}-` + "x".repeat(4096) });
		const read = jobs.read(id, "root", 0);
		expect(read.outputLost).toBe(true);
		expect(read.text.length).toBeLessThanOrEqual(50 * 1024 + 8192);
	});
});

describe("hardening: subagent output budget", () => {
	it("bounds per-child output and reports loss", async () => {
		const model = {
			id: "chatter",
			name: "chatter",
			providerId: "mock",
			contextWindow: 128_000,
		};
		const stream = async (_m: unknown, _req: unknown, emit: (d: any) => void) => {
			for (let i = 0; i < 80; i++) emit({ kind: "text", text: "y".repeat(8192) });
			emit({ kind: "finish", reason: "stop" });
		};
		const registry = new SubagentRegistry({
			factory: new DefaultAgentFactory(),
			model: () => model,
			stream,
			createTools: () => new ToolBroker(),
		});
		const child = registry.start({ ownerId: "root", label: "child", prompt: "talk" });
		await vi.waitFor(() => expect(registry.get(child.id, "root").busy).toBe(false), { timeout: 5000 });
		const read = registry.read(child.id, "root", 0);
		expect(read.outputLost).toBe(true);
		expect(read.output.reduce((total, item) => total + item.text.length, 0)).toBeLessThan(300 * 1024);
		await registry.close();
	});
});

describe("hardening: child capability inheritance", () => {
	it("inherits every parent tool except the explicit exclude list", () => {
		const parent = new ToolBroker();
		for (const name of ["get_time", "exec_command", "subagent_start", "project_tool"]) parent.register(tool(name));
		const child = createChildTools(parent, { exclude: ["subagent_start"] });
		expect(child.names().sort()).toEqual(["exec_command", "get_time", "project_tool"]);
	});

	it("supports an explicit include list", () => {
		const parent = new ToolBroker();
		for (const name of ["a", "b", "c"]) parent.register(tool(name));
		expect(createChildTools(parent, { include: ["b"] }).names()).toEqual(["b"]);
	});
});

describe("hardening: extension host honesty", () => {
	it("keeps replacement UI slots visible and clears them once on disposal", async () => {
		const slots = new Map<string, unknown>();
		const clears: string[] = [];
		const set = (name: string, value: unknown) => {
			slots.set(name, value);
			if (value === undefined) clears.push(name);
		};
		const runner = new ExtensionRunner({ cwd: process.cwd(), tools: new ToolBroker() });
		runner.attachUI({ ...createPrintUI(() => {}),
			setStatus: set, setWidget: set,
			setHeader: value => set("header", value), setFooter: value => set("footer", value),
		});
		const first = { render: () => ["first"] }, second = { render: () => ["second"] };
		await runner.activateBuiltin("slots", pi => {
			for (const component of [first, second]) {
				pi.ui.setStatus("status", component.render()[0]);
				pi.ui.setWidget("widget", component);
				pi.ui.setHeader(component); pi.ui.setFooter(component);
			}
		});
		expect([...slots.values()]).toEqual(["second", second, second, second]);
		expect(clears).toEqual([]);
		await runner.dispose();
		expect([...slots.values()]).toEqual([undefined, undefined, undefined, undefined]);
		expect(clears).toHaveLength(4);
	});
	it("registerProvider fails loudly when the host has no provider port", async () => {
		const runner = new ExtensionRunner({ cwd: process.cwd(), tools: new ToolBroker() });
		const provider = { name: "x", stream: async () => {} };
		await expect(runner.activateBuiltin("probe", (pi) => { pi.registerProvider("x", provider as never); })).resolves.toBeUndefined();
		expect(runner.diagnostics().some((entry) => entry.status === "failed" && entry.id === "builtin:probe")).toBe(true);
	});

	it("print fallback UI reports hasUI false instead of faking answers", async () => {
		const ui = createPrintUI(() => {});
		expect(ui.hasUI()).toBe(false);
		expect(await ui.confirm("t", "m")).toBe(false);
	});
});

describe("hardening: keyboard and frame invariants", () => {
	it("Alt+Enter is the follow-up key and no longer doubles as Shift+Enter", () => {
		expect(matchesKey("\x1b\r", Key.altEnter)).toBe(true);
		expect(matchesKey("\x1b\r", Key.shiftEnter)).toBe(false);
		expect(matchesKey("\x1b[13;2u", Key.shiftEnter)).toBe(true);
	});

	it("renderer clamps every emitted row to the terminal width", () => {
		let written = "";
		const terminal = { columns: 20, syncWrite: (data: string) => { written = data; } } as unknown as ProcessTerminal;
		new MainScreenRenderer(terminal).renderFrame(["short", "x".repeat(60)]);
		// Rows are positioned absolutely rather than CR LF delimited, so writing a row that
		// fills the terminal never leaves the cursor in a wrap state for the next row.
		const rows = written.split(/\x1b\[\d+;1H/).slice(1);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			const plain = row.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
			expect(visibleWidth(plain)).toBeLessThanOrEqual(20);
		}
	});
});

describe("hardening: consecutive tool call hard cap", () => {
	it("预算超限时整批拒绝并如实落盘终止原因", async () => {
		const scenario = new Scenario().when(() => true).callTool("echo", {});
		const harness = SubjectHarness.create({
			scenario,
			maxConsecutiveToolCalls: 2,
			tools: [mockTool("echo", () => "ok")],
		});
		await harness.subject.pushInput("开始");
		await harness.subject.waitForIdle();
		const text = harness.historySnapshot().map((m) => (m.role === "assistant" ? m.content : "")).join("\n");
		expect(text).toContain("将超过上限 2");
		expect(text).toContain("未正常收敛");
	});
});
