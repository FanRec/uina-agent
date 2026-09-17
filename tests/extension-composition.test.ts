import activateWorkspaceTools from "../src/extensions/workspace-tools/index.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRunner, createPrintUI, type ExtensionAPI } from "../src/extensions/runner.js";
import { ToolBroker, type Tool } from "../src/tools/broker.js";
import { Subject } from "../src/agent/loop.js";
import { MemorySessionStore, openJsonlSession } from "../src/session/jsonl-store.js";
import { projectAgentHistory } from "../src/session/recovery.js";
import { mockModel } from "./helpers/mock-provider.js";
import type { ModelStreamFn } from "../src/core/types.js";
import { TranscriptContainer } from "../src/ui/components/transcript/transcript.js";
import { ModelRegistry } from "../src/ai/providers.js";
import { parseArgs } from "../src/cli/args.js";

const directories: string[] = [];
const runners: ExtensionRunner[] = [];
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.dispose();
	await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function temp() {
	const dir = await mkdtemp(join(tmpdir(), "uina-composition-"));
	directories.push(dir);
	return dir;
}
function runner(cwd: string, options: Partial<ConstructorParameters<typeof ExtensionRunner>[0]> = {}) {
	const value = new ExtensionRunner({ cwd, tools: new ToolBroker({ ownerId: "root" }), ...options });
	runners.push(value);
	return value;
}
async function activate(host: ExtensionRunner, id: string, fn?: (api: ExtensionAPI) => void) {
	let api!: ExtensionAPI;
	await host.activateBuiltin(id, (value) => {
		api = value;
		fn?.(value);
	});
	return api;
}
const echo = (value: string): Tool => ({
	def: {
		type: "function",
		function: {
			name: "echo",
			description: "Echo",
			parameters: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
				additionalProperties: false,
			},
		},
	},
	run: async () => ({ result: value, status: "succeeded" }),
});
const stream: ModelStreamFn = async (_m, _r, emit) => {
	emit({ kind: "text", text: "answer" });
	emit({ kind: "finish", reason: "stop" });
};

