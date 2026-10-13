import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 原子写文件：先写唯一 tmp 再 rename，读者要么看到旧内容要么看到完整新内容。
 * 失败时清理 tmp；写侧各自负责"持久确认成功后才提交内存状态"。
 */

export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const temp = `${filePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, content, "utf8");
		await rename(temp, filePath);
	} finally {
		await rm(temp, { force: true });
	}
}

export function writeTextAtomicSync(filePath: string, content: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const temp = `${filePath}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, content, "utf8");
		renameSync(temp, filePath);
	} finally {
		rmSync(temp, { force: true });
	}
}

/** JSON 文件统一格式：tab 缩进 + 尾换行，供人排查时直接可读。 */
export function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	return writeTextAtomic(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}

export function writeJsonAtomicSync(filePath: string, value: unknown): void {
	writeTextAtomicSync(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}
