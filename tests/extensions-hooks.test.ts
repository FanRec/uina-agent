import { describe, it, expect } from "vitest";
import { ExtensionHost } from "../src/extensions/host.js";
import { createRuntimeHooks } from "../src/extensions/runtime-hooks.js";
import type { RuntimeHooks } from "../src/runtime/hooks.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";
import { Subject } from "../src/agent/loop.js";
import { streamCompactor } from "../src/agent/compaction.js";
import { ToolBroker } from "../src/tools/broker.js";
import type { Model, ModelRequest, ModelStreamFn, StreamDelta, ThinkingLevel } from "../src/core/types.js";
import { mockModel } from "./helpers/mock-provider.js";
import { createOpenAIProvider } from "../src/ai/gateway.js";
import { createServer } from "node:http";

function mockPair(
	deltas: StreamDelta[] = [{ kind: "text", text: "你好" }, { kind: "finish", reason: "stop" }],
	name = "mock-model",
	contextWindow = 4096,
	thinkingLevels: readonly ThinkingLevel[] = ["off", "low", "high"],
): { model: Model; stream: ModelStreamFn } {
	const model: Model = {
		id: name,
		name,
		providerId: name,
		contextWindow,
		thinkingLevels,
	};
	return {
		model,
		stream: async (_m: Model, _req: ModelRequest, onDelta: (d: StreamDelta) => void) => {
			for (const delta of deltas) {
				onDelta(delta);
			}
		},
	};
}
const mockProvider = mockPair;

