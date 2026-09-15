/**
 * read_file 的截断防护：行数与字节数双上限，先命中者生效。
 * 从不返回半行（单行超限的特判除外）；截断时附可操作的续读提示。
 * 对齐 search-core 的 50KB 输出预算，防大文件/长行炸模型上下文。
 */

export const READ_MAX_LINES = 2000;
export const READ_MAX_BYTES = 50 * 1024; // 50KB
export const READ_MAX_LINE_CHARS = 2000; // 单行超字节上限时的兜底字符数

export interface ReadTruncation {
	/** 截断后的内容 */
	text: string;
	/** 是否发生截断 */
	truncated: boolean;
	/** 命中的上限 */
	truncatedBy: "lines" | "bytes" | null;
	/** 输出的完整行数 */
	outputLines: number;
	/** 输入的总行数 */
	totalLines: number;
	/** 输入的总字节数（UTF-8） */
	totalBytes: number;
	/** 首行单独超字节上限（输出为其前 READ_MAX_LINE_CHARS 字符） */
	firstLineExceedsLimit: boolean;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 对已按 offset/limit 切好的行数组应用双上限截断。
 * 输入即"模型要看到的内容"，文件级分页由调用方负责。
 */
export function truncateReadLines(
	lines: string[],
	maxLines: number = READ_MAX_LINES,
	maxBytes: number = READ_MAX_BYTES,
): ReadTruncation {
	const totalBytes = Buffer.byteLength(lines.join("\n"), "utf8");
	if (lines.length <= maxLines && totalBytes <= maxBytes) {
		return {
			text: lines.join("\n"),
			truncated: false,
			truncatedBy: null,
			outputLines: lines.length,
			totalLines: lines.length,
			totalBytes,
			firstLineExceedsLimit: false,
		};
	}

	// 单行（截取起点）就超字节上限：无法返回完整行，兜底给前 N 字符。
	const firstLineBytes = lines.length > 0 ? Buffer.byteLength(lines[0], "utf8") : 0;
	if (firstLineBytes > maxBytes) {
		return {
			text: lines[0].slice(0, READ_MAX_LINE_CHARS),
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 1,
			totalLines: lines.length,
			totalBytes,
			firstLineExceedsLimit: true,
		};
	}

	// 逐行收集完整行，字节预留给行间换行符。
	const kept: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const lineBytes = Buffer.byteLength(lines[i], "utf8") + (i > 0 ? 1 : 0);
		if (bytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		kept.push(lines[i]);
		bytes += lineBytes;
	}
	return {
		text: kept.join("\n"),
		truncated: true,
		truncatedBy,
		outputLines: kept.length,
		totalLines: lines.length,
		totalBytes,
		firstLineExceedsLimit: false,
	};
}

/** 二进制检测：前 8KB 出现 NUL 字节即按二进制拒绝读为文本。 */
export function looksBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, 8192).includes(0);
}
