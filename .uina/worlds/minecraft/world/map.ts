/**
 * map@1 读取材料（world.md §8.6；capabilities.md §map 的输入/返回合同）。
 *
 * 一次纯当前 sample 内同时固定库存选择、地图元数据、像素已知掩码和图标；
 * image=true 才在关键循环外编码 PNG（encodeMapPng）并原子写
 * `<imageDir>/<sha256>.png`。地图像素由 Driver 的增量包缓存拥有，这里只读：
 * 中心/维度协议不下发恒 null，不读服务器存档补值；缺失增量不补透明色。
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { ItemValue } from "../contracts/body.js";
import type { ClientFactsPort, ClientInventoryValue, MapIconValue } from "../contracts/client-facts.js";
import type { ImageFileRef, JsonValue } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import { encodeMapPng, MAP_CELLS, MAP_IMAGE_SIZE } from "./png.js";

export const MAP_REF = "map@1";

export interface MapQueryInput {
	id: number | null;
	image: boolean;
}

/** 输入 schema 已校验过形状；这里只落缺省（image 缺省 true）。 */
export function resolveMapInput(input: JsonValue): MapQueryInput {
	const raw = input as { id?: number; image?: boolean };
	return { id: typeof raw.id === "number" ? raw.id : null, image: raw.image ?? true };
}

export interface MapSample {
	id: number;
	/** 一次 sample 固定的像素掩码（z 行 x 列；null=未收到）。 */
	colors: (number | null)[];
	scale: number | null;
	locked: boolean | null;
	icons: MapIconValue[] | null;
	receivedPixels: number;
	paintedPixels: number;
	/** map 包未到等事实缺口；不包含 image 交付问题（那是 read 阶段）。 */
	unknown: string[];
	observedAt: string;
}

/** ItemValue → filled_map 的 map_id 组件；组件类型名按 1.21.11 mapper 非命名空间。 */
export function mapIdOf(item: ItemValue | null): number | null {
	if (item == null) return null;
	const name = item.name.replace(/^minecraft:/, "");
	if (name !== "filled_map") return null;
	const components = item.components as { added?: { type?: string; data?: unknown }[] } | null;
	const added = components?.added;
	if (!Array.isArray(added)) return null;
	for (const component of added) {
		if (component?.type === "map_id" && typeof component.data === "number") {
			if (Number.isSafeInteger(component.data) && component.data >= 0) return component.data;
		}
	}
	return null;
}

/** 携带地图的槽位顺序：主手 → 副手 → 热键栏其余 → 背包（capabilities.md §map）。 */
export function carriedMapIds(inventory: ClientInventoryValue): { slot: number; id: number }[] {
	const bySlot = new Map(inventory.slots.map((entry) => [entry.slot, entry.item]));
	const order: number[] = [];
	if (inventory.selectedSlot != null) order.push(36 + inventory.selectedSlot);
	order.push(45);
	for (let slot = 36; slot <= 44; slot++) order.push(slot);
	for (let slot = 9; slot <= 35; slot++) order.push(slot);
	const seen = new Set<number>();
	const carried: { slot: number; id: number }[] = [];
	for (const slot of order) {
		const id = mapIdOf(bySlot.get(slot) ?? null);
		if (id == null || seen.has(id)) continue;
		seen.add(id);
		carried.push({ slot, id });
	}
	return carried;
}

function mapNotFound(message: string, hint: string): never {
	throw callFailure({
		code: "NOT_FOUND",
		source: "world",
		message,
		hint,
		dispatch: "not_sent",
		effects: [],
		recoverable: true,
	});
}

/**
 * 一次 sample 固定选图与切面。显式 id 必须对应当前携带的 filled_map；
 * 没有已开地图报 NOT_FOUND，不自动开图或装备。
 */
