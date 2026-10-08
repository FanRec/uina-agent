import { existsSync, readFileSync, truncateSync } from "node:fs";

/**
 * JSONL 日志恢复（facts-journal / operation-log 共享）：
 * 尾部 partial（崩溃截断的最后一行）丢弃即可；中段损坏明确失败不做猜测。
 * 截断按保留行的字节长度执行，只移除尾部 partial，不动完整记录。
 */
export function recoverJsonlLines<T>(filePath: string, label: string): { records: T[]; truncatedTailLines: number } {
	if (!existsSync(filePath)) return { records: [], truncatedTailLines: 0 };
	const content = readFileSync(filePath, "utf8");
	const lines = content.split("\n");
	let end = lines.length;
	let truncated = 0;
	if (end > 0 && lines[end - 1]!.trim() !== "") {
		try {
			JSON.parse(lines[end - 1]!);
		} catch {
			truncated = 1;
			end -= 1;
		}
	}
	const records: T[] = [];
	for (let i = 0; i < end; i++) {
		const line = lines[i]!.trim();
		if (line === "") continue;
		try {
			records.push(JSON.parse(line) as T);
		} catch (error) {
			throw new Error(`${label}第 ${i + 1} 行损坏（非尾部），明确失败不做猜测`, { cause: error });
		}
	}
	if (truncated > 0) truncateSync(filePath, byteLengthOf(lines, end));
	return { records, truncatedTailLines: truncated };
}

function byteLengthOf(lines: string[], keep: number): number {
	let size = 0;
	for (let i = 0; i < keep; i++) size += Buffer.byteLength(lines[i]!, "utf8") + 1;
	return size;
}