describe("extension composition", () => {
	it("calls independent services, restores explicit replacement, and rejects disposed consumers", async () => {
		const host = runner(await temp());
		const provider = await activate(host, "provider");
		const consumer = await activate(host, "consumer");
		const remove = provider.registerService<{ query: string }, string>(
			"search.query/v1",
			(input, context) => input.query + ":" + context.callerId,
		);
		expect(await consumer.callService("search.query/v1", { query: "hello" })).toBe("hello:builtin:consumer");
		expect(() => consumer.registerService("search.query/v1", () => "duplicate")).toThrow();
		const undo = consumer.registerService("search.query/v1", () => "new", { replace: true });
		expect(await consumer.callService("search.query/v1", {})).toBe("new");
		undo();
		expect(await consumer.callService("search.query/v1", { query: "again" })).toBe("again:builtin:consumer");
		remove();
		expect(consumer.hasService("search.query/v1")).toBe(false);
		await expect(consumer.callService("search.query/v1", {})).rejects.toThrow("不可用");
		await host.dispose();
		await expect(consumer.callService("search.query/v1", {})).rejects.toThrow("已失效");
	});
	it("uses the tool pipeline, keeps subject identity, records programmatic calls without model messages", async () => {
		const records: unknown[] = [];
		const tools = new ToolBroker({ ownerId: "root" });
		const host = runner(await temp(), {
			tools,
			onCustomEntry: async (e) => {
				records.push(e);
			},
		});
		const provider = await activate(host, "provider");
		const consumer = await activate(host, "consumer");
		provider.registerTool({
			...echo("ok"),
			run: async (_args, _signal, context) => ({
				result: JSON.stringify(context),
				status: "succeeded",
				details: { source: "echo" },
			}),
		});
		consumer.onHook("tools.transformResult", () => ({ result: "transformed" }));
		const result = await consumer.callTool("echo", { text: "hello" });
		expect(result).toMatchObject({ result: "transformed", status: "succeeded", details: { source: "echo" } });
		expect(records).toHaveLength(2);
		expect(JSON.stringify(records)).toContain("builtin:consumer");
		expect((await consumer.callTool("echo", { bad: 2 })).status).toBe("not_started");
		consumer.onHook("tools.beforeCall", () => ({ block: true, reason: "blocked by test" }));
		expect((await consumer.callTool("echo", { text: "hello" })).status).toBe("not_started");
	});
	it("cancels and settles an in-flight service on unload", async () => {
		const host = runner(await temp());
		const provider = await activate(host, "provider");
		const consumer = await activate(host, "consumer");
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		provider.registerService(
			"wait",
			(_input, { signal }) =>
				new Promise((_resolve, reject) => {
					entered();
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		const call = consumer.callService("wait", null);
		const rejected = expect(call).rejects.toThrow();
		await ready;
		await host.dispose();
		await rejected;
	});
	it("restores tool registrations and never sends stale validated args to a replacement", async () => {
		const tools = new ToolBroker();
		const undoBase = tools.register(echo("old"));
		const prepared = tools.prepare("echo", { text: "hello" });
		const undo = tools.register(echo("new"), { replace: true });
		expect((await tools.execute(prepared)).status).toBe("not_started");
		expect(await tools.run("echo", { text: "hello" })).toBe("new");
		undo();
		expect(await tools.run("echo", { text: "hello" })).toBe("old");
		undoBase();
		expect(tools.has("echo")).toBe(false);
	});
	it("refreshes a directory helper and manifest entry without activating helpers as extensions", async () => {
		const cwd = await temp();
		const dir = join(cwd, ".uina/extensions/package");
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ type: "module", uina: { extensions: ["src/entry.ts"] } }),
		);
		await writeFile(join(dir, "src/helper.ts"), 'export const value: string = "old";');
		await writeFile(
			join(dir, "src/entry.ts"),
			'import { value } from "./helper.js"; export default function(api) { api.registerService("value", () => value); }',
		);
		const host = runner(cwd);
		const consumer = await activate(host, "consumer");
		await host.load();
		expect(host.diagnostics().filter((e) => e.status === "failed")).toEqual([]);
		expect(await consumer.callService("value", null)).toBe("old");
		await writeFile(join(dir, "src/helper.ts"), 'export const value: string = "new";');
		await host.reload();
		expect(await consumer.callService("value", null)).toBe("new");
		await writeFile(join(dir, "src/helper.ts"), "invalid syntax !!!");
		await expect(host.reload()).rejects.toThrow();
		expect(await consumer.callService("value", null)).toBe("new");
	});
	it("unloading an older header owner leaves the active owner intact", async () => {
		const cwd = await temp();
		const dir = join(cwd, ".uina/extensions");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "header.ts"),
			'export default api => { api.ui.setHeader({ render: () => ["A"] }); api.ui.setFooter({ render: () => ["A"] }); };',
		);
		const host = runner(cwd);
		const ui = createPrintUI(() => {});
		const header = vi.fn();
		const footer = vi.fn();
		host.attachUI({ ...ui, setHeader: header, setFooter: footer });
		await host.load();
		await activate(host, "later", (api) => {
			api.ui.setHeader({ render: () => ["B"] });
			api.ui.setFooter({ render: () => ["B"] });
		});
		await host.disposeProjects();
		expect(header.mock.lastCall?.[0].render(80)).toEqual(["B"]);
		expect(footer.mock.lastCall?.[0].render(80)).toEqual(["B"]);
		await host.dispose();
		expect(header.mock.lastCall?.[0]).toBeUndefined();
	});
	it("collects independent context contributions after prompt transforms", async () => {
		const host = runner(await temp());
		const a = await activate(host, "a");
		const b = await activate(host, "b");
		a.onHook("turn.prepare", () => ({ systemPrompt: "changed" }));
		a.registerContextContributor("memory", () => [{ role: "user", content: "memory" }]);
		b.registerContextContributor("skills", (ctx) => [{ role: "user", content: ctx.systemPrompt + ":skills" }]);
		const result = await host.runtimeHooks().turn.prepare({ prompt: "hi", systemPrompt: "initial" });
		expect(result.messages?.map((m) => m.content)).toEqual(["memory", "changed:skills"]);
		expect(result.systemPrompt).toBe("changed");
	});
	it("renders tool details and Markdown through replaceable presentation contracts", async () => {
		const host = runner(await temp());
		const api = await activate(host, "ui");
		const transcript = new TranscriptContainer();
		transcript.setRendererResolver({
			message: (t) => host.registry.getMessageRenderer(t),
			entry: (t) => host.registry.getEntryRenderer(t),
			tool: (n) => host.registry.getToolRenderer(n),
			markdown: (text, ctx) => host.registry.transformMarkdown(text, ctx),
		});
		host.registry.onChange(() => transcript.invalidate());
		const remove = api.registerToolRenderer("echo", (tool, options) => ({
			render: () => [options.expanded ? "expanded" : "custom:" + JSON.stringify(tool.details)],
		}));
		transcript.startTurn(1, "user");
		transcript.startTool("echo", {}, "c");
		transcript.addToolDone("echo", "result", 1, "succeeded", "c", {}, { details: { count: 3 } });
		expect(transcript.render(80).join("")).toContain('custom:{"count":3}');
		remove();
		expect(transcript.render(80).join("")).not.toContain("custom:");
		api.registerMarkdownTransformer("replace", (text) => text.replace("user", "transformed"));
		expect(transcript.render(80).join("")).toContain("transformed");
	});
	it("accepts explicit CLI extension paths and rejects an absent path", () => {
		expect(parseArgs(["-e", "a", "--extension=b", "hello"])).toMatchObject({ extensions: ["a", "b"], prompt: "hello" });
		expect(() => parseArgs(["--extension"])).toThrow("需要");
	});
});

