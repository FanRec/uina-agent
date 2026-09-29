import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage } from "../../core/errors.js";

export interface WorldStateStore {
	load(): Promise<Record<string, boolean>>;
	save(state: Record<string, boolean>): Promise<void>;
}

export function createFileWorldStateStore(
	filePath: string | undefined,
	reportError?: (error: unknown) => void,
): WorldStateStore {
	return {
		async load(): Promise<Record<string, boolean>> {
			if (!filePath) return {};
			let raw: string;
			try {
				raw = await readFile(filePath, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return {};
				reportError?.(new Error(`[World Framework] 读取 World 状态 ${filePath} 失败: ${errorMessage(error)}。本次按缺省状态继续，但这不等价于"无保存状态"。`));
				return {};
			}
			try {
				const parsed: unknown = JSON.parse(raw);
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
					const result: Record<string, boolean> = {};
					for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
						if (typeof val === "boolean") result[key] = val;
					}
					return result;
				}
				reportError?.(new Error(`[World Framework] World 状态 ${filePath} 不是合法的对象形状，已忽略现有状态并按缺省继续。`));
			} catch (error) {
				reportError?.(new Error(`[World Framework] World 状态 ${filePath} 不是合法 JSON，已忽略现有状态并按缺省继续: ${errorMessage(error)}`));
			}
			return {};
		},
		async save(state: Record<string, boolean>): Promise<void> {
			if (!filePath) return;
			await mkdir(dirname(filePath), { recursive: true });
			const temp = `${filePath}.tmp`;
			await writeFile(temp, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
			await rename(temp, filePath);
		},
	};
}
