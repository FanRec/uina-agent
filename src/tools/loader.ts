/**
 * 工具扫描器（对齐 pi 的扩展自动发现）：
 * 扫描目录下的顶层 .ts 文件与子目录 index.ts，动态 import 后自动注册。
 * 每个工具模块必须 default 导出：
 *  - Tool 对象（get_time 形态）
 *  - Tool[]（一批工具）
 *  - (registry) => void 注册函数（pi 的 registerTool 形态，可组合工厂）
 * 单个模块失败（import 错误/注册冲突）只报告不阻塞——一个坏工具不拖垮整个。
 */
import { readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { Dirent } from "node:fs";
import type { Tool } from "./broker.js";
import type { ToolBroker } from "./broker.js";

export interface LoadResult {
	loaded: number;
	failed: { file: string; error: string }[];
}

/** 收集待加载的工具模块路径：顶层 .ts + 子目录 index.ts（pi 的两种发现形态） */
function collectModules(dir: string): string[] {
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return []; // 目录不存在 = 没有工具，不报错
	}
	const mods: string[] = [];
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isFile() && extname(e.name) === ".ts") {
			mods.push(p);
		} else if (e.isDirectory()) {
			const idx = join(p, "index.ts");
			if (isFile(idx)) mods.push(idx);
		}
	}
	return mods;
}

/** 文件是否存在（index.ts 约定检测用） */
function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
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
				result.failed.push({
					file: basename(file),
					error: "模块未 default 导出工具（需 Tool / Tool数组 / 注册函数）",
				});
				continue;
			}
			await registerExport(registry, mod.default);
			result.loaded++;
		} catch (e) {
			result.failed.push({ file: basename(file), error: (e as Error).message });
		}
	}
	return result;
}

async function registerExport(reg: ToolBroker, exp: unknown): Promise<void> {
	if (Array.isArray(exp)) {
		for (const t of exp) reg.register(t as Tool);
		return;
	}
	if (typeof exp === "function") {
		await (exp as (r: ToolBroker) => void | Promise<void>)(reg);
		return;
	}
	reg.register(exp as Tool);
}