describe("replaceable compaction", () => {
	it("uses one proposal/commit path for manual and automatic compaction", async () => {
		const host = runner(await temp());
		const reasons: string[] = [];
		const api = await activate(host, "summary");
		api.registerCompactor(async (request) => {
			reasons.push(request.reason);
			return { summary: "extension summary", keepFrom: request.suggestedKeepFrom };
		});
		for (const manual of [true, false]) {
			const subject = new Subject(mockModel(), stream, new ToolBroker(), {
				compactor: host.compactor,
				compaction: { contextWindow: manual ? undefined : 1, reserveTokens: 0, keepRecentTokens: 1 },
			});
			subject.addHistory([
				{ role: "user", content: "old" },
				{ role: "assistant", content: "previous answer" },
			]);
			if (manual) await subject.compact();
			else await subject.pushInput("new");
			expect(subject.historySnapshot()[0]).toMatchObject({ role: "compactionSummary", summary: "extension summary" });
		}
		expect(reasons).toEqual(["manual", "automatic"]);
	});
	it("does not fall back after strategy failure or commit an invalid cut", async () => {
		const fallback = vi.fn(stream);
		const host = runner(await temp());
		const api = await activate(host, "summary");
		let proposal: "throw" | "invalid" = "throw";
		api.registerCompactor(async () => {
			if (proposal === "throw") throw new Error("summary failed");
			return { summary: "bad cut", keepFrom: 2 };
		});
		const subject = new Subject(mockModel(), fallback, new ToolBroker(), { compactor: host.compactor });
		subject.addHistory([
			{ role: "user", content: "old" },
			{ role: "assistant", content: "", tool_calls: [{ id: "c", name: "x", args: {} }] },
			{ role: "tool", tool_call_id: "c", content: "ok", status: "succeeded" },
		]);
		const before = subject.historySnapshot();
		await expect(subject.compact()).rejects.toThrow("summary failed");
		proposal = "invalid";
		await expect(subject.compact()).rejects.toThrow("切断");
		expect(subject.historySnapshot()).toEqual(before);
		expect(fallback).not.toHaveBeenCalled();
	});
	it("cancellation and store failure preserve original history", async () => {
		const store = new MemorySessionStore();
		const save = vi.spyOn(store, "appendCompaction").mockRejectedValue(new Error("disk failed"));
		const subject = new Subject(mockModel(), stream, new ToolBroker(), {
			store,
			compactor: async () => ({ summary: "new", keepFrom: 1 }),
		});
		subject.addHistory([
			{ role: "user", content: "old" },
			{ role: "assistant", content: "answer" },
		]);
		const before = subject.historySnapshot();
		await expect(subject.compact()).rejects.toThrow("disk failed");
		expect(subject.historySnapshot()).toEqual(before);
		save.mockRestore();
		let started!: () => void;
		const ready = new Promise<void>((r) => {
			started = r;
		});
		const cancelled = new Subject(mockModel(), stream, new ToolBroker(), {
			compactor: (_request, signal) =>
				new Promise((_resolve, reject) => {
					started();
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		});
		cancelled.addHistory(before);
		const work = cancelled.compact();
		const failure = expect(work).rejects.toThrow();
		await ready;
		cancelled.interrupt();
		await failure;
		expect(cancelled.historySnapshot()).toEqual(before);
		expect(cancelled.isBusy()).toBe(false);
	});
	it("recovers exactly the committed extension summary and retained tail", async () => {
		const cwd = await temp();
		const file = join(cwd, "session.jsonl");
		const opened = await openJsonlSession(file);
		const subject = new Subject(mockModel(), stream, new ToolBroker(), {
			store: opened.store,
			compactor: async () => ({ summary: "persisted", keepFrom: 2 }),
		});
		await subject.pushInput("one");
		await subject.pushInput("two");
		await subject.compact();
		const expected = subject.historySnapshot();
		await opened.store.close();
		const reopened = await openJsonlSession(file);
		expect(projectAgentHistory(reopened.snapshot.entries)).toEqual(expected);
		await reopened.store.close();
	});
});

it("restores overridden model and provider registrations with their original facts", async () => {
	const registry = new ModelRegistry();
	const old = { id: "provider", stream };
	registry.registerProvider(old);
	registry.registerModel(mockModel({ id: "model", providerId: "provider", imageInput: true }));
	const newer = { id: "provider", stream: vi.fn(stream) };
	const undoProvider = registry.registerProvider(newer, { replace: true });
	const undoModel = registry.registerModel(mockModel({ id: "model", providerId: "provider", imageInput: false }), {
		replace: true,
	});
	expect(registry.getProvider("provider")).toBe(newer);
	expect(registry.resolve("provider/model").imageInput).toBe(false);
	undoModel();
	undoProvider();
	expect(registry.getProvider("provider")).toBe(old);
	expect(registry.resolve("provider/model").imageInput).toBe(true);
});

it("an extension can choose its own automatic compression trigger without inventing a context window", async () => {
	const host = runner(await temp());
	const api = await activate(host, "summary");
	api.registerCompactor(async () => ({ summary: "policy summary", keepFrom: 1 }), {
		shouldCompact: (input) => input.historyLength >= 2,
	});
	const subject = new Subject(mockModel(), stream, new ToolBroker(), {
		compactor: host.compactor,
		compactionTrigger: host.compactionTrigger,
	});
	subject.addHistory([
		{ role: "user", content: "old" },
		{ role: "assistant", content: "old answer" },
	]);
	await subject.pushInput("new");
	expect(subject.historySnapshot()[0]).toMatchObject({ summary: "policy summary" });
	expect(subject.getContextWindow()).toBeUndefined();
});

it("rejects a compactor proposal that keeps the whole history", async () => {
	const host = runner(await temp());
	const api = await activate(host, "keep-everything");
	api.registerCompactor(async (request) => ({ summary: "no-op summary", keepFrom: request.history.length }), {
		shouldCompact: () => true,
	});
	const subject = new Subject(mockModel(), stream, new ToolBroker(), {
		compactor: host.compactor,
		compactionTrigger: host.compactionTrigger,
	});
	subject.addHistory([
		{ role: "user", content: "old" },
		{ role: "assistant", content: "old answer" },
	]);
	const errors: string[] = [];
	subject.subscribe((event) => {
		if (event.type === "error") errors.push(event.text);
	});
	await subject.pushInput("new");
	// The probe must reject it: accepting would persist a summary plus the messages it summarizes.
	expect(errors.some((text) => text.includes("compaction 保留位置无效"))).toBe(true);
	expect(subject.historySnapshot().some((message) => message.role === "compactionSummary")).toBe(false);
});

it("skills and filesystem extensions compose through services and the existing tool execution pipeline", async () => {
	const cwd = await temp();
	await mkdir(join(cwd, ".uina/skills"), { recursive: true });
	await writeFile(join(cwd, ".uina/skills/example.md"), "Example skill instructions");
	const tools = new ToolBroker({ ownerId: "root" });
	const host = runner(cwd, {
		tools,
		extensionPaths: [
			join(process.cwd(), "examples/extensions/skills"),
		],
	});
	await host.activateBuiltin("workspace-tools", activateWorkspaceTools);
	const consumer = await activate(host, "consumer");
	const undoRead = consumer.registerTool({ ...echo("replacement"), def: { ...echo("").def, function: { ...echo("").def.function, name: "read_file" } } }, { replace: true });
	expect((await consumer.callTool("read_file", { text: "x" })).result).toBe("replacement");
	undoRead();
	await host.load();
	expect(host.diagnostics().filter((e) => e.status === "failed")).toEqual([]);
	expect(await consumer.callService("skills.discover/v1", null)).toMatchObject([{ name: "example" }]);
	expect(await consumer.callTool("read_skill", { name: "example" })).toMatchObject({
		status: "succeeded",
		result: "Example skill instructions",
	});
	const prepared = await host.runtimeHooks().turn.prepare({ prompt: "hi", systemPrompt: "system" });
	expect(prepared.messages?.[0].content).toContain("Available skills");
	await host.reload();
	expect(await consumer.callTool("read_skill", { name: "example" })).toMatchObject({
		result: "Example skill instructions",
	});
	await host.disposeProjects();
	await expect(consumer.callService("skills.discover/v1", null)).rejects.toThrow("不可用");
});
