import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import {
	SessionNavigationError,
	listSessionBranches,
	readSessionBranch,
} from "../src/session/navigation.js";

/**
 * 分支查询（P1.3 / P1.4 的回归网）。
 *
 * 这两个函数此前**零测试覆盖**，却在 P1.4 里被改写了内部实现
 * （不再重算全部分支再 find，而是直接用手上已有的 rewind 记录构造）。
 * 因此这里最关键的一条是**等价性对拍**：同一份记录，两条路径给出的 branch 必须逐字段相同。
 */
async function seedWithTwoBranches() {
	const store = new MemorySessionStore();
	await store.appendMessage({ role: "user", content: "original task" });
	await store.appendMessage({ role: "assistant", content: "bad plan" });
	const target = store.readRecords()[0].id;
	const cutAt = store.readRecords()[1].id;
	await store.appendRewind({ id: "r1", requestId: "q1", targetId: target, fromId: cutAt, source: "user", reason: "bad premise" });
	await store.appendMessage({ role: "assistant", content: "corrected plan" });
	const beforeSecond = store.readRecords().at(-1)!.id;
	await store.appendRewind({ id: "r2", requestId: "q2", targetId: target, fromId: beforeSecond, source: "user", reason: "again" });
	return { store, records: store.readRecords(), target, cutAt };
}

describe("listSessionBranches", () => {
	it("为每条 rewind 记录产出一个分支，headId 指向被保留的那一端", async () => {
		const { records, cutAt } = await seedWithTwoBranches();
		const { branches } = listSessionBranches(records);
		expect(branches.map((b) => b.id)).toEqual(["r1", "r2"]);
		expect(branches[0]).toMatchObject({
			id: "r1",
			fromId: cutAt,
			headId: cutAt,
			reason: "bad premise",
		});
		expect(typeof branches[0].createdAt).toBe("string");
	});

	it("nodeCount 是分支区间内去掉 rewind 自身后的节点数", async () => {
		const { records } = await seedWithTwoBranches();
		const { branches } = listSessionBranches(records);
		for (const b of branches) {
			expect(b.nodeCount).toBeGreaterThanOrEqual(0);
			expect(Number.isInteger(b.nodeCount)).toBe(true);
		}
	});
});

describe("readSessionBranch", () => {
	it("返回的 branch 与 listSessionBranches 中同 id 的那条完全一致（P1.4 等价性对拍）", async () => {
		const { records } = await seedWithTwoBranches();
		const { branches } = listSessionBranches(records);
		for (const expected of branches) {
			const { branch } = readSessionBranch(records, expected.id);
			expect(branch).toEqual(expected);
		}
	});

	it("返回的 nodes 是映射后的 SessionNodeInfo（带 preview），且每条分支都不含自己的 rewind 节点", async () => {
		const { records } = await seedWithTwoBranches();
		const { branches } = listSessionBranches(records);
		expect(branches.length).toBeGreaterThan(1);
		for (const b of branches) {
			const { nodes } = readSessionBranch(records, b.id);
			expect(nodes.length).toBeGreaterThan(0);
			for (const n of nodes) {
				// 切片上界若算错（多含一格），这条分支自己的 rewind 节点就会漏进来。
				expect(n.id).not.toBe(b.id);
				expect(typeof n.preview).toBe("string");
				expect(n).toHaveProperty("active");
				expect(n).toHaveProperty("canRewind");
			}
		}
	});

	it("更早的 rewind 节点会出现在后一次回溯的 nodes 里（它确实被这次回溯放弃了）", async () => {
		const { records } = await seedWithTwoBranches();
		// r2 回退到 m1，区间覆盖 [m2, r1, m3] —— r1 是先前那次回溯的记录，也被放弃。
		const { nodes } = readSessionBranch(records, "r2");
		expect(nodes.map((n) => n.id)).toContain("r1");
	});

	it("nodeCount 与返回的 nodes 数量一致", async () => {
		const { records } = await seedWithTwoBranches();
		const { branch, nodes } = readSessionBranch(records, "r1");
		expect(branch.nodeCount).toBe(nodes.length);
	});

	it("未知分支 id 抛 SessionNavigationError（而不是 TypeError）", async () => {
		const { records } = await seedWithTwoBranches();
		expect(() => readSessionBranch(records, "nope")).toThrow(SessionNavigationError);
		expect(() => readSessionBranch(records, "nope")).toThrow("未知会话分支");
	});
});
