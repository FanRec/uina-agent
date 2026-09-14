/**
 * 摘要请求自身的预算防护（compactHistory）。
 *
 * 背景：恢复一个用大窗口模型录制的会话后，被折叠段的序列化结果可以远超当前模型的
 * 硬限 —— 那次注定失败的摘要请求会在传输层被切断（undici terminated）并重试三次，
 * 最后以难以定位的 turn_failed 告终（真机事故：182k 上下文压 124k 窗口）。
 *
 * compactHistory 现在在发出前量一次：超限先降级（丢工具结果正文），仍超限则抛带
 * 数字的错误。回退本修复（去掉 compactHistory 里的预算检查）后，超限用例会因
 * 摘要请求照常发出而变红（mock 收到超大 prompt）。
 */
import { describe, expect, it } from "vitest";
import { compactHistory, serializeConversation } from "../src/agent/compaction.js";
import type { AgentMessage, Model, ModelStreamFn, StreamDelta } from "../src/core/types.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";

function modelWithWindow(window: number | undefined): Model {
	return { id: "m", name: "m", providerId: "mock", contextWindow: window };
}

/** 记录收到的 user prompt；按 options.omit 预定行为。 */
function capturingStream(behavior: { omit?: boolean } = {}): { stream: ModelStreamFn; prompts: string[] } {
	const prompts: string[] = [];
	const stream: ModelStreamFn = async (_model, req, onDelta: (d: StreamDelta) => void) => {
		const user = [...req.messages].reverse().find((m) => m.role === "user");
		const text = typeof user?.content === "string" ? user.content : "";
		prompts.push(text);
		if (behavior.omit && /工具结果已省略/.test(text) === false) {
			// 降级未生效时模拟传输层失败：请求大到发不出去。
			throw new Error("undici terminated");
		}
		onDelta({ kind: "text", text: "## 目标\n测试摘要" });
		onDelta({ kind: "finish", reason: "stop" });
	};
	return { stream, prompts };
}

/** 构造一条工具结果消息，content 指定字符数。 */
function toolResult(chars: number): AgentMessage {
	return { role: "tool", content: "结".repeat(chars) } as AgentMessage;
}

function bigHistory(toolChars: number): (AgentMessage)[] {
	const history: AgentMessage[] = [];
	history.push({ role: "user", content: "开始" } as AgentMessage);
	history.push({ role: "assistant", content: "好" } as AgentMessage);
	// 40 条大工具结果：每条 6000 字符，共 24 万字符 ≈ 60k tokens
	for (let i = 0; i < 40; i++) {
		history.push({ role: "assistant", content: `调用${i}`, tool_calls: [{ id: `c${i}`, name: "read", args: "{}" }] } as AgentMessage);
		history.push(toolResult(toolChars));
	}
	history.push({ role: "assistant", content: "尾部" } as AgentMessage);
	return history;
}

describe("compactHistory：摘要请求自身的预算防护", () => {
	it("摘要输入超限时先降级：prompt 里的工具结果正文被省略，调用名保留", async () => {
		const { stream, prompts } = capturingStream();
		const model = modelWithWindow(100_000);
		// 预算 = (100_000 - 2_000 输出余量) * 4 = 392k 字符。完整序列化 = 340k 铺垫
		// + 40 条截断正文 8 万 + 骨架 ≈ 425k，超；降级后正文换占位 ≈ 342k，装得下。
		const history = bigHistory(20_000);
		history.splice(1, 0, { role: "user", content: "铺".repeat(340_000) } as AgentMessage);

		const result = await compactHistory(
			history,
			model,
			stream,
			{ cut: { firstKeptEntryIndex: history.length - 1, turnStartIndex: -1, isSplitTurn: false }, tokensBefore: 999_999 },
			NO_RUNTIME_HOOKS.provider,
		);

		expect(result).not.toBeNull();
		expect(prompts).toHaveLength(1);
		// 降级生效：正文被省略，只有占位行。
		expect(prompts[0]).toContain("工具结果已省略");
		expect(prompts[0]).not.toContain("[工具结果]: ");
		// 调用名仍在：事实保留，丢的只是原文。
		expect(prompts[0]).toContain("read(");
	});

	it("降级后仍超限：立即抛带数字的错误，摘要请求不再发出", async () => {
		const { stream, prompts } = capturingStream();
		const model = modelWithWindow(20_000);
		// 预算 = (20_000 - 2_000) * 4 = 72k 字符：100k 铺垫连降级后都装不下。
		const history = bigHistory(100);
		history.splice(1, 0, { role: "user", content: "铺".repeat(100_000) } as AgentMessage);

		await expect(
			compactHistory(
				history,
				model,
				stream,
				{ cut: { firstKeptEntryIndex: history.length - 1, turnStartIndex: -1, isSplitTurn: false }, tokensBefore: 999_999 },
				NO_RUNTIME_HOOKS.provider,
			),
		).rejects.toThrow(/超模型窗口 20000/);
		// 快速失败：一次请求都没发。
		expect(prompts).toHaveLength(0);
	});

	it("contextWindow 未定义时不设防：未知就说明未知，请求原样发出", async () => {
		const { stream, prompts } = capturingStream();
		const model = modelWithWindow(undefined);
		const history = bigHistory(20_000);
		history.splice(1, 0, { role: "user", content: "铺".repeat(340_000) } as AgentMessage);

		const result = await compactHistory(
			history,
			model,
			stream,
			{ cut: { firstKeptEntryIndex: history.length - 1, turnStartIndex: -1, isSplitTurn: false }, tokensBefore: 999_999 },
			NO_RUNTIME_HOOKS.provider,
		);

		expect(result).not.toBeNull();
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).not.toContain("工具结果已省略");
	});

	it("serializeConversation 降级：正文换成占位，占位标注原字符数", () => {
		const messages = [toolResult(12_345)] as unknown as (AgentMessage)[];
		const normal = serializeConversation(messages);
		const degraded = serializeConversation(messages, { omitToolResults: true });
		expect(normal).toContain("[工具结果]: ");
		expect(degraded).toContain("原 12345 字符");
		expect(degraded.length).toBeLessThan(normal.length);
	});
});
