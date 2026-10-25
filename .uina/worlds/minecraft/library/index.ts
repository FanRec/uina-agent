/** Ordinary working files. No task, asset registry or duplicate execution state. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
	LibraryPort,
	LibraryKind,
	LibraryDetail,
	LibrarySummary,
	LibrarySaveRequest,
	LibraryUpdateRequest,
	LibraryListQuery,
	ProgramHeader,
	TextMetadata,
	ProgramOrigin,
} from "../contracts/library.js";
import type { ResolvedProgram, ProgramValidation } from "../contracts/program.js";
import { LibraryFiles, digest, libraryError, missing, optionalRead, utf8 } from "./files.js";
import { parseHeader, patchHeader, validateHeader, withHeader } from "./header.js";
import { parseProgramSource, programError, executionError } from "./program-source.js";

export interface LibraryOptions {
	dataRoot: string;
	compile(program: ResolvedProgram): Promise<ProgramValidation>;
	/** Trusted composition root checks committed Call identity and immutable snapshot. */
	readSource(origin: ProgramOrigin): Promise<{ source: string; digest: string } | null>;
}
export interface FileLibrary extends LibraryPort {
	loadProgram(name: string): Promise<ResolvedProgram>;
}
function summaryOf(d: LibraryDetail): LibrarySummary {
	if (d.kind === "program") {
		const { source: _s, input: _i, output: _o, examples: _e, savedFrom: _f, ...summary } = d;
		return summary;
	}
	if (d.kind === "experience") {
		const { text: _t, header: _h, ...summary } = d;
		return summary;
	}
	const { about: _a, files: _f, target: _t, formatHint: _h, digest: _d, ...summary } = d;
	return summary;
}
function checkedHeader(source: string, kind: "program" | "experience"): ProgramHeader | TextMetadata {
	const parsed = parseHeader(source, kind);
	if (parsed.error) libraryError("HEADER_INVALID", parsed.error);
	return parsed.header ?? {};
}
async function io<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (/^E[A-Z]+$/.test((error as NodeJS.ErrnoException).code ?? "")) libraryError("IO_ERROR", String(error));
		throw error;
	}
}
export function createLibrary(options: LibraryOptions): FileLibrary {
	const files = new LibraryFiles(options.dataRoot);
	async function detail(kind: LibraryKind, name: string, path: string, hashRaw = true): Promise<LibraryDetail> {
		const s = await stat(path);
		const base = { name, summary: null as string | null, tags: [] as string[], path, updatedAt: s.mtime.toISOString() };
		if (kind !== "blueprint") {
			const bytes = await readFile(path);
			let source: string, encodingError: string | undefined;
			try {
				source = utf8(bytes);
			} catch {
				source = bytes.toString("utf8");
				encodingError = "file is not valid UTF-8";
			}
			const parsed = parseHeader<ProgramHeader & TextMetadata>(source, kind);
			const h = parsed.header;
			const common = {
				...base,
				summary: h?.summary ?? null,
				tags: h?.tags ?? [],
				digest: digest(bytes),
				...((encodingError ?? parsed.error) ? { headerError: encodingError ?? parsed.error } : {}),
			};
			if (kind === "experience") return { ...common, kind, text: source, header: h };
			return {
				...common,
				kind,
				source,
				...(h?.input === undefined ? {} : { input: h.input }),
				...(h?.output === undefined ? {} : { output: h.output }),
				...(h?.examples === undefined ? {} : { examples: h.examples }),
				...(h?.saved === undefined ? {} : { savedFrom: h.saved }),
			};
		}
		const root = (await files.root(kind))!;
		const names = await readdir(path);
		const entries = names.filter((n) => /^design\.[^.]+$/i.test(n)).sort();
		if (entries.length === 0) libraryError("BLUEPRINT_SOURCE_MISSING", `no design file in ${path}`);
		if (entries.length > 1)
			libraryError("BLUEPRINT_AMBIGUOUS", `multiple design files in ${path}: ${entries.join(", ")}`);
		const design = join(path, entries[0]!);
		await files.contained(root, design);
		let size: number,
			hash = "";
		try {
			const info = await stat(design);
			if (!info.isFile()) libraryError("BLUEPRINT_CORRUPT", "design entry is not a regular file");
			size = info.size;
			if (hashRaw) {
				const hasher = createHash("sha256");
				size = 0;
				for await (const chunk of createReadStream(design)) {
					hasher.update(chunk);
					size += chunk.length;
				}
				hash = hasher.digest("hex");
			}
		} catch (error) {
			libraryError("BLUEPRINT_CORRUPT", String(error));
		}
		let about: TextMetadata | null = null,
			aboutError: string | undefined;
		const aboutPath = join(path, "about.json");
		try {
			await files.contained(root, aboutPath);
			about = JSON.parse(utf8(await readFile(aboutPath))) as TextMetadata;
			validateHeader(about, "blueprint");
		} catch (error) {
			if ((error as { code?: string }).code === "ACCESS_DENIED") throw error;
			if (!missing(error)) aboutError = String(error);
			about = null;
		}
		let target: Extract<LibraryDetail, { kind: "blueprint" }>["target"];
		const targetPath = join(path, "target.json");
		if (hashRaw) {
			try {
				await files.contained(root, targetPath);
				const bytes = await readFile(targetPath);
				const envelope = JSON.parse(utf8(bytes)) as { schema?: unknown };
				if (!envelope || typeof envelope.schema !== "string")
					libraryError("TARGET_INVALID", "target schema identity is missing");
				target = { schema: envelope.schema, digest: digest(bytes), validation: "unavailable" };
			} catch (error) {
				if (!missing(error)) {
					if ((error as { code?: string }).code === "ACCESS_DENIED") throw error;
					libraryError("TARGET_INVALID", String(error));
				}
			}
		}
		return {
			...base,
			kind,
			summary: about?.summary ?? null,
			tags: about?.tags ?? [],
			about,
			...(aboutError ? { aboutError } : {}),
			files: names.filter((n) => /^design\.[^.]+$/i.test(n) || n === "about.json" || n === "target.json").sort(),
			size,
			digest: hash,
			formatHint: extname(design).slice(1),
			...(target ? { target } : {}),
		};
	}
	async function finalProgram(source: string): Promise<void> {
		checkedHeader(source, "program");
		const result = await options.compile(parseProgramSource(source, null));
		if (!result.ok) libraryError(result.code, result.message);
	}
	async function writeText(
		kind: "program" | "experience",
		path: string,
		source: string,
		create: boolean,
		expected?: string,
	): Promise<void> {
		if (Buffer.from(source, "utf8").toString("utf8") !== source)
			libraryError("HEADER_INVALID", "text is not well-formed Unicode");
		checkedHeader(source, kind);
		if (kind === "program") await finalProgram(source);
		await files.write(kind, path, source, create, expected);
	}
	const library: FileLibrary = {
		list: (query: LibraryListQuery = {}) =>
			io(async () => {
				const found: LibrarySummary[] = [];
				for (const kind of query.kind ? [query.kind] : (["program", "blueprint", "experience"] as LibraryKind[])) {
					for (const [name, paths] of await files.entries(kind)) {
						try {
							const d = summaryOf(await detail(kind, name, paths[0]!, false));
							if (paths.length > 1) {
								const diagnostic = `PROGRAM_CONFLICT: ${paths.join(", ")}`;
								if (d.kind === "blueprint") d.aboutError = diagnostic;
								else d.headerError = diagnostic;
							}
							found.push(d);
						} catch (error) {
							if ((error as { code?: string }).code === "ACCESS_DENIED") throw error;
							const s = await stat(paths[0]!);
							const base = { name, path: paths[0]!, summary: null, tags: [], updatedAt: s.mtime.toISOString() };
							found.push(
								kind === "program"
									? { ...base, kind, digest: "", headerError: String(error) }
									: { ...base, kind, aboutError: String(error) },
							);
						}
					}
				}
				const text = query.text?.toLowerCase(),
					tag = query.tag?.toLowerCase();
				return found
					.filter(
						(d) =>
							(!text || [d.name, d.summary ?? ""].some((x) => x.toLowerCase().includes(text))) &&
							(!tag || d.tags.some((t) => t.toLowerCase().includes(tag))),
					)
					.sort(
						(a, b) =>
							b.updatedAt.localeCompare(a.updatedAt) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
					)
					.slice(0, query.limit ?? 50);
			}),
		get: (kind, name) =>
			io(async () => {
				const path = await files.locate(kind, name);
				return path ? detail(kind, name, path) : null;
			}),
		loadProgram: (name) =>
			io(async () => {
				const d = await library.get("program", name);
				if (!d || d.kind !== "program") programError("PROGRAM_NOT_FOUND", `program ${name} not found`);
				if (d.headerError) programError("PROGRAM_INVALID", d.headerError);
				return parseProgramSource(d.source, name);
			}).catch(executionError),
		save: (request) =>
			io(() =>
				files.serial(request.kind ?? "program", request.name, async () => {
					const kind = request.kind ?? "program",
						path = await files.target(kind, request.name);
					if (kind === "blueprint") {
						const r = request as Extract<LibrarySaveRequest, { kind: "blueprint" }>;
						if (!(await files.locate(kind, r.name)))
							libraryError("BLUEPRINT_SOURCE_MISSING", `no design file for ${r.name}`);
						const d = await detail(kind, r.name, path, false);
						if (await optionalRead(join(path, "about.json")))
							libraryError("NAME_EXISTS", "blueprint already registered");
						const metadata = { summary: r.summary, ...(r.tags === undefined ? {} : { tags: r.tags }) };
						try {
							validateHeader(metadata, kind);
						} catch (error) {
							libraryError("HEADER_INVALID", String(error));
						}
						await files.write(kind, join(path, "about.json"), JSON.stringify(metadata) + "\n", true);
						return { ...summaryOf(d), summary: r.summary, tags: r.tags ?? [] };
					}
					if (await files.locate(kind, request.name)) libraryError("NAME_EXISTS", "entry already exists");
					let source: string;
					if (request.kind === "experience") source = request.text;
					else {
						const r = request as Extract<LibrarySaveRequest, { kind?: "program" }>;
						let original = r.source;
						let saved: ProgramHeader["saved"];
						if (r.from) {
							const material = await options.readSource(r.from);
							if (!material) libraryError("NOT_FOUND", "source Call or immutable snapshot is missing");
							if (digest(material.source) !== material.digest)
								libraryError("PROGRAM_CONFLICT", "source snapshot digest mismatch");
							original = material.source;
							saved = { ...r.from, digest: material.digest, at: new Date().toISOString() };
						}
						if (original === undefined) libraryError("INVALID_INPUT", "provide exactly one source or from");
						const inherited = checkedHeader(original, "program") as ProgramHeader;
						const { saved: _oldSaved, ...metadata } = inherited;
						const h: ProgramHeader = { ...metadata, summary: r.summary };
						for (const key of ["tags", "input", "output", "examples"] as const)
							if (r[key] !== undefined) Object.assign(h, { [key]: r[key] });
						if (saved) h.saved = saved;
						source = withHeader(original, h, "program");
					}
					await writeText(kind as "program" | "experience", path, source, true);
					return summaryOf((await library.get(kind, request.name))!);
				}),
			),
		update: (request) =>
			io(() =>
				files.serial(request.kind ?? "program", request.name, async () => {
					const kind = request.kind ?? "program",
						path = await files.locate(kind, request.name);
					if (!path) libraryError("NOT_FOUND", "entry not found");
					if (request.kind === "blueprint") {
						const d = await detail(kind, request.name, path, false);
						if (d.kind !== "blueprint") throw new Error("wrong kind");
						if (d.aboutError) libraryError("HEADER_INVALID", d.aboutError);
						const metadata = patchHeader(d.about ?? {}, request.metadata);
						try {
							validateHeader(metadata, "blueprint");
						} catch (error) {
							libraryError("HEADER_INVALID", String(error));
						}
						await files.write(kind, join(path, "about.json"), JSON.stringify(metadata) + "\n", false);
					} else {
						const r = request as Exclude<LibraryUpdateRequest, { kind: "blueprint" }>;
						const current = await readFile(path);
						if (r.expectedDigest !== undefined && digest(current) !== r.expectedDigest)
							libraryError("DIGEST_CONFLICT", "working file changed");
						const replacement = request.kind === "experience" ? request.text : (r as { source?: string }).source;
						let source: string;
						if (replacement !== undefined) source = replacement;
						else {
							let original: string;
							try {
								original = utf8(current);
							} catch {
								return libraryError("HEADER_INVALID", "text is not valid UTF-8; replace the full file");
							}
							const h = checkedHeader(original, kind as "program" | "experience");
							source = withHeader(original, patchHeader(h, r.metadata!), kind as "program" | "experience");
						}
						await writeText(kind as "program" | "experience", path, source, false, r.expectedDigest);
					}
					return summaryOf((await library.get(kind, request.name))!);
				}),
			),
		delete: (kind, name) =>
			io(() =>
				files.serial(kind, name, async () => {
					const path = await files.locate(kind, name);
					if (!path) libraryError("NOT_FOUND", "entry not found");
					await files.remove(kind, path);
				}),
			),
	};
	return library;
}
