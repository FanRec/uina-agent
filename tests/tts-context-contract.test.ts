import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createTtsTool } from "../.uina/extensions/tts/tool.js";
import { VoicePerception } from "../.uina/extensions/voice/perception.js";
import { VoiceSession } from "../.uina/extensions/voice/session.js";
import { createVoiceTool } from "../.uina/extensions/voice/tool.js";
import { estimateRequestTokens } from "../src/agent/context.js";
import { createOpenAIProvider, toWireMessages } from "../src/ai/gateway.js";
import type { ChatMsg, RequestProjection } from "../src/core/types.js";
import { filterCompactionMessages } from "../src/extensions/compaction/index.js";
import { assertEventFrameContext, EVENT_FRAME_KIND } from "../src/extensions/event-frames/protocol.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";

const request: RequestProjection = {
	projectionId: "p",
	modelKey: "m",
	tools: [],
	messages: [{ role: "user" as const, content: "continue" }],
};

/**
 * 上一版（三消息）观察格式的冻结副本，只作度量基线：它不引用当前实现，所以不会随重构漂移。
 * 形状来自重构前的 buildEventFrameGroup：user 通知 + 携带 eventId 的合成调用 + JSON 回执。
 */
function legacyObservation(text: string, notice: string): ChatMsg[] {
	const eventId = "voice:perception:legacy";
	const id = "ef_legacy";
	return [
		{
			role: "user",
			content: notice,
			context: { kind: EVENT_FRAME_KIND, input: { eventId }, group: { id, index: 0, size: 3 } },
		},
		{
			role: "assistant",
			content: "",
			tool_calls: [{ id, name: "external_event_frame", args: { eventId } }],
			context: { kind: EVENT_FRAME_KIND, input: { eventId }, group: { id, index: 1, size: 3 } },
		},
		{
			role: "tool",
			tool_call_id: id,
			content: JSON.stringify({
				eventId,
				source: { kind: "runtime", type: "voice-perception", origin: "internal" },
				text,
			}),
			context: { kind: EVENT_FRAME_KIND, input: { eventId }, group: { id, index: 2, size: 3 } },
		},
	];
}
describe("Voice projection and model-facing contracts", () => {
	it("keeps structured failure evidence in tool content instead of object coercion", async () => {
		const tool = createTtsTool({
			recover: async () => ({ status: "unknown", reason: { stop: "not confirmed", epoch: "old" } }),
		} as never);
		const result = await tool.run({ action: "recover" });
		expect(result.result).toContain("not confirmed");
		expect(result.result).not.toContain("[object Object]");
		expect(result.status).toBe("unknown");
	});
	it("measures the real wire projection against the previous three-message observation format", () => {
		const summary = "上一段台词尚未确认是否播完；不要当作用户已经听见。";
		const legacyNotice =
			"[运行时通知] 以下为语音输出状态瞬态快照（环境感知信息，非用户输入，无需直接回应）；正文在随后的 external_event_frame 回执中。";
		const previous = [...request.messages, ...legacyObservation(`[语音输出状态] ${summary}`, legacyNotice)];
		const voice = new VoicePerception();
		voice.record({ kind: "delivery_unknown", summary }, "cause");
		const current = voice.transform(request);
		const before = {
			messageCount: previous.length,
			characters: JSON.stringify(toWireMessages([...previous])).length,
			estimatedTokens: estimateRequestTokens(previous),
		};
		const after = {
			messageCount: current.messages.length,
			characters: JSON.stringify(toWireMessages([...current.messages])).length,
			estimatedTokens: estimateRequestTokens(current.messages),
		};
		console.log(
			"Voice wire observation metrics",
			JSON.stringify({ baseline: "previous three-message observation format, same fact and request", before, after }),
		);
		expect(after.messageCount).toBeLessThan(before.messageCount);
		expect(after.characters).toBeLessThan(before.characters);
		expect(after.estimatedTokens).toBeLessThan(before.estimatedTokens);
		expect(JSON.stringify(toWireMessages([...current.messages]))).toContain(summary);
		voice.prepare(current);
		voice.consume();
		expect(voice.transform(request).messages).toEqual(request.messages);
	});
	it("keeps real Voice frames protocol-valid and out of compaction", () => {
		const voice = new VoicePerception();
		voice.record({ kind: "delivery_unknown", summary: "旧发声未确认。" }, "source");
		const projection = voice.transform(request);
		expect(() => assertEventFrameContext(projection.messages)).not.toThrow();
		expect(filterCompactionMessages(projection.messages)).toEqual(request.messages);
	});
	it("inspection does not consume facts and an actual response consumes only prepared versions", () => {
		const voice = new VoicePerception();
		voice.record({ kind: "delivery_unknown", summary: "first" }, "source");
		const inspected = voice.transform(request);
		expect(voice.peek()?.summary).toBe("first");
		voice.prepare(inspected);
		voice.record({ kind: "delivery_failed", summary: "newer" }, "source");
		voice.consume();
		expect(voice.peek()?.summary).toBe("newer");
		voice.prepare(voice.transform(request));
		voice.consume();
		expect(voice.transform(request).messages).toEqual(request.messages);
	});
	it("groups repeated facts without dropping different reasons", () => {
		const voice = new VoicePerception();
		voice.record({ kind: "delivery_failed", summary: "same" }, "a");
		voice.record({ kind: "delivery_failed", summary: "same" }, "b");
		voice.record({ kind: "delivery_unknown", summary: "other" }, "c");
		const projection = voice.transform(request);
		const body = (projection.messages.at(-1) as { content: string }).content;
		expect(body).toContain("2 段");
		expect(body).toContain("other");
	});
	it("captures exact projected causes, including escaped text, rather than matching later similar facts", () => {
		const voice = new VoicePerception();
		const fact = { kind: "delivery_unknown" as const, summary: 'reply says "unknown"\nnot completed' };
		voice.record(fact, "old");
		const projection = voice.transform(request);
		voice.record(fact, "new");
		voice.prepare(projection);
		voice.consume();
		expect(voice.peek()).toEqual(fact);
		voice.prepare(voice.transform(request));
		voice.consume();
		expect(voice.peek()).toBeNull();
	});
	it("exposes completion evidence in actual OpenAI wire content", async () => {
		const tts = createTtsTool({
			test: async () => ({ scope: "playback", status: "succeeded", playback_completed: true, path: "streaming" }),
		} as never);
		const result = await tts.run({ action: "test", scope: "playback" });
		const wire = toWireMessages([
			{ role: "tool", tool_call_id: "call", content: result.result, details: result.details, status: result.status },
		]);
		expect(JSON.stringify(wire)).toContain("测试音已播完");
		expect(JSON.stringify(wire)).toContain("流式");
		expect(JSON.stringify(wire)).not.toContain("details");
	});
	it("sends the evidence and current schema through a real gateway HTTP request", async () => {
		let received = "";
		const server = createServer((req, response) => {
			req.setEncoding("utf8");
			req.on("data", (chunk) => {
				received += chunk;
			});
			req.on("end", () => {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const tool = createTtsTool({
				test: async () => ({ scope: "playback", status: "succeeded", playback_completed: true, path: "streaming" }),
			} as never);
			const result = await tool.run({ action: "test", scope: "playback" });
			const provider = createOpenAIProvider("wire-fixture", {
				baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
				apiKey: "fixture-only",
				maxRetries: 0,
			});
			await provider.stream(
				{ id: "fixture", name: "fixture", providerId: "wire-fixture" },
				{
					messages: [
						{
							role: "assistant",
							content: "",
							tool_calls: [{ id: "call", name: "tts", args: { action: "test", scope: "playback" } }],
						},
						{
							role: "tool",
							tool_call_id: "call",
							content: result.result,
							details: result.details,
							status: result.status,
						},
					],
					tools: [tool.def],
					providerHooks: NO_RUNTIME_HOOKS.provider,
				},
				() => {},
			);
			expect(received).toContain("测试音已播完");
			expect(received).toContain("流式");
			expect(received).not.toContain('"details"');
			expect(received).not.toContain('"const":"reset"');
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
	it("rejects old recovery switches and irrelevant cross-action parameters", () => {
		const Ajv = createRequire(import.meta.url)("ajv");
		const ajv = new Ajv();
		const tts = ajv.compile(createTtsTool({} as never).def.function.parameters);
		expect(tts({ action: "recover" })).toBe(true);
		expect(tts({ action: "recover", operation: "reset" })).toBe(false);
		expect(tts({ action: "recover", operation: "restart", target: "bridge" })).toBe(true);
		expect(tts({ action: "test", target: "vendor" })).toBe(false);
		const voice = ajv.compile(createVoiceTool(new VoiceSession()).def.function.parameters);
		expect(voice({ action: "manage", operation: "set_text_reading" })).toBe(false);
		expect(voice({ action: "manage", operation: "mute", enabled: true })).toBe(false);
	});
});
