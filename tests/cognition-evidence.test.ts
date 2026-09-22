/**
 * 认知扩展阶段 D / M7（收窄版）：执行证据正文保全。
 *
 * 不变量（plan §7 / design §13）：权威执行结果进 canonical 历史；
 * 模型可见变换（transformResult 的 result 改写）不能改变 journal 中的原始正文。
 * 287bb27 已把 status 覆盖退出事实路径（warnIgnoredToolStatus）；本阶段补齐正文：
 * - onDone 观测点（journal tool_finished + tool_result 派发）收到原始执行正文；
 * - executeToolPipeline 返回值（模型可见/调用方返回）仍是改写后的投影。
 */
import { describe, expect, test } from "vitest";
import { ToolBroker } from "../src/tools/broker.js";
import { executeToolPipeline } from "../src/tools/pipeline.js";
import { mockTool } from "./harness/index.js";

describe("M7 执行证据正文保全", () => {
	test("transformResult 改写正文后，onDone 收到原始执行正文（journal 权威），返回值为改写投影", async () => {
		const broker = new ToolBroker();
		broker.register(mockTool("echo_tool", async (args) => ({ result: `echo:${String(args.msg)}`, status: "succeeded" }), {
			description: "回显输入",
			parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"], additionalProperties: false },
		}));

		let observedInOnDone: { result: string; status: string } | undefined;
		const outcome = await executeToolPipeline(
			broker,
			{ callId: "c-1", name: "echo_tool", args: { msg: "hello" } },
			{
				hooks: {
					transformResult: async (input) => ({ result: `[AUDITED] ${input.result}` }),
				},
				observers: {
					onDone: (res) => {
						observedInOnDone = { result: res.result, status: res.status };
					},
				},
			},
		);

		// journal 权威事实：原始正文 + 原始 status。
		expect(observedInOnDone).toEqual({ result: "echo:hello", status: "succeeded" });
		// 模型可见投影：改写生效。
		expect(outcome.result).toBe("[AUDITED] echo:hello");
	});

	test("无 transformResult 时 onDone 与返回值一致（无改写零差异）", async () => {
		const broker = new ToolBroker();
		broker.register(mockTool("plain_tool", async () => ({ result: "raw", status: "succeeded" }), {
			description: "普通工具",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		}));

		const seen: string[] = [];
		const outcome = await executeToolPipeline(
			broker,
			{ callId: "c-2", name: "plain_tool", args: {} },
			{ observers: { onDone: (res) => { seen.push(res.result); } } },
		);
		expect(seen).toEqual(["raw"]);
		expect(outcome.result).toBe("raw");
	});

	test("hook 抛异常时 onDone 收到原始结果（钩子异常不丢已执行事实）", async () => {
		const broker = new ToolBroker();
		broker.register(mockTool("crash_hook", async () => ({ result: "real", status: "succeeded" }), {
			description: "hook 崩溃",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		}));
		const seen: string[] = [];
		await executeToolPipeline(
			broker,
			{ callId: "c-3", name: "crash_hook", args: {} },
			{
				hooks: { transformResult: async () => { throw new Error("hook 崩溃"); } },
				observers: { onDone: (res) => { seen.push(res.result); } },
			},
		);
		expect(seen).toEqual(["real"]);
	});
});
