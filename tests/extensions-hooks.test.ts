import { describe, it, expect } from "vitest";
import { ExtensionHost } from "../src/extensions/host.js";
import { createRuntimeHooks } from "../src/extensions/runtime-hooks.js";
import type { RuntimeHooks } from "../src/runtime/hooks.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";
import { Subject } from "../src/agent/loop.js";
import { ToolBroker } from "../src/tools/broker.js";
import type { ModelProvider, ModelRequest, StreamDelta } from "../src/core/types.js";
import { createOpenAIProvider } from "../src/ai/gateway.js";
import { createServer } from "node:http";

function mockProvider(deltas: StreamDelta[] = [{ kind: "text", text: "你好" }, { kind: "finish", reason: "stop" }]): ModelProvider {
	return {
		name: "mock-model",
		contextWindow: 4096,
		thinkingLevels: ["off", "low", "high"],
		async stream(_req: ModelRequest, onDelta: (d: StreamDelta) => void) {
			for (const delta of deltas) {
				onDelta(delta);
			}
		},
	};
}

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

		host.on("tool_call", (event) => {
			if (event.toolName === "dangerous_tool") {
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
				return "executed";
			},
		});

		const provider: ModelProvider = {
			name: "mock",
			async stream(req, onDelta) {
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
		const subject = new Subject(
			provider,
			tools,
			{
				onToken: () => {},
				onToolDone: (name, result, status) => toolDones.push({ name, result, status }),
			},
			{ runtimeHooks: createRuntimeHooks(host) },
		);

		await subject.pushInput("请运行危险工具");
		await subject.waitForIdle();

		expect(toolActuallyExecuted).toBe(false);
		expect(toolDones.some((d) => d.name === "dangerous_tool" && d.status === "failed")).toBe(true);
		const history = subject.historySnapshot();
		const toolResultMsg = history.find((m) => m.role === "tool");
		expect(toolResultMsg?.content).toContain("[blocked] 工具执行已被拦截: 安全策略拦截高危工具");
	});

	it("transforms tool_result after tool finishes execution", async () => {
		const host = new ExtensionHost();

		host.on("tool_result", (event) => {
			if (event.toolName === "calc") {
				return { result: `[AUDITED] ${event.result}` };
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
				return "42";
			},
		});

		const provider: ModelProvider = {
			name: "mock",
			async stream(req, onDelta) {
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
			provider,
			tools,
			{ onToken: () => {} },
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
		const prov2: ModelProvider = {
			name: "deepseek-reasoner",
			contextWindow: 65536,
			thinkingLevels: ["off", "high"],
			async stream(_req, onDelta) {
				onDelta({ kind: "text", text: "切换成功" });
				onDelta({ kind: "finish", reason: "stop" });
			},
		};

		const subject = new Subject(
			prov1,
			new ToolBroker(),
			{ onToken: () => {} },
			{ runtimeHooks: createRuntimeHooks(host) },
		);

		expect(subject.getModel().name).toBe("mock-model");
		await subject.setModel(prov2);

		expect(subject.getModel().name).toBe("deepseek-reasoner");
		expect(modelSelects).toEqual(["deepseek-reasoner"]);
	});

	it("clamps thinkingLevel adaptively to model capabilities and recovers", async () => {
		const host = new ExtensionHost();
		const levelEvents: string[] = [];
		host.on("thinking_level_select", (e) => {
			levelEvents.push(`${e.previousLevel}->${e.level}`);
		});

		const thinkingModel: ModelProvider = {
			name: "reasoner",
			thinkingLevels: ["off", "low", "high"],
			async stream() {},
		};
		const dumbModel: ModelProvider = {
			name: "dumb-model",
			thinkingLevels: ["off"],
			async stream() {},
		};

		const subject = new Subject(
			thinkingModel,
			new ToolBroker(),
			{ onToken: () => {} },
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

		host.on("session_before_compact", () => {
			beforeCalled = true;
			if (cancelNext) return { cancel: true };
		});
		host.on("session_compact", () => {
			compactCalled = true;
		});

		const provider: ModelProvider = {
			name: "mock",
			async stream(_req, onDelta) {
				onDelta({ kind: "text", text: "历史摘要内容" });
				onDelta({ kind: "finish", reason: "stop" });
			},
		};

		const subject = new Subject(
			provider,
			new ToolBroker(),
			{ onToken: () => {} },
			{ runtimeHooks: createRuntimeHooks(host) },
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

	it("transforms context before sending request to provider", async () => {
		const host = new ExtensionHost();
		host.on("context", (e) => {
			return {
				messages: [
					...e.messages,
					{ role: "user", content: "【注入感知信息: 阳光明媚】" },
				],
			};
		});

		let receivedMessages: any[] = [];
		const provider: ModelProvider = {
			name: "mock",
			async stream(req, onDelta) {
				receivedMessages = [...req.messages];
				onDelta({ kind: "text", text: "看到了" });
				onDelta({ kind: "finish", reason: "stop" });
			},
		};

		const subject = new Subject(
			provider,
			new ToolBroker(),
			{ onToken: () => {} },
			{ runtimeHooks: createRuntimeHooks(host) },
		);

		await subject.pushInput("你好");
		await subject.waitForIdle();

		expect(receivedMessages.some((m) => m.content?.includes("阳光明媚"))).toBe(true);
	});

	it("passes frozen snapshots to transform handlers and accepts explicit replacements only", async () => {
		const host = new ExtensionHost();
		let frozen = false;
		host.on("context", (event) => {
			frozen = Object.isFrozen(event) && Object.isFrozen(event.messages) && Object.isFrozen(event.messages[0]!);
			return { messages: [...event.messages, { role: "user", content: "replacement" }] };
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
		const provider: ModelProvider = {
			name: "guard-probe",
			async stream(request, emit) {
				await providerGate;
				received = request.messages.map((message) => message.content).join("\n");
				emit({ kind: "finish", reason: "stop" });
			},
		};
		const subject = new Subject(provider, new ToolBroker(), { onToken: () => {} }, { runtimeHooks });
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

		host.on("before_agent_start", () => sequence.push("before_agent_start"));
		host.on("agent_start", () => sequence.push("agent_start"));
		host.on("turn_start", () => sequence.push("turn_start"));
		host.on("turn_end", () => sequence.push("turn_end"));
		host.on("agent_end", () => sequence.push("agent_end"));
		host.on("agent_settled", () => sequence.push("agent_settled"));

		const subject = new Subject(
			mockProvider(),
			new ToolBroker(),
			{ onToken: () => {} },
			{ runtimeHooks: createRuntimeHooks(host) },
		);

		await subject.pushInput("测试生命周期");
		await subject.waitForIdle();

		expect(sequence).toEqual([
			"before_agent_start",
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
		const provider: ModelProvider = {
			name: "settlement-probe",
			async stream(request, emit) {
				const user = [...request.messages].reverse().find((message) => message.role === "user");
				users.push(user?.content ?? "");
				emit({ kind: "text", text: "ok" });
				emit({ kind: "finish", reason: "stop" });
			},
		};
		const subject = new Subject(provider, new ToolBroker(), { onToken: () => {} }, { runtimeHooks: createRuntimeHooks(host) });
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

		const provider = mockProvider([
			{ kind: "text", text: "哈" },
			{ kind: "text", text: "喽" },
			{ kind: "finish", reason: "stop" },
		]);

		const subject = new Subject(
			provider,
			new ToolBroker(),
			{ onToken: () => {} },
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
		const collect = async (provider: ModelProvider, interruptAfterStart = false): Promise<string[]> => {
			const host = new ExtensionHost();
			const events: string[] = [];
			for (const type of ["output_start", "output_update", "output_end", "output_interrupted"] as const) {
				host.on(type, (event) => {
					events.push(`${event.type}:${event.channel}${event.type === "output_interrupted" ? `:${event.reason}` : ""}`);
				});
			}
			const subject = new Subject(provider, new ToolBroker(), { onToken: () => {} }, { runtimeHooks: createRuntimeHooks(host) });
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
			name: "thinking-error",
			async stream(_request, emit) {
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
			name: "missing-finish",
			async stream(_request, emit) {
				emit({ kind: "text", text: "partial" });
			},
		});
		expect(malformedFinish).toEqual([
			"output_start:content",
			"output_update:content",
			"output_interrupted:content:error",
		]);

		const contentCancelled = await collect({
			name: "content-cancel",
			async stream(_request, emit, signal) {
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

		host.on("before_provider_headers", (e) => ({ headers: { ...e.headers, "X-Custom-Tenant": "tenant-123" } }));
		host.on("before_provider_request", (e) => {
			return { ...(e.payload as Record<string, unknown>), custom_tag: "injected" };
		});

		let afterResponseStatus = 0;
		host.on("after_provider_response", (e) => {
			afterResponseStatus = e.status;
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

		const provider = createOpenAIProvider({
			baseUrl: `http://127.0.0.1:${port}`,
			apiKey: "test-key",
			model: "mock-llm",
			modelContextWindow: 4096,
		});

		let textOut = "";
		await provider.stream(
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
