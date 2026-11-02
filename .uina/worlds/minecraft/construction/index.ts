/**
 * Construction 的装配端口：蓝图 → Target → 现场差异 → 计划。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 build.plan、§4 build；
 * docs/proposals/mc/modules/library.md §3（Raw / Target / Project 三分与 AirPolicy）。
 *
 * 这里只做"跨所有者"的三件事，不重复别人的规则：
 * 1. 取件：`LibraryPort.readDesign` 给出的字节 + 摘要（Raw 与原件的摘要口径见 library.md §3.3）；
 * 2. 解释：`target.json` 优先（已有 Target 用其明确语义），否则 `.schem` + AirPolicy；
 * 3. 读现场：经 `region@1` 分块读回设计盒（Region 的 8192 上限是它的合同，不是本模块的），
 *    再交给 `planConstruction` 求差异。
 *
 * `world` 用 getter 注入：装配顺序是 World 先建、端口后建，两者互相需要（与
 * `CapabilityDeps.runtime` 两段式同一手法）。`region@1` 读取没有加锁，重入是安全的。
 */

import type { SelfState } from "../contracts/body.js";
import type { BlueprintBytes } from "../contracts/library.js";
import { callFailure, type ExactRef, type JsonValue, type Observation, type Vec3 } from "../contracts/values.js";
import type { WorldReadPort } from "../contracts/world.js";
import { type FieldView, type PlanValue, planConstruction } from "./plan.js";
import { type AirPolicy, decodeSchem } from "./schem.js";
import type { ConstructionTarget, TargetCell } from "./target.js";
import { applyTransform, ConstructionError, resolveGrid, resolvePoint, stripNamespace } from "./target.js";
import { decodeTargetJson } from "./target-json.js";

export interface BlueprintSource {
	readDesign(name: string): Promise<BlueprintBytes | null>;
}

export interface ConstructionOptions {
	blueprints: BlueprintSource;
	world: () => Pick<WorldReadPort, "read">;
}

export interface ResolvedDesign {
	target: ConstructionTarget;
	/** 实际被解释的那份内容的 sha256（有 target.json 时是它，否则是 design.*）。 */
	digest: string;
}

export interface ConstructionPort {
	resolve(name: string, airPolicy?: AirPolicy): Promise<ResolvedDesign | null>;
	plan(query: { ref: string; input: JsonValue }): Promise<PlanValue>;
}

/** 支持的 Raw 格式：只有 Sponge `.schem`（v2/v3）。其余明确失败，不返回空建筑。 */
const SUPPORTED_FORMATS = ".schem (Sponge schematic v2/v3)";

/** region@1 的合同上限，用于把设计盒切成可读的 Y 层。 */
const REGION_MAX_VOXELS = 8192;
/** 1.21 主世界高度范围，读现场时用来夹取扩张后的包围盒。 */
const WORLD_MIN_Y = -64;
const WORLD_MAX_Y = 319;

function fail(code: string, source: "input" | "world" | "environment", message: string, hint?: string): never {
	throw callFailure({
		code,
		source,
		message,
		...(hint != null ? { hint } : {}),
		dispatch: "not_sent",
		effects: [],
		recoverable: true,
	});
}

/** ConstructionError → CallFailure：输入侧的归 input，解码/文件侧的归 environment。 */
function translate(error: unknown): never {
	if (error instanceof ConstructionError) {
		if (error.code === "INVALID_INPUT") fail("INVALID_INPUT", "input", error.message, error.hint);
		fail(error.code === "WRONG_STATE" ? "WRONG_STATE" : error.code, "environment", error.message, error.hint);
	}
	throw error;
}

async function readJson<T>(world: Pick<WorldReadPort, "read">, ref: ExactRef, input: JsonValue): Promise<T> {
	const observation = (await world.read<T>({ ref, input })) as Observation<T>;
	if (observation.value == null) {
		fail("WRONG_STATE", "environment", `${ref} is not available: ${observation.unknown.join("; ") || "unknown"}`);
	}
	return observation.value;
}

