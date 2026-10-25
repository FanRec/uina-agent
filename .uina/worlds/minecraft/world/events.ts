/**
 * events@1：历史视图的输入规范化、游标编解码与页成形。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md#events、modules/world.md §8.5。
 * 游标只编码"哪个历史分区、哪组 kinds、读到哪个 rowid、本次扫描上界、页大小"；
 * 它不代表模型已读，也不绑定连接/Run。kinds 由游标固定，续页不能换过滤。
 * 本文件不碰 SQL：读取由 sqlite-worker 执行，这里只做纯值换算。
 */

import { callFailure } from "../contracts/values.js";
import type { JsonValue } from "../contracts/values.js";
import type { EventGap, EventPage, GameEventKind, GameEventRecord } from "../contracts/world.js";

export const EVENTS_REF = "events@1";

const KINDS: GameEventKind[] = ["chat", "damage", "death", "connection"];

/** 历史分区：binding/world/worldRevision 三元组；换绑定或存档代次即失效。 */
export interface EventScope {
	partition: string;
	binding: string;
	world: string;
	worldRevision: string;
}

export function eventScopeOf(binding: string, world: string, worldRevision: string): EventScope {
	return { partition: JSON.stringify([binding, world, worldRevision]), binding, world, worldRevision };
}

export interface EventCursor {
	v: 1;
	/** 历史分区键（eventScopeOf 的结果）；换分区后旧游标失效。 */
	partition: string;
	/** null = 不过滤（全部四类）。 */
	kinds: GameEventKind[] | null;
	limit: number;
	/** 已读取到的 evidence.rowid；0 表示从可读下界开始。 */
	pos: number;
	/** 本次扫描上界；分页期间保持不变，不追逐新消息。 */
	upper: number;
}

export interface EventInput {
	kinds: GameEventKind[] | null;
	limit: number;
	cursorToken: string | null;
	afterToken: string | null;
}

export interface EventRow {
	rowid: number;
	ref: string;
	observedAt: string;
	dimension: string | null;
	payload: JsonValue;
}

export interface EventQueryParams {
	scope: EventScope;
	kinds: GameEventKind[] | null;
	/** null = 最近窗口（倒序取尾部）。 */
	afterRowid: number | null;
	upper: number | null;
	limit: number;
}

export interface EventQueryResult {
	rows: EventRow[];
	gaps: EventGap[];
	upper: number;
	hasMore: boolean;
}

function invalid(message: string, hint?: string): never {
	throw callFailure({
		code: "INVALID_INPUT",
		source: "input",
		message,
		hint,
		dispatch: "not_sent",
		effects: [],
		recoverable: true,
	});
}

export function encodeCursor(cursor: EventCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(token: string, scope: EventScope): EventCursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
	} catch {
		invalid("events cursor is not a valid token", "pass the token returned by a previous events read");
	}
	const raw = parsed as Partial<EventCursor> | null;
	if (
		raw == null ||
		raw.v !== 1 ||
		typeof raw.partition !== "string" ||
		typeof raw.limit !== "number" ||
		typeof raw.pos !== "number" ||
		typeof raw.upper !== "number"
	) {
		invalid("events cursor has an unsupported shape", "tokens are opaque; do not construct them by hand");
	}
	if (raw.partition !== scope.partition) {
		throw callFailure({
			code: "SNAPSHOT_EXPIRED",
			source: "world",
			message: "events cursor belongs to another world partition",
			hint: "re-read without after to start from the current history",
			dispatch: "not_sent",
			effects: [],
			recoverable: true,
		});
	}
	const kinds =
		raw.kinds == null
			? null
			: (raw.kinds as GameEventKind[]).filter((kind): kind is GameEventKind => KINDS.includes(kind));
	return {
		v: 1,
		partition: raw.partition,
		kinds: raw.kinds == null ? null : kinds,
		limit: Math.max(1, Math.min(200, Math.floor(raw.limit))),
		pos: Math.max(0, Math.floor(raw.pos)),
		upper: Math.max(0, Math.floor(raw.upper)),
	};
}

