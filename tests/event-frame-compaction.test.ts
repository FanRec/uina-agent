import { describe, expect, it } from "vitest";
import { estimateRequestTokens } from "../src/agent/context.js";
import { requestToolDefs } from "../src/agent/projection.js";
import { DEFAULT_OUTPUT_RESERVE_TOKENS, inputTokenBudget } from "../src/core/model.js";
import activateCompaction, { estimateStreamTokens } from "../src/extensions/compaction/index.js";
import { createEventFrameProfile } from "../src/extensions/event-frames/index.js";
import { EVENT_FRAME_TOOL } from "../src/extensions/event-frames/protocol.js";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import { ToolBroker } from "../src/tools/broker.js";
import { Scenario } from "./harness/provider/scenario.js";

const p = createEventFrameProfile().projection;
const projection = (messages: readonly import("../src/core/types.js").ChatMsg[]) => ({
	projectionId: "test",
	modelKey: "test",
	messages,
	tools: [],
});
/** 一条外部输入在真实投影里的形状：前面已有对话消息时是一对合成调用与回执。 */
const frame = (id: string, text: string) =>
	p.convertToLlm!([
		{
			role: "user",
			id: `${id}-op`,
			content: "op",
			input: { eventId: `${id}-op`, source: { kind: "user", type: "operator", origin: "external" } },
		},
		{
			role: "user",
			id,
			content: text,
			input: { eventId: id, source: { kind: "user", type: "terminal", origin: "external" } },
		},
	]).slice(1);
describe("event frame compaction", () => {
	it("keeps the newest frame and summarizes complete old frames as external evidence", async () => {
		const store = new MemorySessionStore();
		await store.appendMessage({ role: "user", id: "e1", content: "OLD ".repeat(1600) }, "e1");
		await store.appendMessage({ role: "user", id: "e2", content: "current request" }, "e2");
		const scenario = Scenario.create({ contextWindow: 2400 }).reply("旧发言来自外界，尚未核验。");
		const runner = new ExtensionRunner({
			cwd: process.cwd(),
			tools: new ToolBroker(),
			history: () => store.state.entries,
			auxiliary: () => store.state.auxiliary,
			onCustomEntry: (e) => store.appendCustomEntry(e),
			emitRuntimeEvent: async () => {},
			models: {
				current: () => scenario.model,
				list: () => [scenario.model],
				groups: () => [],
				resolve: () => scenario.model,
				select: async () => {},
				stream: scenario.stream,
			},
		});
		await runner.activateBuiltin("compaction", activateCompaction);
		const input = [
			{ role: "system" as const, content: "system" },
			...frame("e1", "OLD ".repeat(1600)),
			...frame("e2", "current request"),
		];
		const base = projection(input);
		const first = await runner.runTransformContext(base);
		const measurement = {
			inputTokens: estimateRequestTokens(first.messages, first.tools),
			kind: "approximate" as const,
			source: "test",
		};
		const decision = await runner.runPreflight({
			projection: first,
			measurement,
			pass: 0,
			signal: new AbortController().signal,
		});
		expect(decision.action).toBe("rebuild");
		const out = (await runner.runTransformContext(base)).messages;
		expect(() => p.validateContext!(out, { model: scenario.model, tools: [EVENT_FRAME_TOOL] })).not.toThrow();
		expect(out.some((m) => m.content.startsWith("[历史摘要]"))).toBe(true);
		expect(out.some((m) => m.context?.input?.eventId === "e1")).toBe(false);
		expect(out.some((m) => m.context?.input?.eventId === "e2")).toBe(true);
		expect(scenario.calls.length).toBeGreaterThanOrEqual(1);
		const summaryInput = scenario.calls[0]!.messages.at(-1)!.content;
		// 摘要输入只看正文与来源标签：eventId 这类程序追踪用的身份不进摘要，也不会被复述成事实。
		expect(summaryInput).toContain("[外部发言]");
		expect(summaryInput).not.toContain("eventId");
		expect(summaryInput).not.toContain("调用工具 external_event_frame");
		await runner.dispose();
	});
	it("leaves an exact-fit history alone until context-tool schema spends the budget", async () => {
		const text = "x".repeat(70_000);
		const messages = [
			{ role: "user" as const, content: text, context: { entryId: "old" } },
			{ role: "user" as const, content: "current", context: { entryId: "current", retain: true } },
		];
		const tokensBefore = estimateStreamTokens(messages);
		expect(tokensBefore).toBeGreaterThan(DEFAULT_OUTPUT_RESERVE_TOKENS);
		const window = tokensBefore + DEFAULT_OUTPUT_RESERVE_TOKENS;
		expect(inputTokenBudget({ contextWindow: window })).toBe(tokensBefore);
		const open = async () => {
			const store = new MemorySessionStore();
			await store.appendMessage({ role: "user", id: "old", content: text }, "old");
			await store.appendMessage({ role: "user", id: "current", content: "current" }, "current");
			const scenario = Scenario.create({ contextWindow: window }).reply("已压缩。");
			const runner = new ExtensionRunner({
				cwd: process.cwd(),
				tools: new ToolBroker(),
				history: () => store.state.entries,
				auxiliary: () => store.state.auxiliary,
				onCustomEntry: (entry) => store.appendCustomEntry(entry),
				emitRuntimeEvent: async () => {},
				models: {
					current: () => scenario.model,
					list: () => [scenario.model],
					groups: () => [],
					resolve: () => scenario.model,
					select: async () => {},
					stream: scenario.stream,
				},
			});
			await runner.activateBuiltin("compaction", activateCompaction);
			return { runner, scenario };
		};
		const plain = await open();
		try {
			const plainBase = projection(messages);
			const plainFirst = await plain.runner.runTransformContext(plainBase);
			const plainMeasurement = {
				inputTokens: inputTokenBudget({ contextWindow: window })!,
				kind: "approximate" as const,
				source: "test",
			};
			const plainDecision = await plain.runner.runPreflight({
				projection: plainFirst,
				measurement: plainMeasurement,
				pass: 0,
				signal: new AbortController().signal,
			});
			expect(plainDecision.action).toBe("send");
			const unchanged = (await plain.runner.runTransformContext(plainBase)).messages;
			expect(unchanged).toEqual(messages);
			expect(plain.scenario.calls).toHaveLength(0);
		} finally {
			await plain.runner.dispose();
		}
		const armed = await open();
		try {
			const armedBase = { ...projection(messages), tools: requestToolDefs([], [EVENT_FRAME_TOOL]) };
			const armedFirst = await armed.runner.runTransformContext(armedBase);
			const armedMeasurement = {
				inputTokens: inputTokenBudget({ contextWindow: window })! + 1,
				kind: "approximate" as const,
				source: "test",
			};
			const armedDecision = await armed.runner.runPreflight({
				projection: armedFirst,
				measurement: armedMeasurement,
				pass: 0,
				signal: new AbortController().signal,
			});
			expect(armedDecision.action).toBe("rebuild");
			const trimmed = (await armed.runner.runTransformContext(armedBase)).messages;
			expect(armed.scenario.calls.length).toBeGreaterThanOrEqual(1);
			expect(trimmed.some((message) => message.content.includes("[历史摘要]"))).toBe(true);
		} finally {
			await armed.runner.dispose();
		}
	});
});
