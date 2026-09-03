import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolBroker, type Tool } from "../src/tools/broker.js";
import { Subject } from "../src/agent/loop.js";
import { MemorySessionStore, openJsonlSession } from "../src/session/jsonl-store.js";
import { SessionFormatError } from "../src/session/recovery.js";
import type { ModelRequest, ModelProvider, StreamDelta } from "../src/core/types.js";
import execCommandTool, { createByteDecoder, execCommandDirect } from "../tools/exec-command/index.js";
import getTimeTool from "../tools/get-time/index.js";
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

function makeTool(name: string, run: Tool["run"], executionMode?: Tool["executionMode"]): Tool {
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
		run,
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
		const subject = new Subject(provider, broker, { onToken: () => {} }, { store });
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
		const subject = new Subject(provider, broker, { onToken: () => {} });
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
		const subject = new Subject(provider, broker, { onToken: () => {} });
		subject.pushInput("run");
		await idle(subject);
		expect(maxActive).toBe(2);
		const toolMessages = subject.historySnapshot().filter((message) => message.role === "tool");
		expect(toolMessages.map((message) => message.role === "tool" && message.tool_call_id)).toEqual(["1", "2"]);
	});

	it("delivers steer before followUp and preserves queue order after stop", async () => {
		let release: (() => void) | undefined;
		const provider: ModelProvider = {
			name: "queue-test",
			async stream(req: ModelRequest, onDelta: (delta: StreamDelta) => void, signal?: AbortSignal) {
				const input = lastUser(req);
				if (input === "first") {
					await new Promise<void>((resolve, reject) => {
						release = resolve;
						signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
					});
				}
				onDelta({ kind: "text", text: input });
				onDelta({ kind: "finish", reason: "stop" });
			},
		};
		const broker = new ToolBroker();
		const subject = new Subject(provider, broker, { onToken: () => {} });
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
		const resumed = new Subject(normal, broker, { onToken: () => {} });
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
		const subject = new Subject(provider, broker, { onToken: () => {} });
		subject.pushInput("bad args");
		await idle(subject);
		expect(executed).toBe(false);
		expect(subject.historySnapshot().find((message) => message.role === "tool")?.status).toBe("not_started");
	});

	it("compacts with provider-sized limits and keeps old history on failure", async () => {
		const broker = new ToolBroker();
		const provider = scriptedProvider([
			{
				match: (req) => (req.messages[0]?.content ?? "").includes("压缩成不超过"),
				produce: () => [{ kind: "text", text: "保留的摘要" }],
			},
			{ match: () => true, produce: () => [{ kind: "text", text: "ok" }] },
		]);
		const subject = new Subject(provider, broker, { onToken: () => {} }, {
			compaction: { contextWindow: 100, reserveTokens: 10, keepRecentTokens: 10 },
		});
		subject.addHistory(Array.from({ length: 10 }, (_, index) => ({
			role: "user" as const,
			content: `history-${index}-${"x".repeat(30)}`,
		})));
		subject.pushInput("new");
		await idle(subject);
		expect(provider.calls.some((call) => (call.messages[0]?.content ?? "").includes("压缩成不超过"))).toBe(true);
		expect(subject.historySnapshot().some((message) => message.content === "[历史摘要] 保留的摘要")).toBe(true);

		const failing = scriptedProvider([
			{ match: (req) => (req.messages[0]?.content ?? "").includes("压缩成不超过"), produce: () => { throw new Error("compact down"); } },
		]);
		const failedSubject = new Subject(failing, broker, { onToken: () => {} }, {
			compaction: { contextWindow: 100, reserveTokens: 10, keepRecentTokens: 10 },
		});
		failedSubject.addHistory([{ role: "user", content: "old history" }, { role: "user", content: "x".repeat(500) }]);
		failedSubject.pushInput("new");
		await idle(failedSubject);
		const failedHistory = failedSubject.historySnapshot();
		expect(failedHistory.some((message) => message.content === "old history")).toBe(true);
		expect(failedHistory.some((message) => (message.content ?? "").includes("上轮处理出错"))).toBe(false);
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
		const tool = reopened.snapshot.messages.find((message) => message.role === "tool");
		expect(tool && tool.status).toBe("unknown");
		await reopened.store.close();
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines[0]).toContain('"kind":"header"');
		expect(lines.length).toBe(4);

		const completedPath = join(root, "completed.jsonl");
		const completed = await openJsonlSession(completedPath);
		await completed.store.appendMessage({ role: "assistant", content: "", tool_calls: [{ id: "call-2", name: "x", args: {} }] });
		await completed.store.appendEvent("tool_started", { callId: "call-2", name: "x", args: {} });
		await completed.store.appendEvent("tool_finished", { callId: "call-2", name: "x", status: "succeeded", result: "ok" });
		await completed.store.close();
		const completedOpen = await openJsonlSession(completedPath);
		expect(completedOpen.snapshot.messages.find((message) => message.role === "tool")?.status).toBe("succeeded");
		await completedOpen.store.close();
	});

	it("repairs only a torn final line and rejects an invalid middle line", async () => {
		const root = mkdtempSync(join(tmpdir(), "uina-session-"));
		tempDirs.push(root);
		const path = join(root, "session.jsonl");
		const header = JSON.stringify({ kind: "header", version: 2, id: "x", cwd: root, createdAt: new Date().toISOString() });
		const message = JSON.stringify({ kind: "message", id: "m", seq: 1, timestamp: new Date().toISOString(), message: { role: "user", content: "ok" } });
		writeFileSync(path, `${header}\n${message}\n{"kind":"message"`);
		const opened = await openJsonlSession(path);
		expect(opened.snapshot.messages).toHaveLength(1);
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
		const result = JSON.parse(await execCommandTool.run({ command }));
		expect(result.stdout).toContain("END");
		expect(result.truncated.stdout).toBe(true);
		const path = result.fullOutputPath.stdout as string;
		expect(path).toBeTruthy();
		expect(readFileSync(path, "utf8").endsWith("END")).toBe(true);
	});

	it("keeps a useful suffix for a single long line", async () => {
		const quote = String.fromCharCode(34);
		const result = await execCommandDirect(`node -e ${quote}process.stdout.write(String.fromCharCode(120).repeat(100000))${quote}`);
		expect(result.stdout.length).toBeGreaterThan(0);
	});

	it("preserves split UTF-8 and deterministic invalid-byte fallback", () => {
		const decoder = createByteDecoder();
		const bytes = Buffer.from("中文测试", "utf8");
		expect(decoder.push(bytes.subarray(0, 4)) + decoder.push(bytes.subarray(4)) + decoder.flush()).toBe("中文测试");
		const invalid = createByteDecoder();
		expect(invalid.push(Buffer.from([0xff, 0xfe]))).toBe(Buffer.from([0xff, 0xfe]).toString("latin1"));
		const mixed = createByteDecoder();
		expect(mixed.push(Buffer.from([0xe4])) + mixed.push(Buffer.from([0xff, 0xfe]))).toBe("äÿþ");
	});
});
