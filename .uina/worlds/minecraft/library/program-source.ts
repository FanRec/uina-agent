/** Working-file ownership stays here; Program owns compilation and immutable snapshots. */
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import type { ProgramHeader, ResolvedProgram } from "../contracts/program.js";
import { callFailure } from "../contracts/values.js";
import { PROGRAM_POLICY } from "../program/policy.js";
import type { ValidateFunction } from "ajv";
const AjvConstructor = createRequire(import.meta.url)("ajv") as new (
	opts: object,
) => { compile(schema: object): ValidateFunction };
const ajv = new AjvConstructor({ strict: false, allErrors: true, addUsedSchema: false });

export function programError(code: string, message: string): never {
	throw callFailure({ code, source: "program", message, dispatch: "not_sent", effects: [], recoverable: true });
}
export function validateProgramName(name: string): void {
	if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name))
		programError("SELECTOR_INVALID", `invalid program name ${name}`);
}
export function parseProgramSource(source: string, name: string | null): ResolvedProgram {
	if (Buffer.byteLength(source, "utf8") > PROGRAM_POLICY.maxSourceBytes)
		programError("PROGRAM_INVALID", "source exceeds 64 KiB");
	// Reject unpaired surrogates instead of hashing replacement bytes that were never supplied.
	if (Buffer.from(source, "utf8").toString("utf8") !== source)
		programError("PROGRAM_INVALID", "source is not well-formed Unicode");
	const lines = (source.startsWith("\uFEFF") ? source.slice(1) : source).split(/\r?\n/);
	let header: ProgramHeader = {};
	if (lines[0]?.startsWith("// uina ")) {
		try {
			const raw: unknown = JSON.parse(lines[0].slice(8));
			if (raw == null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("header must be an object");
			const h = raw as Record<string, unknown>;
			if (lines[1]?.startsWith("// uina ")) throw new Error("multiple headers");
			if (Object.keys(h).some((k) => !["summary", "tags", "input", "output", "examples", "saved"].includes(k)))
				throw new Error("unknown header field");
			if (h.summary !== undefined && typeof h.summary !== "string") throw new Error("summary must be a string");
			if (h.tags !== undefined && (!Array.isArray(h.tags) || !h.tags.every((t) => typeof t === "string")))
				throw new Error("tags must be strings");
			for (const key of ["input", "output"])
				if (h[key] !== undefined) {
					if (!h[key] || typeof h[key] !== "object" || Array.isArray(h[key]))
						throw new Error(`${key} must be a schema object`);
					ajv.compile(h[key] as object);
				}
			if (h.examples !== undefined) {
				if (!Array.isArray(h.examples)) throw new Error("examples must be an array");
				for (const e of h.examples) {
					if (
						!e ||
						typeof e !== "object" ||
						!("input" in e) ||
						Object.keys(e).some((k) => !["input", "output"].includes(k))
					)
						throw new Error("invalid example");
					for (const key of ["input", "output"])
						if (key in e && h[key] && !ajv.compile(h[key] as object)(e[key]))
							throw new Error(`example ${key} rejected`);
				}
			}
			if (h.saved !== undefined) {
				const s = h.saved as Record<string, unknown>;
				if (
					!s ||
					typeof s !== "object" ||
					["run", "segment", "call", "digest", "at"].some((k) => typeof s[k] !== "string")
				)
					throw new Error("invalid saved origin");
			}
			header = raw as ProgramHeader;
		} catch (e) {
			programError("PROGRAM_INVALID", `invalid program header: ${String(e)}`);
		}
	}
	return {
		name,
		origin: name == null ? "code" : "library",
		source,
		header,
		digest: createHash("sha256").update(source).digest("hex"),
	};
}
export async function readProgram(root: string, name: string): Promise<ResolvedProgram> {
	validateProgramName(name);
	let realRoot: string;
	try {
		realRoot = await realpath(root);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT")
			return programError("PROGRAM_NOT_FOUND", `program ${name} not found`);
		throw e;
	}
	const matches: string[] = [];
	const visited = new Set<string>();
	async function scan(path: string): Promise<void> {
		const actual = await realpath(path);
		const rel = relative(realRoot, actual);
		if (rel.startsWith("..") || isAbsolute(rel)) programError("ACCESS_DENIED", `program path leaves library: ${path}`);
		if (visited.has(actual)) return;
		visited.add(actual);
		for (const d of await readdir(actual, { withFileTypes: true })) {
			if (/^[._]/.test(d.name)) continue;
			const child = join(actual, d.name);
			if (d.isDirectory()) await scan(child);
			else if (d.isSymbolicLink()) {
				const target = await realpath(child);
				const r = relative(realRoot, target);
				if (r.startsWith("..") || isAbsolute(r)) programError("ACCESS_DENIED", `program link leaves library: ${child}`);
				const { stat } = await import("node:fs/promises");
				if ((await stat(target)).isDirectory()) await scan(child);
				else if (d.name.toLowerCase() === `${name.toLowerCase()}.js`) matches.push(child);
			} else if (d.isFile() && d.name.toLowerCase() === `${name.toLowerCase()}.js`) matches.push(child);
		}
	}
	await scan(realRoot);
	if (matches.length === 0)
		programError("PROGRAM_NOT_FOUND", `program ${name} not found; native capabilities require @version`);
	if (matches.length > 1) programError("PROGRAM_CONFLICT", `program ${name} has multiple files: ${matches.join(", ")}`);
	const bytes = await readFile(matches[0]!);
	let source: string;
	try {
		source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return programError("PROGRAM_INVALID", "source is not valid UTF-8");
	}
	return parseProgramSource(source, name);
}
