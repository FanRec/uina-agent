import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { paginate } from "../.uina/worlds/qq/src/pagination.js";

const binding = { account: "100", scope: "qq", kind: "contacts", filters: { keyword: "", state: "all" } };
const items = ["a", "b", "c", "d", "e"];

function firstCursor(): string {
	const result = paginate(items, { limit: 2 }, binding);
	expect(result.ok).toBe(true);
	if (!result.ok || !result.nextCursor) throw new Error("Expected a continuation cursor");
	return result.nextCursor;
}

function changedCursor(change: (payload: unknown[]) => unknown): string {
	return Buffer.from(
		JSON.stringify(change(JSON.parse(Buffer.from(firstCursor(), "base64url").toString("utf8")))),
	).toString("base64url");
}

describe("QQ stateless pagination", () => {
	it("continues all pages without duplicate or missing items", () => {
		const first = paginate(items, { limit: 2 }, binding);
		expect(first).toMatchObject({ ok: true, page: ["a", "b"], hasMore: true, total: 5 });
		if (!first.ok) throw new Error(first.detail);
		const second = paginate(items, { limit: 2, cursor: first.nextCursor }, binding);
		expect(second).toMatchObject({ ok: true, page: ["c", "d"], hasMore: true, total: 5 });
		if (!second.ok) throw new Error(second.detail);
		expect(paginate(items, { limit: 2, cursor: second.nextCursor }, binding)).toEqual({
			ok: true,
			page: ["e"],
			hasMore: false,
			total: 5,
		});
	});

	it("defaults to 20 and accepts a caller requested limit above 100", () => {
		const many = Array.from({ length: 150 }, (_, index) => index);
		const first = paginate(many, {}, binding);
		expect(first).toMatchObject({ ok: true, page: many.slice(0, 20), hasMore: true, total: 150 });
		expect(paginate(many, { limit: 125 }, binding)).toMatchObject({
			ok: true,
			page: many.slice(0, 125),
			hasMore: true,
			total: 150,
		});
		expect(paginate(many, { limit: 200 }, binding)).toEqual({ ok: true, page: many, hasMore: false, total: 150 });
	});

	it("supports a custom default without including a terminal cursor", () => {
		expect(paginate(items, {}, binding, 5)).toEqual({ ok: true, page: items, hasMore: false, total: 5 });
		expect(paginate([], {}, binding)).toEqual({ ok: true, page: [], hasMore: false, total: 0 });
	});

	it.each([0, -1, 1.5, "2", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid limit %s", (limit) => {
		expect(paginate(items, { limit }, binding)).toMatchObject({ ok: false, reason: "cursor_invalid" });
	});

	it("returns stale when list content or order changes", () => {
		const cursor = firstCursor();
		for (const changed of [["a", "b", "c", "d"], ["b", "a", "c", "d", "e"], ["a", "b", "changed", "d", "e"], []]) {
			expect(paginate(changed, { limit: 2, cursor }, binding)).toMatchObject({ ok: false, reason: "cursor_stale" });
		}
	});

	it.each([
		{ ...binding, account: "200" },
		{ ...binding, scope: "other" },
		{ ...binding, kind: "groups" },
		{ ...binding, filters: { keyword: "a", state: "all" } },
		{ ...binding, filters: { keyword: "", state: "pending" } },
	])("rejects a cursor used with different binding %j", (otherBinding) => {
		expect(paginate(items, { limit: 2, cursor: firstCursor() }, otherBinding)).toMatchObject({
			ok: false,
			reason: "cursor_invalid",
		});
	});

	it("rejects a cursor used with a different page limit", () => {
		expect(paginate(items, { limit: 3, cursor: firstCursor() }, binding)).toMatchObject({
			ok: false,
			reason: "cursor_invalid",
		});
	});

	it("canonicalizes equivalent object property order in binding and presented data", () => {
		const initial = paginate(
			[
				{ id: 1, name: "a" },
				{ id: 2, name: "b" },
			],
			{ limit: 1 },
			{ account: "100", filter: { state: "all", keyword: "" } },
		);
		if (!initial.ok) throw new Error(initial.detail);
		expect(
			paginate(
				[
					{ name: "a", id: 1 },
					{ name: "b", id: 2 },
				],
				{ limit: 1, cursor: initial.nextCursor },
				{ filter: { keyword: "", state: "all" }, account: "100" },
			),
		).toEqual({
			ok: true,
			page: [{ name: "b", id: 2 }],
			hasMore: false,
			total: 2,
		});
	});

	it.each([
		"",
		"not-a-cursor",
		"!!!!",
		null,
		12,
		Buffer.from("{oops").toString("base64url"),
		Buffer.from("{}").toString("base64url"),
	])("rejects malformed cursor %s", (cursor) => {
		expect(paginate(items, { limit: 2, cursor }, binding)).toMatchObject({ ok: false, reason: "cursor_invalid" });
	});

	it.each([
		(payload: unknown[]) => [1, ...payload.slice(1)],
		(payload: unknown[]) => [...payload, "extra"],
		(payload: unknown[]) => [payload[0], 123, ...payload.slice(2)],
		(payload: unknown[]) => [payload[0], payload[1], "wrong", payload[3]],
		(payload: unknown[]) => [payload[0], payload[1], payload[2], -1],
		(payload: unknown[]) => [payload[0], payload[1], payload[2], 1.5],
		(payload: unknown[]) => [payload[0], payload[1], payload[2], "2"],
		(payload: unknown[]) => [payload[0], payload[1], payload[2], Number.MAX_SAFE_INTEGER + 1],
		(payload: unknown[]) => [payload[0], payload[1], payload[2], 5],
	])("rejects invalid cursor version, shape, hashes or offset %#", (change) => {
		expect(paginate(items, { limit: 2, cursor: changedCursor(change) }, binding)).toMatchObject({
			ok: false,
			reason: "cursor_invalid",
		});
	});

	it("resumes a cursor in an independent process without retained state", () => {
		const moduleUrl = new URL("../.uina/worlds/qq/src/pagination.ts", import.meta.url).href;
		const code = `import { paginate } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(paginate(${JSON.stringify(items)}, ${JSON.stringify({ limit: 2, cursor: firstCursor() })}, ${JSON.stringify(binding)})));`;
		const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
			encoding: "utf8",
		});
		expect(JSON.parse(output)).toMatchObject({ ok: true, page: ["c", "d"], hasMore: true, total: 5 });
	});
});
