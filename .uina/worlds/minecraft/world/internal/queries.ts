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

/** 历史证据列表查询输入：可选过滤 + 分页 token（固定存储版本）。 */
function normalizeEvidenceList(input: JsonValue): JsonValue {
	const obj = expectObject(input, "input");
	const result: Record<string, JsonValue> = {};
	if (obj.stream !== undefined) {
		if (typeof obj.stream !== "string")
			throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "stream 必须是 Ref 字符串" });
		result.stream = obj.stream;
	}
	if (obj.schema !== undefined) {
		if (typeof obj.schema !== "string" || !obj.schema.includes("@")) {
			throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "schema 必须是 ExactRef" });
		}
		result.schema = obj.schema;
	}
	if (obj.limit !== undefined) {
		if (typeof obj.limit !== "number" || !Number.isInteger(obj.limit) || obj.limit < 1 || obj.limit > 500) {
			throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "limit 必须是 1..500 的整数" });
		}
		result.limit = obj.limit;
	}
	if (obj.page !== undefined) {
		const page = expectObject(obj.page, "input.page");
		if (typeof page.version !== "number" || !Number.isInteger(page.version) || page.version < 0) {
			throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "page.version 必须是非负整数" });
		}
		if (typeof page.afterStoreSeq !== "number" || !Number.isInteger(page.afterStoreSeq) || page.afterStoreSeq < 0) {
			throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "page.afterStoreSeq 必须是非负整数" });
		}
		result.page = { version: page.version, afterStoreSeq: page.afterStoreSeq };
	}
	return result;
}

/**
 * 内置查询集。
 * 纯当前：self/inventory/block（S-W1）。
 * 纯历史：evidence.list@1 —— 已持久证据与显式缺口的分页读取（S-W3）。
 * 容器/实体/事件等领域查询由能力层提供 descriptor 后扩展；此处不冒认完整目录。
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
		{
			descriptor: {
				ref: "evidence.list@1",
				summary:
					"已持久历史证据与显式缺口分页读取；先等提交屏障（本次已接收上界全部落盘）再原子读取。返回 items（fact 携带原始 Fact 载荷，gap 携带区间）与分页 token",
				input: {
					type: "object",
					properties: { stream: "Ref?", schema: "ExactRef?", limit: "1..500?", page: "{version, afterStoreSeq}?" },
				},
				output: {
					type: "{ items: [{kind:'fact',ref,stream,seq,schema,fact}|{kind:'gap',ref,stream,after,through,reason}], next: {version,afterStoreSeq}|null, complete: boolean }",
				},
				feedback: false,
			},
			deps: new Set(["history"] as DependencyKind[]),
			normalizeInput: normalizeEvidenceList,
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
