/**
 * 地图切面的 PNG 编码（world.md §8.6 的唯一实现，纯函数无 IO）。
 *
 * 输入是 map@1 采样的 128×128 (number|null)[]（z 行 x 列；null=未收到，
 * 0..3=已收到的透明色），输出固定 512×512 的真彩色 PNG（4× 整数倍放大）：
 * 未收到 = 棋盘遮罩两灰阶；已收到的透明 = 地图纸底色；其余 = 版本色板 RGB。
 * 棋盘/纸色是本项目固定的显示常量，不属于协议事实；色板见 driver/facts/map-colors.ts。
 */

import { deflateSync } from "node:zlib";
import { MAP_PALETTE } from "./map-colors.js";

export const MAP_CELLS = 128 * 128;
export const MAP_IMAGE_SCALE = 4;
export const MAP_IMAGE_SIZE = 128 * MAP_IMAGE_SCALE;

/** 未收到像素的棋盘遮罩：品红两档按 (x+z) 交替，与全部色板条目都可区分。 */
export const MAP_UNKNOWN_CHECKER: readonly [number, number, number] = [255, 0, 255] as const;
const CHECKER_B: readonly [number, number, number] = [128, 0, 128] as const;
/** 已收到的透明色（byte 0..3，服务端 calculateARGBColor 恒 0）保留的地图纸底色。 */
export const MAP_PAPER_RGB: readonly [number, number, number] = [240, 235, 214] as const;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
	return Buffer.concat([head, data, crc]);
}

/** 色板字节 → RGB；byte<4 是透明（NONE），由调用方决定纸色。 */
export function mapByteRgb(byte: number): readonly [number, number, number] | null {
	const entry = MAP_PALETTE[byte];
	if (entry == null) return null;
	return entry.rgb;
}

/** 把一次采样的 128×128 (number|null)[] 编码为 512×512 PNG。像素个数必须是 16384。 */
export function encodeMapPng(colors: readonly (number | null)[]): Buffer {
	if (colors.length !== MAP_CELLS) throw new Error(`map colors length must be ${MAP_CELLS}, got ${colors.length}`);
	const width = MAP_IMAGE_SIZE;
	const raw = Buffer.alloc((width * 3 + 1) * width);
	let offset = 0;
	for (let y = 0; y < width; y++) {
		raw[offset++] = 0; // filter: none
		const srcY = y >>> 2; // 4× 最近邻：目标行 y 对应源行 y>>2
		for (let x = 0; x < width; x++) {
			const srcX = x >>> 2;
			const pixel = colors[srcY * 128 + srcX];
			let r: number;
			let g: number;
			let b: number;
			if (pixel == null) {
				[r, g, b] = (srcX + srcY) % 2 === 0 ? MAP_UNKNOWN_CHECKER : CHECKER_B;
			} else if (pixel < 4) {
				[r, g, b] = MAP_PAPER_RGB;
			} else {
				const rgb = MAP_PALETTE[pixel]?.rgb ?? ([0, 0, 0] as const);
				[r, g, b] = rgb;
			}
			raw[offset++] = r;
			raw[offset++] = g;
			raw[offset++] = b;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(width, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 6 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
