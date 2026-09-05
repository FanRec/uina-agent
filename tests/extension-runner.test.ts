import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { ToolBroker, type Tool } from "../src/tools/broker.js";
import { DefaultAgentFactory } from "../src/agent/runtime.js";
import type { ModelProvider } from "../src/core/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("project extension runner", () => {
	it("owns registrations, persists custom records through its ports, and invalidates old ctx on reload", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-ext-"));
		roots.push(root);
		const directory = join(root, ".uina", "extensions");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "sample.js"), `export default async function(pi) {
 globalThis.__uinaTestExtension = pi;
 pi.registerCommand({ name: 'hello', description: 'hello' });
 await pi.sendMessage({ customType: 'test.message', content: 'visible to provider' });
 await pi.appendEntry({ customType: 'test.entry', data: { ok: true } });
 return () => { globalThis.__uinaDisposed = true; };
}`, "utf8");
		const messages: unknown[] = [];
		const entries: unknown[] = [];
		const runner = new ExtensionRunner({ cwd: root, tools: new ToolBroker(), onCustomMessage: async (value) => { messages.push(value); }, onCustomEntry: async (value) => { entries.push(value); } });
		await runner.load();
		expect(runner.registry.getCommand("hello")).toBeDefined();
		expect(messages).toEqual([{ customType: "test.message", content: "visible to provider" }]);
		expect(entries).toEqual([{ customType: "test.entry", data: { ok: true } }]);
		const old = (globalThis as Record<string, unknown>).__uinaTestExtension as { ui: { getEditorText(): string } };
		await runner.reload();
		expect((globalThis as Record<string, unknown>).__uinaDisposed).toBe(true);
		expect(() => old.ui.getEditorText()).toThrow(/已失效/);
		await runner.dispose();
	});

	it("reports activation failures instead of silently swallowing them", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-ext-"));
		roots.push(root);
		const directory = join(root, ".uina", "extensions");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "bad.js"), "export default function() { throw new Error('broken extension'); }", "utf8");
		const onError = vi.fn();
		const runner = new ExtensionRunner({ cwd: root, tools: new ToolBroker(), onError });
		await runner.load();
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("broken extension"));
	});

	it("attributes handler failures and awaits async teardown for project and builtin scopes", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-ext-"));
		roots.push(root);
		const directory = join(root, ".uina", "extensions");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "async.js"), `export default function(pi) {
 pi.on('agent_start', () => { throw new Error('owned handler failure'); });
 return async () => { await Promise.resolve(); globalThis.__uinaAsyncDisposed = true; };
}`, "utf8");

		const onError = vi.fn();
		const tools = new ToolBroker();
		const runner = new ExtensionRunner({ cwd: root, tools, onError });
		await runner.load();
		await runner.emit({ type: "agent_start", turnSeq: 1 });
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("project:.uina/extensions/async.js:agent_start"));

		const builtinTool: Tool = {
			def: {
				type: "function",
				function: { name: "builtin_scope_tool", description: "scope test", parameters: { type: "object", properties: {} } },
			},
			run: async () => ({ result: "ok", status: "succeeded" }),
		};
		let builtinDisposed = false;
		await runner.activateBuiltin("scope-test", (pi) => {
			pi.registerTool(builtinTool);
			return async () => { await Promise.resolve(); builtinDisposed = true; };
		});
		expect(tools.has("builtin_scope_tool")).toBe(true);

		await runner.dispose();
		expect((globalThis as Record<string, unknown>).__uinaAsyncDisposed).toBe(true);
		expect(builtinDisposed).toBe(true);
		expect(tools.has("builtin_scope_tool")).toBe(false);
	});

	it("creates scope-filtered runtime hook views over the same Host", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-ext-"));
		roots.push(root);
		const runner = new ExtensionRunner({ cwd: root, tools: new ToolBroker() });
		const seen: string[] = [];
		await runner.activateBuiltin("one", (pi) => { pi.on("agent_start", () => { seen.push("one"); }); });
		await runner.activateBuiltin("two", (pi) => { pi.on("agent_start", () => { seen.push("two"); }); });

		await runner.runtimeHooks(["builtin:one"]).events.emit({ type: "agent_start", turnSeq: 1 });
		expect(seen).toEqual(["one"]);
		await runner.runtimeHooks().events.emit({ type: "agent_start", turnSeq: 2 });
		expect(seen).toEqual(["one", "one", "two"]);
		await runner.dispose();
	});

	it("keeps child Agents on no-op runtime hooks unless a scope is explicitly injected", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-ext-"));
		roots.push(root);
		const runner = new ExtensionRunner({ cwd: root, tools: new ToolBroker() });
		await runner.activateBuiltin("root-context", (pi) => {
			pi.on("context", (event) => ({ messages: [...event.messages, { role: "user", content: "root-only" }] }));
		});
		let received = "";
		const provider: ModelProvider = {
			name: "child",
			async stream(request, emit) {
				received = request.messages.map((message) => message.content).join("\n");
				emit({ kind: "finish", reason: "stop" });
			},
		};
		const child = new DefaultAgentFactory().create({ provider, tools: new ToolBroker() });
		await child.send({ id: "child-input", mode: "followUp", source: { kind: "agent", type: "test" }, text: "child" });
		await child.waitForIdle();
		expect(received).not.toContain("root-only");
		await child.dispose();
		await runner.dispose();
	});
});
