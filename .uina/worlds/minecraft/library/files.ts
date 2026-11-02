/** Filesystem boundaries and atomic publication shared by all three kinds. */
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { LibraryKind } from "../contracts/library.js";

export function libraryError(code: string, message: string): never {
	throw Object.assign(new Error(message), { code });
}
export function validName(name: string): void {
	if (
		typeof name !== "string" ||
		!/^[a-z][a-z0-9_-]{0,47}$/.test(name) ||
		/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)
	)
		libraryError("NAME_INVALID", `invalid library name ${name}`);
}
export const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
export async function optionalRead(path: string): Promise<Buffer | null> {
	try {
		return await readFile(path);
	} catch (error) {
		if (missing(error)) return null;
		throw error;
	}
}
export function utf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
const folders = { program: "programs", blueprint: "blueprints", experience: "experiences" };
export class LibraryFiles {
	private readonly tails = new Map<string, Promise<unknown>>();
	constructor(readonly dataRoot: string) {}
	async root(kind: LibraryKind, create = false): Promise<string | null> {
		if (create) await mkdir(this.dataRoot, { recursive: true });
		let base: string;
		try {
			base = await realpath(this.dataRoot);
		} catch (error) {
			if (missing(error)) return null;
			throw error;
		}
		const path = join(base, folders[kind]);
		if (create) await mkdir(path, { recursive: true });
		try {
			await this.contained(base, path);
		} catch (error) {
			if (missing(error)) return null;
			throw error;
		}
		return path;
	}
	async contained(root: string, path: string): Promise<string> {
		const actual = await realpath(path),
			rel = relative(root, actual);
		if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel))
			libraryError("ACCESS_DENIED", `path leaves library: ${path}`);
		return actual;
	}
	async entries(kind: LibraryKind): Promise<Map<string, string[]>> {
		const root = await this.root(kind),
			result = new Map<string, string[]>();
		if (!root) return result;
		const seen = new Set<string>();
		const visit = async (directory: string): Promise<void> => {
			const actual = await this.contained(root, directory);
			if (seen.has(actual.toLowerCase())) return;
			seen.add(actual.toLowerCase());
			for (const d of await readdir(directory, { withFileTypes: true })) {
				if (/^[._]/.test(d.name)) continue;
				const path = join(directory, d.name);
				await this.contained(root, path);
				const s = await stat(path);
				if (kind === "program" && s.isDirectory()) {
					await visit(path);
					continue;
				}
				const extension = kind === "program" ? ".js" : ".md";
				if (kind === "blueprint" ? !s.isDirectory() : !s.isFile() || !d.name.toLowerCase().endsWith(extension))
					continue;
				const name = (kind === "blueprint" ? d.name : d.name.slice(0, -extension.length)).toLowerCase();
				try {
					validName(name);
				} catch {
					continue;
				}
				result.set(name, [...(result.get(name) ?? []), path]);
			}
		};
		await visit(root);
		return result;
	}
	async locate(kind: LibraryKind, name: string): Promise<string | null> {
		validName(name);
		const paths = (await this.entries(kind)).get(name) ?? [];
		if (paths.length > 1)
			libraryError(
				kind === "program" ? "PROGRAM_CONFLICT" : "NAME_EXISTS",
				`conflicting ${kind} paths: ${paths.join(", ")}`,
			);
		return paths[0] ?? null;
	}
	async target(kind: LibraryKind, name: string): Promise<string> {
		const existing = await this.locate(kind, name);
		if (existing) return existing;
		return join(
			(await this.root(kind, true))!,
			kind === "blueprint" ? name : name + (kind === "program" ? ".js" : ".md"),
		);
	}
	async write(kind: LibraryKind, path: string, bytes: string, create: boolean, expected?: string): Promise<void> {
		const root = (await this.root(kind, true))!;
		await this.contained(root, dirname(path));
		try {
			await this.contained(root, path);
		} catch (error) {
			if (!missing(error)) throw error;
		}
		const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, bytes, { flag: "wx" });
			if (expected !== undefined) {
				const current = await optionalRead(path);
				if (!current || digest(current) !== expected)
					libraryError("DIGEST_CONFLICT", "working file changed before publication");
			}
			if (create) {
				try {
					await link(temporary, path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") libraryError("NAME_EXISTS", "entry already exists");
					throw error;
				}
			} else await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true });
		}
	}
	async remove(kind: LibraryKind, path: string): Promise<void> {
		const root = (await this.root(kind))!;
		const absolute = resolve(path);
		await this.contained(root, absolute);
		if (absolute.toLowerCase() === resolve(root).toLowerCase())
			libraryError("ACCESS_DENIED", "cannot remove library root");
		await rm(absolute, { recursive: kind === "blueprint" });
	}
	async serial<T>(kind: LibraryKind, name: string, work: () => Promise<T>): Promise<T> {
		validName(name);
		const key = `${kind}:${name}`,
			previous = this.tails.get(key) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(work);
		this.tails.set(key, next);
		try {
			return await next;
		} finally {
			if (this.tails.get(key) === next) this.tails.delete(key);
		}
	}
}
