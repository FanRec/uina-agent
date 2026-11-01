/**
 * Sponge `.schem`（v2 / v3）→ Construction Target 的解码。
 *
 * 唯一定义来源：docs/proposals/mc/modules/library.md §3.1–§3.3、
 * docs/proposals/mc/modules/capabilities.md §4「共用目标与差异处理」。
 * 「Raw 不自动变 Target」的方向不可逆：本文件只做一件事——把原件字节读成
 * 明确语义的目标格；读不懂就报错，**不返回空建筑**。
 *
 * 只支持下列范围（其余格式明确失败，由调用方转成 WRONG_STATE）：
 * - root 名 `Schematic`；`Version` 2 或 3（v3 的 Palette/Data 在 `Blocks` 子标签下）；
 * - `Width/Height/Length` + `Palette`(state 字符串 → 索引) + `BlockData`(无符号 varint 流)；
 * - 索引顺序 `(y*Length + z)*Width + x`，即与 region@1 相同的 `order:"xzy"`；
 * - 方块实体、实体、生物群系与 3D 生物群系一律不解释：Target 只承诺方块状态。
 *
 * 空气格必须由 `airPolicy` 定性（Raw 里 air 既可能是"清空"也可能是"保留"）：
 * `set_air` → clear，`preserve` → preserve；没有策略却含空气 → INVALID_INPUT。
 */

import { nbtByteArray, nbtCompound, nbtInt, readNbt } from "./nbt.js";
import type { NbtCompound } from "./nbt.js";
import { ConstructionError, isAirName, stripNamespace } from "./target.js";
import type { ConstructionTarget, TargetCell } from "./target.js";

export type AirPolicy = "set_air" | "preserve";

/** 解码期的体积护栏（与 region@1 同量级）；真正的合同上限在计划阶段（targets 数量）。 */
export const SCHEM_MAX_VOXELS = 8192;

const SUPPORTED = ".schem (Sponge schematic v2/v3)";

