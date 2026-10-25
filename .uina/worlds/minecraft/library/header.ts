/** One first-line parser for program and experience headers; reads retain diagnostics. */
import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import type { ProgramHeader, TextMetadata } from "../contracts/library.js";

const Ajv = createRequire(import.meta.url)("ajv") as new (
	options: object,
) => { compile(schema: object): ValidateFunction };
const ajv = new Ajv({ strict: false, allErrors: true, addUsedSchema: false });
export function validateHeader(raw: unknown, kind: "program" | "experience" | "blueprint"): void {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("header must be an object");
	const h = raw as Record<string, unknown>;
	const allowed =
		kind === "program"
			? ["summary", "tags", "input", "output", "examples", "saved"]
			: kind === "experience"
				? ["summary", "tags", "applies"]
				: ["summary", "tags"];
	if (Object.keys(h).some((k) => !allowed.includes(k))) throw new Error("unknown metadata field");
	if (h.summary !== undefined && typeof h.summary !== "string") throw new Error("summary must be a string");
	if (kind === "blueprint" && typeof h.summary !== "string") throw new Error("blueprint summary is required");
	for (const key of ["tags", "applies"])
		if (h[key] !== undefined && (!Array.isArray(h[key]) || !h[key].every((t) => typeof t === "string")))
			throw new Error(`${key} must be strings`);
	for (const key of ["input", "output"])
		if (h[key] !== undefined) {
			if (!h[key] || typeof h[key] !== "object" || Array.isArray(h[key]))
				throw new Error(`${key} must be a schema object`);
			ajv.compile(h[key]);
		}
	if (h.examples !== undefined) {
		if (!Array.isArray(h.examples)) throw new Error("examples must be an array");
		for (const e of h.examples) {
			if (
				!e ||
				typeof e !== "object" ||
				Array.isArray(e) ||
				!("input" in e) ||
				Object.keys(e).some((k) => !["input", "output"].includes(k))
			)
				throw new Error("invalid example");
			for (const key of ["input", "output"])
				if (key in e && h[key] && !ajv.compile(h[key] as object)(e[key])) throw new Error(`example ${key} rejected`);
		}
	}
	if (h.saved !== undefined) {
		const s = h.saved as Record<string, unknown>;
		const fields = ["run", "segment", "call", "digest", "at"];
		if (
			!s ||
			typeof s !== "object" ||
			Array.isArray(s) ||
			fields.some((k) => typeof s[k] !== "string") ||
			Object.keys(s).some((k) => !fields.includes(k))
		)
			throw new Error("invalid saved origin");
	}
}
export interface ParsedHeader<T> {
	header: T | null;
	body: string;
	bom: string;
	newline: string;
	error?: string;
}
export function parseHeader<T extends ProgramHeader | TextMetadata>(
	source: string,
	kind: "program" | "experience",
): ParsedHeader<T> {
	const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
	const text = source.slice(bom.length),
		end = text.indexOf("\n");
	const first = (end < 0 ? text : text.slice(0, end)).replace(/\r$/, "");
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const marker = kind === "program" ? /^\/\/ uina(?:\s|$)/ : /^<!-- uina(?:\s|$)/;
	if (!marker.test(first)) return { header: null, body: text, bom, newline };
	const body = end < 0 ? "" : text.slice(end + 1);
	try {
		const next = body.split(/\r?\n/, 1)[0]!;
		if (marker.test(next)) throw new Error("multiple structured headers");
		const match = kind === "program" ? /^\/\/ uina\s+(.+)$/.exec(first) : /^<!-- uina\s+(.+)\s+-->$/.exec(first);
		if (!match) throw new Error("malformed structured header");
		const header: unknown = JSON.parse(match[1]!);
		validateHeader(header, kind);
		return { header: header as T, body, bom, newline };
	} catch (error) {
		return { header: null, body, bom, newline, error: String(error) };
	}
}
export function withHeader(
	source: string,
	header: ProgramHeader | TextMetadata,
	kind: "program" | "experience",
): string {
	const p = parseHeader(source, kind);
	const json = JSON.stringify(header)
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
	return p.bom + (kind === "program" ? `// uina ${json}` : `<!-- uina ${json} -->`) + p.newline + p.body;
}
export function patchHeader<T extends ProgramHeader | TextMetadata>(header: T, patch: object): T {
	const result = { ...header } as Record<string, unknown>;
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			if (key === "tags") result.tags = [];
			else delete result[key];
		} else result[key] = value;
	}
	return result as T;
}
