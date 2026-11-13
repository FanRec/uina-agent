import { describe, expect, test } from "vitest";
import type { OutputTagSnapshot } from "../src/core/expression.js";
import type { ChatMsg } from "../src/core/types.js";
import type { RuntimeEvent } from "../src/runtime/events.js";
import type { RuntimeHooks } from "../src/runtime/hooks.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import { SubjectHarness } from "./harness/core/subject-harness.js";
import { Scenario } from "./harness/provider/scenario.js";

/** 注册 speech/cue 语法的测试用 RuntimeHooks（Registry 合同另在 decoder 测试覆盖）。 */
function tagsSnapshot(): OutputTagSnapshot {
	return new Map<string, { name: string; kind: "block" | "marker" }>([
		["speech", { name: "speech", kind: "block" }],
		["cue", { name: "cue", kind: "marker", attributes: { id: "required-string", target: "optional-string" } } as never],
	]);
}

function hooksWithEvents(observed?: (event: RuntimeEvent) => void): RuntimeHooks {
	return {
		...NO_RUNTIME_HOOKS,
		output: { tags: tagsSnapshot },
		events: {
			emit: async () => {},
			observe: (event) => observed?.(event),
			flush: async () => {},
		},
	};
}

describe("Output Interpretation 在 Subject 的唯一接线", () => {
	test("语义事件先于对应生命周期事件派发；注解与原文原子持久化", async () => {
		const scenario = new Scenario();
		scenario.fallback(() => [
			{ kind: "text", text: '前置<speech>你好<cue id="nod"/>！</speech>后置' },
			{ kind: "finish", reason: "stop" },
		]);
		const harness = SubjectHarness.create({
			scenario,
			store: new MemorySessionStore(),
			runtimeHooks: hooksWithEvents(),
		});
		const sequence: string[] = [];
		harness.subscribe((event: RuntimeEvent) => {
			if (event.type === "expression") {
				sequence.push(`expression:${event.event.kind}`);
			} else if (event.type === "output_end" && event.channel === "content") {
				sequence.push("output_end");
			}
		});
		await harness.run("说话");
		expect(sequence).toEqual([
			"expression:text", // Block 外的前置文字
			"expression:block_start",
			"expression:text",
			"expression:marker",
			"expression:text",
			"expression:block_end",
			"expression:text", // Block 外的后置文字
			"output_end",
		]);
		// 注解与 content 同一条 Assistant 记录原子落盘；原文不变。
		const message = harness.history.find((m) => m.role === "assistant");
		expect(message && "expression" in message ? message.expression : undefined).toMatchObject({
			version: 1,
			tags: [
				{ kind: "block_start", name: "speech", blockId: "speech-1", rawRange: [2, 10] },
				{ kind: "marker", name: "cue", blockId: "speech-1", rawRange: [12, 27] },
				{ kind: "block_end", name: "speech", blockId: "speech-1", reason: "closed", rawRange: [28, 37] },
			],
		});
		expect(message?.content).toContain("<speech>你好");
		const storeMessage = harness.records.find(
			(record) => record.kind === "message" && record.message.role === "assistant",
		) as { message: { content: string; expression?: unknown } } | undefined;
		expect(storeMessage?.message.expression).toBeDefined();
	});

	test("无标签的流不产生注解（文本事件照常承载可见文字）", async () => {
		const scenario = new Scenario();
		scenario.fallback(() => [
			{ kind: "text", text: "普通回答，没有标签。" },
			{ kind: "finish", reason: "stop" },
		]);
		const harness = SubjectHarness.create({ scenario, runtimeHooks: hooksWithEvents() });
		const events: RuntimeEvent[] = [];
		harness.subscribe((event: RuntimeEvent) => {
			if (event.type === "expression") events.push(event);
		});
		await harness.run("普通");
		// 没有已识别标签：不产生 block/marker 事件，也没有注解；文本事件仍承载可见文字。
		const semanticKinds = events.map((event) => (event.type === "expression" ? event.event.kind : "other"));
		expect(semanticKinds.every((kind) => kind === "text")).toBe(true);
		const message = harness.history.find((m) => m.role === "assistant");
		expect(message && "expression" in message ? message.expression : undefined).toBeUndefined();
	});

	test("工具执行屏障：content 与 tool_calls 同现时先 flush 语义事件再执行工具", async () => {
		const scenario = new Scenario();
		scenario.fallback(() => [
			{ kind: "text", text: "<speech>先说这句</speech>" },
			{ kind: "tool_call", call: { id: "call-1", name: "probe", args: "{}", argsValid: true } },
			{ kind: "finish", reason: "tool_calls" },
		]);
		scenario
			.when((req) => req.messages.some((message) => message.role === "tool"))
			.then(() => [
				{ kind: "text", text: "工具之后不再说话。" },
				{ kind: "finish", reason: "stop" },
			]);
		// 模拟扩展宿主的异步观察队列：expression 事件延迟 25ms 才被消费。
		let tail: Promise<void> = Promise.resolve();
		const consumed: string[] = [];
		const hooks: RuntimeHooks = {
			...NO_RUNTIME_HOOKS,
			output: { tags: tagsSnapshot },
			events: {
				emit: async () => {},
				observe: (event) => {
					if (event.type !== "expression") return;
					tail = tail.then(
						() =>
							new Promise<void>((resolve) => {
								setTimeout(() => {
									consumed.push((event as { event: { kind: string } }).event.kind);
									resolve();
								}, 25);
							}),
					);
				},
				flush: () => tail,
			},
		};
		let toolRanAt = Number.POSITIVE_INFINITY;
		const harness = SubjectHarness.create({
			scenario,
			runtimeHooks: hooks,
			tools: [
				{
					def: {
						type: "function",
						function: { name: "probe", description: "probe", parameters: { type: "object", properties: {} } },
					},
					run: async () => {
						toolRanAt = consumed.length;
						return { result: "ok", status: "succeeded" };
					},
				},
			],
		});
		await harness.run("说话并调用");
		// 工具执行前，语义事件必须已经全部进入扩展的本地状态（flush 完成后才执行工具）。
		// 前三个是本轮响应的语义事件；第四个 text 来自工具回注后的第二次请求。
		expect(consumed.slice(0, 3)).toEqual(["block_start", "text", "block_end"]);
		expect(toolRanAt).toBe(3);
	});

	test("模型历史视图：无签名回放时标签语义化为普通文本；thinkingReplay all 保持原文", async () => {
		async function capturedMessages(thinkingReplay: "none" | "all"): Promise<readonly ChatMsg[]> {
			const scenario = new Scenario({ thinkingReplay } as never);
			const seen: ChatMsg[] = [];
			scenario.fallback(() => [
				{ kind: "text", text: "<speech>第一轮</speech>" },
				{ kind: "finish", reason: "stop" },
			]);
			scenario
				.when((req) => req.messages.some((message) => message.role === "user" && message.content === "第二问"))
				.then((req) => {
					seen.push(...req.messages);
					return [
						{ kind: "text", text: "第二轮回答。" },
						{ kind: "finish", reason: "stop" },
					];
				});
			const harness = SubjectHarness.create({ scenario, runtimeHooks: hooksWithEvents() });
			await harness.run("第一问");
			await harness.run("第二问");
			return seen;
		}
		const plain = await capturedMessages("none");
		const assistantPlain = plain.filter((m) => m.role === "assistant").map((m) => m.content);
		expect(assistantPlain).toEqual(["第一轮"]);
		const replay = await capturedMessages("all");
		const assistantReplay = replay.filter((m) => m.role === "assistant").map((m) => m.content);
		expect(assistantReplay).toEqual(["<speech>第一轮</speech>"]);
	});
});
