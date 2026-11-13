/**
 * 旧 Session 兼容（验收矩阵 A15 / 反例 6）：旧 Journal 中的 `uina.prompt.snapshot`
 * auxiliary 记录与 `uina.compaction.summary` checkpoint 不再被运行时解释或续写，
 * 但旧 Session 必须照常打开、恢复主线、接受回溯与新请求；旧 System 文本不会被
 * 重新注入（systemPrompt 保持静态，由 Host 装配）。
 */

import { openJsonlSession } from "../src/session/jsonl-store.js";
import { UinaTestHarness } from "./harness/host/harness.js";
import { describe, expect, test } from "./harness/index.js";
import { Scenario } from "./harness/provider/scenario.js";

describe("旧 Journal 兼容：旧 prompt snapshot 记录不再解释、Session 仍可恢复", () => {
	test("含旧 prompt snapshot 与 compaction checkpoint 的 Session 可恢复主线并继续新请求", async ({ env }) => {
		const seeded = await openJsonlSession(env.sessionPath);
		await seeded.store.appendMessage({ role: "user", id: "old-1", content: "旧会话的第一问" }, "old-1");
		await seeded.store.appendMessage({ role: "assistant", id: "old-2", content: "旧会话的第一答" }, "old-2");
		// 旧运行时写下的辅助记录：legacy prompt snapshot + 旧 compaction checkpoint
		//（指纹按旧格式构造，恢复后不再作为运行时依据，也不影响打开）。
		await seeded.store.appendCustomEntry({
			customType: "uina.prompt.snapshot",
			data: {
				turnNumber: 1,
				fingerprint: "legacy-fingerprint",
				systemPrompt: "[旧运行时的 system prompt 文本]",
				injections: [{ extension: "builtin:legacy", kind: "systemPrompt", chars: 20, preview: "legacy" }],
			},
		});
		await seeded.store.appendCustomEntry({
			customType: "uina.compaction.summary",
			data: {
				version: 1,
				summary: "[历史摘要] 旧压缩摘要",
				coveredThroughEntryId: "old-1",
				tailStartsAtEntryId: "old-2",
				prefixFingerprint: "legacy-fingerprint-does-not-match",
				source: "manual",
			},
		});
		await seeded.store.close();

		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });
		scenario.fallback(() => [
			{ kind: "text", text: "ok" },
			{ kind: "finish", reason: "stop" },
		]);
		const uina = await UinaTestHarness.create({ env, scenario });
		try {
			// 主线照常恢复：旧 snapshot 记录被忽略，消息历史完整。
			expect(uina.host.historyCount()).toBe(2);

			await uina.send("恢复后的新问题", "direct");
			await uina.waitForIdle();
			const last = scenario.calls.at(-1);
			expect(last).toBeDefined();
			const contents = (last?.messages ?? []).map((m) => m.content ?? "");
			// systemPrompt 由当前 Host 装配，不含旧运行时的 system 文本。
			expect(contents[0]).not.toContain("[旧运行时的 system prompt 文本]");
			// 旧 checkpoint 指纹与主线不符：不生效（历史保持原样）。
			expect(contents.some((c) => c.startsWith("[历史摘要] 旧压缩摘要"))).toBe(false);
			// 旧消息完整可达。
			expect(contents.some((c) => c.includes("旧会话的第一问"))).toBe(true);

			// 回溯仍可用（旧 Session 的主线是安全的）。
			const rewind = await uina.host.session.requestRewind({ targetId: "old-1", reason: "legacy compat" }, "test");
			expect("status" in rewind ? rewind.status : "committed").toBe("committed");
		} finally {
			await uina.dispose();
		}
	});
});
