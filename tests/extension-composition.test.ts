import activateWorkspaceTools from "../src/extensions/workspace-tools/index.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRunner, createPrintUI, type ExtensionAPI } from "../src/extensions/runner.js";
import { ToolBroker, type Tool } from "../src/tools/broker.js";
import { TranscriptContainer } from "../src/ui/components/transcript/transcript.js";
import { parseArgs } from "../src/cli/args.js";
import activateCompaction from "../src/extensions/compaction/index.js";
import { mockModel } from "./helpers/mock-provider.js";
import type { Model, ModelStreamFn } from "../src/core/types.js";

const directories: string[] = [];
const runners: ExtensionRunner[] = [];

/** P6c：compaction capability 的 /compact 事实出口测试的模型装配。 */
const compactionModel = (): Model => mockModel({ id: "mock", name: "mock", contextWindow: 50_000 });
const summarizingStream = (summary: string | Error): { stream: ModelStreamFn; summaryCalls: () => number } => {
	let calls = 0;
	const stream: ModelStreamFn = async (_m, req, emit) => {
		calls++;
		if ((req.messages[0]?.content ?? "").includes("上下文摘要助手")) {
			if (summary instanceof Error) throw summary;
			emit({ kind: "text", text: summary });
		} else {
			emit({ kind: "text", text: "ok" });
		}
		emit({ kind: "finish", reason: "stop" });
	};
	return { stream, summaryCalls: () => calls };
};
const bigHistory = (): { role: "user" | "assistant"; content: string }[] =>
	Array.from({ length: 30 }, (_, index) =>
		index % 2 === 0 ? { role: "user" as const, content: `问${index} ${"词".repeat(3_000)}` } : { role: "assistant" as const, content: `答${index} ${"词".repeat(3_000)}` },
	);
const compactionHost = (cwd: string, stream: ModelStreamFn) => {
	const auxiliary: import("../src/session/types.js").SessionCustomEntryRecord[] = [];
	let value!: ExtensionRunner;
	value = runner(cwd, {
		models: {
			current: () => compactionModel(),
			list: () => [compactionModel()],
			groups: () => [],
			resolve: () => compactionModel(),
			select: async () => {},
			thinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			stream: ((model, request, onDelta, signal) => stream(model, request, onDelta, signal)) as ModelStreamFn,
		} as never,
		// capability 的 anchorId 取主线头 entry id；无 journal 的纯扩展层测试给一条合成主线头。
		history: () => [{ kind: "message", id: "head", seq: 1, timestamp: "", message: { role: "user", content: "head" } }] as never,
		// capability 私有持久状态（uina.compaction.summary）的落点：auxiliary timeline。
		auxiliary: () => auxiliary,
		// pi.emitEvent 的装配：capability 事实进扩展事件总线（同宿主真实装配）。
		emitRuntimeEvent: (event) => value.emit(event),
		onCustomEntry: async (entry) => {
			// 模拟宿主 journal 语义：custom_entry 落 auxiliary timeline（非主线）。
			auxiliary.push({ kind: "custom_entry", id: `aux-${auxiliary.length + 1}`, seq: auxiliary.length + 1, timestamp: "", customType: entry.customType, data: entry.data });
		},
	});
	return value;
};

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
		a.onHook("turn.prepare", () => ({ messages: [{ role: "user", content: "memory" }] }));
		b.onHook("turn.prepare", (ctx) => ({ messages: [{ role: "user", content: ctx.systemPrompt + ":skills" }] }));
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

// P6c：Subject.compact/registerCompactor/resolveCompactionResult 退役后，
// compaction capability 的事件出口契约——事实经 pi.emitEvent 进扩展事件
// 总线（builtin UI 是消费者），不再进宿主 subject.dispatch 流。
describe("compaction capability event contract", () => {
	it("broadcasts session_compact after a forced trim with summary persisted via appendEntry", async () => {
		const { stream, summaryCalls } = summarizingStream("总线摘要");
		const host = compactionHost(await temp(), stream);
		const seen: string[] = [];
		host.on("session_compact", () => seen.push("compact"));
		await activate(host, "compaction", activateCompaction);
		const force = host.registry.getCommand("compact");
		expect(force?.handler).toBeDefined();

		const messages = bigHistory();
		await force?.handler?.("");
		const trimmed = await host.runTransformContext(messages as never);
		expect(summaryCalls()).toBe(1);
		// 摘要消息紧随（无 leading system），尾部保留在预算内。
		expect((trimmed[0] as { content: string }).content).toBe("[历史摘要] 总线摘要");
		expect(trimmed.length).toBeLessThan(messages.length);
		expect(seen).toEqual(["compact"]);
	});

	it("broadcasts session_compact_failed when the summarizer fails and passes the request through", async () => {
		const { stream } = summarizingStream(new Error("summary down"));
		const host = compactionHost(await temp(), stream);
		const failures: string[] = [];
		host.on("session_compact_failed", (event) => failures.push((event as { error?: string }).error ?? ""));
		await activate(host, "compaction", activateCompaction);
		const force = host.registry.getCommand("compact");
		const messages = bigHistory();
		await force?.handler?.("");
		const passed = await host.runTransformContext(messages as never);
		expect(passed).toEqual(messages);
		expect(failures.some((error) => error.includes("summary down"))).toBe(true);
	});
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
