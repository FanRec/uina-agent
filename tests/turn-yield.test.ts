import type { Tool, ToolExecutionResult } from "../src/tools/broker.js";
import { describe, expect, SubjectHarness, test } from "./harness/index.js";
import { Scenario } from "./harness/provider/scenario.js";

/**
 * `continuation: "yield"` 的唯一判据：这批工具结果进 canonical 之后，
 * 仅凭它们不需要再问模型一次。整批都这么声明才让出，混进任何要看的结果都照常推理。
 */

function tool(name: string, result: Partial<ToolExecutionResult> = {}): Tool {
	return {
		def: {
			type: "function",
			function: {
				name,
				description: name,
				parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
			},
		},
		run: async () => ({ result: `${name}: ok`, status: "succeeded", ...result }),
	};
}

function callTools(...names: string[]) {
	return [
		...names.map((name, index) => ({
			kind: "tool_call" as const,
			call: { id: `call-${index}`, name, args: "{}", argsValid: true },
		})),
		{ kind: "finish" as const, reason: "tool_calls" as const },
	];
}

/** 第一轮发工具调用，之后（如果有下一次请求）走文本兜底。 */
function harnessWith(tools: Tool[], ...names: string[]): SubjectHarness {
	const scenario = new Scenario();
	scenario.when((req) => !req.messages.some((message) => message.role === "tool")).then(() => callTools(...names));
	scenario.fallback(() => [
		{ kind: "text", text: "继续" },
		{ kind: "finish", reason: "stop" },
	]);
	return SubjectHarness.create({ scenario, tools });
}

describe("工具批次的让出判据", () => {
	test("单个可让出的结果：落盘后结束本轮，不再发一次模型请求", async () => {
		const harness = harnessWith([tool("mine", { continuation: "yield" })], "mine");
		await harness.run("开始挖矿");
		expect(harness.scenario.calls.length).toBe(1);
		const toolMessages = harness.history.filter((message) => message.role === "tool");
		expect(toolMessages).toHaveLength(1);
	});

	test("整批都是可让出的结果：各自落盘，只让出一次", async () => {
		const harness = harnessWith(
			[tool("mine", { continuation: "yield" }), tool("collect", { continuation: "yield" })],
			"mine",
			"collect",
		);
		await harness.run("两个一起提交");
		expect(harness.scenario.calls.length).toBe(1);
		expect(harness.history.filter((message) => message.role === "tool")).toHaveLength(2);
	});

	test("可让出 + 普通结果：继续推理，让模型先看读到的内容", async () => {
		const harness = harnessWith([tool("mine", { continuation: "yield" }), tool("observe")], "mine", "observe");
		await harness.run("提交并看一眼");
		expect(harness.scenario.calls.length).toBe(2);
	});

	test("可让出 + 失败结果：继续推理，不把失败藏起来", async () => {
		const harness = harnessWith(
			[tool("mine", { continuation: "yield" }), tool("collect", { status: "failed" })],
			"mine",
			"collect",
		);
		await harness.run("一个成功一个失败");
		expect(harness.scenario.calls.length).toBe(2);
	});

	test("stop 与 yield 同批：stop 优先，语义不变", async () => {
		const harness = harnessWith(
			[tool("mine", { continuation: "stop" }), tool("collect", { continuation: "yield" })],
			"mine",
			"collect",
		);
		await harness.run("混合");
		expect(harness.scenario.calls.length).toBe(1);
	});

	test('没有任何工具结果：不当成"全部可让出"', async () => {
		const scenario = new Scenario();
		scenario.fallback(() => [
			{ kind: "text", text: "直接回答" },
			{ kind: "finish", reason: "stop" },
		]);
		const harness = SubjectHarness.create({ scenario });
		await harness.run("聊一句");
		expect(harness.scenario.calls.length).toBe(1);
		expect(harness.history.filter((message) => message.role === "tool")).toHaveLength(0);
	});

	test("让出是通用合同，不靠工具名字：任意工具声明都生效", async () => {
		// 名字与 Minecraft 无关：语义来自结果字段，不来自注册表里的领域判断。
		const harness = harnessWith([tool("schedule_reminder", { continuation: "yield" })], "schedule_reminder");
		await harness.run("设个提醒");
		expect(harness.scenario.calls.length).toBe(1);
	});
});
