/**
 * 回合内体检（对齐 dsh 的 between-step pressure）。
 *
 * 背景：自动压缩原先只在 prepareTurn（回合开头）查一次。一个回合可以跑几十次工具调用，
 * 上下文在回合内从 10 万涨到 18 万，期间无人过问 —— 等下一个回合开头才压缩，那时的压缩
 * 请求自身就是一个超大请求（实测 163k 真实输入），在传输层被切断，整个回合 turn_failed。
 *
 * 回退本修复（把 prepareTurn 移回 runTurn 开头）后，这条测试会因为 session_compact
 * 不再出现而变红。
 */
import { describe, expect, it } from "vitest";
import type { AgentMessage, Model, ModelStreamFn } from "../src/core/types.js";
import { mockModel } from "./helpers/mock-provider.js";

// 阈值 = contextWindow(100_000) - reserveTokens(16_384 默认) = 83_616
const MODEL: Model = mockModel({ id: "mock", name: "mock", contextWindow: 100_000 });

describe("自动压缩：每次模型调用前都体检，而不是只在回合开头", () => {
	it("同一个回合内上下文越过阈值后，在下一次调用前就压缩", async () => {
		const { ExtensionHost } = await import("../src/extensions/host.js");
		const { createRuntimeHooks } = await import("../src/extensions/runtime-hooks.js");
		const { Subject } = await import("../src/agent/loop.js");
		const { ToolBroker } = await import("../src/tools/broker.js");

		let call = 0;
		const stream: ModelStreamFn = async (_model, _req, onDelta) => {
			call++;
			if (call === 1) {
				// 第一步：请求一个不存在的工具，逼出工具往返，让回合继续到第二次调用。
				onDelta({ kind: "tool_call", call: { id: "c1", name: "no_such_tool", args: "{}" } });
				// 服务端报回一个越过阈值的真实总量：它成为后续估算的锚。
				onDelta({ kind: "usage", usage: { input: 1, output: 1, totalTokens: 90_000 } });
				onDelta({ kind: "finish", reason: "tool_calls" });
				return;
			}
			// 压缩请求与后续正常调用都返回一段文本。
			onDelta({ kind: "text", text: "摘要内容" });
			onDelta({ kind: "finish", reason: "stop" });
		};

		const host = new ExtensionHost();
		const subject = new Subject(MODEL, stream, new ToolBroker(), {
			systemPrompt: "sys",
			runtimeHooks: createRuntimeHooks(host),
		});

		// 铺垫一段足够长的历史，让自动压缩有可推进的切点（keepRecentTokens 默认 20k）。
		const chunk = "词".repeat(4_000);
		const seed: AgentMessage[] = [];
		for (let i = 0; i < 12; i++) {
			seed.push({ role: "user", content: `第${i}问 ${chunk}` });
			seed.push({ role: "assistant", content: `第${i}答 ${chunk}` });
		}
		subject.addHistory(seed);

		let compacted = 0;
		host.on("session_compact", () => { compacted++; });

		await subject.pushInput("跑两轮");
		await subject.waitForIdle();

		// 回合内第二步调用前就该压缩：90k 的真实锚已超过 83,616 的阈值。
		// 回退修复后这里恒为 0 —— 那时只在回合开头查一次，而开头还没有 90k 的锚。
		expect(compacted).toBe(1);
		expect(call).toBeGreaterThanOrEqual(3);
	});
});
