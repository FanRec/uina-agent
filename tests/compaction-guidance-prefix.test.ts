import { readFile } from "node:fs/promises";
import { openJsonlSession } from "../src/session/jsonl-store.js";
import { estimateRequestTokens } from "../src/agent/context.js";
import type { ChatMsg } from "../src/core/types.js";
import { estimateStreamTokens, splitGuidancePrefix } from "../src/extensions/compaction/index.js";
import { describe, expect, it } from "vitest";
import { IsolatedEnv, Scenario, UinaTestHarness } from "./harness/index.js";

const msg = (role: ChatMsg["role"], content: string, context?: ChatMsg["context"]): ChatMsg =>
	({ role, content, ...(context ? { context } : {}) }) as ChatMsg;

describe("Compaction 与固定扩展前缀（A10）", () => {
	it("runtime.guidance 前缀被剔除出裁剪视图，成本单独预留；历史条目原样保留", () => {
		const prefixText = "前缀正文".repeat(50);
		const messages = [
			msg("system", "系统提示"),
			msg("user", prefixText, { kind: "runtime.guidance" }),
			msg("user", "第一问", { entryId: "e1" }),
			msg("assistant", "第一答", { entryId: "e2" }),
			msg("user", "第二问", { entryId: "e3" }),
		];
		const { history, guidanceCostTokens } = splitGuidancePrefix(messages);
		expect(history).toEqual([messages[0], messages[2], messages[3], messages[4]]);
		// 携带 entryId 的历史条目全部保留：压缩边界到 canonical history 的映射不受影响
		expect(history.filter((m) => m.context?.entryId)).toHaveLength(3);
		// 前缀成本与同口径估算一致（非零：预留进消息预算）
		expect(guidanceCostTokens).toBe(estimateRequestTokens([messages[1]!] as readonly ChatMsg[], []));
		expect(guidanceCostTokens).toBeGreaterThan(0);
	});

	it("没有前缀时裁剪视图不变、成本为零；前缀消息不计入历史 token 估算", () => {
		const messages = [
			msg("system", "系统提示"),
			msg("user", "第一问", { entryId: "e1" }),
			msg("assistant", "第一答", { entryId: "e2" }),
		];
		const { history, guidanceCostTokens } = splitGuidancePrefix(messages);
		expect(history).toEqual(messages);
		expect(guidanceCostTokens).toBe(0);
		// 对照：若前缀未被剔除，历史 token 估算会包含它
		const withPrefix = [
			messages[0]!,
			msg("user", "固定前缀".repeat(100), { kind: "runtime.guidance" }),
			...messages.slice(1),
		];
		const split = splitGuidancePrefix(withPrefix);
		expect(estimateStreamTokens(split.history, false)).toBe(estimateStreamTokens(messages, false));
	});

	it("端到端：压缩摘要不含固定前缀正文，重建后的请求前缀仍在 System 之后", async () => {
		const env = await IsolatedEnv.create({ prefix: "uina-compact-guidance-" });
		await env.writeExtension(
			"speech/index.ts",
			`export default async function (pi) {
	await pi.provideContext({ id: "instructions", kind: "guidance", file: "PROMPT.md" });
}`,
		);
		await env.writeFile(".uina/extensions/speech/PROMPT.md", "指南独有标记XYZ：语音要轻声。");
		// 种入足够长的历史，让 /compact 必然产生摘要
		const opened = await openJsonlSession(env.sessionPath);
		for (let i = 0; i < 30; i++) {
			const body = `历史${i} ${"词".repeat(4_000)}`;
			await opened.store.appendMessage({ role: i % 2 === 0 ? "user" : "assistant", content: body });
		}
		await opened.store.close();

		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });
		scenario.when((req) => (req.messages[0]?.content ?? "").includes("上下文摘要助手")).reply("摘".repeat(500));
		scenario.fallback(() => [
			{ kind: "text", text: "ok" },
			{ kind: "finish", reason: "stop" },
		]);
		const uina = await UinaTestHarness.create({ env, scenario });
		try {
			await uina.host.commands.dispatch("/compact");
			const summaryRequests = scenario.calls.filter((req) =>
				(req.messages[0]?.content ?? "").includes("上下文摘要助手"),
			);
			expect(summaryRequests.length).toBeGreaterThan(0);
			// 摘要输入是裁剪视图：固定前缀不进摘要，也不会让摘要窗口错位
			for (const req of summaryRequests) {
				expect(JSON.stringify(req.messages)).not.toContain("指南独有标记XYZ");
			}
			expect(await readFile(env.sessionPath, "utf8")).toContain("uina.compaction.summary");

			// 重建后的普通请求：前缀仍装配在 System 之后（每请求重新装配，不依赖历史）
			await uina.send("压缩后的一问");
			await uina.waitForIdle();
			const normal = scenario.calls.filter((req) => !(req.messages[0]?.content ?? "").includes("上下文摘要助手"));
			const last = normal.at(-1)!;
			expect(last.messages[0]!.role).toBe("system");
			expect(last.messages[1]!.context?.kind).toBe("runtime.guidance");
			expect(last.messages[1]!.content).toContain("指南独有标记XYZ");
		} finally {
			await uina.dispose();
			await env.dispose();
		}
	});
});
