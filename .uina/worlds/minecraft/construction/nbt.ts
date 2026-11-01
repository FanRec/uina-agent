/**
 * 最小 NBT 读取器：只为解码蓝图原件，不做写入、不做 SNBT。
 *
 * 唯一定义来源：本文件（蓝图格式支持范围见 docs/proposals/mc/modules/library.md §3.3、
 * capabilities.md §4 build）。Sponge `.schem` 是 gzip 的 NBT，因此这里同时处理
 * 压缩探测。所有长度/深度都有显式上限：来自文件的字节不能被无限信任，
 * 越界一律结构化失败，不返回半份数据。
 *
 * 值域映射（够用即可，不做 NBT 类型保真）：
 * - Byte/Short/Int → number，Long → bigint（超出 2^53，保留类型）
 * - Float/Double → number，String → string
 * - Byte_Array → Uint8Array（按位读，不做符号解释），Int_Array → Int32Array，
 *   Long_Array → BigInt64Array
 * - List → Array，Compound → Record
 */

import { gunzipSync } from "node:zlib";

export type NbtValue = number | bigint | string | Uint8Array | Int32Array | BigInt64Array | NbtValue[] | NbtCompound;

export interface NbtCompound {
	[key: string]: NbtValue;
}

export interface NbtDocument {
	name: string;
	value: NbtCompound;
}

export class NbtError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NbtError";
	}
}

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

/** 深度上限：合法蓝图不会嵌套这么深，越界一定是坏文件或刻意构造的。 */
const MAX_DEPTH = 32;
/** 字符串上限 1 MiB。 */
const MAX_STRING_BYTES = 1 << 20;
/** 数组/列表元素上限 2^24（16M）：8192 体素的设计远小于这个数。 */
const MAX_ELEMENTS = 1 << 24;

class Reader {
	private offset = 0;
	constructor(private readonly buffer: Buffer) {}

	private need(bytes: number, what: string): void {
		if (this.offset + bytes > this.buffer.length) {
			throw new NbtError(`unexpected end of NBT payload while reading ${what} at offset ${this.offset}`);
		}
	}

	private u8(what: string): number {
		this.need(1, what);
		return this.buffer[this.offset++]!;
	}

	private i16(what: string): number {
		this.need(2, what);
		const value = this.buffer.readInt16BE(this.offset);
		this.offset += 2;
		return value;
	}

	private u16(what: string): number {
		this.need(2, what);
		const value = this.buffer.readUInt16BE(this.offset);
		this.offset += 2;
		return value;
	}

	private i32(what: string): number {
		this.need(4, what);
		const value = this.buffer.readInt32BE(this.offset);
		this.offset += 4;
		return value;
	}

	private i64(what: string): bigint {
		this.need(8, what);
		const value = this.buffer.readBigInt64BE(this.offset);
		this.offset += 8;
		return value;
	}

	private f32(what: string): number {
		this.need(4, what);
		const value = this.buffer.readFloatBE(this.offset);
		this.offset += 4;
		return value;
	}

	private f64(what: string): number {
		this.need(8, what);
		const value = this.buffer.readDoubleBE(this.offset);
		this.offset += 8;
		return value;
	}

	private string(what: string): string {
		const length = this.u16(what);
		if (length > MAX_STRING_BYTES) throw new NbtError(`${what} is ${length} bytes, over the ${MAX_STRING_BYTES} limit`);
		this.need(length, what);
		const value = this.buffer.toString("utf8", this.offset, this.offset + length);
		this.offset += length;
		return value;
	}

	private count(what: string): number {
		const value = this.i32(what);
		if (value < 0) throw new NbtError(`${what} has a negative length ${value}`);
		if (value > MAX_ELEMENTS) throw new NbtError(`${what} is ${value} elements, over the ${MAX_ELEMENTS} limit`);
		return value;
	}

	/** 根标签：必须是一个带名字的 Compound。 */
	root(): NbtDocument {
		const tag = this.u8("root tag");
		if (tag !== TAG_COMPOUND) throw new NbtError(`NBT root must be a compound, got tag ${tag}`);
		const name = this.string("root name");
		return { name, value: this.payload(TAG_COMPOUND, 0, "root") as NbtCompound };
	}

