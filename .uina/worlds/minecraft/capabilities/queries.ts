/**
 * K1 查询子集：QueryDescriptor 声明 + resolver（I1 五查询）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §3、§5；plan §9。
 * resolver 只从当前事实视图组装 Fact（不造值：视图为 null/未知的部分如实带
 * unknown 透传）；watch 语义由 World 当前读统一承担（保守失效）。
 * 输入校验按 descriptor.input 由本模块的 Ajv 编译一次后包装 resolver：schema 是
 * 唯一事实来源，resolver 里不再手写字段检查（两套校验必然漂移）。
 */

import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import type { QueryDescriptor } from "../contracts/capabilities.js";
import type { ClientFactView, SectionTarget } from "../contracts/client-facts.js";
import type { Place } from "../contracts/values.js";
import type { JsonValue, JsonSchema, ExactRef, Vec3 } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import type { QueryResolver } from "../world/current.js";

/** Ajv 仅由本模块构造（strict 关闭：schema 含开放键；allErrors 全量报告）。 */
interface AjvLike {
	compile(schema: Record<string, unknown>): ValidateFunction;
	errorsText(errors?: ValidateFunction["errors"]): string;
}
const AjvCtor = createRequire(import.meta.url)("ajv") as new (options: {
	strict: boolean;
	allErrors: boolean;
}) => AjvLike;

const EMPTY_INPUT: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

