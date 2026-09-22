import { describe, expect, test, mockTool } from "./harness/index.js";
import { vi } from "vitest";
import { ToolBroker } from "../src/tools/broker.js";
import { executeToolPipeline } from "../src/tools/pipeline.js";
import type { ToolResultStatus } from "../src/core/types.js";

describe("Tool Execution Pipeline", () => {
	function createTestBroker() {
		const broker = new ToolBroker();
		broker.register(mockTool("echo_tool", async (args) => ({ result: `echo:${String(args.msg)}`, status: "succeeded" }), {
			description: "回显输入",
			parameters: {
				type: "object",
				properties: {
					msg: { type: "string" },
				},
				required: ["msg"],
				additionalProperties: false,
			},
		}));
		return broker;
	}

	test("executes the full pipeline in order: beforeCall -> onStart -> run -> transformResult -> onDone", async () => {
		const broker = createTestBroker();
		const trace: string[] = [];

		const outcome = await executeToolPipeline(
			broker,
			{ callId: "c-1", name: "echo_tool", args: { msg: "hello" } },
			{
				hooks: {
					beforeCall: async (input) => {
						trace.push(`beforeCall:${input.callId}:${input.name}`);
						return {};
					},
					transformResult: async (input) => {
						trace.push(`transformResult:${input.callId}:${input.result}`);
						return { result: `[AUDITED] ${input.result}` };
					},
				},
				observers: {
					onStart: (call) => {
						trace.push(`onStart:${call.callId}`);
					},
					onDone: (res, call) => {
						trace.push(`onDone:${call.callId}:${res.status}:${res.result}`);
					},
				},
			},
		);

		expect(trace).toEqual([
			"beforeCall:c-1:echo_tool",
			"onStart:c-1",
			"transformResult:c-1:echo:hello",
			// 阶段 D/M7：onDone（journal 权威事实）拿原始正文；改写只作用于返回值投影。
			"onDone:c-1:succeeded:echo:hello",
		]);
		expect(outcome.status).toBe("succeeded");
		expect(outcome.result).toBe("[AUDITED] echo:hello");
		// 阶段 D/M7：返回值携带 canonical（原始执行结果）供 journal 落盘。
		expect(outcome.canonical).toBeDefined();
		expect(outcome.canonical!.result).toBe("echo:hello");
	});

	test("drops contribution status so execution facts cannot be rewritten (failed stays failed)", async () => {
		const broker = new ToolBroker();
		broker.register(mockTool("fail_tool", async () => ({ result: "boom", status: "failed" }), { description: "失败工具" }));

		const outcome = await executeToolPipeline(
			broker,
			{ callId: "c-fail", name: "fail_tool", args: {} },
			{
				hooks: {
					// 模拟 JS 扩展无视类型合同返回 status：流水线必须丢弃，result/details 改写仍生效
					transformResult: async (input) => ({ result: `[SPUN] ${input.result}`, status: "succeeded" } as never),
				},
			},
		);
		expect(outcome.status).toBe("failed");
		expect(outcome.result).toBe("[SPUN] boom");
	});

	test("drops contribution status on succeeded outcomes too", async () => {
		const broker = createTestBroker();

		const outcome = await executeToolPipeline(
			broker,
			{ callId: "c-ok", name: "echo_tool", args: { msg: "keep" } },
			{
				hooks: {
					transformResult: async (input) => ({ result: `[AUDITED] ${input.result}`, status: "cancelled" } as never),
				},
			},
		);
		expect(outcome.status).toBe("succeeded");
		expect(outcome.result).toBe("[AUDITED] echo:keep");
	});

	test("short-circuits when signal is already aborted before start", async () => {
		const broker = createTestBroker();
		const trace: string[] = [];
		const controller = new AbortController();
		controller.abort();

		const outcome = await executeToolPipeline(
			broker,
			{ callId: "c-abort", name: "echo_tool", args: { msg: "hello" } },
			{
				signal: controller.signal,
				hooks: {
					beforeCall: async () => {
						trace.push("beforeCall");
						return {};
					},
				},
				observers: {
					onStart: () => {
						trace.push("onStart");
					},
					onDone: (res) => {
						trace.push(`onDone:${res.status}`);
					},
				},
			},
		);

		expect(trace).toEqual(["onDone:not_started"]);
		expect(outcome.status).toBe("not_started");
		expect(outcome.result).toContain("工具调用未启动");
	});

	test("short-circuits when beforeCall blocks execution", async () => {
		const broker = createTestBroker();
		const trace: string[] = [];

		const outcome = await executeToolPipeline(
			broker,
			{ callId: "c-block", name: "echo_tool", args: { msg: "forbidden" } },
			{
				hooks: {
					beforeCall: async () => {
						trace.push("beforeCall");
						return { block: true, reason: "安全策略拒绝执行" };
					},
					transformResult: async () => {
						trace.push("transformResult");
						return {};
					},
				},
				observers: {
					onStart: () => {
						trace.push("onStart");
					},
					onDone: (res) => {
						trace.push(`onDone:${res.status}:${res.result}`);
					},
				},
			},
		);

		expect(trace).toEqual([
			"beforeCall",
			"onDone:not_started:[blocked] 工具执行已被拦截: 安全策略拒绝执行",
		]);
		expect(outcome.status).toBe("not_started");
		expect(outcome.result).toBe("[blocked] 工具执行已被拦截: 安全策略拒绝执行");
	});

	test("handles schema validation errors without invoking transformResult or onStart", async () => {
		const broker = createTestBroker();
		const trace: string[] = [];

		const outcome = await executeToolPipeline(
			broker,
			{ callId: "c-invalid", name: "echo_tool", args: { msg: 12345 } }, // msg 必须为 string
			{
				hooks: {
					beforeCall: async () => {
						trace.push("beforeCall");
						return {};
					},
					transformResult: async () => {
						trace.push("transformResult");
						return {};
					},
				},
				observers: {
					onStart: () => {
						trace.push("onStart");
					},
					onDone: (res) => {
						trace.push(`onDone:${res.status}`);
					},
				},
			},
		);

		expect(trace).toEqual([
			"beforeCall",
			"onDone:not_started",
		]);
		expect(outcome.status).toBe("not_started");
		expect(outcome.result).toContain("参数校验失败");
	});

	test("records onStart and closes with status unknown if cancelled during execution", async () => {
		const broker = new ToolBroker();
		const controller = new AbortController();
		const trace: string[] = [];

		broker.register(mockTool("hanging_tool", async (_args, signal) => {
			return new Promise((_resolve, reject) => {
				// 已经在执行中触发中断
				controller.abort();
				if (signal?.aborted) {
					reject(new Error("aborted"));
				} else {
					signal?.addEventListener("abort", () => {
						reject(new Error("aborted"));
					});
				}
			});
		}, { description: "等待取消" }));

		const pipelinePromise = executeToolPipeline(
			broker,
			{ callId: "c-hang", name: "hanging_tool", args: {} },
			{
				signal: controller.signal,
				observers: {
					onStart: () => {
						trace.push("onStart");
					},
					onDone: (res) => {
						trace.push(`onDone:${res.status}`);
					},
				},
			},
		);

		const outcome = await pipelinePromise;
		expect(trace).toEqual(["onStart", "onDone:unknown"]);
		expect(outcome.status).toBe("unknown");
	});

	test("preserves continuation stop from tool outcome", async () => {
		const broker = new ToolBroker();
		broker.register(mockTool("stopper", async () => {
			return { result: "done", status: "succeeded" as ToolResultStatus, continuation: "stop" };
		}, { description: "请求中断决策" }));

		const outcome = await broker.executePipeline(
			{ callId: "c-stop", name: "stopper", args: {} },
		);

		expect(outcome.continuation).toBe("stop");
		expect(outcome.status).toBe("succeeded");
	});

	test("executes tools directly through Host.runToolDirect with extension hooks and no model history", async ({ uina, env }) => {
		await env.writeExtension(
			"probe.mjs",
			`
export default function activate(uina) {
  uina.registerTool({
    def: {
      type: "function",
      function: {
        name: "host_direct_probe",
        description: "直通测试",
        parameters: { type: "object", properties: { val: { type: "string" } }, required: ["val"], additionalProperties: false },
      },
    },
    async run(args) { return { result: "pong:" + args.val, status: "succeeded" }; },
  });
  uina.onHook("tools.transformResult", (input) => {
    if (input.name === "host_direct_probe") {
      return { result: "[HOOKED] " + input.result };
    }
  });
}
`,
		);
		await uina.start();

		const res = await uina.callTool("host_direct_probe", { val: "test123" });
		expect(res.status).toBe("succeeded");
		expect(res.result).toBe("[HOOKED] pong:test123");
		// 验证没有写入模型会话历史
		expect(uina.history).toHaveLength(0);
		expect(uina).toHaveNoLeakedResources();
	});
	test("warns when a contribution carries only status and does not flip the execution result", async () => {
		const broker = new ToolBroker();
		broker.register(mockTool("fail_tool", async () => ({ result: "boom", status: "failed" }), { description: "失败工具" }));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const outcome = await executeToolPipeline(
				broker,
				{ callId: "c-status", name: "fail_tool", args: {} },
				{ hooks: { transformResult: async () => ({ status: "succeeded" } as never) } },
			);
			expect(outcome.status).toBe("failed");
			expect(outcome.result).toBe("boom");
			expect(warn.mock.calls.some(call => String(call[0]).includes("status"))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

});
