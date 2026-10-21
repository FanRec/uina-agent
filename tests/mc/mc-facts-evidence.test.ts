import { describe, expect, test } from "vitest";
import type { ClientFactNotice, ClientFactsSubscription } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { FactsSource } from "../../.uina/worlds/minecraft/driver/facts.js";
import { makeFactsHarness } from "./mc-fake.js";

/**
 * 证据保留回归（world.md §5.4 / public-api §4.1）。
 *
 * 三个历史缺陷：
 * 1. 释放水线取"全部订阅者"最小值，只读 watch 从不 ack → 永不释放，1024 条后报假缺口。
 * 2. acknowledge 忽略 ack.stream，reset 换流后旧流高位覆盖新流 → 证据在落盘前被释放。
 * 3. 无证据消费者时的"保留 + 溢出报 gap"是正确行为，不能被修复 1 顺手删掉。
 */

const MAX_PENDING = 1024;

interface Recorder {
	notices: ClientFactNotice[];
	subscription(): ClientFactsSubscription;
	gaps(): { stream: string; after: number }[];
}

/** 订阅并记录通知；consume=true 时按"收到即持久"确认，模拟历史存储。 */
function record(facts: FactsSource, options: { consume: boolean }): Recorder {
	const notices: ClientFactNotice[] = [];
	let sub: ClientFactsSubscription | null = null;
	sub = facts.subscribe(
		(notice) => {
			notices.push(notice);
			if (!options.consume || notice.kind !== "evidence") return;
			const mark = notice.records[0]?.mark;
			if (mark == null) return;
			sub?.acknowledge({ receiver: "recv:t:1", stream: mark.stream, durableThrough: mark.sequence });
		},
		{ consumesEvidence: options.consume },
	);
	return {
		notices,
		subscription: () => {
			if (sub != null) return sub;
			throw new Error("subscription not created");
		},
		gaps: () =>
			notices
				.filter((n): n is Extract<ClientFactNotice, { kind: "evidence_gap" }> => n.kind === "evidence_gap")
				.map((n) => ({ stream: n.stream, after: n.after })),
	};
}

describe("证据释放水线", () => {
	test("只读订阅者不阻塞已确认证据的释放：消费方持续 ack 时缓冲区不溢出", () => {
		const h = makeFactsHarness();
		const watcher = record(h.facts, { consume: false }); // 只读观察者，从不 ack
		const consumer = record(h.facts, { consume: true });
		for (let i = 0; i < MAX_PENDING + 200; i++) h.emitMessage(`m${i}`);
		expect(consumer.gaps()).toEqual([]);
		// 非消费者同样收不到假缺口（它本来就不参与释放判定）
		expect(watcher.gaps()).toEqual([]);
	});

	test("无证据消费者时保留缓冲，溢出如实报缺口（不静默丢弃）", () => {
		const h = makeFactsHarness();
		const watcher = record(h.facts, { consume: false });
		for (let i = 0; i < MAX_PENDING + 2; i++) h.emitMessage(`m${i}`);
		const gaps = watcher.gaps();
		expect(gaps.length).toBeGreaterThan(0);
		// 一条都没确认过：缺口从 0 起覆盖整个后缀
		expect(gaps[0]?.after).toBe(0);
	});

	test("换流后旧流的确认不授权新流：新流序号 1 起一条都没被释放", () => {
		const h = makeFactsHarness();
		const consumer = record(h.facts, { consume: false });
		for (let i = 0; i < 5; i++) h.emitMessage(`old${i}`);
		const stream1 = h.facts.evidenceThrough.stream;
		consumer.subscription().acknowledge({ receiver: "recv:t:1", stream: stream1, durableThrough: 5 });

		h.disconnect();
		h.reconnect();
		const stream2 = h.facts.evidenceThrough.stream;
		expect(stream2).not.toBe(stream1);
		for (let i = 0; i < 100; i++) h.emitMessage(`after-reset${i}`);
		// 迟到的旧流确认（序号远大于新流长度）不得推进新流释放水线
		consumer.subscription().acknowledge({ receiver: "recv:t:1", stream: stream1, durableThrough: 100 });

		for (let i = 0; i < MAX_PENDING + 2; i++) h.emitMessage(`new${i}`);
		const gaps = consumer.gaps();
		expect(gaps.length).toBeGreaterThan(0);
		// 若旧高位被误当新流确认，前 100 条已被释放，缺口会从 100 起而不是从 0 起
		expect(gaps[0]).toEqual({ stream: stream2, after: 0 });
	});
});
