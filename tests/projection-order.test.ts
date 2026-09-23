/**
 * Host 装配顺序合同（host.start() 注释引用本文件）：
 * 帧投影(convertToLlm) → transformContext 链（compaction 裁剪 → 项目扩展注入 → tail 相位尾帧）
 * → 预算门 → 协议校验。
 *
 * 以认知扩展的占位 hook（项目扩展注入 [记忆] 块）验证：
 * 1. compaction 先于项目扩展 hook 运行（后者收到的是已裁剪、已带摘要的消息）；
 * 2. 记忆块注入在摘要之后、tail 尾帧之前；
 * 3. 帧组原子性保持（最新外部输入以完整三消息组到达 Provider；多组帧并存合法）；
 * 4. 请求级预算门通过（远期历史被裁剪，回合不因超预算失败）。
 *
 * 重排 host.start() 的激活顺序、tail 相位规则或请求管线顺序而不更新本测试，属于破坏性变更。
 */
import { describe, expect, test } from "./harness/index.js";
import { UinaTestHarness } from "./harness/host/harness.js";
import { Scenario } from "./harness/provider/scenario.js";

describe("Host 装配顺序合同：帧投影 → compaction → 项目扩展（认知占位）", () => {
	test("超预算历史下：摘要先于记忆块、帧组原子、预算门通过", async ({ env }) => {
		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });
		scenario
			.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手"))
			.reply("早期对话围绕长文本输入展开");
		scenario.fallback(() => [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }]);

		// 认知占位扩展：记录收到的消息是否已带摘要/仍含远期历史，并在末尾注入记忆块。
		await env.writeExtension("memory-standin.mjs", `
			export default function activate(uina) {
				uina.onHook("turn.transformContext", (projection) => {
					const contents = projection.messages.map((m) => String(m.content ?? ""));
					const previous = globalThis.__orderProbe;
					const sawSummary = contents.some((c) => c.startsWith("[历史摘要] "));
					globalThis.__orderProbe = {
						sawSummary: Boolean(previous?.sawSummary) || sawSummary,
						sawFarHistory: sawSummary
							? contents.some((c) => c.includes("第0问"))
							: previous?.sawFarHistory ?? contents.some((c) => c.includes("第0问")),
					};
					return { projection: { ...projection, messages: [...projection.messages, { role: "user", content: "[记忆] 认知占位块" }] } };
				});
				// tail 相位：注入一个可辨识的尾帧（模拟视口/具身快照），验证恒排在非 tail 注入之后。
				uina.onHook("turn.transformContext", (projection) => {
					return { projection: { ...projection, messages: [...projection.messages, { role: "user", content: "[TAIL] 瞬态尾帧占位" }] } };
				}, { tail: true });
			}
		`);

		const uina = await UinaTestHarness.create({ env, scenario });
		try {
			const history = Array.from({ length: 60 }, (_, index) =>
				index % 2 === 0
					? { role: "user" as const, content: `第${index}问 ${"词".repeat(3_000)}` }
					: { role: "assistant" as const, content: `第${index}答 ${"词".repeat(3_000)}` },
			);
			uina.host.subject.addHistory(history);

			await uina.send("跑一轮", "direct");
			await uina.waitForIdle();

			const last = scenario.calls.at(-1);
			expect(last).toBeDefined();
			const contents = (last?.messages ?? []).map((m) => m.content ?? "");

			// 1. compaction 先于项目扩展 hook：占位 hook 看到摘要已注入、远期历史已被裁剪。
			const probe = (globalThis as { __orderProbe?: { sawSummary: boolean; sawFarHistory: boolean } }).__orderProbe;
			expect(probe?.sawSummary).toBe(true);
			expect(probe?.sawFarHistory).toBe(false);

			// 2. 摘要紧随 leading system；记忆块在摘要之后；tail 尾帧在记忆块之后且位于消息组末尾。
			expect(contents[1]?.startsWith("[历史摘要] ")).toBe(true);
			const memoryIndex = contents.findIndex((c) => c.includes("[记忆] 认知占位块"));
			expect(memoryIndex).toBeGreaterThan(1);
			expect(contents[memoryIndex + 1]).toContain("[TAIL] 瞬态尾帧占位");
			expect(contents[contents.length - 1]).toContain("[TAIL] 瞬态尾帧占位");
			// systemPrompt 纯净性：记忆块与尾帧文本都不得进入 system。
			expect(contents[0]).not.toContain("[记忆]");
			expect(contents[0]).not.toContain("[TAIL]");

			// 3. 帧组原子：最新外部输入「跑一轮」以完整帧组到达（通知 + 合成调用 + 回执）。
			const messages = last?.messages ?? [];
			const receiptIndex = messages.findIndex((m) => m.role === "tool" && String(m.content).includes("跑一轮"));
			expect(receiptIndex).toBeGreaterThan(1);
			expect(messages[receiptIndex - 2]?.role).toBe("user");
			expect(messages[receiptIndex - 1]?.role).toBe("assistant");

			// 4. 预算门通过：最终请求不含被裁剪的远期历史，回合成功（请求已发出）。
			expect(contents.some((c) => c.includes("第0问"))).toBe(false);
			expect(scenario.calls.length).toBeGreaterThanOrEqual(1);
		} finally {
			await uina.dispose();
			delete (globalThis as { __orderProbe?: unknown }).__orderProbe;
		}
	});
});