function readFailure(message: string, hint?: string): never {
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

const VEC3_SCHEMA: JsonSchema = {
	type: "object",
	properties: { x: { type: "integer" }, y: { type: "integer" }, z: { type: "integer" } },
	required: ["x", "y", "z"],
	additionalProperties: false,
};

/** 已过 schema 校验的输入按声明形状读取（校验是唯一依据，此处不重复检查）。 */
function checkedInput<T>(input: JsonValue): T {
	return input as unknown as T;
}

/** 组合根装配入口：描述符列表 + resolver 表（键 = descriptor.ref）。 */
export interface BuiltQueries {
	descriptors: QueryDescriptor[];
	resolvers: ReadonlyMap<ExactRef, QueryResolver>;
}

export function buildQueries(): BuiltQueries {
	const built: { descriptor: QueryDescriptor; resolver: QueryResolver }[] = [
		{
			descriptor: {
				ref: "self@1",
				summary: "Client body state at the current commit boundary (position, vitals, status effects)",
				input: EMPTY_INPUT,
				output: { type: "object" },
				access: "read",
				watchable: true,
				feedback: false,
				examples: [
					{
						input: {},
						output: {
							value: {
								place: {
									world: "wld:demo",
									worldRevision: "wldrev:demo",
									dimension: "overworld",
									position: { x: 0, y: 64, z: 0 },
								},
								velocity: { x: 0, y: 0, z: 0 },
								health: 20,
								food: 20,
								onGround: true,
								maxHealth: null,
								saturation: null,
								oxygen: null,
								inWater: null,
								inLava: null,
								effects: [],
								xpLevel: null,
							},
							observedAt: "2026-01-01T00:00:00.000Z",
							source: "mixed",
							coverage: "complete",
							unknown: [],
							evidence: [],
						},
					},
				],
			},
			resolver: (view) => view.self(),
		},
		{
			descriptor: {
				ref: "inventory@1",
				summary: "Client inventory window slots and layout at the current commit boundary",
				input: EMPTY_INPUT,
				output: { type: "object" },
				access: "read",
				watchable: true,
				feedback: false,
				examples: [
					{
						input: {},
						output: {
							value: { revision: 1, layout: { slotCount: 46, regions: [] }, slots: [], selectedSlot: 0 },
							observedAt: "2026-01-01T00:00:00.000Z",
							source: "server",
							coverage: "partial",
							unknown: ["item components not captured in I1"],
							evidence: [],
						},
					},
				],
			},
			resolver: (view) => view.inventory(),
		},
		{
			descriptor: {
				ref: "block@1",
				summary: "Single block state at integer coordinates (null state = chunk not loaded)",
				input: {
					type: "object",
					properties: { block: VEC3_SCHEMA },
					required: ["block"],
					additionalProperties: false,
				},
				output: { type: "object" },
				access: "read",
				watchable: true,
				feedback: false,
				examples: [
					{
						input: { block: { x: 0, y: 64, z: 0 } },
						output: {
							value: {
								target: {
									place: {
										world: "wld:demo",
										worldRevision: "wldrev:demo",
										dimension: "overworld",
										position: { x: 0, y: 64, z: 0 },
									},
									block: { x: 0, y: 64, z: 0 },
								},
								state: { name: "grass_block", properties: {} },
								sign: null,
							},
							observedAt: "2026-01-01T00:00:00.000Z",
							source: "server",
							coverage: "complete",
							unknown: [],
							evidence: [],
						},
					},
				],
			},
			resolver: (view, input) => {
				// schema 已保证 block 为整数向量
				const { block } = checkedInput<{ block: Vec3 }>(input);
				return view.block({ place: placeOf(view, block), block });
			},
		},
		{
			descriptor: {
				ref: "blocks@1",
				summary: "16x16x16 section voxel scans (palette + indices); at most 4 sections per query",
				input: {
					type: "object",
					properties: {
						sections: {
							type: "array",
							items: {
								type: "object",
								properties: { section: VEC3_SCHEMA },
								required: ["section"],
								additionalProperties: false,
							},
							minItems: 1,
							maxItems: 4,
						},
					},
					required: ["sections"],
					additionalProperties: false,
				},
				output: { type: "object" },
				access: "read",
				watchable: false,
				feedback: false,
				examples: [
					{
						input: { sections: [{ section: { x: 0, y: 4, z: 0 } }] },
						output: {
							value: { sections: [] },
							observedAt: "2026-01-01T00:00:00.000Z",
							source: "server",
							coverage: "partial",
							unknown: ["section 0,64,0 not fully loaded"],
							evidence: [],
						},
					},
				],
			},
			resolver: (view, input) => {
				// schema 已保证 sections 为 1..4 项整数 section 坐标
				const { sections } = checkedInput<{ sections: { section: Vec3 }[] }>(input);
				const targets: SectionTarget[] = sections.map((entry) => ({
					...placeOf(view, {
						x: entry.section.x * 16,
						y: entry.section.y * 16,
						z: entry.section.z * 16,
					}),
					section: entry.section,
				}));
				return view.sections(targets);
			},
		},
		{
			descriptor: {
				ref: "entities@1",
				summary: "Currently tracked client-side entities (extent=tracked; out of range is not proven absent)",
				input: EMPTY_INPUT,
				output: { type: "object" },
				access: "read",
				watchable: true,
				feedback: false,
				examples: [
					{
						input: {},
						output: {
							value: { extent: "tracked", entities: [] },
							observedAt: "2026-01-01T00:00:00.000Z",
							source: "server",
							coverage: "partial",
							unknown: ["entity metadata not captured in I1"],
							evidence: [],
						},
					},
				],
			},
			resolver: (view) => view.entities(),
		},
	];
	const ajv = new AjvCtor({ strict: false, allErrors: true });
	const resolvers = new Map<ExactRef, QueryResolver>();
	for (const item of built) {
		if (resolvers.has(item.descriptor.ref)) {
			throw new Error(`duplicate query ref: ${item.descriptor.ref}`);
		}
		resolvers.set(item.descriptor.ref, validated(ajv, item.descriptor, item.resolver));
	}
	return { descriptors: built.map((item) => item.descriptor), resolvers };
}

/** 按 descriptor.input 编译一次并包装 resolver：resolver 只处理已合法输入。 */
function validated(ajv: AjvLike, descriptor: QueryDescriptor, resolve: QueryResolver): QueryResolver {
	const validate = ajv.compile(descriptor.input as Record<string, unknown>);
	return (view, input) => {
		// input 为 null 视同空查询（WorldQuery.input 是 JsonValue，允许 null）
		const normalized: JsonValue = input ?? {};
		if (!validate(normalized)) {
			readFailure(
				`${descriptor.ref} input rejected: ${ajv.errorsText(validate.errors)}`,
				`input schema of ${descriptor.ref} is authoritative`,
			);
		}
		return resolve(view, normalized);
	};
}

function placeOf(view: ClientFactView, position: Vec3): Place {
	const scope = view.scope();
	return {
		world: scope.world,
		worldRevision: scope.worldRevision,
		dimension: scope.dimension ?? "unknown",
		position,
	};
}
