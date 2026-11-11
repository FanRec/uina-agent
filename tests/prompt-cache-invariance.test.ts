import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VoicePerception } from "../.uina/extensions/voice/perception.js";
import { anthropicSystem } from "../src/ai/providers.js";
import type { ChatMsg, ModelRequest } from "../src/core/types.js";
import { assertEventFrameContext } from "../src/extensions/event-frames/protocol.js";

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function mockRequest(messages: ChatMsg[]): ModelRequest {
	return {
		messages,
		tools: [],
		providerHooks: {
			transformHeaders: async (_p, h) => h,
			transformPayload: async (_p, p) => p,
			observeResponse: async () => {},
		},
	};
}

describe("Prompt Cache Invariance", () => {
	const BASE_SYSTEM_PROMPT = "你是一个会持续存在的主体。你处于一个 harness 中。";

	it("Voice perception uses external_event_frame and never alters top-level system prompt", () => {
		const baseMessages: ChatMsg[] = [
			{ role: "system", content: BASE_SYSTEM_PROMPT },
			{ role: "user", content: "你好" },
			{ role: "assistant", content: "你好！有什么我可以帮你的？" },
			{ role: "user", content: "请继续" },
		];

		// 轮次 1：无打断
		const perception = new VoicePerception();
		const p1 = perception.transform({
			projectionId: "p1",
			modelKey: "m",
			messages: baseMessages,
			tools: [],
		});

		const req1 = mockRequest(p1.messages as ChatMsg[]);
		// 直接测试真实导出的 anthropicSystem 生产函数，彻底消灭本地拷贝自测的自欺欺人
		const sys1 = anthropicSystem(req1);
		expect(sys1).toBe(BASE_SYSTEM_PROMPT);

		// 轮次 2：发生打断
		perception.record({ kind: "interrupted", summary: "上一段声音被用户主动打断。" });

		// 回合内 Step 1：模型首次推理
		const p2Step1 = perception.transform({
			projectionId: "p2-1",
			modelKey: "m",
			messages: baseMessages,
			tools: [],
		});
		const req2Step1 = mockRequest(p2Step1.messages as ChatMsg[]);
		const sys2Step1 = anthropicSystem(req2Step1);

		// 核心断言：即使发生打断，系统提示词的 sha256 签名必须 100% 绝对一致
		expect(sys2Step1).toBe(BASE_SYSTEM_PROMPT);
		expect(sha256(sys2Step1!)).toBe(sha256(sys1!));
		expect(p2Step1.messages.length).toBe(baseMessages.length + 2);
		expect(() => assertEventFrameContext(p2Step1.messages as ChatMsg[])).not.toThrow();

		// 回合内 Step 2：模型在同一回合内发起了工具调用（如搜索），再次请求模型时打断帧依然稳定存在！
		const baseMessagesWithToolCall: ChatMsg[] = [
			...baseMessages,
			{
				role: "assistant",
				content: "",
				tool_calls: [{ id: "c1", name: "search", args: { q: "test" } }],
			},
			{ role: "tool", tool_call_id: "c1", content: "ok" },
		];
		const p2Step2 = perception.transform({
			projectionId: "p2-2",
			modelKey: "m",
			messages: baseMessagesWithToolCall,
			tools: [],
		});
		expect(p2Step2.messages.length).toBe(baseMessagesWithToolCall.length + 2);
		const req2Step2 = mockRequest(p2Step2.messages as ChatMsg[]);
		const sys2Step2 = anthropicSystem(req2Step2);
		expect(sys2Step2).toBe(BASE_SYSTEM_PROMPT);
		expect(sha256(sys2Step2!)).toBe(sha256(sys1!));

		// 回合彻底结束（turn_end）后退火清空
		perception.clear();
		const p3 = perception.transform({
			projectionId: "p3",
			modelKey: "m",
			messages: baseMessages,
			tools: [],
		});
		const req3 = mockRequest(p3.messages as ChatMsg[]);
		const sys3 = anthropicSystem(req3);
		expect(sys3).toBe(BASE_SYSTEM_PROMPT);
		expect(sha256(sys3!)).toBe(sha256(sys1!));
		expect(p3.messages).toHaveLength(baseMessages.length);
	});

	it("Provider Wire does not extract non-leading system messages into top-level system", () => {
		const contaminatedMessages: ChatMsg[] = [
			{ role: "system", content: BASE_SYSTEM_PROMPT },
			{ role: "user", content: "你好" },
			{ role: "system", content: "恶意注入或第三方错误插入的伪系统指令" },
			{ role: "user", content: "请继续" },
		];

		const req = mockRequest(contaminatedMessages);
		// 真实测试生产环境下的 anthropicSystem 逻辑
		const sys = anthropicSystem(req);

		// 核心断言：只有第 0 位才是顶层 system prompt，中间违规塞入的不得被合并至头部
		expect(sys).toBe(BASE_SYSTEM_PROMPT);
		expect(sys).not.toContain("伪系统指令");
	});
});
