import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolBroker, type Tool } from "../src/tools/broker.js";
import { Subject } from "../src/agent/loop.js";
import { MemorySessionStore, openJsonlSession } from "../src/session/jsonl-store.js";
import { SessionFormatError, recoverRecords } from "../src/session/recovery.js";
import { projectModelHistory } from "../src/agent/projection.js";
import type { Model, ModelRequest, ModelStreamFn, StreamDelta } from "../src/core/types.js";
import execCommandTool, { execCommandDirect } from "../src/extensions/runtime-tools/exec-command/index.js";
import { OutputCollector } from "../src/extensions/runtime-tools/exec-command/output.js";
import getTimeTool from "../src/extensions/runtime-tools/get-time/index.js";
import { scriptedProvider, toolCallDelta, lastUser } from "./helpers/mock-provider.js";

const tempDirs: string[] = [];
afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function idle(subject: Subject, timeoutMs = 5000): Promise<void> {
	const started = Date.now();
	while (subject.isBusy()) {
		if (Date.now() - started > timeoutMs) throw new Error("等待主体空闲超时");
		await wait();
	}
}

function makeTool(name: string, run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>, executionMode?: Tool["executionMode"]): Tool {
	return {
		def: {
			type: "function",
			function: {
				name,
				description: name,
				parameters: {
					type: "object",
					properties: { value: { type: "string" } },
					required: [],
					additionalProperties: false,
				},
			},
		},
		executionMode,
		run: async (args, signal) => ({ result: await run(args, signal), status: "succeeded" }),
	};
}

describe("ToolBroker", () => {
	it("validates arguments before execution and serializes arbitrary thrown values", async () => {
		const broker = new ToolBroker();
		let executed = false;
		broker.register(makeTool("typed", async () => {
			executed = true;
			return "ok";
		}));
		const invalid = JSON.parse(await broker.run("typed", { value: 1 }));
		expect(invalid.status).toBe("not_started");
		expect(executed).toBe(false);

		broker.register(makeTool("throws", async () => {
			throw null;
		}));
		const failed = JSON.parse(await broker.run("throws", {}));
		expect(failed.status).toBe("failed");
		expect(failed.error).toContain("null");
	});
});

