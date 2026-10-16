/**
 * 内置查询描述符与求值（docs/proposals/mc/public-api.md §5）。
 *
 * 一份定义两种使用路径：deps 声明依赖类别，read/watch 据此固定切面；
 * 不运行通用查询规划器。完整查询目录由能力层随后续切片扩展；
 * 查询 ref/输入/输出在 descriptor 内发布，不让消费方猜开放 JSON。
 */

import type { ClientFactView } from "../../contracts/client-facts.js";
import type { QueryDescriptor } from "../../contracts/callables.js";
import type { BlockTarget } from "../../contracts/body.js";
import type { DependencyKind } from "./invalidation.js";
import type { Fact, JsonValue, Ref } from "../../contracts/values.js";
import { CallFailureError } from "../../contracts/errors.js";

export interface QueryDefinition {
	descriptor: QueryDescriptor;
	deps: ReadonlySet<DependencyKind>;
	/** 输入规范化；非法输入抛 INVALID_ARGUMENT。返回规范化后的输入（进入 stream 身份）。 */
	normalizeInput(input: JsonValue): JsonValue;
	/** 纯当前求值（deps 含 current 时必须提供）；view 只允许在本同步步使用。 */
	evalCurrent?(view: ClientFactView, input: JsonValue): Fact<JsonValue>;
}

function expectObject(input: JsonValue, what: string): Record<string, JsonValue> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new CallFailureError({ code: "INVALID_ARGUMENT", message: `${what} 必须是对象` });
	}
	return input;
}

function expectEmpty(input: JsonValue): JsonValue {
	const obj = expectObject(input, "input");
	if (Object.keys(obj).length !== 0) {
		throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "input 必须为 {}" });
	}
	return {};
}

function expectVec3(value: JsonValue, what: string): { x: number; y: number; z: number } {
	const obj = expectObject(value, what);
	for (const key of ["x", "y", "z"] as const) {
		const v = obj[key];
		if (typeof v !== "number" || !Number.isFinite(v)) {
			throw new CallFailureError({ code: "INVALID_ARGUMENT", message: `${what}.${key} 必须是有限数字` });
		}
	}
	return { x: obj.x as number, y: obj.y as number, z: obj.z as number };
}

function expectBlockTarget(input: JsonValue): JsonValue {
	const obj = expectObject(input, "input");
	const place = expectObject(obj.place ?? null, "input.place");
	if (
		typeof place.world !== "string" ||
		typeof place.worldRevision !== "string" ||
		typeof place.dimension !== "string"
	) {
		throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "input.place 缺少 world/worldRevision/dimension" });
	}
	const position = expectVec3(place.position ?? null, "input.place.position");
	const block = expectVec3(obj.block ?? null, "input.block");
	for (const axis of ["x", "y", "z"] as const) {
		if (!Number.isInteger(block[axis])) {
			throw new CallFailureError({ code: "INVALID_ARGUMENT", message: `input.block.${axis} 必须是整数` });
		}
	}
	void position;
	return {
		place: { world: place.world, worldRevision: place.worldRevision, dimension: place.dimension, position },
		block,
	};
}

/** 规范化 JSON（键排序），用作 stream 身份的一部分。 */
export function canonicalJson(value: JsonValue): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/**
 * 内置查询集（S-W1：纯当前三项；S-W3 追加历史 evidence.list@1）。
 * self/inventory 不可用时 Driver 返回 null，按 public-api 以 null+unknown 表达，不抛 SENSOR_UNAVAILABLE。
 */
export function builtinQueries(): Map<string, QueryDefinition> {
	const defs: QueryDefinition[] = [
		{
			descriptor: {
				ref: "self@1",
				summary: "自身当前状态（位置/生命/food/onGround）；不可用为 null",
				input: { type: "object", additionalProperties: false },
				output: { type: "SelfState|null (client.self@1)" },
				feedback: true,
			},
			deps: new Set(["current"] as DependencyKind[]),
			normalizeInput: expectEmpty,
			evalCurrent: (view) => view.self() as unknown as Fact<JsonValue>,
		},
		{
			descriptor: {
				ref: "inventory@1",
				summary: "当前背包读数（known 标记槽位、layout、revision）；不可用为 null",
				input: { type: "object", additionalProperties: false },
				output: { type: "ClientInventoryValue|null (client.inventory@1)" },
				feedback: true,
			},
			deps: new Set(["current"] as DependencyKind[]),
			normalizeInput: expectEmpty,
			evalCurrent: (view) => view.inventory() as unknown as Fact<JsonValue>,
		},
		{
			descriptor: {
				ref: "block@1",
				input: { type: "BlockTarget" },
				summary: "单格当前方块；state=null 表示未知，空气为 minecraft:air",
				output: { type: "ClientBlockValue (client.block@1)" },
				feedback: true,
			},
			deps: new Set(["current"] as DependencyKind[]),
			normalizeInput: expectBlockTarget,
			evalCurrent: (view, input) => view.block(input as unknown as BlockTarget) as unknown as Fact<JsonValue>,
		},
	];
	return new Map(defs.map((d) => [d.descriptor.ref, d]));
}

/** 查询流身份：绑定分区 + 确切查询 + 规范化参数（world.md §6.5/§9.4）。 */
export function queryStreamRef(
	queryRef: string,
	world: Ref,
	worldRevision: Ref,
	dimension: Ref | null,
	input: JsonValue,
): string {
	const dim = dimension ?? "unknown";
	return `mcw:q:${queryRef}|${world}/${worldRevision}|${dim}|${canonicalJson(input)}`;
}
