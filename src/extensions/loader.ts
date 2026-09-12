import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import type { ExtensionModule } from "./runner.js";
const sourceFile = /\.(?:[cm]?js|[cm]?ts)$/;
async function exists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw e;
	}
}
async function entries(file: string): Promise<string[]> {
	if (!(await stat(file)).isDirectory()) {
		if (!sourceFile.test(file)) throw new Error("不支持的扩展入口: " + file);
		return [file];
	}
	const manifest = join(file, "package.json");
	if (await exists(manifest)) {
		const metadata = JSON.parse(await readFile(manifest, "utf8")) as { uina?: { extensions?: unknown } };
		if (metadata.uina?.extensions !== undefined) {
			if (!Array.isArray(metadata.uina.extensions) || !metadata.uina.extensions.every((p) => typeof p === "string"))
				throw new Error("uina.extensions 必须是入口路径数组: " + manifest);
			return await Promise.all(
				metadata.uina.extensions.map(async (p) => {
					const entry = resolve(file, p);
					if (!(await stat(entry)).isFile() || !sourceFile.test(entry))
						throw new Error("manifest 扩展入口必须是脚本文件: " + entry);
					return entry;
				}),
			);
		}
	}
	for (const name of ["index.ts", "index.js", "index.mts", "index.mjs"])
		if (await exists(join(file, name))) return [join(file, name)];
	return [];
}
/** One level of discovery; package manifests express deeper layouts explicitly. */
export async function discoverExtensions(cwd: string, paths: readonly string[] = []): Promise<string[]> {
	const directory = join(cwd, ".uina", "extensions");
	const files: string[] = [];
	if (await exists(directory)) {
		for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (entry.isDirectory() || sourceFile.test(entry.name))
				files.push(...(await entries(join(directory, entry.name))));
		}
	}
	for (const p of paths) {
		const found = await entries(resolve(cwd, p));
		if (!found.length) throw new Error("扩展目录没有入口: " + p);
		files.push(...found);
	}
	return [...new Set(await Promise.all(files.map((p) => realpath(p))))];
}
/** As in Pi, each load evaluates a fresh local module graph. No native module cache bypasses reload. */
export async function importExtension(file: string): Promise<ExtensionModule> {
	const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
	const activate = await jiti.import(file, { default: true });
	return { default: activate as ExtensionModule["default"] };
}