describe("Subject", () => {
	it("executes a tool loop and persists message events", async () => {
		const broker = new ToolBroker();
		broker.register(getTimeTool);
		const store = new MemorySessionStore();
		const provider = scriptedProvider([
			{ match: (req) => !req.messages.some((message) => message.role === "tool"), produce: () => [toolCallDelta("t1", "get_time", {})] },
			{ match: () => true, produce: () => [{ kind: "text", text: "完成" }] },
		]);
		const subject = new Subject(provider.model, provider.stream, broker, { store });
		subject.pushInput("几点");
		await idle(subject);
		expect(provider.calls).toHaveLength(2);
		expect(subject.historySnapshot().filter((message) => message.role === "tool")).toHaveLength(1);
		expect(store.records.some((record) => record.kind === "event" && record.event === "tool_started")).toBe(true);
	});

	it("preserves tool results already bounded by the tool output contract", async () => {
		const broker = new ToolBroker();
		broker.register(makeTool("large", async () => "x".repeat(5000)));
		const provider = scriptedProvider([
			{ match: (req) => !req.messages.some((message) => message.role === "tool"), produce: () => [toolCallDelta("large-1", "large", {})] },
			{ match: () => true, produce: () => [{ kind: "text", text: "done" }] },
		]);
		const subject = new Subject(provider.model, provider.stream, broker);
		subject.pushInput("large");
		await idle(subject);
		const tool = provider.calls[1].messages.find((message) => message.role === "tool");
		expect(tool?.content).toBe("x".repeat(5000));
	});

	it("runs independent tools in parallel and returns results in call order", async () => {
		const broker = new ToolBroker();
		let active = 0;
		let maxActive = 0;
		const run = async (args: Record<string, unknown>) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await wait(80);
			active--;
			return String(args.value);
		};
		broker.register(makeTool("one", run));
		broker.register(makeTool("two", run));
		const provider = scriptedProvider([
			{ match: (req) => !req.messages.some((message) => message.role === "tool"), produce: () => [toolCallDelta("1", "one", { value: "one" }), toolCallDelta("2", "two", { value: "two" })] },
			{ match: () => true, produce: () => [{ kind: "text", text: "done" }] },
		]);
		const subject = new Subject(provider.model, provider.stream, broker);
		subject.pushInput("run");
		await idle(subject);
		expect(maxActive).toBe(2);
		const toolMessages = subject.historySnapshot().filter((message) => message.role === "tool");
		expect(toolMessages.map((message) => message.role === "tool" && message.tool_call_id)).toEqual(["1", "2"]);
	});

	it("delivers steer before followUp and preserves queue order after stop", async () => {
		let release: (() => void) | undefined;
		const model: Model = {
			id: "queue-test",
			name: "queue-test",
			providerId: "mock",
			contextWindow: 128_000,
		};
		const stream: ModelStreamFn = async (_m: Model, req: ModelRequest, onDelta: (delta: StreamDelta) => void, signal?: AbortSignal) => {
			const input = lastUser(req);
			if (input === "first") {
				await new Promise<void>((resolve, reject) => {
					release = resolve;
					signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
				});
			}
			onDelta({ kind: "text", text: input });
			onDelta({ kind: "finish", reason: "stop" });
		};
		const broker = new ToolBroker();
		const subject = new Subject(model, stream, broker);
		subject.pushInput("first");
		await wait(20);
		subject.steer("steer");
		subject.followUp("follow");
		subject.interrupt();
		await idle(subject);
		expect(subject.queuedSnapshot().map((item) => item.text)).toEqual(["steer", "follow"]);
		const editorItems = await subject.takeQueuedForEditor();
		expect(editorItems.map((item) => item.text)).toEqual(["steer", "follow"]);
		release?.();

		const normal = scriptedProvider([{ match: () => true, produce: () => [{ kind: "text", text: "ok" }] }]);
		const resumed = new Subject(normal.model, normal.stream, broker);
		resumed.pushInput(editorItems.map((item) => item.text).join("\n\n"));
		await idle(resumed);
		expect(lastUser(normal.calls[0])).toBe("steer\n\nfollow");
	});

	it("does not execute malformed tool arguments", async () => {
		const broker = new ToolBroker();
		let executed = false;
		broker.register(makeTool("bad", async () => {
			executed = true;
			return "bad";
		}));
		const provider = scriptedProvider([
			{ match: (req) => !req.messages.some((message) => message.role === "tool"), produce: () => [{ kind: "tool_call", call: { id: "bad-1", name: "bad", args: "{\"value\":" , argsValid: false } }] },
			{ match: () => true, produce: () => [{ kind: "text", text: "stopped" }] },
		]);
		const subject = new Subject(provider.model, provider.stream, broker);
		subject.pushInput("bad args");
		await idle(subject);
		expect(executed).toBe(false);
		expect(subject.historySnapshot().find((message) => message.role === "tool")?.status).toBe("not_started");
	});

	it("does not execute tool calls when the provider ended on length", async () => {
		const broker = new ToolBroker();
		let executed = false;
		broker.register(makeTool("length_tool", async () => {
			executed = true;
			return "should not run";
		}));
		const provider = scriptedProvider([
			{ match: () => true, produce: () => [{ kind: "tool_call", call: { id: "length-1", name: "length_tool", args: "{}" } }, { kind: "finish", reason: "length" }] },
		]);
		const subject = new Subject(provider.model, provider.stream, broker);
		subject.pushInput("length");
		await idle(subject);
		expect(executed).toBe(false);
		expect(subject.historySnapshot().find((message) => message.role === "assistant")?.status).toBe("length");
		expect(subject.historySnapshot().find((message) => message.role === "tool")?.status).toBe("not_started");
	});

	it("compacts with provider-sized limits and keeps old history on failure", async () => {
		const broker = new ToolBroker();
		const provider = scriptedProvider([
			{
				match: (req) => (req.messages[0]?.content ?? "").includes("你是上下文摘要助手"),
				produce: () => [{ kind: "text", text: "保留的摘要" }],
			},
			{ match: () => true, produce: () => [{ kind: "text", text: "ok" }] },
		]);
		const subject = new Subject(provider.model, provider.stream, broker, {
			compaction: { contextWindow: 100, reserveTokens: 10, keepRecentTokens: 10 },
		});
		subject.addHistory(Array.from({ length: 10 }, (_, index) => ({
			role: "user" as const,
			content: `history-${index}-${"x".repeat(30)}`,
		})));
		subject.pushInput("new");
		await idle(subject);
		expect(provider.calls.some((call) => (call.messages[0]?.content ?? "").includes("你是上下文摘要助手"))).toBe(true);
		expect(subject.historySnapshot().some((message) => message.content === "[历史摘要] 保留的摘要")).toBe(true);

		const failing = scriptedProvider([
			{ match: (req) => (req.messages[0]?.content ?? "").includes("你是上下文摘要助手"), produce: () => { throw new Error("compact down"); } },
		]);
		const failedSubject = new Subject(failing.model, failing.stream, broker, {
			compaction: { contextWindow: 100, reserveTokens: 10, keepRecentTokens: 10 },
		});
		failedSubject.addHistory([{ role: "user", content: "old history" }, { role: "user", content: "x".repeat(500) }]);
		failedSubject.pushInput("new");
		await idle(failedSubject);
		const failedHistory = failedSubject.historySnapshot();
		expect(failedHistory.some((message) => message.content === "old history")).toBe(true);
		expect(failedHistory.some((message) => (message.content ?? "").includes("上轮处理出错"))).toBe(false);
	});

	it("scopes actual usage to one provider request and does not reuse it on the next turn", async () => {
		let request = 0;
		const reports: Array<{ usedTokens: number; actual: boolean; cacheRead?: number }> = [];
		const model: Model = {
			id: "usage-scope",
			name: "usage-scope",
			providerId: "mock",
			contextWindow: 100_000,
			thinkingLevels: ["off"],
		};
		const stream: ModelStreamFn = async (_m: Model, _req: ModelRequest, emit: (delta: StreamDelta) => void) => {
			request++;
			emit({ kind: "text", text: `reply-${request}` });
			if (request === 1) {
				emit({ kind: "usage", usage: { input: 10, output: 5, cacheRead: 7, cacheWrite: 0, reasoning: 0, totalTokens: 22 } });
			}
			emit({ kind: "finish", reason: "stop" });
		};
		const subject = new Subject(model, stream, new ToolBroker());
		subject.subscribe((event) => {
			if (event.type === "turn_end" && event.usage) {
				reports.push(event.usage as { usedTokens: number; actual: boolean; cacheRead?: number });
			}
		});
		await subject.pushInput("one");
		await subject.pushInput("two");
		expect(reports[0]).toMatchObject({ usedTokens: 22, actual: true, cacheRead: 7 });
		expect(reports[1]?.actual).toBe(false);
		expect(reports[1]?.cacheRead).toBeUndefined();
	});

	it("keeps an unknown provider context window unknown and disables automatic compaction", async () => {
		const provider = scriptedProvider([{ match: () => true, produce: () => [{ kind: "text", text: "ok" }] }]);
		const subject = new Subject(provider.model, provider.stream, new ToolBroker());
		subject.addHistory([{ role: "user", content: "x".repeat(300_000) }]);
		await subject.pushInput("next");
		expect(subject.getContextWindow()).toBeUndefined();
		expect(provider.calls).toHaveLength(1);
	});

	it("takes queued items for editor in single LIFO pull-back order", async () => {
		const provider = scriptedProvider([{ match: () => true, produce: () => [{ kind: "text", text: "ok" }] }]);
		const subject = new Subject(provider.model, provider.stream, new ToolBroker());
		subject.seedQueue([
			{ id: "q1", order: 1, text: "task 1", mode: "followUp" },
			{ id: "q2", order: 2, text: "task 2", mode: "followUp" },
		]);
		expect(subject.queuedSnapshot()).toHaveLength(2);

		// takeLastQueuedForEditor 取出最后入队的一条（对齐 Alt+Up pullBackLast）
		const last = await subject.takeLastQueuedForEditor();
		expect(last?.id).toBe("q2");
		expect(last?.text).toBe("task 2");
		expect(subject.queuedSnapshot()).toHaveLength(1);

		// 再次取出最后一条
		const first = await subject.takeLastQueuedForEditor();
		expect(first?.id).toBe("q1");
		expect(first?.text).toBe("task 1");
		expect(subject.queuedSnapshot()).toHaveLength(0);

		// 队列为空时返回 null
		const empty = await subject.takeLastQueuedForEditor();
		expect(empty).toBeNull();
	});

	it("consumes an input enqueued mid-run after the previous turn and replays the full session", async () => {
		const provider = scriptedProvider([{ match: () => true, produce: () => [{ kind: "text", text: "ok" }] }]);
		const store = new MemorySessionStore();
		const subject = new Subject(provider.model, provider.stream, new ToolBroker(), { store });
		void subject.pushInput("first");
		await subject.pushInput("second", { mode: "followUp" });
		await idle(subject);

		const records = store.readRecords();
		// 完整重放必须成功，且队列无残留
		const state = recoverRecords([...records]);
		expect(state.queued).toHaveLength(0);
		// 中间不允许出现 queue_restored
		expect(records.some((r) => r.kind === "event" && r.event === "queue_restored")).toBe(false);
		// second 必须恰好被消费为一条 input（ENQUEUED → INPUT）
		const inputs = records.filter((r) => r.kind === "input") as Array<{ input: { text: string } }>;
		expect(inputs.map((r) => r.input.text)).toEqual(["second"]);
	});

	it("does not consume an input already claimed for the editor while the run is settling", async () => {
		let releaseModel!: () => void;
		const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
		let releaseRestored!: () => void;
		const restoredGate = new Promise<void>((resolve) => { releaseRestored = resolve; });

		const stream: ModelStreamFn = async (_m: Model, _req: ModelRequest, emit: (delta: StreamDelta) => void) => {
			await modelGate;
			emit({ kind: "text", text: "done" });
			emit({ kind: "finish", reason: "stop" });
		};
		const model: Model = { id: "pull-race", name: "pull-race", providerId: "mock", contextWindow: 100_000 };
		const store = new MemorySessionStore();
		// 第一条 queue_restored 的落盘被挂起：模拟"认领"与"事件写入"之间的真实窗口
		const originalAppend = store.appendEvent.bind(store);
		let gateUsed = false;
		Object.assign(store, {
			appendEvent: (event: Parameters<MemorySessionStore["appendEvent"]>[0], data: Record<string, unknown>): Promise<void> => {
				const result = originalAppend(event, data);
				if (!gateUsed && event === "queue_restored") {
					gateUsed = true;
					return Promise.all([result, restoredGate]).then(() => undefined);
				}
				return result;
			},
		});
		const subject = new Subject(model, stream, new ToolBroker(), { store });

		void subject.pushInput("first");
		await subject.pushInput("second", { mode: "followUp" });
		// 认领在调用时刻同步完成，queue_restored 写入仍被挂起
		const pulled = subject.takeLastQueuedForEditor();
		// 放行第一轮：回合收尾触发 resumeQueued，此时 second 已被认领，不得被消费
		releaseModel();
		await wait();
		releaseRestored();
		const last = await pulled;
		await idle(subject);

		expect(last?.text).toBe("second");
		const records = store.readRecords();
		// second 只被还原到编辑器，从未产生 input 记录
		expect(records.some((r) => r.kind === "input")).toBe(false);
		expect(records.filter((r) => r.kind === "event" && r.event === "queue_restored")).toHaveLength(1);
		// 完整重放合法（ENQUEUED → RESTORED 是合法终态）
		const state = recoverRecords([...records]);
		expect(state.queued).toHaveLength(0);
	});
});

