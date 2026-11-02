/**
 * places@1 领域记录的纯值层：ref 映射、查询解析、过滤与观察成形。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 places、§5 记录、public-api §5。
 * 记录 schema 固定 minecraft:place@1；ref = place:<name>（Ref 无语法限制，转换只在本文件）。
 * 记录值 = {name, at:{position,dimension}, kind, note?, savedAt}；存储分区 = world+worldRevision，
 * dimension 留在记录值里（capability §2.2：跨维度地点保留显式维度，不简化成三个数）。
 * 过滤冻结：kind 精确匹配；near = 当前维度内欧氏距离 ≤ near，设置 near 时其他维度不返回。
 */

import type { JsonValue, Observation, ObservationCursor, Ref, Vec3 } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import type { StoredRecordRow } from "./sqlite-worker.js";

export const PLACES_REF = "places@1";
export const PLACE_SCHEMA = "minecraft:place@1" as const;

export type PlaceKind = "home" | "mine" | "farm" | "other";

export interface PlaceValue {
	name: string;
	at: { position: Vec3; dimension: string };
	kind: PlaceKind;
	note?: string;
	savedAt: string;
}

export function placeRef(name: string): Ref {
	return `place:${name}`;
}

export function placeNameOf(ref: Ref): string | null {
	return ref.startsWith("place:") ? ref.slice("place:".length) : null;
}

export interface PlacesQueryInput {
	kind?: PlaceKind;
	near?: number;
}

export interface PlacesOrigin {
	dimension: string;
	position: Vec3;
}

export interface PlacesQueryParams {
	kind?: PlaceKind;
	near?: number;
	origin: PlacesOrigin | null;
}

/**
 * 解析 places@1 输入：kind/near 已由 descriptor schema 校验，这里只决定 near 的原点。
 * near 需要当前位置（同一维度才有距离语义）；拿不到当前位置时显式失败，不静默放开过滤。
 */
export function resolvePlacesQuery(input: JsonValue, origin: PlacesOrigin | null): PlacesQueryParams {
	const raw = (input ?? {}) as PlacesQueryInput;
	if (raw.near != null && origin == null) {
		throw callFailure({
			code: "DISCONNECTED",
			source: "world",
			message: "places@1 `near` needs the current position, but no live self facts are available",
			hint: "retry without `near`, or reconnect first",
			dispatch: "not_sent",
			effects: [],
			recoverable: true,
		});
	}
	return { kind: raw.kind, near: raw.near, origin };
}

function malformed(ref: string): never {
	throw callFailure({
		code: "INTERNAL",
		source: "world",
		message: `place record ${ref} has a malformed value; the record store is inconsistent`,
		dispatch: "not_sent",
		effects: [],
		recoverable: false,
	});
}

function placeValueOf(row: StoredRecordRow): PlaceValue {
	const value = row.value as unknown as Partial<PlaceValue> | null;
	if (
		value == null ||
		typeof value !== "object" ||
		typeof value.name !== "string" ||
		typeof value.savedAt !== "string" ||
		value.at == null ||
		typeof value.at.dimension !== "string" ||
		value.at.position == null ||
		![value.at.position.x, value.at.position.y, value.at.position.z].every(Number.isFinite) ||
		typeof value.kind !== "string"
	)
		malformed(row.ref);
	return value as PlaceValue;
}

function nearFilter(place: PlaceValue, params: PlacesQueryParams): boolean {
	if (params.near == null) return true;
	// near 是"当前位置附近"：只对当前维度的地点有距离语义，其他维度直接不返回。
	if (place.at.dimension !== params.origin?.dimension) return false;
	const p = params.origin.position;
	const d = Math.hypot(place.at.position.x - p.x, place.at.position.y - p.y, place.at.position.z - p.z);
	return d <= params.near;
}

export interface PlacesObservationMeta {
	observedAt: string;
	evidence: Ref[];
	cursor: ObservationCursor;
}

export function placesObservation<T>(
	rows: StoredRecordRow[],
	params: PlacesQueryParams,
	meta: PlacesObservationMeta,
): Observation<T> {
	const places = rows
		.map((row) => ({ row, place: placeValueOf(row) }))
		.filter(({ place }) => (params.kind == null || place.kind === params.kind) && nearFilter(place, params))
		.map(({ place }) => place)
		.sort((a, b) => a.name.localeCompare(b.name));
	return {
		value: { places } as T,
		observedAt: meta.observedAt,
		source: "history",
		coverage: "complete",
		unknown: [],
		evidence: meta.evidence,
		cursor: meta.cursor,
	};
}
