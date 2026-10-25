/** Strict execution material built from the same header and scan used by Library. */
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import type { ProgramHeader } from "../contracts/library.js";
import type { ResolvedProgram } from "../contracts/program.js";
import { callFailure } from "../contracts/values.js";
import { PROGRAM_POLICY } from "../program/policy.js";
import { digest, LibraryFiles, utf8, validName } from "./files.js";
import { parseHeader } from "./header.js";

export function programError(code: string, message: string): never {
	throw callFailure({ code, source: "program", message, dispatch: "not_sent", effects: [], recoverable: true });
}
export function executionError(error: unknown): never {
	const e = error as { code?: string; message?: string };
	programError(e.code === "NAME_INVALID" ? "SELECTOR_INVALID" : (e.code ?? "IO_ERROR"), e.message ?? String(error));
}
export function validateProgramName(name: string): void {
	try {
		validName(name);
	} catch {
		programError("SELECTOR_INVALID", `invalid program name ${name}`);
	}
}
export function parseProgramSource(source: string, name: string | null): ResolvedProgram {
	if (Buffer.byteLength(source, "utf8") > PROGRAM_POLICY.maxSourceBytes)
		programError("PROGRAM_INVALID", "source exceeds 64 KiB");
	if (Buffer.from(source, "utf8").toString("utf8") !== source)
		programError("PROGRAM_INVALID", "source is not well-formed Unicode");
	const parsed = parseHeader<ProgramHeader>(source, "program");
	if (parsed.error) programError("PROGRAM_INVALID", `invalid program header: ${parsed.error}`);
	return {
		name,
		origin: name === null ? "code" : "library",
		source,
		header: parsed.header ?? {},
		digest: digest(source),
	};
}
/** Read-only helper for small composition roots; no second scanner. */
export async function readProgram(root: string, name: string): Promise<ResolvedProgram> {
	validateProgramName(name);
	const path = await new LibraryFiles(dirname(root)).locate("program", name).catch(executionError);
	if (!path) programError("PROGRAM_NOT_FOUND", `program ${name} not found; native capabilities require @version`);
	let source: string;
	try {
		source = utf8(await readFile(path));
	} catch (error) {
		if (error instanceof TypeError) programError("PROGRAM_INVALID", "source is not valid UTF-8");
		throw error;
	}
	return parseProgramSource(source, name);
}
