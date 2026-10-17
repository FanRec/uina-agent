/**
 * Minecraft World 提交屏障覆盖（world.md §6.2）。
 *
 * 屏障要证明的只有一件事：read 返回时，**本次调用之前已接收**的全部条目（事实与缺口，
 * 跨流，含封口决定的区间）都已完成提交或被明确判为故障——不因未落盘被静默遗漏，
 * 也不因某一流封口而卡死。
 */

import { describe, expect, it } from "vitest";
import { createWorld } from "../.uina/worlds/minecraft/world/index.js";
import {
	type AppendOutcome,
	MemoryWorldStore,
	type StoredEntry,
} from "../.uina/worlds/minecraft/world/internal/store.js";
import { FakeClientFacts, capturedFact } from "./minecraft-world-fake-facts.js";

const HISTORY_QUERY = { ref: "evidence.list@1", input: {} } as const;

/** 每次提交延迟一个宏任务：让"接收"与"提交"真实交错。 */
class SlowCommitStore extends MemoryWorldStore {
	override async append(entries: StoredEntry[]): Promise<AppendOutcome> {
		await new Promise((resolve) => setTimeout(resolve, 1));
		return super.append(entries);
	}
}

interface ItemView {
	kind: "fact" | "gap";
	ref: string;
}

function items(observation: { value: unknown }): ItemView[] {
	return (observation.value as { items: ItemView[] }).items;
}

describe("minecraft world 提交屏障覆盖", () => {
	it("多流事实 + 缺口 + 封口：一次读取覆盖全部已接收条目，且不因封口卡死", async () => {
		const facts = new FakeClientFacts();
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		try {
			facts.emitEvidence([capturedFact({ stream: "mcw:test:stream:a", sequence: 1 })]);
			facts.emitGap("mcw:gap:b1", "mcw:test:stream:b", 0, 2);
			facts.emitEvidence([capturedFact({ stream: "mcw:test:stream:a", sequence: 3 })]);
			// 封口不产生待落盘条目：它只把未知后缀缺口解析为有限区间。
			facts.emitEnd({ stream: "mcw:test:stream:b", sequence: 3 });

			const observation = await world.read(HISTORY_QUERY);
			const seen = items(observation);
			expect(seen).toHaveLength(3); // a:1、b 缺口、a:3
			expect(seen.filter((i) => i.kind === "gap")).toHaveLength(1);
			expect(seen.filter((i) => i.kind === "fact")).toHaveLength(2);
			// durable：a 的连续前缀 1，b 的缺口 (0,2] 与 (2,3] 由封口闭合到 3。
			const durable = new Map<string, number>();
			for (const ack of facts.acks) durable.set(ack.stream, ack.durableThrough);
			expect(durable.get("mcw:test:stream:b")).toBe(2);
		} finally {
			await world.close();
		}
	});

	it("提交交错：并发接收与并发读取下不遗漏、不重复交付、不卡死", async () => {
		const facts = new FakeClientFacts();
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new SlowCommitStore() });
		try {
			const reads: Promise<number>[] = [];
			for (let seq = 1; seq <= 6; seq += 1) {
				facts.emitEvidence([capturedFact({ sequence: seq })]);
				if (seq % 2 === 0) {
					// 与后续接收交错：每次读取都必须覆盖其调用时刻的接收上界。
					reads.push(world.read(HISTORY_QUERY).then((observation) => items(observation).length));
				}
			}
			const observed = await Promise.all(reads);
			// 单调：后发起的读取不会看到更少的已提交条目。
			expect([...observed].sort((a, b) => a - b)).toEqual(observed);
			expect(observed.every((count) => count > 0)).toBe(true);

			const last = await world.read(HISTORY_QUERY);
			expect(items(last)).toHaveLength(6);
			expect(facts.acks.at(-1)?.durableThrough).toBe(6);
		} finally {
			await world.close();
		}
	});

	it("cursor 与读取视图同源：无新提交时连续两次读取给出同一 cursor", async () => {
		const facts = new FakeClientFacts();
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store: new MemoryWorldStore() });
		try {
			facts.emitEvidence([capturedFact({ sequence: 1 })]);
			const first = await world.read(HISTORY_QUERY);
			const second = await world.read(HISTORY_QUERY);
			expect(second.cursor).toEqual(first.cursor);

			// 有新提交后 cursor 前进（单调），旧 cursor 不再声明覆盖新视图。
			facts.emitEvidence([capturedFact({ sequence: 2 })]);
			const third = await world.read(HISTORY_QUERY);
			expect(third.cursor.sequence).toBeGreaterThan(first.cursor.sequence);
		} finally {
			await world.close();
		}
	});
});
