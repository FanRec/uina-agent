import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { builtinCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
import { emptyFactRevisions } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type {
	ClientFactView,
	ClientInventoryValue,
	ClientMapValue,
} from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { Fact } from "../../.uina/worlds/minecraft/contracts/values.js";
import { MAP_CELLS, MAP_IMAGE_SIZE } from "../../.uina/worlds/minecraft/world/png.js";
import {
	exportMapImage,
	MAP_REF,
	pruneExportedImages,
	readExportedImage,
} from "../../.uina/worlds/minecraft/world/map.js";
import { MinecraftWorld } from "../../.uina/worlds/minecraft/world/index.js";

/**
 * map@1 读取材料（world.md §8.6 / capabilities.md §map）：选图顺序、计数、
 * PNG 缓存与 read_image 授权校验。facts 用手造视图；文件用真实临时目录。
 */

const capabilities = builtinCatalog.bind({
	surface: () => null,
	knowledge: () => null,
	gotoDirector: {} as never,
	runtime: () => {
		throw new Error("unused runtime");
	},
});

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function filledMap(id: number): ClientInventoryValue["slots"][number]["item"] {
	return {
		name: "filled_map",
		count: 1,
		stackSize: 64,
		durability: null,
		components: { added: [{ type: "map_id", data: id }], removed: [] },
	};
}

function inventory(entries: { slot: number; item: unknown }[], selectedSlot = 2): ClientInventoryValue {
	const slots = new Map(entries.map((entry) => [entry.slot, entry.item]));
	const all: ClientInventoryValue["slots"] = [];
	for (let slot = 0; slot < 46; slot++) {
		all.push({ slot, known: true, item: (slots.get(slot) ?? null) as ClientInventoryValue["slots"][number]["item"] });
	}
	return {
		revision: 1,
		layout: {
			slotCount: 46,
			regions: [
				{ name: "crafting", slots: [0, 1, 2, 3, 4] },
				{ name: "armor", slots: [5, 6, 7, 8] },
				{ name: "main", slots: Array.from({ length: 27 }, (_, i) => 9 + i) },
				{ name: "hotbar", slots: Array.from({ length: 9 }, (_, i) => 36 + i) },
				{ name: "offhand", slots: [45] },
			],
		},
		slots: all,
		selectedSlot,
	};
}

/** colors[0]=GRASS HIGH、colors[1]=透明、其余未收到。 */
function mapColors(): (number | null)[] {
	const colors: (number | null)[] = new Array(MAP_CELLS).fill(null);
	colors[0] = 6;
	colors[1] = 0;
	return colors;
}

function mapValue(id: number, colors: (number | null)[]): ClientMapValue {
	return { id, scale: 0, locked: false, colors, icons: null, center: null, dimension: null };
}

function fakeFacts(view: Partial<ClientFactView>) {
	const stamp = {
		source: "facts:t",
		epoch: "ep:t",
		sequence: 1,
		revisions: emptyFactRevisions(),
		connection: "conn:t",
		incarnation: "inc:t",
	};
	const facts = {
		sample: (fn: (view: ClientFactView) => unknown) => ({
			stamp,
			scope: { binding: "b", world: "w", worldRevision: "r", dimension: "overworld" },
			evidenceThrough: { stream: "evs:t", sequence: 0 },
			value: fn(view as ClientFactView),
		}),
		subscribe: () => ({
			stamp,
			evidenceThrough: { stream: "evs:t", sequence: 0 },
			acknowledge() {},
			close() {},
		}),
	};
	return facts as ConstructorParameters<typeof MinecraftWorld>[0]["facts"];
}

function makeWorld(facts: ReturnType<typeof fakeFacts>, imageDir?: string): MinecraftWorld {
	return new MinecraftWorld({
		facts,
		readers: capabilities.readers,
		validators: capabilities.validators,
		queries: capabilities.queries,
		dbPath: join(tempDir("uina-map-world-"), "history.db"),
		binding: { binding: "b:t", world: "w:t", worldRevision: "r:t" },
		namespace: "map-test",
		...(imageDir == null ? {} : { imageDir }),
	});
}

interface DecodedPng {
	width: number;
	height: number;
	pixel(x: number, y: number): [number, number, number];
}

/** 最小 PNG 解码：签名 + IHDR + inflate(IDAT) 后逐像素取 RGB。 */
function decodePng(bytes: Buffer): DecodedPng {
	expect(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
	let offset = 8;
	const chunks = new Map<string, Buffer[]>();
	while (offset < bytes.length) {
		const length = bytes.readUInt32BE(offset);
		const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
		const data = bytes.subarray(offset + 8, offset + 8 + length);
		chunks.set(type, [...(chunks.get(type) ?? []), data]);
		offset += 12 + length;
	}
	const ihdr = chunks.get("IHDR")![0];
	const width = ihdr.readUInt32BE(0);
	const height = ihdr.readUInt32BE(4);
	expect(ihdr[8]).toBe(8);
	expect(ihdr[9]).toBe(2); // truecolor
	const raw = inflateSync(Buffer.concat(chunks.get("IDAT")!));
	return {
		width,
		height,
		pixel(x, y) {
			const stride = width * 3 + 1;
			const base = y * stride + 1 + x * 3;
			return [raw[base], raw[base + 1], raw[base + 2]];
		},
	};
}

async function readMap(world: MinecraftWorld, input: { id?: number; image?: boolean }) {
	return await world.read<{
		id: number;
		receivedPixels: number;
		paintedPixels: number;
		totalPixels: number;
		image: unknown;
		scale: number | null;
		icons: unknown;
	}>({
		ref: MAP_REF,
		input,
	});
}

describe("map@1 读取材料", () => {
	test("自动选图按 主手→副手→热键栏→背包；计数与图片导出", async () => {
		const imageDir = tempDir("uina-map-export-");
		const facts = fakeFacts({
			inventory: () =>
				factOf(
					inventory([
						{ slot: 20, item: filledMap(9) },
						{ slot: 38, item: filledMap(7) },
						{ slot: 45, item: filledMap(8) },
					]),
				),
			map: (id: number) => factOf(mapValue(id, id === 7 ? mapColors() : new Array(MAP_CELLS).fill(null))),
		});
		const world = makeWorld(facts, imageDir);
		const observation = await readMap(world, {});
		expect(observation.value.id).toBe(7); // 主手 36+2=38 优先
		expect(observation.value.receivedPixels).toBe(2);
		expect(observation.value.paintedPixels).toBe(1); // byte 6 算涂色，byte 0 是透明
		expect(observation.value.totalPixels).toBe(MAP_CELLS);
		expect(observation.cursor).toBeNull();
		const image = observation.value.image as {
			path: string;
			sha256: string;
			bytes: number;
			width: number;
			height: number;
		};
		expect(image).not.toBeNull();
		expect(image.width).toBe(MAP_IMAGE_SIZE);
		expect(image.height).toBe(MAP_IMAGE_SIZE);
		const bytes = readFileSync(image.path);
		expect(bytes.length).toBe(image.bytes);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(image.sha256);
		// PNG 内容：GRASS HIGH=(127,178,56)、透明=纸色、未知=品红棋盘（两档奇偶）
		const png = decodePng(bytes);
		expect(png.width).toBe(MAP_IMAGE_SIZE);
		expect(png.pixel(0, 0)).toEqual([127, 178, 56]); // 源 (0,0)
		expect(png.pixel(5, 3)).toEqual([240, 235, 214]); // 源 (1,0) 收到的透明
		expect(png.pixel(3, 5)).toEqual([128, 0, 128]); // 源 (0,1) 未收到，棋盘偶格
		expect(png.pixel(8, 0)).toEqual([255, 0, 255]); // 源 (2,0) 未收到，棋盘奇格
		// 显式 id：携带的另一张 map 也可以读（全未收到 → image=null + unknown）
		const other = await readMap(world, { id: 9 });
		expect(other.value.id).toBe(9);
		expect(other.value.receivedPixels).toBe(0);
		expect(other.value.image).toBeNull();
		expect(other.unknown.length).toBeGreaterThan(0);
	});

	test("image=false 只读元数据不产文件；imageDir 未配置时 image=null + unknown", async () => {
		const imageDir = tempDir("uina-map-export-");
		const facts = fakeFacts({
			inventory: () => factOf(inventory([{ slot: 38, item: filledMap(7) }])),
			map: (id: number) => factOf(mapValue(id, mapColors())),
		});
		const world = makeWorld(facts, imageDir);
		const before = readdirSafe(imageDir);
		const meta = await readMap(world, { image: false });
		expect(meta.value.image).toBeNull();
		expect(readdirSafe(imageDir).length).toBe(before.length);
		const noDir = makeWorld(facts);
		const degraded = await readMap(noDir, {});
		expect(degraded.value.image).toBeNull();
		expect(degraded.unknown.some((entry) => entry.includes("export directory"))).toBe(true);
		expect(degraded.value.receivedPixels).toBe(2);
	});

	test("没有携带地图或显式 id 未携带 → NOT_FOUND", async () => {
		const facts = fakeFacts({
			inventory: () => factOf(inventory([])),
			map: (id: number) => factOf(mapValue(id, mapColors())),
		});
		const world = makeWorld(facts, tempDir("uina-map-export-"));
		await expect(readMap(world, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
		const carried = fakeFacts({
			inventory: () => factOf(inventory([{ slot: 38, item: filledMap(7) }])),
			map: (id: number) => factOf(mapValue(id, mapColors())),
		});
		const withMap = makeWorld(carried, tempDir("uina-map-export-"));
		await expect(readMap(withMap, { id: 12 })).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(readMap(withMap, { id: -1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
	});

	test("read_image 授权校验：目录外、摘要不符、mime 不符都拒绝；有效 ref 返回 base64", async () => {
		const imageDir = tempDir("uina-map-export-");
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		writeFileSync(join(imageDir, "a.png"), png);
		const ref = {
			path: join(imageDir, "a.png"),
			sha256: createHash("sha256").update(png).digest("hex"),
			bytes: png.length,
			mimeType: "image/png" as const,
		};
		const delivered = await readExportedImage(imageDir, ref);
		expect(delivered.mimeType).toBe("image/png");
		expect(Buffer.from(delivered.data, "base64").equals(png)).toBe(true);

		const outside = tempDir("uina-map-outside-");
		const outsideFile = join(outside, "b.png");
		writeFileSync(outsideFile, png);
		await expect(readExportedImage(imageDir, { ...ref, path: outsideFile })).rejects.toThrow(
			/outside the export directory/,
		);
		await expect(readExportedImage(imageDir, { ...ref, sha256: "0".repeat(64) })).rejects.toThrow(/digest mismatch/);
		await expect(readExportedImage(imageDir, { ...ref, bytes: png.length + 1 })).rejects.toThrow(/size mismatch/);
		await expect(
			readExportedImage(imageDir, { ...ref, mimeType: "image/gif" as unknown as "image/png" }),
		).rejects.toThrow(/mime type/);
		await expect(readExportedImage(imageDir, { ...ref, path: join(imageDir, "missing.png") })).rejects.toThrow(
			/does not exist/,
		);
	});
});

function readdirSafe(dir: string): string[] {
	return existsSync(dir) ? readdirSync(dir) : [];
}

function factOf<T>(value: T): Fact<T> {
	return {
		value,
		observedAt: "2026-01-01T00:00:00.000Z",
		source: "server",
		coverage: "complete",
		unknown: [],
		evidence: [],
	};
}

// ---- 批22：同摘要并发导出与派生缓存生命周期 ----

function mapSample(id: number): Parameters<typeof exportMapImage>[1] {
	return {
		id,
		colors: new Array<number>(MAP_CELLS).fill(4),
		scale: null,
		locked: false,
		icons: null,
		receivedPixels: MAP_CELLS,
		paintedPixels: MAP_CELLS,
		unknown: [],
		observedAt: "t",
	};
}

describe("导出并发与生命周期", () => {
	test("同摘要并发导出互不冲突：双方成功、单文件、tmp 清干净", async () => {
		const dir = tempDir("uina-map-race-");
		const s = mapSample(1);
		const [a, b] = await Promise.all([exportMapImage(dir, s), exportMapImage(dir, s)]);
		expect(a.ref.sha256).toBe(b.ref.sha256);
		expect(a.ref.path).toBe(b.ref.path);
		expect(existsSync(a.ref.path)).toBe(true);
		expect(readdirSync(dir).filter((name) => name.endsWith(".png")).length).toBe(1);
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		const read = await readExportedImage(dir, a.ref);
		expect(read.mimeType).toBe("image/png");
	});

	test("启动清理删除上一会话的派生图片与残留 tmp，其他文件不动", async () => {
		const dir = tempDir("uina-map-prune-");
		writeFileSync(join(dir, "aaa.png"), "png");
		writeFileSync(join(dir, "bbb.png"), "png");
		writeFileSync(join(dir, ".stale.tmp"), "partial");
		writeFileSync(join(dir, "notes.txt"), "keep");
		expect(await pruneExportedImages(dir)).toBe(3);
		expect(existsSync(join(dir, "notes.txt"))).toBe(true);
		expect(existsSync(join(dir, "aaa.png"))).toBe(false);
		// 目录尚不存在：无事可清
		expect(await pruneExportedImages(join(dir, "missing"))).toBe(0);
	});
});
