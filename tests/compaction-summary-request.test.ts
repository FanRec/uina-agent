/**
 * 摘要请求合同：思考档位跟随宿主、流式正文驱动进度、总超时兜底。
 *
 * requestTextCompletion 只依赖 pi.models.current()/thinkingLevel()/stream()，
 * 这里用最小 fake 直接驱动导出函数，不经过完整压缩流程。
 */
import { describe, expect, test } from "vitest";
import type { ChatMsg, ModelRequest, ThinkingLevel } from "../src/core/types.js";
import { requestTextCompletion } from "../src/extensions/compaction/index.js";
import type { ExtensionAPI } from "../src/extensions/runner.js";

type Delta = { kind: string; text?: string };

function fakePi(options: {
	thinkingLevel?: ThinkingLevel;
	thinkingLevelUnavailable?: boolean;
	stream: (request: ModelRequest, onDelta: (delta: Delta) => void, signal: AbortSignal) => Promise<void>;
}): ExtensionAPI {
	const models = {
		current: () => ({ id: "test-model" }),
		thinkingLevel: () => {
			if (options.thinkingLevelUnavailable) throw new Error("宿主未提供思考档位事实入口");
			return options.thinkingLevel;
		},
		stream: (_model: unknown, request: ModelRequest, onDelta: (delta: Delta) => void, signal: AbortSignal) =>
			options.stream(request, onDelta, signal),
	};
	return { models } as unknown as ExtensionAPI;
}

const MESSAGES: ChatMsg[] = [{ role: "user", content: "历史" }];

describe("compaction 摘要请求", () => {
	test("思考档位跟随宿主声明，流式正文驱动进度回调", async () => {
		const requests: ModelRequest[] = [];
		const activities: number[] = [];
		const pi = fakePi({
			thinkingLevel: "high",
			stream: async (request, onDelta) => {
				requests.push(request);
				onDelta({ kind: "thinking", text: "思考不计入正文" });
				onDelta({ kind: "text", text: "摘要" });
				onDelta({ kind: "text", text: "正文" });
			},
		});
		const result = await requestTextCompletion(pi, MESSAGES, "摘要模型请求", new AbortController().signal, {
			onActivity: (chars) => activities.push(chars),
		});
		expect(result).toBe("摘要正文");
		expect(requests[0]?.thinkingLevel).toBe("high");
		expect(requests[0]?.tools).toEqual([]);
		expect(activities).toEqual([2, 4]);
	});

	test("宿主未提供思考档位入口时不发送 thinking 字段", async () => {
		const requests: ModelRequest[] = [];
		const pi = fakePi({
			thinkingLevelUnavailable: true,
			stream: async (request, onDelta) => {
				requests.push(request);
				onDelta({ kind: "text", text: "正文" });
			},
		});
		await requestTextCompletion(pi, MESSAGES, "摘要模型请求", new AbortController().signal);
		expect(requests).toHaveLength(1);
		expect("thinkingLevel" in (requests[0] ?? {})).toBe(false);
	});

	test("总超时把无响应 Provider 变成可重试的显式失败", async () => {
		const pi = fakePi({
			thinkingLevelUnavailable: true,
			stream: (_request, _onDelta, signal) =>
				new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () =>
						reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
					);
				}),
		});
		let message: string | undefined;
		try {
			await requestTextCompletion(pi, MESSAGES, "摘要模型请求", new AbortController().signal, { timeoutMs: 20 });
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("摘要模型请求超时");
		expect(message).toContain("请重试或检查 Provider");
	});
});
