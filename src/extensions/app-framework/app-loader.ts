import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createJiti } from "jiti";
import type { ExtensionAPI } from "../runner.js";
import type { AppRegistry } from "./app-registry.js";
import type { AppDef } from "./types.js";

const SOURCE_FILE_PATTERN = /\.(?:[cm]?js|[cm]?ts)$/;

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

async function resolveDirectoryEntry(dir: string): Promise<string | null> {
	const manifestPath = join(dir, "package.json");
	if (await pathExists(manifestPath)) {
		try {
			const raw = await readFile(manifestPath, "utf8");
			const pkg = JSON.parse(raw) as { main?: unknown; uina?: { entry?: unknown } };
			const entryCandidate = (typeof pkg.uina?.entry === "string" ? pkg.uina.entry : pkg.main) as string | undefined;
			if (entryCandidate) {
				const resolved = resolve(dir, entryCandidate);
				if ((await pathExists(resolved)) && SOURCE_FILE_PATTERN.test(resolved)) {
					return resolved;
				}
			}
		} catch {
			// ignore invalid package.json and fallback to default filenames
		}
	}

	for (const candidate of ["index.ts", "index.js", "index.mts", "index.mjs"]) {
		const target = join(dir, candidate);
		if (await pathExists(target)) {
			return target;
		}
	}

	return null;
}

/**
 * 扫描指定基准目录下的所有外部 App 入口文件
 */
export async function discoverExternalAppEntries(searchDirs: readonly string[]): Promise<string[]> {
	const entries: string[] = [];

	for (const searchDir of searchDirs) {
		if (!(await pathExists(searchDir))) continue;

		try {
			const items = await readdir(searchDir, { withFileTypes: true });
			for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
				const fullPath = join(searchDir, item.name);
				if (item.isDirectory()) {
					const entry = await resolveDirectoryEntry(fullPath);
					if (entry) entries.push(entry);
				} else if (SOURCE_FILE_PATTERN.test(item.name)) {
					entries.push(fullPath);
				}
			}
		} catch {
			// 忽略不可读目录
		}
	}

	const realEntries: string[] = [];
	for (const entry of entries) {
		try {
			realEntries.push(await realpath(entry));
		} catch {
			realEntries.push(resolve(entry));
		}
	}

	return [...new Set(realEntries)];
}

/**
 * 判断对象是否符合 AppDef 静态契约
 */
export function isAppDef(obj: unknown): obj is AppDef {
	if (typeof obj !== "object" || obj === null) return false;
	const candidate = obj as Record<string, unknown>;
	return (
		typeof candidate.name === "string" &&
		candidate.name.trim().length > 0 &&
		typeof candidate.description === "string" &&
		typeof candidate.actions === "object" &&
		candidate.actions !== null
	);
}

/**
 * 从导入的模块中提取 AppDef 契约对象
 */
export async function extractAppDef(moduleExport: unknown, pi: ExtensionAPI): Promise<AppDef | null> {
	if (isAppDef(moduleExport)) {
		return moduleExport;
	}
	if (typeof moduleExport === "function") {
		// 支持导出工厂函数：export default createMyApp() 或 export default () => appDef
		const result = await (moduleExport as (pi?: ExtensionAPI) => unknown)(pi);
		if (isAppDef(result)) {
			return result;
		}
	}
	if (typeof moduleExport === "object" && moduleExport !== null) {
		const record = moduleExport as Record<string, unknown>;
		if (isAppDef(record.appDef)) return record.appDef;
		if (isAppDef(record.app)) return record.app;
		if (isAppDef(record.default)) return record.default;
	}
	return null;
}

/**
 * 扫描并动态装配外部 Apps 至 AppRegistry
 * @param pi 宿主 ExtensionAPI
 * @param registry 应用注册表
 * @param customSearchDirs 自定义扫描目录（可选，默认扫描工作区 .uina/apps 与用户全局 ~/.uina/apps）
 * @returns 统一注销销毁函数
 */
export async function loadExternalApps(
	pi: ExtensionAPI,
	registry: AppRegistry,
	customSearchDirs?: readonly string[],
): Promise<() => Promise<void>> {
	const searchDirs = customSearchDirs ?? [
		join(pi.cwd, ".uina", "apps"),
		join(homedir(), ".uina", "apps"),
	];

	const entries = await discoverExternalAppEntries(searchDirs);
	const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
	const unregisterFns: Array<() => Promise<void>> = [];

	for (const entry of entries) {
		try {
			const moduleExport = (await jiti.import(entry, { default: true })) as unknown;
			const appDef = await extractAppDef(moduleExport, pi);

			if (appDef) {
				const unregister = await registry.register(appDef);
				unregisterFns.push(unregister);
			} else {
				pi.reportError(new Error(`外部 App 入口未导出合法的 AppDef 契约: ${entry}`));
			}
		} catch (error) {
			pi.reportError(new Error(`动态装载外部 App 失败 (${entry}): ${error instanceof Error ? error.message : String(error)}`));
		}
	}

	return async () => {
		for (const unregister of unregisterFns) {
			try {
				await unregister();
			} catch {
				// ignore disposal errors
			}
		}
		unregisterFns.length = 0;
	};
}
