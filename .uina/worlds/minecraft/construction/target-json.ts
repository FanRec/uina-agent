/**
 * `target.json`（Construction 定义的目标语义，版本 1）→ Construction Target。
 *
 * 唯一定义来源：docs/proposals/mc/modules/library.md §3.1–§3.2（Raw / Target / Project 三分）、
 * docs/proposals/mc/modules/capabilities.md §4「共用目标与差异处理」。
 * `target.json` 是 Target 的**声明形态**：它已经是解释后的语义，不再经过 AirPolicy，
 * 也不允许被本次调用的 airPolicy 改写（"已有 Target 使用其明确语义"）。
 *
 * 两种写法（同一条记录只能选一种）：
 * - 密集：`{size:[nx,ny,nz], order:"xzy", palette:[...], cells:[索引...]}`
 *   索引顺序与 region@1 相同（x 最快、其次 z、最后 y），cell 数必须等于 nx*ny*nz；
 * - 稀疏：`{cells:[{at:[x,y,z], kind, block?, reason?}]}`，包围盒由实际格推导。
 *   稀疏是给人手写用的——库没有 `target.json` 的写入方，没有它这份格式就只能靠程序生成。
 */

import type { BlockSpec } from "../contracts/body.js";
import type { ConstructionTarget, TargetCell, TargetKind } from "./target.js";
import { ConstructionError, normalizeTarget } from "./target.js";

export const TARGET_SCHEMA = "minecraft:construction.target@1";

const KINDS: readonly TargetKind[] = ["set", "clear", "preserve", "unknown"];

function invalid(message: string, hint?: string): never {
	throw new ConstructionError("WRONG_STATE", `target.json: ${message}`, hint);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value == null || Array.isArray(value)) invalid(`${what} must be an object`);
	return value as Record<string, unknown>;
}

function asTuple(value: unknown, what: string): { x: number; y: number; z: number } {
	if (!Array.isArray(value) || value.length !== 3) invalid(`${what} must be an array of three integers`);
	const [x, y, z] = value as unknown[];
	for (const component of [x, y, z]) {
		if (typeof component !== "number" || !Number.isInteger(component)) {
			invalid(`${what} must be an array of three integers`);
		}
	}
	return { x: x as number, y: y as number, z: z as number };
}

function asBlock(value: unknown, what: string): BlockSpec {
	if (typeof value === "string" && value.length > 0) return value;
	const record = asRecord(value, what);
	const name = record.name;
	if (typeof name !== "string" || name.length === 0) invalid(`${what}.name must be a non-empty string`);
	const properties: Record<string, string> = {};
	if (record.properties !== undefined) {
		for (const [key, raw] of Object.entries(asRecord(record.properties, `${what}.properties`))) {
			if (typeof raw !== "string") invalid(`${what}.properties.${key} must be a string`);
			properties[key] = raw;
		}
	}
	return Object.keys(properties).length === 0 ? name : { name, properties };
}

function paletteCell(raw: unknown, index: number): TargetCell {
	const record = asRecord(raw, `palette[${index}]`);
	const kind = record.kind;
	if (typeof kind !== "string" || !KINDS.includes(kind as TargetKind)) {
		invalid(`palette[${index}].kind must be one of ${KINDS.join("/")}`);
	}
	if (kind === "set") {
		if (record.block === undefined) invalid(`palette[${index}] is a set target but has no block`);
		return { at: { x: 0, y: 0, z: 0 }, kind: "set", block: asBlock(record.block, `palette[${index}].block`) };
	}
	if (kind === "unknown") {
		const reason = record.reason;
		if (reason !== undefined && typeof reason !== "string") invalid(`palette[${index}].reason must be a string`);
		return {
			at: { x: 0, y: 0, z: 0 },
			kind: "unknown",
			reason: typeof reason === "string" ? reason : "design marks this cell as unknown",
		};
	}
	return { at: { x: 0, y: 0, z: 0 }, kind: kind as TargetKind };
}

/** 解析一份 `target.json` 字节。 */
export function decodeTargetJson(text: string): ConstructionTarget {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		invalid(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	const document = asRecord(parsed, "root");
	if (document.schema !== TARGET_SCHEMA) {
		invalid(`schema is ${JSON.stringify(document.schema)}, expected "${TARGET_SCHEMA}"`);
	}
	if (document.order !== undefined && document.order !== "xzy") {
		invalid(`order is ${JSON.stringify(document.order)}; only "xzy" is defined`);
	}
	if (!Array.isArray(document.cells)) invalid("cells must be an array");

	if (document.palette !== undefined) {
		const size = asTuple(document.size, "size");
		if (size.x <= 0 || size.y <= 0 || size.z <= 0) invalid("size components must be positive");
		const palette = document.palette;
		if (!Array.isArray(palette) || palette.length === 0) invalid("palette must be a non-empty array");
		const cells = document.cells;
		const expected = size.x * size.y * size.z;
		if (cells.length !== expected) {
			invalid(`cells has ${cells.length} entries but size ${size.x}x${size.y}x${size.z} needs ${expected}`);
		}
		const templates = palette.map((entry, index) => paletteCell(entry, index));
		const resolved: TargetCell[] = cells.map((raw, index) => {
			if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw >= templates.length) {
				invalid(`cells[${index}] must be a palette index in 0..${templates.length - 1}`);
			}
			const x = index % size.x;
			const z = Math.floor(index / size.x) % size.z;
			const y = Math.floor(index / (size.x * size.z));
			return { ...templates[raw]!, at: { x, y, z } };
		});
		return normalizeTarget(resolved, size);
	}

	const sparse: TargetCell[] = document.cells.map((raw, index) => {
		const record = asRecord(raw, `cells[${index}]`);
		const at = asTuple(record.at, `cells[${index}].at`);
		const cell = paletteCell({ kind: record.kind, block: record.block, reason: record.reason }, index);
		return { ...cell, at };
	});
	return normalizeTarget(sparse);
}