async function readSelf(world: Pick<WorldReadPort, "read">): Promise<SelfState> {
	return await readJson<SelfState>(world, "self@1", {});
}

interface BuildTargetRequest {
	replace?: boolean;
	cells?: { at: unknown; block: string | { name: string; properties?: Record<string, string> } }[];
	from?: { kind: string; name: string };
	at?: unknown;
	mirror?: "none" | "x" | "z";
	rotate?: 0 | 90 | 180 | 270;
	airPolicy?: AirPolicy;
	expectDigest?: string;
	maxTimeMs?: number;
}

/** 设计格的包围盒（含 1 格外扩）：支撑面判定要看邻居。 */
function boundingBox(cells: TargetCell[]): { min: Vec3; max: Vec3 } {
	let min = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY };
	let max = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY };
	for (const cell of cells) {
		min = { x: Math.min(min.x, cell.at.x), y: Math.min(min.y, cell.at.y), z: Math.min(min.z, cell.at.z) };
		max = { x: Math.max(max.x, cell.at.x), y: Math.max(max.y, cell.at.y), z: Math.max(max.z, cell.at.z) };
	}
	return {
		min: { x: min.x - 1, y: Math.max(WORLD_MIN_Y, min.y - 1), z: min.z - 1 },
		max: { x: max.x + 1, y: Math.min(WORLD_MAX_Y, max.y + 1), z: max.z + 1 },
	};
}

interface RegionRead {
	origin: Vec3;
	shape: [number, number, number];
	palette: { name: string; properties: Record<string, string> }[];
	cells: number[];
	order: "xzy";
	missing: number;
}

/**
 * 经 region@1 读整个设计盒（+1 圈邻居）。
 * 沿 Y 切层以满足 region 的 8192 上限；跨层的时刻差在计划语义下是可接受的
 * （计划本来就要在执行前重新核验，不冒充快照）。
 */
async function readField(world: Pick<WorldReadPort, "read">, cells: TargetCell[]): Promise<FieldView> {
	const box = boundingBox(cells);
	const nx = box.max.x - box.min.x + 1;
	const ny = box.max.y - box.min.y + 1;
	const nz = box.max.z - box.min.z + 1;
	if (nx * nz > REGION_MAX_VOXELS) {
		fail(
			"INVALID_INPUT",
			"input",
			`design footprint is ${nx}x${nz}; a single region@1 read covers at most ${REGION_MAX_VOXELS} columns`,
			"split the design so its footprint stays under the region limit",
		);
	}
	const slabHeight = Math.max(1, Math.floor(REGION_MAX_VOXELS / (nx * nz)));
	const blocks = new Map<string, { name: string; properties: Record<string, string> } | null>();
	for (let y = 0; y < ny; y += slabHeight) {
		const from = { x: box.min.x, y: box.min.y + y, z: box.min.z };
		const to = { x: box.max.x, y: Math.min(box.max.y, box.min.y + y + slabHeight - 1), z: box.max.z };
		const slice = await readJson<RegionRead>(world, "region@1", { from, to });
		const [sx, , sz] = slice.shape;
		for (let index = 0; index < slice.cells.length; index++) {
			const value = slice.cells[index]!;
			const x = slice.origin.x + (index % sx);
			const z = slice.origin.z + (Math.floor(index / sx) % sz);
			const cellY = slice.origin.y + Math.floor(index / (sx * sz));
			blocks.set(`${x},${cellY},${z}`, value < 0 ? null : (slice.palette[value] ?? null));
		}
	}
	return {
		blockAt: (at) => {
			const state = blocks.get(`${at.x},${at.y},${at.z}`);
			if (!state) return null;
			return { name: stripNamespace(state.name), properties: state.properties };
		},
	};
}

interface InventoryRead {
	counts: Record<string, number>;
}