/** 请求级校验：cursor 与 kinds/after/limit 互斥（capabilities §3 events）。 */
export function parseEventInput(input: JsonValue): EventInput {
	const raw = (input ?? {}) as Record<string, JsonValue>;
	if (raw.cursor != null) {
		for (const forbidden of ["kinds", "after", "limit"]) {
			if (raw[forbidden] != null) {
				invalid(
					`events cursor cannot be combined with ${forbidden}`,
					"the cursor already fixes the filter and page size",
				);
			}
		}
		if (typeof raw.cursor !== "string") invalid("events cursor must be a string");
		return { kinds: null, limit: 0, cursorToken: raw.cursor, afterToken: null };
	}
	if (raw.after != null && typeof raw.after !== "string") invalid("events after must be a string");
	const limit = raw.limit == null ? 50 : raw.limit;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200) {
		invalid("events limit must be an integer within 1..200");
	}
	let kinds: GameEventKind[] | null = null;
	if (raw.kinds != null) {
		if (!Array.isArray(raw.kinds) || raw.kinds.length === 0) {
			invalid("events kinds must be a non-empty array when present");
		}
		for (const kind of raw.kinds) {
			if (typeof kind !== "string" || !KINDS.includes(kind as GameEventKind)) {
				invalid(`unknown event kind: ${String(kind)}`, `known kinds: ${KINDS.join(", ")}`);
			}
		}
		kinds = [...new Set(raw.kinds as GameEventKind[])];
	}
	return { kinds, limit, cursorToken: null, afterToken: typeof raw.after === "string" ? raw.after : null };
}

function sameKinds(a: GameEventKind[] | null, b: GameEventKind[] | null): boolean {
	if (a == null || b == null) return a == b;
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every((kind) => set.has(kind));
}

/** 第二段解析：token 需要分区才能解码；after 的过滤条件由 token 固定。 */
export function resolveEventQuery(
	input: JsonValue,
	scope: EventScope,
): { params: EventQueryParams; cursor: EventCursor | null } {
	const parsed = parseEventInput(input);
	if (parsed.cursorToken != null) {
		const cursor = decodeCursor(parsed.cursorToken, scope);
		return {
			params: {
				scope,
				kinds: cursor.kinds,
				afterRowid: cursor.pos,
				upper: cursor.upper,
				limit: cursor.limit,
			},
			cursor,
		};
	}
	if (parsed.afterToken != null) {
		const after = decodeCursor(parsed.afterToken, scope);
		// 过滤条件由 token 固定：不能借同一次续读换 kinds（"全部"与显式列表都算换过滤）。
		if (parsed.kinds != null && !sameKinds(parsed.kinds, after.kinds)) {
			invalid("events after token fixes the kind filter", "start a new read without after to change kinds");
		}
		return {
			params: {
				scope,
				kinds: after.kinds,
				afterRowid: after.pos,
				upper: null,
				limit: parsed.limit,
			},
			cursor: null,
		};
	}
	return {
		params: { scope, kinds: parsed.kinds, afterRowid: null, upper: null, limit: parsed.limit },
		cursor: null,
	};
}

/**
 * 页成形：分页未读完给 next（固定过滤与上界），读完给 after（指向本次扫描上界）。
 * gaps 是分区内的已知缺口；重复读取同一 gap ref 不代表新的丢失。
 */
export function buildEventPage(result: EventQueryResult, params: EventQueryParams): EventPage {
	const events: GameEventRecord[] = result.rows.map((row) => ({
		ref: row.ref,
		receivedAt: row.observedAt,
		dimension: row.dimension,
		payload: row.payload,
		evidence: [],
	}));
	if (result.hasMore) {
		const rowid = result.rows.length > 0 ? result.rows[result.rows.length - 1].rowid : (params.afterRowid ?? 0);
		return {
			events,
			gaps: result.gaps,
			next: encodeCursor({
				v: 1,
				partition: params.scope.partition,
				kinds: params.kinds,
				limit: params.limit,
				pos: rowid,
				upper: result.upper,
			}),
		};
	}
	// 空页也推进到本次扫描上界，避免反复扫同一段（过滤掉的其他 kind 不造成反复扫描）。
	const afterPos = Math.max(result.upper, params.upper ?? 0, result.rows[result.rows.length - 1]?.rowid ?? 0);
	return {
		events,
		gaps: result.gaps,
		after: encodeCursor({
			v: 1,
			partition: params.scope.partition,
			kinds: params.kinds,
			limit: params.limit,
			pos: afterPos,
			upper: result.upper,
		}),
	};
}
