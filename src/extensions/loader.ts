import { readdir, readFile, realpath, stat } from "node:fs/promises";
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
/** One level of discovery; package manifests express deeper layouts explicitly. */
export interface DiscoveredExtensionEntry {
	readonly file: string;
	/** 独占资源根（扩展 Prompt 文件机制）：目录扩展与多入口包为所在目录；
	 * 单文件入口没有独占根（文件式 guidance 明确失败，内联不受影响）。 */
	readonly root?: string;
}

async function entries(file: string): Promise<DiscoveredExtensionEntry[]> {
	if (!(await stat(file)).isDirectory()) {
		if (!sourceFile.test(file)) throw new Error("不支持的扩展入口: " + file);
		return [{ file }];
	}
	const manifest = join(file, "package.json");
	if (await exists(manifest)) {
		const metadata = JSON.parse(await readFile(manifest, "utf8")) as { uina?: { extensions?: unknown } };
		if (metadata.uina?.extensions !== undefined) {
			if (!Array.isArray(metadata.uina.extensions) || !metadata.uina.extensions.every((p) => typeof p === "string"))
				throw new Error("uina.extensions 必须是入口路径数组: " + manifest);
			// 多入口包：每个入口一个激活作用域与 owner，但共享包目录作为资源根。
			return await Promise.all(
				metadata.uina.extensions.map(async (p) => {
					const entry = resolve(file, p);
					if (!(await stat(entry)).isFile() || !sourceFile.test(entry))
						throw new Error("manifest 扩展入口必须是脚本文件: " + entry);
					return { file: entry, root: file };
				}),
			);
		}
	}
	for (const name of ["index.ts", "index.js", "index.mts", "index.mjs"])
		if (await exists(join(file, name))) return [{ file: join(file, name), root: file }];
	return [];
}

export async function discoverExtensionEntries(
	cwd: string,
	paths: readonly string[] = [],
): Promise<DiscoveredExtensionEntry[]> {
	const directory = join(cwd, ".uina", "extensions");
	const files: DiscoveredExtensionEntry[] = [];
	if (await exists(directory)) {
		for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			if (entry.isDirectory() || sourceFile.test(entry.name))
				files.push(...(await entries(join(directory, entry.name))));
		}
	}
	for (const p of paths) {
		const found = await entries(resolve(cwd, p));
		if (!found.length) throw new Error("扩展目录没有入口: " + p);
		files.push(...found);
	}
	// 与旧行为一致：按入口文件真实路径去重；资源根同样取真实路径。
	const seen = new Map<string, DiscoveredExtensionEntry>();
	for (const found of files) {
		const [file, root] = await Promise.all([realpath(found.file), found.root ? realpath(found.root) : undefined]);
		const key = file;
		if (!seen.has(key)) seen.set(key, root ? { file, root } : { file });
	}
	return [...seen.values()];
}

export async function discoverExtensions(cwd: string, paths: readonly string[] = []): Promise<string[]> {
	return (await discoverExtensionEntries(cwd, paths)).map((entry) => entry.file);
}
/** As in Pi, each load evaluates a fresh local module graph. No native module cache bypasses reload. */
export async function importExtension(file: string): Promise<ExtensionModule> {
	const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
	const activate = await jiti.import(file, { default: true });
	return { default: activate as ExtensionModule["default"] };
}