export function sampleMap(facts: ClientFactsPort, input: MapQueryInput): MapSample {
	return facts.sample((view) => {
		const inventory = view.inventory();
		if (inventory.value == null) {
			mapNotFound(
				"inventory has not arrived; carried maps cannot be resolved",
				"wait for the connection to sync (inventory@1) before querying map@1",
			);
		}
		const carried = carriedMapIds(inventory.value);
		const id = input.id ?? carried[0]?.id ?? null;
		if (id == null) mapNotFound("no map is carried", "carry or activate a filled_map first; map@1 does not open maps");
		if (input.id != null && !carried.some((entry) => entry.id === input.id)) {
			mapNotFound(
				`map id ${input.id} is not carried`,
				`carried map ids: ${carried.map((entry) => entry.id).join(", ") || "(none)"}`,
			);
		}
		const map = view.map(id);
		const unknown = [...inventory.unknown];
		if (map.value == null) {
			unknown.push(...map.unknown);
			return {
				id,
				colors: new Array(MAP_CELLS).fill(null),
				scale: null,
				locked: null,
				icons: null,
				receivedPixels: 0,
				paintedPixels: 0,
				unknown,
				observedAt: map.observedAt,
			} satisfies MapSample;
		}
		let receivedPixels = 0;
		let paintedPixels = 0;
		for (const pixel of map.value.colors) {
			if (pixel == null) continue;
			receivedPixels += 1;
			if (pixel > 3) paintedPixels += 1; // byte 0..3 是透明（NONE）
		}
		return {
			id,
			colors: map.value.colors,
			scale: map.value.scale,
			locked: map.value.locked,
			icons: map.value.icons,
			receivedPixels,
			paintedPixels,
			unknown,
			observedAt: map.observedAt,
		} satisfies MapSample;
	}).value;
}

export interface MapImageExport {
	ref: ImageFileRef;
	legend: string;
}

/**
 * 编码本次切面为 512×512 PNG 并原子写 `<imageDir>/<sha256>.png`。
 * 同摘要文件重复查询写同名文件（字节相同，rename 原子替换），旧引用不失效。
 */
export async function exportMapImage(imageDir: string, sample: MapSample): Promise<MapImageExport> {
	const png = encodeMapPng(sample.colors);
	const sha256 = createHash("sha256").update(png).digest("hex");
	const path = join(imageDir, `${sha256}.png`);
	await mkdir(imageDir, { recursive: true });
	const tmp = join(imageDir, `.${sha256}.tmp`);
	const handle = await open(tmp, "w");
	try {
		await handle.writeFile(png);
	} finally {
		await handle.close();
	}
	await rename(tmp, path);
	const legend = `map ${sample.id} cut: ${sample.receivedPixels}/${MAP_CELLS} pixels received, ${sample.paintedPixels} painted; magenta checkerboard = unknown, parchment = received transparent`;
	return {
		ref: { path, sha256, bytes: png.length, mimeType: "image/png", width: MAP_IMAGE_SIZE, height: MAP_IMAGE_SIZE },
		legend,
	};
}

/** read_image 授权校验（executor.md §2.1.1）：realpath 必须落在 imageDir 内，字节与摘要一致。 */
export async function readExportedImage(
	imageDir: string,
	ref: Pick<ImageFileRef, "path" | "sha256" | "bytes" | "mimeType">,
): Promise<{ mimeType: "image/png"; data: string }> {
	if (ref.mimeType !== "image/png") throw new Error(`unsupported image mime type: ${ref.mimeType}`);
	const realDir = await realpath(imageDir);
	const realPath = await realpath(ref.path).catch(() => {
		throw new Error(`image file does not exist: ${ref.path}`);
	});
	if (realPath !== realDir && !realPath.startsWith(realDir + sep)) {
		throw new Error(`image path is outside the export directory: ${ref.path}`);
	}
	const bytes = await readFile(realPath);
	if (bytes.length !== ref.bytes)
		throw new Error(`image size mismatch: file has ${bytes.length}, ref claims ${ref.bytes}`);
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== ref.sha256) throw new Error(`image digest mismatch: file is ${digest}, ref claims ${ref.sha256}`);
	return { mimeType: "image/png", data: bytes.toString("base64") };
}

/** 只在 readMap 内使用的完整返回值（capabilities.md §map）。 */
export interface MapQueryValue {
	id: number;
	scale: number | null;
	locked: boolean | null;
	center: { x: number; z: number } | null;
	dimension: string | null;
	icons: MapIconValue[] | null;
	receivedPixels: number;
	totalPixels: number;
	paintedPixels: number;
	image: ImageFileRef | null;
}

export function mapValueOf(sample: MapSample, image: ImageFileRef | null): MapQueryValue {
	return {
		id: sample.id,
		scale: sample.scale,
		locked: sample.locked,
		center: null,
		dimension: null,
		icons: sample.icons,
		receivedPixels: sample.receivedPixels,
		totalPixels: MAP_CELLS,
		paintedPixels: sample.paintedPixels,
		image,
	};
}