export function createConstruction(options: ConstructionOptions): ConstructionPort {
	const world = () => options.world();

	async function resolve(name: string, airPolicy?: AirPolicy): Promise<ResolvedDesign | null> {
		const source = await options.blueprints.readDesign(name);
		if (source == null) return null;
		if (source.targetBytes != null) {
			// 已有 Target：用其明确语义，本次 airPolicy 一律不参与（合同原句）。
			return {
				target: decodeTargetJson(source.targetBytes.toString("utf8")),
				digest: source.targetDigest ?? source.digest,
			};
		}
		if (source.formatHint !== "schem") {
			fail(
				"WRONG_STATE",
				"environment",
				`blueprint "${name}" is a .${source.formatHint} file, which this world cannot interpret`,
				`supported formats: ${SUPPORTED_FORMATS}`,
			);
		}
		return { target: decodeSchem(source.bytes, airPolicy == null ? {} : { airPolicy }), digest: source.digest };
	}

	return {
		resolve,
		async plan(query) {
			const input = query.input as unknown as BuildTargetRequest;
			try {
				const self = await readSelf(world());
				const cells = await resolveTargets(input, self);
				const field = await readField(world(), cells.cells);
				const inventory = await readJson<InventoryRead>(world(), "inventory@1", {});
				return planConstruction(
					{
						cells: cells.cells,
						replace: input.replace === true,
						...(cells.blueprint != null ? { blueprint: cells.blueprint } : {}),
					},
					field,
					inventory.counts ?? {},
				);
			} catch (error) {
				translate(error);
			}
		},
	};

	async function resolveTargets(
		input: BuildTargetRequest,
		self: SelfState,
	): Promise<{ cells: TargetCell[]; blueprint?: { ref: string; digest: string } }> {
		if (input.cells != null) {
			if (input.from != null) fail("INVALID_INPUT", "input", "cells and from are mutually exclusive");
			const cells: TargetCell[] = input.cells.map((entry, index) => ({
				at: gridOf(entry.at, self, `cells[${index}].at`),
				kind: "set" as const,
				block: entry.block,
			}));
			return { cells };
		}
		if (input.from == null) fail("INVALID_INPUT", "input", "build needs either cells or from");
		if (input.from.kind !== "blueprint") {
			fail("INVALID_INPUT", "input", `from.kind must be "blueprint", got ${JSON.stringify(input.from.kind)}`);
		}
		if (input.at == null) fail("INVALID_INPUT", "input", "from a blueprint requires at (the design origin)");
		const design = await resolve(input.from.name, input.airPolicy);
		if (design == null) {
			fail("NOT_FOUND", "environment", `blueprint "${input.from.name}" is not in the library`);
		}
		if (input.expectDigest != null && input.expectDigest !== design.digest) {
			fail(
				"CONFLICT",
				"environment",
				`blueprint "${input.from.name}" changed since it was planned (digest ${design.digest} != expected ${input.expectDigest})`,
				"re-run build.plan to see the current design before building it",
			);
		}
		const anchor = gridOf(input.at, self, "at");
		const cells = applyTransform(design.target, anchor, {
			...(input.mirror != null ? { mirror: input.mirror } : {}),
			...(input.rotate != null ? { rotate: input.rotate } : {}),
		});
		return { cells, blueprint: { ref: `blueprint:${input.from.name}`, digest: design.digest } };
	}

	/** 整数格解析：rel 相对脚下格；显式维度必须与当前维度一致（K1 同口径）。 */
	function gridOf(raw: unknown, self: SelfState, what: string): Vec3 {
		const point = resolvePoint(raw, self);
		if (point.dimension !== self.place.dimension) {
			fail(
				"WRONG_STATE",
				"input",
				`${what} is in dimension ${point.dimension}, current dimension is ${self.place.dimension}`,
			);
		}
		return resolveGrid(raw, self);
	}
}