describe("JSONL session", () => {
	it("appends, replays and recovers an unfinished tool as unknown", async () => {
		const root = mkdtempSync(join(tmpdir(), "uina-session-"));
		tempDirs.push(root);
		const path = join(root, "session.jsonl");
		const { store } = await openJsonlSession(path);
		await store.appendMessage({ role: "user", content: "hello" });
		await store.appendMessage({ role: "assistant", content: "", tool_calls: [{ id: "call-1", name: "x", args: {} }] });
		await store.appendEvent("tool_started", { callId: "call-1", name: "x", args: {} });
		await store.close();
		const reopened = await openJsonlSession(path);
		const tool = projectModelHistory(reopened.snapshot.entries).find((message) => message.role === "tool");
		expect(tool && tool.status).toBe("unknown");
		await reopened.store.close();
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines[0]).toContain('"kind":"header"');
		expect(lines.length).toBe(5);
		expect(JSON.parse(lines.at(-1)!)).toMatchObject({kind:"message",message:{role:"tool",status:"unknown"}});

		const completedPath = join(root, "completed.jsonl");
		const completed = await openJsonlSession(completedPath);
		await completed.store.appendMessage({ role: "assistant", content: "", tool_calls: [{ id: "call-2", name: "x", args: {} }] });
		await completed.store.appendEvent("tool_started", { callId: "call-2", name: "x", args: {} });
		await completed.store.appendEvent("tool_finished", { callId: "call-2", name: "x", status: "succeeded", result: "ok" });
		await completed.store.close();
		const completedOpen = await openJsonlSession(completedPath);
		expect(projectModelHistory(completedOpen.snapshot.entries).find((message) => message.role === "tool")?.status).toBe("succeeded");
		await completedOpen.store.close();
	});

	it("preserves one ordered entry stream and projects custom messages in place", async () => {
		const root = mkdtempSync(join(tmpdir(), "uina-session-order-"));
		tempDirs.push(root);
		const path = join(root, "session.jsonl");
		const opened = await openJsonlSession(path);
		await opened.store.appendMessage({ role: "user", content: "A" });
		await opened.store.appendCustomMessage({ customType: "probe", content: "C" });
		await opened.store.appendMessage({ role: "assistant", content: "B" });
		await opened.store.appendCustomEntry({ customType: "ui-only", data: { value: "D" } });
		await opened.store.close();

		const reopened = await openJsonlSession(path);
		expect(reopened.snapshot.entries.map((entry) => entry.kind)).toEqual([
			"message",
			"custom_message",
			"message",
			"custom_entry",
		]);
		expect(projectModelHistory(reopened.snapshot.entries).map((message) => message.content)).toEqual(["A", "C", "B"]);
		await reopened.store.close();
	});

	it("uses the latest compaction as the model-history boundary without rewriting journal order", async () => {
		const root = mkdtempSync(join(tmpdir(), "uina-session-compact-"));
		tempDirs.push(root);
		const path = join(root, "session.jsonl");
		const opened = await openJsonlSession(path);
		await opened.store.appendMessage({ role: "user", content: "old" });
		await opened.store.appendCustomMessage({ customType: "old-custom", content: "old-custom" });
		await opened.store.appendMessage({ role: "assistant", content: "tail" });
		await opened.store.appendCompaction("summary", [{ role: "assistant", content: "tail" }], 100);
		await opened.store.appendCustomMessage({ customType: "new-custom", content: "new-custom" });
		await opened.store.appendMessage({ role: "assistant", content: "after" });
		await opened.store.close();

		const reopened = await openJsonlSession(path);
		expect(reopened.snapshot.entries.map((entry) => entry.kind)).toEqual([
			"message",
			"custom_message",
			"message",
			"compaction",
			"custom_message",
			"message",
		]);
		expect(projectModelHistory(reopened.snapshot.entries).map((message) => message.content)).toEqual([
			"[历史摘要] summary",
			"tail",
			"new-custom",
			"after",
		]);
		await reopened.store.close();
	});

	it("repairs only a torn final line and rejects an invalid middle line", async () => {
		const root = mkdtempSync(join(tmpdir(), "uina-session-"));
		tempDirs.push(root);
		const path = join(root, "session.jsonl");
		const header = JSON.stringify({ kind: "header", version: 2, id: "x", cwd: root, createdAt: new Date().toISOString() });
		const message = JSON.stringify({ kind: "message", id: "m", seq: 1, timestamp: new Date().toISOString(), message: { role: "user", content: "ok" } });
		writeFileSync(path, `${header}\n${message}\n{"kind":"message"`);
		const opened = await openJsonlSession(path);
		expect(opened.snapshot.entries).toHaveLength(1);
		await opened.store.close();

		writeFileSync(path, `${header}\nnot-json\n${message}\n`);
		await expect(openJsonlSession(path)).rejects.toBeInstanceOf(SessionFormatError);

		writeFileSync(path, `${header}\n${message}\nnot-json\n`);
		await expect(openJsonlSession(path)).rejects.toBeInstanceOf(SessionFormatError);
	});
});

