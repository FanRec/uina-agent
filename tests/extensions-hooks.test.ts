import { describe, it, expect } from "vitest";
import { ExtensionHost } from "../src/extensions/host.js";
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

		const notices: string[] = [];
		const subject = new Subject(
			provider,
			tools,
			{
				onToken: () => {},
				onNotice: (msg) => notices.push(msg),
			},
			{ extensionHost: host },
		);

		await subject.pushInput("请运行危险工具");
		await subject.waitForIdle();

		expect(toolActuallyExecuted).toBe(false);
		expect(notices.some((n) => n.includes("安全策略拦截高危工具"))).toBe(true);
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
			{ extensionHost: host },
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
			{ extensionHost: host },
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
			{ extensionHost: host },
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
			{ extensionHost: host },
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
			{ extensionHost: host },
		);

		await subject.pushInput("你好");
		await subject.waitForIdle();

		expect(receivedMessages.some((m) => m.content?.includes("阳光明媚"))).toBe(true);
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
			{ extensionHost: host },
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
			{ extensionHost: host },
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

	it("intercepts HTTP requests at provider network level (before_provider_headers, before_provider_request, after_provider_response)", async () => {
		const host = new ExtensionHost();

		host.on("before_provider_headers", (e) => {
			e.headers["X-Custom-Tenant"] = "tenant-123";
		});
		host.on("before_provider_request", (e) => {
			const payload = e.payload as Record<string, unknown>;
			payload.custom_tag = "injected";
			return payload;
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
		});

		let textOut = "";
		await provider.stream(
			{
				messages: [{ role: "user", content: "hello" }],
				extensionHost: host,
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

	it("discovers external resources via resources_discover and registers tools dynamically", async () => {
		const host = new ExtensionHost();
		const testToolFile = "tests/fixtures/discovered-tool.js";
		const fs = await import("node:fs");
		const path = await import("node:path");

		fs.mkdirSync("tests/fixtures", { recursive: true });
		fs.writeFileSync(
			testToolFile,
			`export default {
				def: {
					type: "function",
					function: {
						name: "dynamically_discovered_tool",
						description: "由扩展动态发现加载的工具",
						parameters: { type: "object", properties: {} },
					},
				},
				async run() { return "discovered_ok"; },
			};`,
		);

		host.on("resources_discover", () => {
			return {
				toolPaths: [path.resolve(testToolFile)],
			};
		});

		const discovered = await host.emitResourcesDiscover(process.cwd(), "startup");
		expect(discovered.toolPaths?.length).toBe(1);

		const { loadToolsFromPaths } = await import("../src/tools/loader.js");
		const broker = new ToolBroker();
		const result = await loadToolsFromPaths(discovered.toolPaths!, broker);

		expect(result.loaded).toBe(1);
		expect(broker.has("dynamically_discovered_tool")).toBe(true);

		// 清理临时文件
		fs.unlinkSync(testToolFile);
		fs.rmdirSync("tests/fixtures");
	});
});