describe("ExtensionHost & Hooks Architecture", () => {
	it("isolates errors in event handlers without disrupting execution", async () => {
		const host = new ExtensionHost();
		const errors: string[] = [];
		host.onError((err) => errors.push(err.error));

		host.on("agent_start", () => {
			throw new Error("扩展意外崩溃");
		});

		let normalRan = false;
		host.on("agent_start", () => {
			normalRan = true;
		});

		await host.emit({ type: "agent_start", turnSeq: 1 });
		expect(normalRan).toBe(true);
		expect(errors).toContain("扩展意外崩溃");
	});

	it("intercepts tool_call when block: true is returned", async () => {
		const host = new ExtensionHost();
		let toolActuallyExecuted = false;

		host.onHook("tools.beforeCall", (input) => {
			if (input.name === "dangerous_tool") {
				return { block: true, reason: "安全策略拦截高危工具" };
			}
		});

		const tools = new ToolBroker();
		tools.register({
			def: {
				type: "function",
				function: {
					name: "dangerous_tool",
					description: "高危工具",
					parameters: { type: "object", properties: {} },
				},
			},
			async run() {
				toolActuallyExecuted = true;
				return { result: "executed", status: "succeeded" };
			},
		});

		const pair = {
			model: mockModel({ id: "mock", name: "mock" }),
			stream: async (_m: Model, req: ModelRequest, onDelta: (d: StreamDelta) => void) => {
				if (req.messages.some((m) => m.role === "tool")) {
					onDelta({ kind: "text", text: "已获知工具被拦截" });
					onDelta({ kind: "finish", reason: "stop" });
				} else {
					onDelta({
						kind: "tool_call",
						call: { id: "call-1", name: "dangerous_tool", args: "{}" },
					});
					onDelta({ kind: "finish", reason: "tool_calls" });
				}
			},
		};

		const toolDones: Array<{ name: string; result: string; status?: string }> = [];
		const subject = new Subject(pair.model, pair.stream, tools, { runtimeHooks: createRuntimeHooks(host) });
		subject.subscribe((e) => {
			if (e.type === "tool_result") toolDones.push({ name: e.toolName, result: e.result, status: e.status });
		});

		await subject.pushInput("请运行危险工具");
		await subject.waitForIdle();

		expect(toolActuallyExecuted).toBe(false);
		expect(toolDones.some((d) => d.name === "dangerous_tool" && d.status === "not_started")).toBe(true);
		const history = subject.historySnapshot();
		const toolResultMsg = history.find((m) => m.role === "tool");
		expect(toolResultMsg?.content).toContain("[blocked] 工具执行已被拦截: 安全策略拦截高危工具");
	});

	it("transforms tool_result after tool finishes execution", async () => {
		const host = new ExtensionHost();

		host.onHook("tools.transformResult", (input) => {
			if (input.name === "calc") {
				return { result: `[AUDITED] ${input.result}` };
			}
		});

		const tools = new ToolBroker();
		tools.register({
			def: {
				type: "function",
				function: {
					name: "calc",
					description: "计算器",
					parameters: { type: "object", properties: {} },
				},
			},
			async run() {
				return { result: "42", status: "succeeded" };
			},
		});

		const pair = {
			model: mockModel({ id: "mock", name: "mock" }),
			stream: async (_m: Model, req: ModelRequest, onDelta: (d: StreamDelta) => void) => {
				if (req.messages.some((m) => m.role === "tool")) {
					onDelta({ kind: "text", text: "完成" });
					onDelta({ kind: "finish", reason: "stop" });
				} else {
					onDelta({
						kind: "tool_call",
						call: { id: "c1", name: "calc", args: "{}" },
					});
					onDelta({ kind: "finish", reason: "tool_calls" });
				}
			},
		};

		const subject = new Subject(
			pair.model,
			pair.stream,
			tools,
			{ runtimeHooks: createRuntimeHooks(host) },
		);

		await subject.pushInput("算一下");
		await subject.waitForIdle();

		const history = subject.historySnapshot();
		const toolMsg = history.find((m) => m.role === "tool");
		expect(toolMsg?.content).toBe("[AUDITED] 42");
	});

	it("supports dynamic model switching via setModel and emits model_select", async () => {
		const host = new ExtensionHost();
		const modelSelects: string[] = [];
		host.on("model_select", (e) => {
			modelSelects.push(e.model);
		});

		const prov1 = mockProvider();
		const prov2 = mockPair([{ kind: "text", text: "切换成功" }, { kind: "finish", reason: "stop" }], "deepseek-reasoner", 65536, ["off", "high"]);

		const subject = new Subject(
			prov1.model,
			prov1.stream,
			new ToolBroker(),
			{ runtimeHooks: createRuntimeHooks(host) },
		);

		expect(subject.getModel().name).toBe("mock-model");
		await subject.setModel(prov2.model);

		expect(subject.getModel().name).toBe("deepseek-reasoner");
		expect(modelSelects).toEqual(["deepseek-reasoner"]);
	});

	it("clamps thinkingLevel adaptively to model capabilities and recovers", async () => {
		const host = new ExtensionHost();
		const levelEvents: string[] = [];
		host.on("thinking_level_select", (e) => {
			levelEvents.push(`${e.previousLevel}->${e.level}`);
		});

		const thinkingModel = mockModel({
			id: "reasoner",
			name: "reasoner",
			thinkingLevels: ["off", "low", "high"],
		});
		const dumbModel = mockModel({
			id: "dumb-model",
			name: "dumb-model",
			thinkingLevels: ["off"],
		});

		const subject = new Subject(
			thinkingModel,
			async () => {},
			new ToolBroker(),
			{ runtimeHooks: createRuntimeHooks(host) },
		);

		// 1. 设置思考深度为 high
		subject.setThinkingLevel("high");
		expect(subject.getThinkingLevel()).toBe("high");
		expect(subject.getPreferredThinkingLevel()).toBe("high");

		// 2. 热切换到不支持思考的模型：自动 clamp 到 off
		await subject.setModel(dumbModel);
		expect(subject.getThinkingLevel()).toBe("off");
		expect(subject.getPreferredThinkingLevel()).toBe("high"); // 依然保留用户的意图

		// 3. 热切换回支持思考的模型：自动恢复到 high
		await subject.setModel(thinkingModel);
		expect(subject.getThinkingLevel()).toBe("high");
	});

	it("dispatches session_compact events and allows cancelling via session_before_compact", async () => {
		const host = new ExtensionHost();
		let cancelNext = true;
		let beforeCalled = false;
		let compactCalled = false;

		host.onHook("turn.beforeCompact", () => {
			beforeCalled = true;
			if (cancelNext) return { cancel: true };
		});
		host.on("session_compact", () => {
			compactCalled = true;
		});

		const pair = mockPair([{ kind: "text", text: "历史摘要内容" }, { kind: "finish", reason: "stop" }]);

		const subject = new Subject(
			pair.model,
			pair.stream,
			new ToolBroker(),
			{ runtimeHooks: createRuntimeHooks(host), compactor: streamCompactor(pair.stream) },
		);

		subject.addHistory([
			{ role: "user", content: "第一条" },
			{ role: "assistant", content: "回复一" },
			{ role: "user", content: "第二条" },
			{ role: "assistant", content: "回复二" },
		]);

		// 第一次：被 session_before_compact cancel 阻断
		await subject.compact();
		expect(beforeCalled).toBe(true);
		expect(compactCalled).toBe(false);

		// 第二次：允许压缩
		cancelNext = false;
		await subject.compact();
		expect(compactCalled).toBe(true);
	});

	it("在未达到压缩阈值或刚聊一句时，绝不触发 session_before_compact", async () => {
		const host = new ExtensionHost();
		let beforeCalled = false;
		host.onHook("turn.beforeCompact", () => {
			beforeCalled = true;
		});

		const pair = mockPair([{ kind: "text", text: "正常回复" }, { kind: "finish", reason: "stop" }], "mock", 128000);

		const subject = new Subject(
			pair.model,
			pair.stream,
			new ToolBroker(),
			{ runtimeHooks: createRuntimeHooks(host) },
		);

		// 发送单条消息（一问一答）
		await subject.pushInput("你好呀");
		expect(beforeCalled).toBe(false);
	});

	it("transforms context before sending request to provider", async () => {
		const host = new ExtensionHost();
		host.onHook("turn.transformContext", (messages) => {
			return {
				messages: [
					...messages,
					{ role: "user", content: "【注入感知信息: 阳光明媚】" },
				],
			};
		});

		let receivedMessages: any[] = [];
		const pair = {
			model: mockModel({ id: "mock", name: "mock" }),
			stream: async (_m: Model, req: ModelRequest, onDelta: (d: StreamDelta) => void) => {
				receivedMessages = [...req.messages];
				onDelta({ kind: "text", text: "看到了" });
				onDelta({ kind: "finish", reason: "stop" });
			},
		};

		const subject = new Subject(
			pair.model,
			pair.stream,
			new ToolBroker(),
			{ runtimeHooks: createRuntimeHooks(host) },
		);

		await subject.pushInput("你好");
		await subject.waitForIdle();

		expect(receivedMessages.some((m) => m.content?.includes("阳光明媚"))).toBe(true);
	});

	it("passes frozen snapshots to transform handlers and accepts explicit replacements only", async () => {
		const host = new ExtensionHost();
		let frozen = false;
		host.onHook("turn.transformContext", (messages) => {
			frozen = Object.isFrozen(messages) && Object.isFrozen(messages[0]!);
			return { messages: [...messages, { role: "user", content: "replacement" }] };
		});
		const hooks = createRuntimeHooks(host);
		const transformed = await hooks.turn.transformContext([{ role: "user", content: "original" }]);
		expect(frozen).toBe(true);
		expect(transformed.map((message) => message.content)).toEqual(["original", "replacement"]);
	});

	it("guards every RuntimeHooks implementation at the Subject boundary", async () => {
		let inputFrozen = false;
		let returned: Array<{ role: "user"; content: string }> | undefined;
		let contextReturned!: () => void;
		const contextReady = new Promise<void>((resolve) => { contextReturned = resolve; });
		let releaseProvider!: () => void;
		const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
		const runtimeHooks: RuntimeHooks = {
			...NO_RUNTIME_HOOKS,
			turn: {
				...NO_RUNTIME_HOOKS.turn,
				transformContext: async (messages) => {
					inputFrozen = Object.isFrozen(messages) && Object.isFrozen(messages[0]!);
					returned = [{ role: "user", content: "replacement" }];
					setTimeout(() => {
						returned?.push({ role: "user", content: "late mutation" });
						contextReturned();
					}, 0);
					return returned;
				},
			},
		};
		let received = "";
		const model = mockModel({ id: "guard-probe", name: "guard-probe" });
		const stream: ModelStreamFn = async (_m, request, emit) => {
			await providerGate;
			received = request.messages.map((message) => message.content).join("\n");
			emit({ kind: "finish", reason: "stop" });
		};
		const subject = new Subject(model, stream, new ToolBroker(), { runtimeHooks });
		const run = subject.pushInput("original");
		await contextReady;
		releaseProvider();
		await run;
		await subject.waitForIdle();
		expect(inputFrozen).toBe(true);
		expect(received).toBe("replacement");
	});

	it("emits agent_start, turn_start, turn_end, agent_end, agent_settled", async () => {
		const host = new ExtensionHost();
		const sequence: string[] = [];

		host.onHook("turn.prepare", () => { sequence.push("turn.prepare"); });
		host.on("agent_start", () => sequence.push("agent_start"));
		host.on("turn_start", () => sequence.push("turn_start"));
		host.on("turn_end", () => sequence.push("turn_end"));
		host.on("agent_end", () => sequence.push("agent_end"));
		host.on("agent_settled", () => sequence.push("agent_settled"));

		const pair = mockProvider();
		const subject = new Subject(
			pair.model,
			pair.stream,
			new ToolBroker(),
			{ runtimeHooks: createRuntimeHooks(host) },
		);

		await subject.pushInput("测试生命周期");
		await subject.waitForIdle();

		expect(sequence).toEqual([
			"turn.prepare",
			"agent_start",
			"turn_start",
			"turn_end",
			"agent_end",
			"agent_settled",
		]);
	});

	it("keeps one active run through agent_end handlers and queues input received during settlement", async () => {
		const host = new ExtensionHost();
		let releaseFirstEnd!: () => void;
		const firstEndReached = new Promise<void>((resolve) => { releaseFirstEnd = resolve; });
		let continueFirstEnd!: () => void;
		const firstEndGate = new Promise<void>((resolve) => { continueFirstEnd = resolve; });
		let ends = 0;
		host.on("agent_end", async () => {
			ends++;
			if (ends === 1) {
				releaseFirstEnd();
				await firstEndGate;
			}
		});

		const users: string[] = [];
		const model = mockModel({ id: "settlement-probe", name: "settlement-probe" });
		const stream: ModelStreamFn = async (_m, request, emit) => {
			const user = [...request.messages].reverse().find((message) => message.role === "user");
			users.push(user?.content ?? "");
			emit({ kind: "text", text: "ok" });
			emit({ kind: "finish", reason: "stop" });
		};
		const subject = new Subject(model, stream, new ToolBroker(), { runtimeHooks: createRuntimeHooks(host) });
		const firstRun = subject.pushInput("first");
		await firstEndReached;

		let idleResolved = false;
		const idle = subject.waitForIdle().then(() => { idleResolved = true; });
		await subject.pushInput("second");
		await Promise.resolve();
		expect(subject.isBusy()).toBe(true);
		expect(idleResolved).toBe(false);

		continueFirstEnd();
		await firstRun;
		await idle;
		expect(users).toEqual(["first", "second"]);
		expect(subject.isBusy()).toBe(false);
	});

	it("emits normalized output stream events (output_start, update, end)", async () => {
		const host = new ExtensionHost();
		const outputDeltas: Array<{ offset: number; text: string; channel: string }> = [];
		let startSeen = false;
		let endSeen = false;

		host.on("output_start", (e) => {
			if (e.channel === "content") startSeen = true;
		});
		host.on("output_update", (e) => {
			outputDeltas.push({ offset: e.offset, text: e.text, channel: e.channel });
		});
		host.on("output_end", (e) => {
			if (e.channel === "content") endSeen = true;
		});

		const pair = mockProvider([
			{ kind: "text", text: "哈" },
			{ kind: "text", text: "喽" },
			{ kind: "finish", reason: "stop" },
		]);

		const subject = new Subject(
			pair.model,
			pair.stream,
			new ToolBroker(),
			{ runtimeHooks: createRuntimeHooks(host) },
		);

		await subject.pushInput("打个招呼");
		await subject.waitForIdle();

		expect(startSeen).toBe(true);
		expect(endSeen).toBe(true);
		expect(outputDeltas).toEqual([
			{ offset: 1, text: "哈", channel: "content" },
			{ offset: 2, text: "喽", channel: "content" },
		]);
	});

	it("closes every opened output channel exactly once on success, error, and cancellation", async () => {
		const collect = async (pair: { model: Model; stream: ModelStreamFn }, interruptAfterStart = false): Promise<string[]> => {
			const host = new ExtensionHost();
			const events: string[] = [];
			for (const type of ["output_start", "output_update", "output_end", "output_interrupted"] as const) {
				host.on(type, (event) => {
					events.push(`${event.type}:${event.channel}${event.type === "output_interrupted" ? `:${event.reason}` : ""}`);
				});
			}
			const subject = new Subject(pair.model, pair.stream, new ToolBroker(), { runtimeHooks: createRuntimeHooks(host) });
			const run = subject.pushInput("probe");
			if (interruptAfterStart) {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				subject.interrupt();
			}
			await run;
			await subject.waitForIdle();
			return events;
		};

		const normal = await collect(mockProvider([
			{ kind: "thinking", text: "plan" },
			{ kind: "text", text: "answer" },
			{ kind: "finish", reason: "stop" },
		]));
		expect(normal).toEqual([
			"output_start:thinking",
			"output_update:thinking",
			"output_start:content",
			"output_update:content",
			"output_end:thinking",
			"output_end:content",
		]);

		const thinkingError = await collect({
			model: mockModel({ id: "thinking-error" }),
			stream: async (_m, _request, emit) => {
				emit({ kind: "thinking", text: "partial" });
				throw new Error("network lost");
			},
		});
		expect(thinkingError).toEqual([
			"output_start:thinking",
			"output_update:thinking",
			"output_interrupted:thinking:error",
		]);

		const malformedFinish = await collect({
			model: mockModel({ id: "missing-finish" }),
			stream: async (_m, _request, emit) => {
				emit({ kind: "text", text: "partial" });
			},
		});
		expect(malformedFinish).toEqual([
			"output_start:content",
			"output_update:content",
			"output_interrupted:content:error",
		]);

		const contentCancelled = await collect({
			model: mockModel({ id: "content-cancel" }),
			stream: async (_m, _request, emit, signal) => {
				emit({ kind: "text", text: "partial" });
				await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
			},
		}, true);
		expect(contentCancelled).toEqual([
			"output_start:content",
			"output_update:content",
			"output_interrupted:content:cancelled",
		]);
	});

	it("intercepts HTTP requests at provider network level (before_provider_headers, before_provider_request, after_provider_response)", async () => {
		const host = new ExtensionHost();

		host.onHook("provider.transformHeaders", (input) => ({ headers: { ...input.headers, "X-Custom-Tenant": "tenant-123" } }));
		host.onHook("provider.transformPayload", (input) => {
			return { payload: { ...(input.payload as Record<string, unknown>), custom_tag: "injected" } };
		});

		let afterResponseStatus = 0;
		host.onHook("provider.observeResponse", (input) => {
			afterResponseStatus = input.status;
		});

		let receivedHeaders: Record<string, string> = {};
		let receivedBody = "";

		const server = createServer((req, res) => {
			receivedHeaders = req.headers as Record<string, string>;
			req.on("data", (chunk) => {
				receivedBody += chunk;
			});
			req.on("end", () => {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
				res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
				res.write("data: [DONE]\n\n");
				res.end();
			});
		});

		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const port = (server.address() as any).port;

		const provider = createOpenAIProvider("openai", {
			baseUrl: `http://127.0.0.1:${port}`,
			apiKey: "test-key",
		});

		const model: Model = {
			id: "mock-llm",
			name: "mock-llm",
			providerId: "openai",
			contextWindow: 4096,
		};

		let textOut = "";
		await provider.stream(
			model,
			{
				messages: [{ role: "user", content: "hello" }],
				providerHooks: createRuntimeHooks(host).provider,
			},
			(delta) => {
				if (delta.kind === "text") textOut += delta.text;
			},
		);

		server.close();

		expect(textOut).toBe("ok");
		expect(receivedHeaders["x-custom-tenant"]).toBe("tenant-123");
		expect(JSON.parse(receivedBody).custom_tag).toBe("injected");
		expect(afterResponseStatus).toBe(200);
	});

});

