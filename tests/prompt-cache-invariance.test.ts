import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { anthropicSystem } from "../src/ai/providers.js";
import { composeContextSources } from "../src/agent/composer.js";
import type { ChatMsg, ModelRequest } from "../src/core/types.js";

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function mockRequest(messages: ChatMsg[]): ModelRequest {
	return {
		messages,
		tools: [],
		providerHooks: {
			transformHeaders: async (_p, h) => h,
			observeResponse: async () => {},
		},
	};
}

/** 经真实 Request Composer 装配 Voice 观察值的请求（与生产装配同一规则）。 */
function composedWithObservation(baseMessages: ChatMsg[], text: string | null): ChatMsg[] {
	if (!text) return baseMessages;
	const { projection } = composeContextSources({
		projection: { projectionId: "p", modelKey: "m", messages: baseMessages, tools: [] },
		collection: {
			contributions: [
				{
					key: "builtin:voice::observation",
					owner: "builtin:voice",
					kind: "observation",
					value: { text, source: { type: "voice.perception", origin: "internal" } },
				},
			],
			omitted: [],
		},
	});
	return [...projection.messages];
}

describe("Prompt Cache Invariance", () => {
	const BASE_SYSTEM_PROMPT = "你是一个会持续存在的主体。你处于一个 harness 中。";

	it("Voice observation rides a runtime-reference message and never alters top-level system prompt", () => {
		const baseMessages: ChatMsg[] = [
			{ role: "system", content: BASE_SYSTEM_PROMPT },
			{ role: "user", content: "你好" },
			{ role: "assistant", content: "你好！有什么我可以帮你的？" },
			{ role: "user", content: "请继续" },
		];
		const FACT = "上一段声音被用户主动打断。";

		// 轮次 1：无未解决事实
		const sys1 = anthropicSystem(mockRequest(baseMessages));
		expect(sys1).toBe(BASE_SYSTEM_PROMPT);

		// 轮次 2：存在未解决的声音事实
		const p2Step1 = composedWithObservation(baseMessages, `[声音] 未解决的声音事实：${FACT}`);
		// 核心断言：即使存在观察，系统提示词的 sha256 签名必须 100% 绝对一致
		const sys2Step1 = anthropicSystem(mockRequest(p2Step1));
		expect(sys2Step1).toBe(BASE_SYSTEM_PROMPT);
		expect(sha256(sys2Step1!)).toBe(sha256(sys1!));
		// 观察是历史之后的一条运行时参考消息，不进入 History View 的输入
		expect(p2Step1.length).toBe(baseMessages.length + 1);
		expect(p2Step1.at(-1)?.context?.kind).toBe("runtime.perception");

		// 回合内 Step 2：模型发起了工具调用，再次请求时观察消息仍在历史之后
		const baseMessagesWithToolCall: ChatMsg[] = [
			...baseMessages,
			{
				role: "assistant",
				content: "",
				tool_calls: [{ id: "c1", name: "search", args: { q: "test" } }],
			},
			{ role: "tool", tool_call_id: "c1", content: "ok" },
		];
		const p2Step2 = composedWithObservation(baseMessagesWithToolCall, `[声音] 未解决的声音事实：${FACT}`);
		expect(p2Step2.length).toBe(baseMessagesWithToolCall.length + 1);
		expect(p2Step2.at(-2)?.role).toBe("tool");
		const sys2Step2 = anthropicSystem(mockRequest(p2Step2));
		expect(sys2Step2).toBe(BASE_SYSTEM_PROMPT);
		expect(sha256(sys2Step2!)).toBe(sha256(sys1!));

		// 事实真实解决（resolve）后退场：请求与基线一致
		const p3 = composedWithObservation(baseMessages, null);
		const sys3 = anthropicSystem(mockRequest(p3));
		expect(sys3).toBe(BASE_SYSTEM_PROMPT);
		expect(sha256(sys3!)).toBe(sha256(sys1!));
		expect(p3).toEqual(baseMessages);
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
