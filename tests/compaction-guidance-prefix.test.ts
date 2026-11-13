import { readFile } from "node:fs/promises";
import { openJsonlSession } from "../src/session/jsonl-store.js";
import { describe, expect, it } from "vitest";
import { IsolatedEnv, Scenario, UinaTestHarness } from "./harness/index.js";

describe("Compaction 与固定扩展前缀（信息注入体系）", () => {
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