	/** 读一个标签的 payload；tag 已由调用方读出。 */
	payload(tag: number, depth: number, what: string): NbtValue {
		if (depth > MAX_DEPTH) throw new NbtError(`NBT nesting exceeds ${MAX_DEPTH} levels at ${what}`);
		switch (tag) {
			case TAG_BYTE:
				return (this.u8(what) << 24) >> 24;
			case TAG_SHORT:
				return this.i16(what);
			case TAG_INT:
				return this.i32(what);
			case TAG_LONG:
				return this.i64(what);
			case TAG_FLOAT:
				return this.f32(what);
			case TAG_DOUBLE:
				return this.f64(what);
			case TAG_BYTE_ARRAY: {
				const length = this.count(`${what} length`);
				this.need(length, what);
				const bytes = new Uint8Array(this.buffer.subarray(this.offset, this.offset + length));
				this.offset += length;
				return bytes;
			}
			case TAG_STRING:
				return this.string(what);
			case TAG_LIST: {
				const elementTag = this.u8(`${what} element type`);
				const length = this.count(`${what} length`);
				if (elementTag === TAG_END && length > 0) throw new NbtError(`${what} is a list of TAG_End`);
				const items: NbtValue[] = [];
				for (let index = 0; index < length; index++) {
					items.push(this.payload(elementTag, depth + 1, `${what}[${index}]`));
				}
				return items;
			}
			case TAG_COMPOUND: {
				const compound: NbtCompound = {};
				for (;;) {
					const childTag = this.u8(`${what} tag`);
					if (childTag === TAG_END) return compound;
					const name = this.string(`${what} name`);
					compound[name] = this.payload(childTag, depth + 1, `${what}.${name}`);
				}
			}
			case TAG_INT_ARRAY: {
				const length = this.count(`${what} length`);
				this.need(length * 4, what);
				const items = new Int32Array(length);
				for (let index = 0; index < length; index++) items[index] = this.i32(`${what}[${index}]`);
				return items;
			}
			case TAG_LONG_ARRAY: {
				const length = this.count(`${what} length`);
				this.need(length * 8, what);
				const items = new BigInt64Array(length);
				for (let index = 0; index < length; index++) items[index] = this.i64(`${what}[${index}]`);
				return items;
			}
			default:
				throw new NbtError(`unknown NBT tag ${tag} at ${what}`);
		}
	}
}

const GZIP_MAGIC = [0x1f, 0x8b] as const;

/** gzip 探测：Sponge 规范要求压缩，但个别工具直写未压缩的 NBT。 */
export function inflateIfGzip(bytes: Uint8Array): Buffer {
	const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	if (buffer.length >= 2 && buffer[0] === GZIP_MAGIC[0] && buffer[1] === GZIP_MAGIC[1]) {
		try {
			return gunzipSync(buffer);
		} catch (error) {
			throw new NbtError(`gzip payload is corrupt: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return buffer;
}

/** 读根标签：NBT 文件的根必须是一个带名字的 Compound。 */
export function readNbt(bytes: Uint8Array): NbtDocument {
	const buffer = inflateIfGzip(bytes);
	if (buffer.length === 0) throw new NbtError("NBT payload is empty");
	return new Reader(buffer).root();
}

// ---- 读取助手：类型不符时报出路径，不静默返回 undefined ----

function typed<T>(value: NbtValue | undefined, what: string, test: (v: NbtValue) => boolean, expected: string): T {
	if (value === undefined) throw new NbtError(`missing NBT field ${what}`);
	if (!test(value)) throw new NbtError(`NBT field ${what} must be ${expected}`);
	return value as T;
}

export function nbtCompound(value: NbtValue | undefined, what: string): NbtCompound {
	return typed<NbtCompound>(
		value,
		what,
		(v) => typeof v === "object" && v != null && !Array.isArray(v) && !ArrayBuffer.isView(v),
		"a compound",
	);
}

export function nbtInt(value: NbtValue | undefined, what: string): number {
	return typed<number>(value, what, (v) => typeof v === "number" && Number.isInteger(v), "an integer");
}

export function nbtString(value: NbtValue | undefined, what: string): string {
	return typed<string>(value, what, (v) => typeof v === "string", "a string");
}

export function nbtByteArray(value: NbtValue | undefined, what: string): Uint8Array {
	return typed<Uint8Array>(value, what, (v) => v instanceof Uint8Array, "a byte array");
}

export function nbtCompoundList(value: NbtValue | undefined, what: string): NbtCompound[] {
	return typed<NbtCompound[]>(value, what, (v) => Array.isArray(v), "a list");
}

export function optionalNbtInt(value: NbtValue | undefined, what: string): number | null {
	if (value === undefined) return null;
	return nbtInt(value, what);
}
