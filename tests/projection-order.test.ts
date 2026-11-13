/**
 * 请求装配顺序合同（信息注入体系）：
 * 帧投影(convertToLlm) → History View（compaction，唯一所有者）→ 工具声明（一次收口）
 * → Request Composer（guidance 固定前缀 / 运行时参考块）→ 预算门 → 协议校验。
 *
 * 以项目扩展的 observation Source 验证：
 * 1. 摘要是 History View 的首位历史（紧随 System），远期历史被裁剪；
 * 2. 运行时参考块（Context Source）装配在 History 之后，不进历史、不进 system；
 * 3. 帧组原子性保持（最新外部输入以完整两消息组到达 Provider）；
 * 4. 请求级预算门通过（远期历史被裁剪，回合不因超预算失败）。
 *
 * 重排请求管线顺序而不更新本测试，属于破坏性变更。
 */

import { openJsonlSession } from "../src/session/jsonl-store.js";
import { UinaTestHarness } from "./harness/host/harness.js";
import { describe, expect, test } from "./harness/index.js";
import { Scenario } from "./harness/provider/scenario.js";

describe("请求装配顺序合同：帧投影 → History View(compaction) → Context Source 装配", () => {
	test("超预算历史下：摘要先于运行时参考块、帧组原子、预算门通过", async ({ env }) => {
		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });
		scenario
			.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"))
			.reply("早期对话围绕长文本输入展开");
		scenario.fallback(() => [
			{ kind: "text", text: "ok" },
			{ kind: "finish", reason: "stop" },
		]);

		// 占位扩展：经 Context Source 提供运行时参考块（只读快照，不写历史）。
		await env.writeExtension(
			"context-standin.mjs",
			`
			export default function activate(uina) {
				uina.provideContext({
					id: "standin",
					kind: "observation",
					read: () => ({ text: "[project context] 占位块", source: { type: "probe", origin: "internal" } }),
				});
			}
		`,
		);

		const history = Array.from({ length: 60 }, (_, index) =>
			index % 2 === 0
				? { role: "user" as const, content: `第${index}问 ${"词".repeat(3_000)}` }
				: { role: "assistant" as const, content: `第${index}答 ${"词".repeat(3_000)}` },
		);
		const seeded = await openJsonlSession(env.sessionPath);
		for (const message of history) await seeded.store.appendMessage(message);
		await seeded.store.close();
		const uina = await UinaTestHarness.create({ env, scenario });
		try {
			await uina.send("跑一轮", "direct");
			await uina.waitForIdle();

			const last = scenario.calls.at(-1);
			expect(last).toBeDefined();
			const contents = (last?.messages ?? []).map((m) => m.content ?? "");

			// 1. 摘要是 History View 的首位历史，紧随 leading system；远期历史已被裁剪。
			expect(contents[0]?.length).toBeGreaterThan(0);
			expect(contents[1]?.startsWith("[历史摘要] ")).toBe(true);

			// 2. 运行时参考块装配在 History 之后（Composer 的运行时参考容器），位于消息末尾。
			const contextIndex = contents.findIndex((c) => c.includes("[project context] 占位块"));
			expect(contextIndex).toBeGreaterThan(1);
			expect(contents[contextIndex]).toContain("[运行时参考信息");
			expect(contents[contents.length - 1]).toContain("[project context] 占位块");
			// systemPrompt 纯净性：运行时参考块不得进入 system。
			expect(contents[0]).not.toContain("[project context]");

			// 3. 帧组原子：最新外部输入「跑一轮」以两消息帧到达（合成调用 + 回执）。
			const messages = last?.messages ?? [];
			const receiptIndex = messages.findIndex((m) => m.role === "tool" && String(m.content).includes("跑一轮"));
			expect(receiptIndex).toBeGreaterThan(1);
			const frameCall = messages[receiptIndex - 1];
			expect(frameCall?.role).toBe("assistant");
			expect(frameCall?.role === "assistant" ? frameCall.tool_calls : undefined).toEqual([
				{ id: expect.any(String), name: "external_event_frame", args: {} },
			]);
			// 帧组在参考块之前：快照消息不落在历史帧与合成调用之间。
			expect(receiptIndex).toBeLessThan(contextIndex);

			// 4. 预算门通过：最终请求不含被裁剪的远期历史，回合成功（请求已发出）。
			expect(contents.some((c) => c.includes("第0问"))).toBe(false);
			expect(scenario.calls.length).toBeGreaterThanOrEqual(1);
		} finally {
			await uina.dispose();
		}
	});
});
