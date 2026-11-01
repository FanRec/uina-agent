/**
 * 生成 tests/mc/fixtures/*.schem：Sponge schematic v2 的最小合法产物。
 *
 * 为什么要脚本而不是手写二进制：NBT 的 tag/长度前缀必须精确，二进制差异看不出来；
 * 脚本让"这份夹具到底装了什么"可读、可复现。产物入库，测试与真服场景都读同一份字节，
 * 于是解码器面对的是真实文件而不是自己构造的内存对象。
 *
 * 结构（5×4×5 木屋，**不含地板**：真服地面就是地板，见 dev/MC-WORLD.md 批14）：
 *   y=0..2     四面墙木板（每层 16 格），北墙 (2,0,0)/(2,1,0) 开门（下半/上半）
 *   y=0        室内 (1,0,1) 一支火把（贴在真服地面上）
 *   y=3        屋顶 5×5 木板
 * 其余格是空气。house-v2.schem 在 (3,1,3) 多一块圆石，用于"计划之后改图"的 digest 冲突。
 *
 * 用法：node scripts/make-mc-schem-fixture.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const WIDTH = 5;
const HEIGHT = 4;
const LENGTH = 5;

// ---- 极简 NBT 写入（只有本夹具用到的 tag） ----

const tag = {
	byte: (v) => ({ t: 1, v }),
	short: (v) => ({ t: 2, v }),
	int: (v) => ({ t: 3, v }),
	byteArray: (v) => ({ t: 7, v }),
	string: (v) => ({ t: 8, v }),
	list: (of, v) => ({ t: 9, of, v }),
	compound: (v) => ({ t: 10, v }),
	intArray: (v) => ({ t: 11, v }),
};

function nameBytes(name) {
	const bytes = Buffer.from(name, "utf8");
	const out = Buffer.alloc(2);
	out.writeUInt16BE(bytes.length, 0);
	return Buffer.concat([out, bytes]);
}

function payload(value) {
	switch (value.t) {
		case 1: {
			const out = Buffer.alloc(1);
			out.writeInt8(value.v, 0);
			return out;
		}
		case 2: {
			const out = Buffer.alloc(2);
			out.writeInt16BE(value.v, 0);
			return out;
		}
		case 3: {
			const out = Buffer.alloc(4);
			out.writeInt32BE(value.v, 0);
			return out;
		}
		case 7: {
			const out = Buffer.alloc(4);
			out.writeInt32BE(value.v.length, 0);
			return Buffer.concat([out, Buffer.from(value.v)]);
		}
		case 8:
			return Buffer.concat([nameBytes(value.v)]);
		case 9: {
			const head = Buffer.alloc(5);
			head.writeInt8(tagOf(value.of), 0);
			head.writeInt32BE(value.v.length, 1);
			return Buffer.concat([head, ...value.v.map((item) => payload({ t: tagOf(value.of), v: item }))]);
		}
		case 10:
			return Buffer.concat([
				...Object.entries(value.v).map(([key, entry]) =>
					Buffer.concat([Buffer.from([entry.t]), nameBytes(key), payload(entry)]),
				),
				Buffer.from([0]),
			]);
		case 11: {
			const head = Buffer.alloc(4);
			head.writeInt32BE(value.v.length, 0);
			const body = Buffer.alloc(value.v.length * 4);
			value.v.forEach((item, index) => body.writeInt32BE(item, index * 4));
			return Buffer.concat([head, body]);
		}
		default:
			throw new Error(`unsupported tag ${value.t}`);
	}
}

function tagOf(primitive) {
	if (typeof primitive === "number") return Number.isInteger(primitive) ? 3 : 6;
	if (typeof primitive === "string") return 8;
	throw new Error("unsupported list element");
}

/** 无符号 LEB128 编码。 */
function varint(value) {
	const out = [];
	let rest = value;
	do {
		let byte = rest & 0x7f;
		rest >>>= 7;
		if (rest !== 0) byte |= 0x80;
		out.push(byte);
	} while (rest !== 0);
	return out;
}

// ---- 设计内容 ----

function house({ withCobble }) {
	const cells = new Map();
	const put = (x, y, z, state) => cells.set(`${x},${y},${z}`, state);
	for (let y = 0; y <= 2; y++) {
		for (let x = 0; x < WIDTH; x++) {
			for (let z = 0; z < LENGTH; z++) {
				const edge = x === 0 || x === WIDTH - 1 || z === 0 || z === LENGTH - 1;
				if (edge) put(x, y, z, "minecraft:oak_planks");
			}
		}
	}
	// 门：只声明 half，其余状态由服务端决定（未声明的状态不构成完成条件）。
	put(2, 0, 0, "minecraft:oak_door[half=lower]");
	put(2, 1, 0, "minecraft:oak_door[half=upper]");
	put(1, 0, 1, "minecraft:torch");
	if (withCobble) put(3, 1, 3, "minecraft:cobblestone");
	for (let x = 0; x < WIDTH; x++) for (let z = 0; z < LENGTH; z++) put(x, 3, z, "minecraft:oak_planks");
	return cells;
}

function encode(cells) {
	const states = [...new Set(cells.values())].sort();
	const palette = new Map(states.map((state, index) => [state, index]));
	const data = [];
	for (let y = 0; y < HEIGHT; y++) {
		for (let z = 0; z < LENGTH; z++) {
			for (let x = 0; x < WIDTH; x++) {
				const state = cells.get(`${x},${y},${z}`) ?? "minecraft:air";
				if (!palette.has(state)) palette.set(state, palette.size);
				data.push(...varint(palette.get(state)));
			}
		}
	}
	const root = {
		Version: tag.int(2),
		DataVersion: tag.int(4189),
		Width: tag.short(WIDTH),
		Height: tag.short(HEIGHT),
		Length: tag.short(LENGTH),
		Offset: tag.intArray([0, 0, 0]),
		Metadata: tag.compound({ Name: tag.string("uina fixture house"), Author: tag.string("uina") }),
		PaletteMax: tag.int(palette.size),
		Palette: tag.compound(Object.fromEntries([...palette].map(([state, index]) => [state, tag.int(index)]))),
		BlockData: tag.byteArray(data),
		BlockEntities: tag.list("string", []),
	};
	const body = Buffer.concat([Buffer.from([10]), nameBytes("Schematic"), payload(tag.compound(root))]);
	return gzipSync(body);
}

const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, "..", "tests", "mc", "fixtures");
mkdirSync(output, { recursive: true });

const plain = encode(house({ withCobble: false }));
const variant = encode(house({ withCobble: true }));
writeFileSync(join(output, "house.schem"), plain);
writeFileSync(join(output, "house-v2.schem"), variant);
console.log(`house.schem ${plain.length} bytes, house-v2.schem ${variant.length} bytes -> ${output}`);
