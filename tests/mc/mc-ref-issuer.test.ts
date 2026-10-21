import { describe, expect, test } from "vitest";
import type { ClientFactNotice } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import { makeFactsHarness } from "./mc-fake.js";

/**
 * 引用发号回归（world.md §5.3：证据流与证据 ref 不可跨启动复用）。
 *
 * 历史缺陷：证据 ref 形如 `ev:1`、`gap:1`，每进程从 1 重来；这些 ref 随
 * CapturedClientFact 落 world-history.db，第二次启动必然与已提交记录冲突。
 * 流名（evs:<ns>:<n>）当时已带命名空间，证据 ref 漏了。
 */

const MAX_PENDING = 1024;

function firstNotice(notices: ClientFactNotice[], kind: string): ClientFactNotice | undefined {
	return notices.find((n) => n.kind === kind);
}

describe("证据 ref 带启动命名空间", () => {
	test("ev/gap ref 与流名同源，形如 <prefix>:<ns>:<n>", () => {
		const h = makeFactsHarness();
		const notices: ClientFactNotice[] = [];
		h.facts.subscribe((notice) => notices.push(notice));
		h.emitMessage("hello");

		const evidence = firstNotice(notices, "evidence");
		expect(evidence?.kind).toBe("evidence");
		if (evidence?.kind !== "evidence") return;
		const record = evidence.records[0];
		expect(record?.ref).toMatch(/^ev:t:\d+$/);
		expect(record?.mark.stream).toMatch(/^evs:t:\d+$/);

		// 溢出缺口同样带命名空间
		for (let i = 0; i < MAX_PENDING + 2; i++) h.emitMessage(`m${i}`);
		const gap = firstNotice(notices, "evidence_gap");
		if (gap?.kind !== "evidence_gap") throw new Error("expected an evidence_gap notice");
		expect(gap.ref).toMatch(/^gap:t:\d+$/);
	});

	test("两次启动（不同命名空间）不会发出同一个证据 ref", () => {
		const refs = new Set<string>();
		for (const ns of ["boot1", "boot2"]) {
			const h = makeFactsHarness({ namespace: ns });
			const notices: ClientFactNotice[] = [];
			h.facts.subscribe((notice) => notices.push(notice));
			h.emitMessage("hello");
			const evidence = firstNotice(notices, "evidence");
			if (evidence?.kind !== "evidence") throw new Error("expected an evidence notice");
			const ref = evidence.records[0]?.ref ?? "";
			expect(ref.startsWith(`ev:${ns}:`)).toBe(true);
			refs.add(ref);
		}
		expect(refs.size).toBe(2);
	});
});