describe("shell output", () => {
	it("keeps the final tail and writes complete output beyond 1 MB", async () => {
		const quote = String.fromCharCode(34);
		const command = `node -e ${quote}process.stdout.write(String.fromCharCode(65)+String.fromCharCode(120).repeat(1100000)+String.fromCharCode(69,78,68))${quote}`;
		const result = JSON.parse((await execCommandTool.run({ command })).result);
		expect(result.stdout).toContain("END");
		expect(result.truncated.stdout).toBe(true);
		const path = result.fullOutputPath.stdout as string;
		expect(path).toBeTruthy();
		expect(readFileSync(path, "utf8").endsWith("END")).toBe(true);
	});

	it("keeps a bounded suffix for a single long line", async () => {
		const quote = String.fromCharCode(34);
		const result = await execCommandDirect(`node -e ${quote}process.stdout.write(String.fromCharCode(120).repeat(100000))${quote}`);
		// A single 100k-char line is truncated to the byte budget, not dropped.
		expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(50 * 1024);
		expect(result.stdout.length).toBeGreaterThan(49 * 1024);
		expect(/^x+$/.test(result.stdout)).toBe(true);
		expect(result.stdoutMeta?.truncated).toBe(true);
		expect(result.stdoutMeta?.fullOutputPath).toBeTruthy();
	});

	it("preserves split UTF-8 across chunks and replaces invalid bytes", () => {
		const collector = new OutputCollector();
		const bytes = Buffer.from("中文测试", "utf8");
		collector.push(bytes.subarray(0, 4));
		collector.push(bytes.subarray(4));
		collector.finish();
		expect(collector.snapshot().content).toBe("中文测试");

		const invalid = new OutputCollector();
		invalid.push(Buffer.from([0xff, 0xfe]));
		invalid.finish();
		expect(invalid.snapshot().content).toBe("\uFFFD\uFFFD");
	});
});