describe("run-safety seams: prepare model swap and shouldStop", () => {
	it("applies a model fact returned from before_agent_start with full setModel discipline", async () => {
		const host = new ExtensionHost();
		const baseModel = mockModel({ id: "base-model", name: "base" });
		const nextModel = mockModel({ id: "next-model", name: "next" });
		const events: string[] = [];
		host.onHook("turn.prepare", () => ({ model: structuredClone(nextModel) }));
		host.on("model_select", (event) => events.push(`model_select:${event.model}`));

		const requested: string[] = [];
		const stream: ModelStreamFn = async (model, _req, emit) => {
			requested.push(model.id);
			emit({ kind: "text", text: "ok" });
			emit({ kind: "finish", reason: "stop" });
		};
		const subject = new Subject(baseModel, stream, new ToolBroker(), { runtimeHooks: createRuntimeHooks(host) });
		await subject.pushInput("hello");
		await subject.waitForIdle();

		expect(requested).toEqual(["next-model"]);
		expect(subject.getModel().id).toBe("next-model");
		expect(events).toEqual(["model_select:next"]);
	});

	it("stops the tool loop between turns when an extension returns stop", async () => {
		const host = new ExtensionHost();
		host.onHook("turn.shouldStop", (input) => {
			expect(input.finishReason).toBe("tool_calls");
			expect(input.toolCallCount).toBe(1);
			return { stop: true };
		});
		let streamCalls = 0;
		const stream: ModelStreamFn = async (_model, _req, emit, signal) => {
			streamCalls++;
			if (streamCalls > 1) throw new Error("shouldStop 未生效：发起了第二次模型调用");
			emit({ kind: "tool_call", call: { id: "t1", name: "noop", args: "{}" } });
			emit({ kind: "finish", reason: "tool_calls" });
			void signal;
		};
		const broker = new ToolBroker();
		broker.register({
			def: { type: "function", function: { name: "noop", description: "noop", parameters: { type: "object", properties: {}, additionalProperties: false } } },
			run: async () => ({ result: "ok", status: "succeeded" as const }),
		});
		const subject = new Subject(mockModel(), stream, broker, { runtimeHooks: createRuntimeHooks(host) });
		await subject.pushInput("run tool once");
		await subject.waitForIdle();

		expect(streamCalls).toBe(1);
		const toolResult = subject.historySnapshot().find((message) => message.role === "tool");
		expect(toolResult && "status" in toolResult ? toolResult.status : undefined).toBe("succeeded");
	});
});
