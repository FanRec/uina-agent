import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { ToolBroker, type Tool } from "../src/tools/broker.js";
import { DefaultAgentFactory } from "../src/agent/runtime.js";
import type { Model, ModelStreamFn } from "../src/core/types.js";
import { mockModel } from "./helpers/mock-provider.js";

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
			pi.onHook("turn.transformContext", (messages) => ({ messages: [...messages, { role: "user", content: "root-only" }] }));
		});
		let received = "";
		const model: Model = mockModel({ id: "child", name: "child" });
		const stream: ModelStreamFn = async (_model, request, emit) => {
			received = request.messages.map((message) => message.content).join("\n");
			emit({ kind: "finish", reason: "stop" });
		};
		const child = new DefaultAgentFactory().create({ model, stream, tools: new ToolBroker() });
		await child.send({ id: "child-input", mode: "followUp", source: { kind: "agent", type: "test" }, text: "child" });
		await child.waitForIdle();
		expect(received).not.toContain("root-only");
		await child.dispose();
		await runner.dispose();
	});

	it("protects existing extensions when a candidate extension has syntax or export errors during pre-import", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-ext-"));
		roots.push(root);
		const directory = join(root, ".uina", "extensions");
		await mkdir(directory, { recursive: true });

		await writeFile(join(directory, "good.js"), `export default function(pi) {
 pi.registerTool({
  def: { type: 'function', function: { name: 'good_tool', description: 'good', parameters: { type: 'object', properties: {} } } },
  run: async () => ({ result: 'good', status: 'succeeded' })
 });
 pi.registerCommand({ name: 'good_cmd', description: 'good' });
 return () => { globalThis.__goodDisposed = true; };
}`, "utf8");

		const tools = new ToolBroker();
		const runner = new ExtensionRunner({ cwd: root, tools });
		await runner.load();

		expect(tools.has("good_tool")).toBe(true);
		expect(runner.registry.getCommand("good_cmd")).toBeDefined();
		expect(runner.list().map(e => e.id)).toEqual(["project:.uina/extensions/good.js"]);

		// 新增一个包含非法导出的文件（预导入阶段拦截）
		await writeFile(join(directory, "bad_export.js"), "export default 'not-a-function';", "utf8");

		// reload 必须在预检阶段失败并抛错
		await expect(runner.reload()).rejects.toThrow(/必须默认导出 activate\(pi\)/);

		// 旧扩展完好无损，并未被注销
		expect(tools.has("good_tool")).toBe(true);
		expect(runner.registry.getCommand("good_cmd")).toBeDefined();
		expect((globalThis as Record<string, unknown>).__goodDisposed).toBeUndefined();

		// diagnostics 能观测到 active 的旧扩展和 failed 的坏扩展
		const diags = runner.diagnostics();
		expect(diags.find(d => d.id === "project:.uina/extensions/good.js")?.status).toBe("active");
		expect(diags.find(d => d.id === "project:.uina/extensions/bad_export.js")?.status).toBe("failed");

		await runner.dispose();
	});

	it("cleans up old extension resources and activates updated extensions on reload", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-ext-"));
		roots.push(root);
		const directory = join(root, ".uina", "extensions");
		await mkdir(directory, { recursive: true });

		let v1Disposed = false;
		(globalThis as Record<string, unknown>).__disposeV1 = () => { v1Disposed = true; };

		await writeFile(join(directory, "my_ext.js"), `export default function(pi) {
 pi.registerTool({
  def: { type: 'function', function: { name: 'v1_tool', description: 'v1', parameters: { type: 'object', properties: {} } } },
  run: async () => ({ result: 'v1', status: 'succeeded' })
 });
 pi.registerCommand({ name: 'v1_cmd', description: 'v1' });
 return () => { globalThis.__disposeV1(); };
}`, "utf8");

		const tools = new ToolBroker();
		const runner = new ExtensionRunner({ cwd: root, tools });
		await runner.load();

		expect(tools.has("v1_tool")).toBe(true);
		expect(runner.registry.getCommand("v1_cmd")).toBeDefined();

		// 更新扩展为 v2
		await writeFile(join(directory, "my_ext.js"), `export default function(pi) {
 pi.registerTool({
  def: { type: 'function', function: { name: 'v2_tool', description: 'v2', parameters: { type: 'object', properties: {} } } },
  run: async () => ({ result: 'v2', status: 'succeeded' })
 });
 pi.registerCommand({ name: 'v2_cmd', description: 'v2' });
}`, "utf8");

		await runner.reload();

		// v1 资源已完全清理
		expect(v1Disposed).toBe(true);
		expect(tools.has("v1_tool")).toBe(false);
		expect(runner.registry.getCommand("v1_cmd")).toBeUndefined();

		// v2 资源已就绪
		expect(tools.has("v2_tool")).toBe(true);
		expect(runner.registry.getCommand("v2_cmd")).toBeDefined();

		await runner.dispose();
	});

	it("isolates activation errors and cleans up partial registrations without crashing other valid extensions", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-ext-"));
		roots.push(root);
		const directory = join(root, ".uina", "extensions");
		await mkdir(directory, { recursive: true });

		// a.js 正常工作
		await writeFile(join(directory, "a.js"), `export default function(pi) {
 pi.registerTool({
  def: { type: 'function', function: { name: 'tool_a', description: 'a', parameters: { type: 'object', properties: {} } } },
  run: async () => ({ result: 'a', status: 'succeeded' })
 });
}`, "utf8");

		// b.js 先注册了一个局部工具，然后抛出运行时错误
		await writeFile(join(directory, "b.js"), `export default function(pi) {
 pi.registerTool({
  def: { type: 'function', function: { name: 'leaked_tool', description: 'b', parameters: { type: 'object', properties: {} } } },
  run: async () => ({ result: 'b', status: 'succeeded' })
 });
 throw new Error("b crashed in activate");
}`, "utf8");

		const tools = new ToolBroker();
		const onError = vi.fn();
		const runner = new ExtensionRunner({ cwd: root, tools, onError });
		await runner.load();

		// a 扩展成功激活并提供服务
		expect(tools.has("tool_a")).toBe(true);

		// b 扩展崩溃后，其局部注册的 leaked_tool 必须被精准回收入垃圾箱，不得残留在全局注册表中
		expect(tools.has("leaked_tool")).toBe(false);

		// 故障可观测：onError 上报，diagnostics 记录
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("b crashed in activate"));
		const diags = runner.diagnostics();
		expect(diags.find(d => d.id === "project:.uina/extensions/a.js")?.status).toBe("active");
		expect(diags.find(d => d.id === "project:.uina/extensions/b.js")?.status).toBe("failed");

		await runner.dispose();
	});

	it("preserves builtin capabilities across project extension reloads", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-ext-"));
		roots.push(root);
		const directory = join(root, ".uina", "extensions");
		await mkdir(directory, { recursive: true });

		const tools = new ToolBroker();
		const runner = new ExtensionRunner({ cwd: root, tools });
		await runner.activateBuiltin("core", (pi) => {
			pi.registerTool({
				def: { type: "function", function: { name: "builtin_tool", description: "builtin", parameters: { type: "object", properties: {} } } },
				run: async () => ({ result: "builtin", status: "succeeded" }),
			});
		});

		await writeFile(join(directory, "proj.js"), `export default function(pi) {
 pi.registerTool({
  def: { type: 'function', function: { name: 'proj_tool', description: 'proj', parameters: { type: 'object', properties: {} } } },
  run: async () => ({ result: 'proj', status: 'succeeded' })
 });
}`, "utf8");

		await runner.load();
		expect(tools.has("builtin_tool")).toBe(true);
		expect(tools.has("proj_tool")).toBe(true);

		await runner.reload();
		// reload 仅卸载项目扩展，内置扩展保持不动
		expect(tools.has("builtin_tool")).toBe(true);
		expect(tools.has("proj_tool")).toBe(true);

		await runner.dispose();
	});
});
