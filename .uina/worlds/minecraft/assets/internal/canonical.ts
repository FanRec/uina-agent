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
 * 内容身份摘要：kind/schema/content/objects/requiredAssets 的规范编码摘要。
 * put 与 read 两侧共用同一函数，read 侧重算核对（assets.md §7.2）。
 */
export function contentDigestOf(identity: {
	kind: string;
	schema: ExactRef;
	content: unknown;
	objects: unknown;
	requiredAssets: readonly string[];
}): Digest {
	return digestOfText(
		canonicalJson({
			domain: "minecraft-asset-content/1",
			kind: identity.kind,
			schema: identity.schema,
			content: identity.content,
			objects: identity.objects,
			requiredAssets: [...identity.requiredAssets],
		}),
	);
}

/** 请求意图摘要（操作账本重放键值）；不含 requestId 本身（id 是键，不是意图）。 */
export function intentDigestOf(intent: unknown): Digest {
	return digestOfText(canonicalJson({ domain: "minecraft-asset-request/1", intent }));
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
