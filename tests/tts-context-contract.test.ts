import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createTtsTool } from "../.uina/extensions/tts/tool.js";
import { VoicePerception } from "../.uina/extensions/voice/perception.js";
import { VoiceSession } from "../.uina/extensions/voice/session.js";
import { createVoiceTool } from "../.uina/extensions/voice/tool.js";
import { estimateRequestTokens } from "../src/agent/context.js";
import { composeContextSources } from "../src/agent/composer.js";
import { createOpenAIProvider, toWireMessages } from "../src/ai/gateway.js";
import type { ChatMsg, RequestProjection } from "../src/core/types.js";
import { assertEventFrameContext, EVENT_FRAME_KIND } from "../src/extensions/event-frames/protocol.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";

const base: RequestProjection = {
	projectionId: "p",
	modelKey: "m",
	tools: [],
	messages: [{ role: "user" as const, content: "continue" }],
};

/** 经真实 Request Composer 装配 Voice 观察值的完整请求（与生产路径同一装配规则）。 */
function composedWithObservation(voice: VoicePerception): RequestProjection {
	const value = voice.observationValue();
	const { projection } = composeContextSources({
		projection: base,
		collection: {
			contributions: value
				? [
						{
							key: "builtin:voice::observation",
							owner: "builtin:voice",
							kind: "observation",
							value,
						},
					]
				: [],
			omitted: [],
		},
	});
	return projection;
}

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

describe("Voice 观察与模型可见合同（信息注入体系）", () => {
	it("keeps structured failure evidence in tool content instead of object coercion", async () => {
		const tool = createTtsTool({
			recover: async () => ({ status: "unknown", reason: { stop: "not confirmed", epoch: "old" } }),
		} as never);
		const result = await tool.run({ action: "recover" });
		expect(result.result).toContain("not confirmed");
		expect(result.result).not.toContain("[object Object]");
		expect(result.status).toBe("unknown");
	});

	it("观察经 Context Source 装配为一条运行时参考消息，比旧三消息帧格式更短", () => {
		const summary = "上一段台词尚未确认是否播完；不要当作用户已经听见。";
		const legacyNotice =
			"[运行时通知] 以下为语音输出状态瞬态快照（环境感知信息，非用户输入，无需直接回应）；正文在随后的 external_event_frame 回执中。";
		const previous = [...base.messages, ...legacyObservation(`[语音输出状态] ${summary}`, legacyNotice)];
		const voice = new VoicePerception();
		voice.record({ kind: "delivery_unknown", summary }, "cause");
		const current = composedWithObservation(voice);
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
		expect(after.messageCount).toBeLessThan(before.messageCount);
		expect(after.characters).toBeLessThan(before.characters);
		expect(after.estimatedTokens).toBeLessThan(before.estimatedTokens);
		expect(JSON.stringify(toWireMessages([...current.messages]))).toContain(summary);
	});

	it("观察不再生成 Event Frame：无合成调用、无帧协议标记，快照标为 runtime.perception", () => {
		const voice = new VoicePerception();
		voice.record({ kind: "delivery_unknown", summary: "旧发声未确认。" }, "source");
		const projection = composedWithObservation(voice);
		// 不抛：帧协议校验只在帧在场时有要求；这里根本没有帧。
		expect(() => assertEventFrameContext(projection.messages)).not.toThrow();
		const serialized = JSON.stringify(projection.messages);
		expect(serialized).not.toContain(EVENT_FRAME_KIND);
		expect(serialized).not.toContain("external_event_frame");
		expect(projection.messages.at(-1)?.context?.kind).toBe("runtime.perception");
	});

	it("inspection does not consume facts; unresolved facts stay visible across requests", () => {
		const voice = new VoicePerception();
		voice.record({ kind: "delivery_unknown", summary: "first" }, "source");
		const inspected = composedWithObservation(voice);
		expect(JSON.stringify(inspected.messages)).toContain("first");
		// read 是纯读：未解决事实在下一次请求继续可见
		expect(JSON.stringify(composedWithObservation(voice).messages)).toContain("first");

		// 同一 causeRef 更新替换旧内容
		voice.record({ kind: "delivery_failed", summary: "newer" }, "source");
		expect(JSON.stringify(composedWithObservation(voice).messages)).toContain("newer");
		expect(JSON.stringify(composedWithObservation(voice).messages)).not.toContain("first");

		// 真实解决后退出
		voice.resolve("source");
		expect(composedWithObservation(voice).messages).toEqual(base.messages);
	});

	it("不同源的不同事实分别可见；同一 causeRef 不按 summary 合并计数", () => {
		const voice = new VoicePerception();
		voice.record({ kind: "delivery_failed", summary: "源 A 失败。" }, "a");
		voice.record({ kind: "delivery_failed", summary: "源 A 失败。" }, "a"); // 同源更新：替换
		voice.record({ kind: "delivery_unknown", summary: "源 C 未知。" }, "c");
		const body = (composedWithObservation(voice).messages.at(-1) as { content: string }).content;
		expect(body).toContain("源 A 失败。");
		expect(body).toContain("源 C 未知。");
		expect(body.match(/源 A 失败/g)).toHaveLength(1);
	});

	it("没有未解决事实时不注入任何消息（零 Source 请求与基线一致）", () => {
		const voice = new VoicePerception();
		expect(composedWithObservation(voice)).toBe(base);
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
