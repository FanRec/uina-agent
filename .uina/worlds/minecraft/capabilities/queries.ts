/**
 * K1 查询子集：QueryDescriptor 声明 + resolver（I1 五查询）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §3、§5；plan §9。
 * resolver 只做输入校验 + 从当前事实视图组装 Fact（不造值：视图为 null/未知
 * 的部分如实带 unknown 透传）；watch 语义由 World 当前读统一承担（保守失效）。
 * 输入参数显式声明边界（空查询拒绝非空 input；blocks 限量 4 个 section——
 * 逐格采样代价随体量线性增长，I1 场景用小半径）。
 */

import type { QueryDescriptor } from "../contracts/capabilities.js";
import type { ClientFactView, SectionTarget } from "../contracts/client-facts.js";
import type { Place } from "../contracts/values.js";
import type { JsonValue, JsonSchema, ExactRef, Vec3 } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import type { QueryResolver } from "../world/current.js";

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

function rejectNonEmptyInput(input: JsonValue, ref: string): void {
	if (input != null && typeof input === "object" && Object.keys(input as object).length > 0) {
		readFailure(`${ref} takes no input; got ${JSON.stringify(input)}`);
	}
}

function intVec(value: unknown, name: string): Vec3 {
	if (typeof value !== "object" || value == null) readFailure(`${name} must be an object with integer x/y/z`);
	const v = value as Record<string, unknown>;
	for (const key of ["x", "y", "z"] as const) {
		if (typeof v[key] !== "number" || !Number.isInteger(v[key])) {
			readFailure(`${name}.${key} must be an integer, got ${JSON.stringify(v[key])}`);
		}
	}
	return { x: v.x as number, y: v.y as number, z: v.z as number };
}

const VEC3_SCHEMA: JsonSchema = {
	type: "object",
	properties: { x: { type: "integer" }, y: { type: "integer" }, z: { type: "integer" } },
	required: ["x", "y", "z"],
	additionalProperties: false,
};

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
			resolver: (view, input) => {
				rejectNonEmptyInput(input, "self@1");
				return view.self();
			},
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
			resolver: (view, input) => {
				rejectNonEmptyInput(input, "inventory@1");
				return view.inventory();
			},
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
				const raw = (input ?? {}) as Record<string, unknown>;
				const block = intVec(raw.block, "block");
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
				const raw = (input ?? {}) as Record<string, unknown>;
				const list = raw.sections;
				if (!Array.isArray(list) || list.length < 1 || list.length > 4) {
					readFailure("blocks@1 needs sections: 1..4 entries");
				}
				const targets: SectionTarget[] = list.map((entry, i) => {
					const section = intVec((entry as Record<string, unknown>).section, `sections[${i}].section`);
					return { ...placeOf(view, { x: section.x * 16, y: section.y * 16, z: section.z * 16 }), section };
				});
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
			resolver: (view, input) => {
				rejectNonEmptyInput(input, "entities@1");
				return view.entities();
			},
		},
	];
	const resolvers = new Map<ExactRef, QueryResolver>();
	for (const item of built) {
		if (resolvers.has(item.descriptor.ref)) {
			throw new Error(`duplicate query ref: ${item.descriptor.ref}`);
		}
		resolvers.set(item.descriptor.ref, item.resolver);
	}
	return { descriptors: built.map((item) => item.descriptor), resolvers };
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
