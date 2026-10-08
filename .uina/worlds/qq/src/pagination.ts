import { createHash } from "node:crypto";

type PaginationResult<T> =
	| { ok: true; page: T[]; hasMore: boolean; nextCursor?: string; total: number }
	| { ok: false; reason: "cursor_invalid" | "cursor_stale"; detail: string };

/** Hash JSON-visible data with ordered arrays and canonical object property order. */
function fingerprint(value: Record<string, unknown> | readonly unknown[]): string {
	const serialized = JSON.stringify(value, (_key: string, current: unknown): unknown => {
		if (current === null || typeof current !== "object" || Array.isArray(current)) return current;
		const record = current as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, record[key]]),
		);
	});
	return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

/** Callers supply freshly fetched, deterministically ordered and filtered display items. */
export function paginate<T>(
	items: readonly T[],
	params: { readonly limit?: unknown; readonly cursor?: unknown },
	binding: Record<string, unknown>,
	defaultLimit = 20,
): PaginationResult<T> {
	const limit = params.limit === undefined ? defaultLimit : params.limit;
	if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
		return { ok: false, reason: "cursor_invalid", detail: "limit must be a positive safe integer" };
	}
	const queryHash = fingerprint({ binding, limit });
	const dataHash = fingerprint(items);
	let position = 0;
	if (params.cursor !== undefined) {
		const cursor = params.cursor;
		if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
			return { ok: false, reason: "cursor_invalid", detail: "cursor must be a base64url string" };
		}
		let payload: unknown;
		try {
			const decoded = Buffer.from(cursor, "base64url");
			if (decoded.toString("base64url") !== cursor) throw new Error("Non-canonical base64url");
			payload = JSON.parse(decoded.toString("utf8"));
		} catch {
			return { ok: false, reason: "cursor_invalid", detail: "cursor encoding or JSON is invalid" };
		}
		if (
			!Array.isArray(payload) ||
			payload.length !== 4 ||
			payload[0] !== 2 ||
			typeof payload[1] !== "string" ||
			!/^[a-f0-9]{16}$/.test(payload[1]) ||
			typeof payload[2] !== "string" ||
			!/^[a-f0-9]{16}$/.test(payload[2]) ||
			!Number.isSafeInteger(payload[3]) ||
			payload[3] < 0
		) {
			return {
				ok: false,
				reason: "cursor_invalid",
				detail: "cursor version, shape, fingerprint or position is invalid",
			};
		}
		if (payload[1] !== queryHash) {
			return {
				ok: false,
				reason: "cursor_invalid",
				detail: "cursor belongs to a different query, account, scope or limit",
			};
		}
		if (payload[2] !== dataHash) {
			return { ok: false, reason: "cursor_stale", detail: "list data changed; restart pagination without a cursor" };
		}
		position = payload[3];
		if (position >= items.length) {
			return { ok: false, reason: "cursor_invalid", detail: "cursor position is outside the continuation range" };
		}
	}
	const end = Math.min(items.length, position + limit);
	const hasMore = end < items.length;
	return {
		ok: true,
		page: items.slice(position, end),
		hasMore,
		...(hasMore
			? { nextCursor: Buffer.from(JSON.stringify([2, queryHash, dataHash, end])).toString("base64url") }
			: {}),
		total: items.length,
	};
}
