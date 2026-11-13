import { describe, expect, it } from "vitest";
import { ExpressionDecoder, OutputInterpreter } from "../src/agent/expression.js";
import type { ExpressionAnnotation, ExpressionEvent } from "../src/core/expression.js";
import { stripExpressionTags } from "../src/core/expression.js";
import { speechSayUtterance, visibleAssistantText } from "../src/presentation/expression-view.js";
import { ingestLive } from "../src/presentation/ingest-live.js";
import { ingestReplay } from "../src/presentation/ingest-replay.js";

function tags(): Map<string, { name: string; kind: "block" | "marker" }> {
	return new Map<string, { name: string; kind: "block" | "marker" }>([
		["speech", { name: "speech", kind: "block" }],
		[
			"cue",
			{
				name: "cue",
				kind: "marker",
				attributes: { id: "required-string", target: "optional-string" },
			} as never,
		],
	]);
}

describe("presentation 表达视图", () => {
	it("presentation 镜像与 core 的标签剔除规则逐字节等价", () => {
		const interpreter = new OutputInterpreter();
		interpreter.startStream("s1", tags());
		const raw = '说明<speech>台词<cue id="nod" target="live2d"/></speech>\n代码 `<cue id="x"/>` 结尾';
		interpreter.feed("s1", raw);
		interpreter.finish("s1", "completed");
		const annotation = interpreter.takeAnnotation("s1") as ExpressionAnnotation;
		expect(visibleAssistantText(raw, annotation)).toBe(stripExpressionTags(raw, annotation));
		expect(visibleAssistantText(raw, annotation)).toBe('说明台词\n代码 `<cue id="x"/>` 结尾');
		// 旧的无注解历史原样返回。
		expect(visibleAssistantText(raw)).toBe(raw);
	});

	it("live 摄取只从 expression 语义事件生成正文；原始 output_update 不再产生 assistant.delta", () => {
		const record = (event: unknown) => ({ at: 1, event }) as never;
		// content 通道的原始 delta 不再有展示事实
		expect(
			ingestLive(record({ type: "output_update", streamId: "s", offset: 1, channel: "content", text: "<speech>你好" })),
		).toEqual([]);
		// expression text 事件生成一份正文
		const textEvent: ExpressionEvent = {
			kind: "text",
			streamId: "s",
			text: "你好",
			scope: { blockId: "speech-1", name: "speech" },
			rawRange: [8, 10],
		};
		const facts = ingestLive(record({ type: "expression", streamId: "s", event: textEvent }));
		expect(facts).toMatchObject([{ kind: "assistant.delta", text: "你好", origin: "live" }]);
	});

	it("speech.say 的可见表达只来自已提交的 Canonical Tool Result details.speech", () => {
		const details = { speech: { version: 1, utteranceId: "u1", text: "额外一句", accepted: true } };
		expect(speechSayUtterance("speech", { action: "say", text: "额外一句" }, details)).toEqual({
			utteranceId: "u1",
			text: "额外一句",
		});
		// 未受理/失败不生成"已说"文字；旧无 details.speech 的历史不推断曾经说过。
		expect(
			speechSayUtterance("speech", { action: "say", text: "x" }, { speech: { ...details.speech, accepted: false } }),
		).toBeNull();
		expect(speechSayUtterance("speech", { action: "stop" }, details)).toBeNull();
		expect(speechSayUtterance("tts", { action: "say", text: "x" }, details)).toBeNull();
		expect(speechSayUtterance("speech", { action: "say", text: "x" }, undefined)).toBeNull();
	});

	it("live tool.finished（succeeded）追加一份 Speech 文字事实", () => {
		const record = (event: unknown) => ({ at: 2, event }) as never;
		const facts = ingestLive(
			record({
				type: "tool_result",
				toolName: "speech",
				args: { action: "say", text: "额外一句" },
				callId: "c1",
				status: "succeeded",
				result: "台词已受理（Utterance u1）。",
				details: { speech: { version: 1, utteranceId: "u1", text: "额外一句", accepted: true } },
			}),
		);
		expect(facts).toHaveLength(2);
		expect(facts[0]).toMatchObject({ kind: "tool.finished", callId: "c1" });
		expect(facts[1]).toMatchObject({ kind: "assistant.delta", text: "额外一句" });
	});

	it("replay 从注解剔除标签；speech.say 文字从 tool 消息派生", () => {
		const annotation: ExpressionAnnotation = {
			version: 1,
			streamId: "s",
			tags: [
				{ kind: "block_start", name: "speech", blockId: "speech-1", rawRange: [0, 8] },
				{ kind: "block_end", name: "speech", blockId: "speech-1", reason: "closed", rawRange: [10, 19] },
			],
		};
		const entries = [
			{
				kind: "message" as const,
				id: "m1",
				seq: 1,
				timestamp: "2026-01-01T00:00:00Z",
				message: {
					role: "assistant" as const,
					content: "<speech>台词</speech>",
					expression: annotation,
					timestamp: "2026-01-01T00:00:00Z",
				},
			},
			{
				kind: "message" as const,
				id: "m2",
				seq: 2,
				timestamp: "2026-01-01T00:00:01Z",
				message: {
					role: "tool" as const,
					tool_call_id: "c1",
					name: "speech",
					content: "受理",
					status: "succeeded" as const,
					details: { speech: { version: 1, utteranceId: "u1", text: "额外一句", accepted: true } },
					timestamp: "2026-01-01T00:00:01Z",
				},
			},
			{
				kind: "message" as const,
				id: "m3",
				seq: 3,
				timestamp: "2026-01-01T00:00:02Z",
				// 旧的无注解历史：原样显示（不假设旧代码的正则就是未来语义）。
				message: {
					role: "assistant" as const,
					content: '旧历史 <cue id="nod"/> 原样',
					timestamp: "2026-01-01T00:00:02Z",
				},
			},
		];
		const auxiliary = [
			{
				kind: "event" as const,
				id: "e1",
				seq: 10,
				timestamp: "2026-01-01T00:00:00Z",
				event: "tool_started" as const,
				data: { callId: "c1", name: "speech", args: { action: "say", text: "额外一句" } },
			},
			{
				kind: "event" as const,
				id: "e2",
				seq: 11,
				timestamp: "2026-01-01T00:00:01Z",
				event: "tool_finished" as const,
				data: { callId: "c1", name: "speech", status: "succeeded" },
			},
		];
		const facts = ingestReplay({ entries, auxiliary });
		const assistantTexts = facts
			.filter((fact) => fact.kind === "assistant.delta")
			.map((fact) => (fact as { text: string }).text);
		expect(assistantTexts).toEqual(["台词", "额外一句", '旧历史 <cue id="nod"/> 原样']);
	});

	it("Decoder 注解覆盖中断流：隐式结束不占原文", () => {
		const decoder = new ExpressionDecoder("s", tags());
		decoder.feed("<speech>部分");
		const events = decoder.finish("interrupted");
		const interpreter = new OutputInterpreter();
		interpreter.startStream("x", tags());
		const raw = "<speech>部分";
		interpreter.feed("x", raw);
		interpreter.finish("x", "interrupted");
		const annotation = interpreter.takeAnnotation("x") as ExpressionAnnotation;
		expect(events.at(-1)).toMatchObject({ kind: "block_end", reason: "interrupted" });
		expect(annotation.tags.at(-1)).toEqual({
			kind: "block_end",
			name: "speech",
			blockId: "speech-1",
			reason: "interrupted",
		});
		expect(visibleAssistantText(raw, annotation)).toBe("部分");
	});
});
