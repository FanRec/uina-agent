/**
 * Watch 类别化失效（批22 P1-4 / public-api §9.2 类别化口径）。
 *
 * 历史缺陷：commit 是单一全局序号，物理拍每 tick 推进——等待 inventory@1 的程序
 * 在背包完全没变时也被 20Hz 唤醒重读。类别化后：游标 = 依赖类别修订之和，
 * 无关提交不再推进水位；未声明的查询保守回退全局序号。
 */
import { describe, expect, test } from "vitest";
import { emptyFactRevisions, queryRevision } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { Fact } from "../../.uina/worlds/minecraft/contracts/values.js";
import { CurrentReads, type QueryDependencies } from "../../.uina/worlds/minecraft/world/current.js";
import { makeFactsHarness } from "./mc-fake.js";

const nullFact = (): Fact<null> => ({
	value: null,
	observedAt: "t",
	source: "server",
	coverage: "complete",
	unknown: [],
	evidence: [],
});

const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};

async function openWatch(deps: QueryDependencies) {
	const h = makeFactsHarness();
	const reads = new CurrentReads(h.facts);
	const first = await reads.read("inventory@1", {}, nullFact, deps);
	const watch = await reads.watch("inventory@1", {}, new AbortController().signal, deps);
	let settled: string | null = null;
	const pending = watch.next(first.cursor!, new AbortController().signal).then((change) => {
		settled = change.kind;
		return change;
	});
	return { h, watch, pending, settled: () => settled };
}

describe("watch 类别化失效", () => {
	test("依赖 inventory 的等待不被物理拍唤醒；真实槽位更新立即醒", async () => {
		const { h, pending, settled } = await openWatch(["inventory"]);
		for (let i = 0; i < 10; i++) h.bot().emit("physicsTick");
		await flush();
		expect(settled()).toBeNull(); // 背包没变：20Hz 提交不再唤醒
		(h.bot().inventory as unknown as { emit: () => void }).emit();
		await flush();
		expect(await pending).toMatchObject({ kind: "changed" });
	});

	test("多类别依赖（self+inventory）：self 类提交同样推进", async () => {
		const { h, pending, settled } = await openWatch(["self", "inventory"]);
		h.bot().emit("move"); // self 类提交（自己也是实体）
		await flush();
		expect(settled()).toBe("changed");
		await pending;
	});

	test("未声明依赖的查询保守回退全局序号：物理拍仍唤醒", async () => {
		const { h, pending, settled } = await openWatch(undefined);
		h.bot().emit("physicsTick");
		await flush();
		expect(settled()).toBe("changed");
		await pending;
	});

	test("依赖 world 的查询被物理拍唤醒（ticks 连续变化，诚实推进）", async () => {
		const { h, pending, settled } = await openWatch(["world"]);
		h.bot().emit("physicsTick");
		await flush();
		expect(settled()).toBe("changed");
		await pending;
	});

	test("断线换代仍返回 reset（不因类别化丢失失效）", async () => {
		const { h, pending, settled } = await openWatch(["inventory"]);
		h.disconnect();
		await flush();
		expect(settled()).toBe("reset");
		const change = await pending;
		expect(change.kind).toBe("reset");
	});

	test("queryRevision：依赖类别之和单调推进，无关类别不影响", () => {
		const revisions = emptyFactRevisions();
		expect(queryRevision(revisions, ["inventory"])).toBe(0);
		revisions.inventory += 1;
		expect(queryRevision(revisions, ["inventory"])).toBe(1);
		revisions.self += 3; // 无关类别：inventory 游标不动
		expect(queryRevision(revisions, ["inventory"])).toBe(1);
		expect(queryRevision(revisions, ["self", "inventory"])).toBe(4);
	});
});
