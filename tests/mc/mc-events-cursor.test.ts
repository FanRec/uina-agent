import { describe, expect, test } from "vitest";
import type { CallFailure } from "../../.uina/worlds/minecraft/contracts/values.js";
import {
	buildEventPage,
	decodeCursor,
	encodeCursor,
	eventScopeOf,
	parseEventInput,
	resolveEventQuery,
} from "../../.uina/worlds/minecraft/world/events.js";

/**
 * events@1 游标与分页（capabilities §3 events / world §8.5）。
 *
 * 这些用例锁住三条容易回归的语义：
 * 1. after/next 是两件事：after 指向本次扫描上界，next 固定过滤与上界继续翻页；
 * 2. kinds 由游标固定，续页不能换过滤；
 * 3. 游标跨分区失效（换绑定/存档代次 → SNAPSHOT_EXPIRED）。
 */

const scope = eventScopeOf("bind:t", "wld:t", "wldrev:t");

function failureOf(run: () => unknown): CallFailure {
	try {
		run();
	} catch (err) {
		return err as CallFailure;
	}
	throw new Error("expected the call to throw CallFailure");
}

describe("events 输入校验", () => {
	test("cursor 不能与 kinds/after/limit 同时出现", () => {
		const err = failureOf(() => parseEventInput({ cursor: "x", kinds: ["chat"] }));
		expect(err.code).toBe("INVALID_INPUT");
		expect(err.source).toBe("input");
	});

	test("kinds 不能为空数组；未知 kind 拒绝", () => {
		expect(failureOf(() => parseEventInput({ kinds: [] })).code).toBe("INVALID_INPUT");
		expect(failureOf(() => parseEventInput({ kinds: ["system"] })).code).toBe("INVALID_INPUT");
	});

	test("limit 1..200，缺省 50", () => {
		expect(parseEventInput({}).limit).toBe(50);
		expect(failureOf(() => parseEventInput({ limit: 0 })).code).toBe("INVALID_INPUT");
		expect(failureOf(() => parseEventInput({ limit: 201 })).code).toBe("INVALID_INPUT");
	});
});

describe("events 游标", () => {
	test("编码/解码往返保留分区、过滤、位置与上界", () => {
		const token = encodeCursor({
			v: 1,
			partition: scope.partition,
			kinds: ["chat", "damage"],
			limit: 20,
			pos: 7,
			upper: 30,
		});
		const cursor = decodeCursor(token, scope);
		expect(cursor).toEqual({
			v: 1,
			partition: scope.partition,
			kinds: ["chat", "damage"],
			limit: 20,
			pos: 7,
			upper: 30,
		});
	});

	test("跨分区使用 → SNAPSHOT_EXPIRED", () => {
		const other = eventScopeOf("bind:u", "wld:u", "wldrev:u");
		const token = encodeCursor({ v: 1, partition: scope.partition, kinds: null, limit: 10, pos: 0, upper: 5 });
		const err = failureOf(() => decodeCursor(token, other));
		expect(err.code).toBe("SNAPSHOT_EXPIRED");
	});

	test("伪造/损坏 token → INVALID_INPUT（不当作从头开始）", () => {
		expect(failureOf(() => decodeCursor("not-base64-json", scope)).code).toBe("INVALID_INPUT");
	});

	test("after 不能换过滤：kinds 与 token 不一致 → INVALID_INPUT", () => {
		const after = encodeCursor({ v: 1, partition: scope.partition, kinds: ["chat"], limit: 50, pos: 9, upper: 9 });
		expect(failureOf(() => resolveEventQuery({ after, kinds: ["damage"] }, scope)).code).toBe("INVALID_INPUT");
	});

	test("after 续读沿用 token 的过滤条件", () => {
		const after = encodeCursor({ v: 1, partition: scope.partition, kinds: ["chat"], limit: 50, pos: 9, upper: 9 });
		const { params } = resolveEventQuery({ after, limit: 30 }, scope);
		expect(params.kinds).toEqual(["chat"]);
		expect(params.afterRowid).toBe(9);
		expect(params.upper).toBeNull();
		expect(params.limit).toBe(30);
	});
});

describe("events 页成形", () => {
	const row = (rowid: number) => ({
		rowid,
		ref: `ev:t:${rowid}`,
		observedAt: "2026-01-01T00:00:00.000Z",
		dimension: "overworld",
		payload: { kind: "chat" },
	});

	test("还有下一页：给 next（固定上界），不给 after", () => {
		const params = { scope, kinds: null, afterRowid: 10, upper: 99, limit: 2 };
		const page = buildEventPage({ rows: [row(11), row(12)], gaps: [], upper: 99, hasMore: true }, params);
		expect(page.after).toBeUndefined();
		expect(page.next).toBeDefined();
		const next = decodeCursor(page.next as string, scope);
		expect(next.pos).toBe(12);
		expect(next.upper).toBe(99);
		expect(next.limit).toBe(2);
	});

	test("读完后 after 指向本次扫描上界（空页也推进）", () => {
		const params = { scope, kinds: null, afterRowid: 10, upper: 20, limit: 5 };
		const page = buildEventPage({ rows: [row(11)], gaps: [], upper: 20, hasMore: false }, params);
		const after = decodeCursor(page.after as string, scope);
		expect(after.pos).toBe(20);
		expect(after.upper).toBe(20);
		const empty = buildEventPage(
			{ rows: [], gaps: [], upper: 33, hasMore: false },
			{ ...params, afterRowid: 20, upper: null },
		);
		expect(decodeCursor(empty.after as string, scope).pos).toBe(33);
	});

	test("gaps 原样透出，事件只保留 ref 作为证据", () => {
		const page = buildEventPage(
			{
				rows: [row(1)],
				gaps: [{ ref: "gap:t:1", reason: "overflow", after: "3", through: null }],
				upper: 1,
				hasMore: false,
			},
			{ scope, kinds: null, afterRowid: null, upper: null, limit: 50 },
		);
		expect(page.gaps).toHaveLength(1);
		expect(page.events[0]?.ref).toBe("ev:t:1");
		expect(page.events[0]?.evidence).toEqual([]);
	});
});