/** `minecraft:oak_stairs[facing=east,half=bottom]` → BlockSpec。 */
export function parseBlockState(key: string): { name: string; properties: Record<string, string> } {
	const match = /^([^[]+?)(?:\[(.*)\])?$/.exec(key.trim());
	if (match == null) throw new ConstructionError("WRONG_STATE", `palette entry "${key}" is not a block state`);
	const name = stripNamespace(match[1]!);
	const properties: Record<string, string> = {};
	const raw = match[2];
	if (raw != null && raw.trim() !== "") {
		for (const pair of raw.split(",")) {
			const at = pair.indexOf("=");
			if (at <= 0) throw new ConstructionError("WRONG_STATE", `palette entry "${key}" has a malformed property`);
			const property = pair.slice(0, at).trim();
			let value = pair.slice(at + 1).trim();
			if (
				value.length >= 2 &&
				((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
			) {
				value = value.slice(1, -1);
			}
			properties[property] = value;
		}
	}
	return { name, properties };
}

/** 无符号 LEB128：索引流没有分隔符，读错一个字节后面全错，因此逐字节设上限。 */
function decodeVarints(bytes: Uint8Array, count: number): number[] {
	const values: number[] = [];
	let value = 0;
	let shift = 0;
	for (let index = 0; index < bytes.length && values.length < count; index++) {
		const byte = bytes[index]!;
		value |= (byte & 0x7f) << shift;
		if ((byte & 0x80) !== 0) {
			shift += 7;
			if (shift > 28) throw new ConstructionError("WRONG_STATE", "BlockData contains a varint over 5 bytes");
			continue;
		}
		values.push(value >>> 0);
		value = 0;
		shift = 0;
	}
	if (values.length < count) {
		throw new ConstructionError(
			"WRONG_STATE",
			`BlockData holds ${values.length} block indices but the ${count} cells of the design need one each (truncated file?)`,
		);
	}
	return values;
}

function holderOf(root: NbtCompound, version: number): NbtCompound {
	return version === 3 ? nbtCompound(root.Blocks, "Blocks") : root;
}

/**
 * 解码一次。`Metadata`/`Offset`/`Entities`/`Biomes`/`BlockEntities` 都不参与 Target：
 * 锚点由调用的 `at` 决定，原件自带 offset 不自动生效（合同把落点交给调用方）；
 * 方块实体只保留方块状态，箱子内容与告示牌文字不进入设计。
 */
export function decodeSchem(bytes: Uint8Array, options: { airPolicy?: AirPolicy } = {}): ConstructionTarget {
	let root: NbtCompound;
	try {
		const document = readNbt(bytes);
		if (document.name !== "Schematic") {
			throw new ConstructionError(
				"WRONG_STATE",
				`blueprint root is "${document.name}", not "Schematic"; supported formats: ${SUPPORTED}`,
			);
		}
		root = document.value;
	} catch (error) {
		if (error instanceof ConstructionError) throw error;
		throw new ConstructionError(
			"WRONG_STATE",
			`blueprint bytes are not a readable schematic: ${error instanceof Error ? error.message : String(error)}`,
			`supported formats: ${SUPPORTED}`,
		);
	}

	const version = nbtInt(root.Version, "Version");
	if (version !== 2 && version !== 3) {
		throw new ConstructionError(
			"WRONG_STATE",
			`schematic Version ${version} is not supported; supported formats: ${SUPPORTED}`,
			"re-export the design as a Sponge schematic v2 or v3",
		);
	}
	const width = nbtInt(root.Width, "Width");
	const height = nbtInt(root.Height, "Height");
	const length = nbtInt(root.Length, "Length");
	if (width <= 0 || height <= 0 || length <= 0) {
		throw new ConstructionError("WRONG_STATE", `schematic has an empty extent ${width}x${height}x${length}`);
	}
	const voxels = width * height * length;
	if (voxels > SCHEM_MAX_VOXELS) {
		throw new ConstructionError(
			"WRONG_STATE",
			`schematic is ${width}x${height}x${length} = ${voxels} cells, over the ${SCHEM_MAX_VOXELS} cell decode limit`,
			"split the design before saving it as a blueprint",
		);
	}

	const holder = holderOf(root, version);
	const paletteTag = nbtCompound(holder.Palette, "Palette");
	const byIndex: { name: string; properties: Record<string, string> }[] = [];
	for (const [key, raw] of Object.entries(paletteTag)) {
		const index = nbtInt(raw, `Palette["${key}"]`);
		if (!Number.isInteger(index) || index < 0 || index >= voxels) {
			throw new ConstructionError("WRONG_STATE", `palette index ${index} for "${key}" is outside 0..${voxels - 1}`);
		}
		if (byIndex[index] !== undefined) {
			throw new ConstructionError("WRONG_STATE", `palette index ${index} is claimed by two block states`);
		}
		byIndex[index] = parseBlockState(key);
	}
	if (byIndex.length === 0) throw new ConstructionError("WRONG_STATE", "schematic palette is empty");

	const data = version === 3 ? nbtByteArray(holder.Data, "Blocks.Data") : nbtByteArray(holder.BlockData, "BlockData");
	const indices = decodeVarints(data, voxels);

	let airCells = 0;
	const cells: TargetCell[] = [];
	for (let index = 0; index < voxels; index++) {
		const state = byIndex[indices[index]!];
		if (state === undefined) {
			throw new ConstructionError("WRONG_STATE", `block index ${indices[index]} has no palette entry`);
		}
		const x = index % width;
		const z = Math.floor(index / width) % length;
		const y = Math.floor(index / (width * length));
		if (isAirName(state.name)) {
			airCells += 1;
			const airPolicy = options.airPolicy;
			if (airPolicy == null) continue;
			cells.push({
				at: { x, y, z },
				kind: airPolicy === "set_air" ? "clear" : "preserve",
			});
			continue;
		}
		cells.push({
			at: { x, y, z },
			kind: "set",
			block: Object.keys(state.properties).length === 0 ? state.name : state,
		});
	}

	if (airCells > 0 && options.airPolicy == null) {
		throw new ConstructionError(
			"INVALID_INPUT",
			`this design has ${airCells} known-air cells; pass airPolicy to decide what they mean`,
			"set_air clears them (paste semantics), preserve leaves the world untouched there",
		);
	}

	return { size: { x: width, y: height, z: length }, cells };
}
