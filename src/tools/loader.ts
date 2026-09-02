import { readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Dirent } from "node:fs";
import { ToolBroker, type Tool } from "./broker.js";

export interface LoadResult {
	loaded: number;
	failed: { file: string; error: string }[];
}

/** Find top-level .ts files and immediate subdirectory index.ts modules. */
function collectModules(dir: string): string[] {
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(`工具目录读取失败 ${dir}: ${safeError(error)}`);
	}

	const modules: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isFile() && extname(entry.name) === ".ts") {
			modules.push(path);
		} else if (entry.isDirectory()) {
			const index = join(path, "index.ts");
			if (isFile(index)) modules.push(index);
		}
	}
	return modules.sort();
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

export async function loadTools(
	dir: string,
	registry: ToolBroker,
): Promise<LoadResult> {
	const result: LoadResult = { loaded: 0, failed: [] };
	for (const file of collectModules(dir)) {
		try {
			const mod = (await import(pathToFileURL(file).href)) as {
				default?: unknown;
			};
			if (mod.default === undefined) {
				throw new Error("模块未 default 导出工具（需 Tool / Tool数组 / 注册函数）");
			}

			// Register into a temporary broker so a failed module cannot partially load.
			const staged = new ToolBroker();
			await registerExport(staged, mod.default);
			const registeredNames = staged.names();
			const registered = registeredNames
				.map((name) => staged.get(name))
				.filter((tool): tool is Tool => tool !== undefined);
			const committed: string[] = [];
			try {
				for (const tool of registered) {
					registry.register(tool);
					committed.push(tool.def.function.name);
				}
			} catch (error) {
				for (const name of committed) registry.remove(name);
				throw error;
			}
			result.loaded += registered.length;
		} catch (error) {
			result.failed.push({ file: basename(file), error: safeError(error) });
		}
	}
	return result;
}

async function registerExport(registry: ToolBroker, value: unknown): Promise<void> {
	if (Array.isArray(value)) {
		for (const tool of value) registry.register(tool as Tool);
		return;
	}
	if (typeof value === "function") {
		await (value as (r: ToolBroker) => void | Promise<void>)(registry);
		return;
	}
	registry.register(value as Tool);
}

function safeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
