/**
 * 规范编码、摘要与引用解析（Assets 内部实现）。
 *
 * 规范 JSON（assets.md §4 的 J）：对象键按 UTF-16 码元序递归排序、无空白、
 * 数组顺序保留；字符串与有限数字按 ECMAScript JSON.stringify 编码。
 * 内容摘要只覆盖内容身份（kind/schema/content/objects/requiredAssets），
 * 不覆盖逻辑版本、head、objectId、evidence/sources（出处，assets.md §1.2/§4）。
 */

import { createHash } from "node:crypto";
import type { ExactRef } from "../../contracts/values.js";

export type Digest = `sha256:${string}`;

/** 规范 JSON：undefined 对象值跳过（可选字段）、数组内 undefined 归 null、非有限数字/非 JSON 值抛错。 */
export function canonicalJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("规范 JSON 不接受非有限数字");
		return JSON.stringify(value);
	}
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
		throw new TypeError("规范 JSON 不接受该值类型");
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function digestOfText(text: string): Digest {
	return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function digestOfBytes(bytes: Uint8Array): Digest {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function isDigestFormat(value: unknown): value is Digest {
	return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * inputDigest（assets.md §4）：author 为捕获后去除工作区 editing 的作者 Manifest
 * 规范值，payloads 为声明发布文件的真实路径/媒体类型/长度/原始字节摘要表（ASCII 排序）。
 */
export function inputDigestOf(input: {
	author: unknown;
	payloads: readonly { path: string; mediaType: string; byteLength: number; digest: string }[];
}): Digest {
	return digestOfText(
		canonicalJson({
			domain: "assets-input/1",
			author: input.author,
			payloads: [...input.payloads].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
		}),
	);
}

/** packageDigest（assets.md §4）：包 Manifest 实际字节的摘要再经域封装。 */
export function packageDigestOf(manifestDigest: Digest): Digest {
	return digestOfText(canonicalJson({ domain: "assets-package/1", manifestDigest }));
}

/**
 * intentDigest（assets.md §6.4）：操作账本重放键值；API 自行计算，模型不能提交。
 * sourceIdentity 对 workspace 为规范化 directory；对 import 为规范化 definition/文件声明/label；
 * 对 run 为 run/segment/record 与 authorMetadata。
 */
export function intentDigestOf(intent: unknown): Digest {
	return digestOfText(canonicalJson({ domain: "assets-publish/1", intent }));
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/;
/** Windows 保留设备名（大小写不敏感，含 "CON.txt" 形式；assets.md §3.1）。 */
const RESERVED_DEVICE_NAMES = new Set([
	"con",
	"prn",
	"aux",
	"nul",
	...["com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9"],
	...["lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"],
]);

export function isValidAssetName(name: unknown): name is string {
	if (typeof name !== "string" || !NAME_PATTERN.test(name)) return false;
	const base = name.split(".", 1)[0];
	return !RESERVED_DEVICE_NAMES.has(base);
}

export interface ParsedExactRef {
	name: string;
	version: number;
}

/** 解析 `<name>@<positive-integer>`；拒绝前导零与非正整数版本。 */
export function parseExactRef(ref: unknown): ParsedExactRef | null {
	if (typeof ref !== "string") return null;
	const at = ref.indexOf("@");
	if (at <= 0 || at === ref.length - 1 || ref.includes("@", at + 1)) return null;
	const name = ref.slice(0, at);
	const versionText = ref.slice(at + 1);
	if (!/^[1-9][0-9]*$/.test(versionText)) return null;
	if (!isValidAssetName(name)) return null;
	return { name, version: Number(versionText) };
}

export function formatRef(name: string, version: number): ExactRef {
	return `${name}@${version}`;
}
