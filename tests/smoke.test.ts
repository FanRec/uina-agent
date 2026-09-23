import { describe, expect, test, SubjectHarness } from "./harness/index.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ToolBroker, type Tool } from "../src/tools/broker.js";
import { MemorySessionStore, openJsonlSession } from "../src/session/jsonl-store.js";
import { SessionFormatError, canonicalReplay, queuedInputs } from "../src/session/recovery.js";
import { projectModelHistory } from "../src/agent/projection.js";
import type { Model, ModelRequest, ModelStreamFn, StreamDelta } from "../src/core/types.js";
import execCommandTool, { execCommandDirect } from "../src/extensions/runtime-tools/exec-command/index.js";
import { OutputCollector } from "../src/extensions/runtime-tools/exec-command/output.js";
import getTimeTool from "../src/extensions/runtime-tools/get-time/index.js";
import { Scenario } from "./harness/provider/scenario.js";

const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

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
	test("validates arguments before execution and serializes arbitrary thrown values", async () => {
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
	test("executes a tool loop and persists message events", async () => {
		const h = SubjectHarness.create({ tools: [getTimeTool], store: new MemorySessionStore() });
		h.scenario
			.when((req) => !req.messages.some((message) => message.role === "tool"))
			.replyWithToolCall("t1", "get_time", {});
		h.scenario.fallback(() => [{ kind: "text", text: "完成" }, { kind: "finish", reason: "stop" }]);

		await h.run("几点");
		expect(h.scenario.calls).toHaveLength(2);
		expect(h.history.filter((message) => message.role === "tool")).toHaveLength(1);
		expect(h.records.some((record) => record.kind === "event" && record.event === "tool_started")).toBe(true);
	});

	test("preserves tool results already bounded by the tool output contract", async () => {
		const h = SubjectHarness.create({ tools: [makeTool("large", async () => "x".repeat(5000))] });
		h.scenario
			.when((req) => !req.messages.some((message) => message.role === "tool"))
			.replyWithToolCall("large-1", "large", {});
		h.scenario.fallback(() => [{ kind: "text", text: "done" }, { kind: "finish", reason: "stop" }]);

		await h.run("large");
		const tool = h.scenario.calls[1].messages.find((message) => message.role === "tool");
		expect(tool?.content).toBe("x".repeat(5000));
	});

	test("runs independent tools in parallel and returns results in call order", async () => {
		let active = 0, maxActive = 0;
		const run = async (args: Record<string, unknown>) => {
			active++; maxActive = Math.max(maxActive, active);
			await wait(80); active--; return String(args.value);
		};
		const h = SubjectHarness.create({ tools: [makeTool("one", run), makeTool("two", run)] });
		h.scenario
			.when((req) => !req.messages.some((message) => message.role === "tool"))
			.then(() => [
				{ kind: "tool_call", call: { id: "1", name: "one", args: JSON.stringify({ value: "one" }) } },
				{ kind: "tool_call", call: { id: "2", name: "two", args: JSON.stringify({ value: "two" }) } },
				{ kind: "finish", reason: "tool_calls" },
			]);
		h.scenario.fallback(() => [{ kind: "text", text: "done" }, { kind: "finish", reason: "stop" }]);

		await h.run("run");
		expect(maxActive).toBe(2);
		const toolMessages = h.history.filter((message) => message.role === "tool");
		expect(toolMessages.map((message) => message.role === "tool" && message.tool_call_id)).toEqual(["1", "2"]);
	});

	test("delivers steer before followUp and preserves queue order after stop", async () => {
		let release: (() => void) | undefined;
		const model: Model = {
			id: "queue-test",
			name: "queue-test",
			providerId: "mock",
			contextWindow: 128_000,
		};
		const stream: ModelStreamFn = async (_m: Model, req: ModelRequest, onDelta: (delta: StreamDelta) => void, signal?: AbortSignal) => {
			const lastMsg = [...req.messages].reverse().find((m) => m.role === "user");
			const input = typeof lastMsg?.content === "string" ? lastMsg.content : "";
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
		const h1 = SubjectHarness.create({ model, stream, broker });
		h1.pushInput("first");
		await wait(20);
		h1.subject.steer("steer");
		h1.subject.followUp("follow");
		h1.interrupt();
		await h1.waitForIdle();
		expect(h1.queuedSnapshot().map((item) => item.text)).toEqual(["steer", "follow"]);
		const editorItems = await h1.claimAllQueued();
		expect(editorItems.map((item) => item.text)).toEqual(["steer", "follow"]);
		release?.();

		const normal = new Scenario();
		normal.fallback(() => [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }]);
		const h2 = SubjectHarness.create({ scenario: normal, broker });
		h2.pushInput(editorItems.map((item) => item.text).join("\n\n"));
		await h2.waitForIdle();
		const lastUserMsg = [...normal.calls[0].messages].reverse().find((m) => m.role === "user");
		expect(lastUserMsg?.content).toBe("steer\n\nfollow");
	});

	test("轮中被消费的排队项必须为每条产生 turn_start（TUI 用户消息渲染依赖它）", async () => {
		let release: (() => void) | undefined;
		const model: Model = {
			id: "queue-render-test",
			name: "queue-render-test",
			providerId: "mock",
			contextWindow: 128_000,
		};
		const stream: ModelStreamFn = async (_m: Model, req: ModelRequest, onDelta: (delta: StreamDelta) => void, signal?: AbortSignal) => {
			const lastMsg = [...req.messages].reverse().find((m) => m.role === "user");
			const input = typeof lastMsg?.content === "string" ? lastMsg.content : "";
			if (input === "first") {
				await new Promise<void>((resolve, reject) => {
					release = resolve;
					signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
				});
			}
			onDelta({ kind: "text", text: input });
			onDelta({ kind: "finish", reason: "stop" });
		};
		const harness = SubjectHarness.create({ model, stream });
		const turnTexts: string[] = [];
		harness.subscribe((event) => {
			if (event.type === "turn_start") turnTexts.push(event.userText);
		});

		harness.pushInput("first");
		await wait(20);
		harness.subject.steer("steer-A");
		harness.subject.followUp("follow-B");
		release?.();
		await harness.waitForIdle();

		// 每条被消费的排队内容都应开启一个新可见回合；text 为空串（非本轮用户消息）不算数
		expect(turnTexts.filter((t) => t.length > 0)).toEqual(["first", "steer-A", "follow-B"]);
	});

	test("被消费的排队项必须产生配对的 turn_start/turn_end（turnNumber 一致）", async () => {
		let release: (() => void) | undefined;
		const model: Model = {
			id: "turn-pair-test",
			name: "turn-pair-test",
			providerId: "mock",
			contextWindow: 128_000,
		};
		const stream: ModelStreamFn = async (_m: Model, req: ModelRequest, onDelta: (delta: StreamDelta) => void) => {
			const lastMsg = [...req.messages].reverse().find((m) => m.role === "user");
			const input = typeof lastMsg?.content === "string" ? lastMsg.content : "";
			if (input === "first") {
				await new Promise<void>((resolve) => { release = resolve; });
			}
			onDelta({ kind: "text", text: "done" });
			onDelta({ kind: "finish", reason: "stop" });
		};
		const harness = SubjectHarness.create({ model, stream });
		const starts: number[] = [];
		const ends: number[] = [];
		harness.subscribe((event) => {
			if (event.type === "turn_start") starts.push(event.turnNumber);
			if (event.type === "turn_end") ends.push(event.turnNumber);
		});

		harness.pushInput("first");
		await wait(20);
		harness.subject.steer("steer-A");
		await wait(20);
		release?.();
		harness.subject.steer("steer-B");
		await harness.waitForIdle();

		// 每个开启的可见回合都必须有同号终态：trajectory / transcript 的 turn 号口径一致
		expect([...starts].sort((a, b) => a - b)).toEqual([...ends].sort((a, b) => a - b));
	});

	test("does not execute malformed tool arguments", async () => {
		let executed = false;
		const h = SubjectHarness.create({ tools: [makeTool("bad", async () => { executed = true; return "bad"; })] });

		h.scenario
			.when((req) => !req.messages.some((message) => message.role === "tool"))
			.then(() => [
				{ kind: "tool_call", call: { id: "bad-1", name: "bad", args: "{\"value\":", argsValid: false } },
				{ kind: "finish", reason: "tool_calls" },
			]);
		h.scenario.fallback(() => [{ kind: "text", text: "stopped" }, { kind: "finish", reason: "stop" }]);

		await h.run("bad args");
		expect(executed).toBe(false);
		expect(h.history.find((message) => message.role === "tool")?.status).toBe("not_started");
	});

	test("does not execute tool calls when the provider ended on length", async () => {
		let executed = false;
		const h = SubjectHarness.create({ tools: [makeTool("length_tool", async () => { executed = true; return "should not run"; })] });

		h.scenario.fallback(() => [
			{ kind: "tool_call", call: { id: "length-1", name: "length_tool", args: "{}" } },
			{ kind: "finish", reason: "length" },
		]);

		await h.run("length");
		expect(executed).toBe(false);
		expect(h.history.find((message) => message.role === "assistant")?.status).toBe("length");
		expect(h.history.find((message) => message.role === "tool")?.status).toBe("not_started");
	});

	test("scopes actual usage to one provider request and does not reuse it on the next turn", async () => {
		let request = 0;
		const reports: import("../src/core/types.js").RequestUsage[] = [];
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
		const harness = SubjectHarness.create({ model, stream });
		harness.subscribe((event) => {
			if (event.type === "turn_end" && event.requestUsage) {
				reports.push(event.requestUsage);
			}
		});
		await harness.pushInput("one");
		await harness.pushInput("two");
		expect(reports[0]?.cacheRead).toBe(7);
		expect(reports[0]?.totalTokens).toBe(22);
		expect(reports[1]?.cacheRead).toBeUndefined();
	});

	test("keeps an unknown provider context window unknown and disables automatic compaction", async () => {
		const h = SubjectHarness.create({ model: { contextWindow: undefined } });
		h.scenario.fallback(() => [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }]);
		h.subject.addHistory([{ role: "user", content: "x".repeat(300_000) }]);
		await h.run("next");
		expect(h.subject.getContextWindow()).toBeUndefined();
		expect(h.scenario.calls).toHaveLength(1);
	});

	test("claims queued items by identity in single LIFO pull-back order (UI peek + claim 组合)", async () => {
		const h = SubjectHarness.create();
		h.scenario.fallback(() => [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }]);
		h.subject.seedQueue([
			{ id: "q1", order: 1, text: "task 1", mode: "followUp" },
			{ id: "q2", order: 2, text: "task 2", mode: "followUp" },
		]);
		expect(h.subject.queuedSnapshot()).toHaveLength(2);

		// UI pull-back 组合：peek 快照取最后入队的身份，claim 按身份领取（对齐 Alt+Up）
		const last = await h.subject.claimQueued(h.subject.queuedSnapshot().at(-1)!.id);
		expect(last?.id).toBe("q2");
		expect(last?.text).toBe("task 2");
		expect(h.subject.queuedSnapshot()).toHaveLength(1);

		// 再次领取最后一条
		const first = await h.subject.claimQueued(h.subject.queuedSnapshot().at(-1)!.id);
		expect(first?.id).toBe("q1");
		expect(first?.text).toBe("task 1");
		expect(h.subject.queuedSnapshot()).toHaveLength(0);

		// 队列为空时 peek 无候选；未知身份幂等返回 null
		const empty = await h.subject.claimQueued("missing-id");
		expect(empty).toBeNull();
	});

	test("consumes an input enqueued mid-run after the previous turn and replays the full session", async () => {
		const h = SubjectHarness.create({ store: new MemorySessionStore() });
		h.scenario.fallback(() => [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }]);
		void h.subject.pushInput("first");
		await h.subject.pushInput("second", { mode: "followUp" });
		await h.subject.waitForIdle();

		const records = h.records;
		// 完整重放必须成功，且队列无残留
		const state = canonicalReplay(records);
		expect(queuedInputs(state)).toHaveLength(0);
		// 中间不允许出现 queue_restored
		expect(records.some((r) => r.kind === "event" && r.event === "queue_restored")).toBe(false);
		// second 必须恰好被消费为一条 input（ENQUEUED → INPUT）
		const inputs = records.filter((r) => r.kind === "input") as Array<{ input: { text: string } }>;
		expect(inputs.map((r) => r.input.text)).toEqual(["first", "second"]);
	});

	test("does not consume an input already claimed for the editor while the run is settling", async () => {
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
		const harness = SubjectHarness.create({ model, stream, store });

		void harness.pushInput("first");
		await harness.pushInput("second", { mode: "followUp" });
		// 认领在调用时刻同步完成，queue_restored 写入仍被挂起
		const pulled = harness.claimQueued(harness.queuedSnapshot().at(-1)!.id);
		// 放行第一轮：回合收尾触发 resumeQueued，此时 second 已被认领，不得被消费
		releaseModel();
		await wait();
		releaseRestored();
		const last = await pulled;
		await harness.waitForIdle();

		expect(last?.text).toBe("second");
		const records = store.readRecords();
		// second 只被还原到编辑器，从未产生 input 记录
		expect(records.some((r) => r.kind === "input" && (r as any).input?.text === "second")).toBe(false);
		expect(records.filter((r) => r.kind === "event" && r.event === "queue_restored")).toHaveLength(1);
		// 完整重放合法（ENQUEUED → RESTORED 是合法终态）
		const state = canonicalReplay(records);
		expect(queuedInputs(state)).toHaveLength(0);
	});
});

describe("JSONL session", () => {
	test("appends, replays and recovers an unfinished tool as unknown", async ({ env }) => {
		const path = env.sessionPath;
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
		expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: "message", message: { role: "tool", status: "unknown" } });

		const completedPath = join(env.cwd, "completed.jsonl");
		const completed = await openJsonlSession(completedPath);
		await completed.store.appendMessage({ role: "assistant", content: "", tool_calls: [{ id: "call-2", name: "x", args: {} }] });
		await completed.store.appendEvent("tool_started", { callId: "call-2", name: "x", args: {} });
		await completed.store.appendEvent("tool_finished", { callId: "call-2", name: "x", status: "succeeded", result: "ok" });
		await completed.store.close();
		const completedOpen = await openJsonlSession(completedPath);
		expect(projectModelHistory(completedOpen.snapshot.entries).find((message) => message.role === "tool")?.status).toBe("succeeded");
		await completedOpen.store.close();
	});

	test("preserves one ordered entry stream and projects custom messages in place", async ({ env }) => {
		const path = env.sessionPath;
		const opened = await openJsonlSession(path);
		await opened.store.appendMessage({ role: "user", content: "A" });
		await opened.store.appendCustomMessage({ customType: "probe", content: "C" });
		await opened.store.appendMessage({ role: "assistant", content: "B" });
		await opened.store.appendCustomEntry({ customType: "ui-only", data: { value: "D" } });
		await opened.store.close();

		const reopened = await openJsonlSession(path);
		// custom_entry 是 Auxiliary：journal 序保留，主线 entries 不含。
		expect(reopened.snapshot.entries.map((entry) => entry.kind)).toEqual([
			"message",
			"custom_message",
			"message",
		]);
		expect(reopened.store.state.auxiliary.map((record) => (record as { customType?: string }).customType)).toEqual(["ui-only"]);
		expect(projectModelHistory(reopened.snapshot.entries).map((message) => message.content)).toEqual(["A", "C", "B"]);
		await reopened.store.close();
	});

	test("repairs only a torn final line and rejects an invalid middle line", async ({ env }) => {
		const path = env.sessionPath;
		const header = JSON.stringify({ kind: "header", version: 3, id: "x", cwd: env.cwd, createdAt: new Date().toISOString() });
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
	test("keeps the final tail and writes complete output beyond 1 MB", async () => {
		const quote = String.fromCharCode(34);
		const command = `node -e ${quote}process.stdout.write(String.fromCharCode(65)+String.fromCharCode(120).repeat(1100000)+String.fromCharCode(69,78,68))${quote}`;
		const result = JSON.parse((await execCommandTool.run({ command })).result);
		expect(result.stdout).toContain("END");
		expect(result.truncated.stdout).toBe(true);
		const path = result.fullOutputPath.stdout as string;
		expect(path).toBeTruthy();
		expect(readFileSync(path, "utf8").endsWith("END")).toBe(true);
	});

	test("keeps a bounded suffix for a single long line", async () => {
		const quote = String.fromCharCode(34);
		const result = await execCommandDirect(`node -e ${quote}process.stdout.write(String.fromCharCode(120).repeat(100000))${quote}`);
		// A single 100k-char line is truncated to the byte budget, not dropped.
		expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(50 * 1024);
		expect(result.stdout.length).toBeGreaterThan(49 * 1024);
		expect(/^x+$/.test(result.stdout)).toBe(true);
		expect(result.stdoutMeta?.truncated).toBe(true);
		expect(result.stdoutMeta?.fullOutputPath).toBeTruthy();
	});

	test("preserves split UTF-8 across chunks and replaces invalid bytes", () => {
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

describe("模型切换语义", () => {
	test("工作中切模型后，steer 续跑使用新模型与思考档（下一轮语义）", async () => {
		type M = import("../src/core/types.js").Model;
		const modelA: M = { id: "model-a", name: "model-a", providerId: "mock", contextWindow: 128_000, thinkingLevels: ["off", "high"] };
		const modelB: M = { id: "model-b", name: "model-b", providerId: "mock", contextWindow: 128_000, thinkingLevels: ["off", "high"] };
		const calls: Array<{ model: string; level?: string; user?: string }> = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const stream: import("../src/core/types.js").ModelStreamFn = async (m, req, onDelta) => {
			const lastMsg = [...req.messages].reverse().find((msg) => msg.role === "user");
			const userText = typeof lastMsg?.content === "string" ? lastMsg.content : "";
			calls.push({ model: m.id, level: req.thinkingLevel, user: userText });
			if (userText === "first") {
				await gate;
			}
			onDelta({ kind: "text", text: userText });
			onDelta({ kind: "finish", reason: "stop" });
		};
		const harness = SubjectHarness.create({ model: modelA, stream, thinkingLevel: "high" });
		const run = harness.pushInput("first");
		await new Promise((r) => setTimeout(r, 30));
		// 工作中：切模型 + 关思考
		await harness.setModel(modelB);
		harness.setThinkingLevel("off");
		release();
		// steer 续跑（旧行为：仍用 modelA + high；期望：modelB + off）
		await harness.subject.steer("second");
		await run;
		await harness.waitForIdle();
		expect(calls.length).toBe(2);
		expect(calls[0]).toMatchObject({ model: "model-a", level: "high" });
		expect(calls[1]).toMatchObject({ model: "model-b", level: "off", user: "second" });
	});
});
