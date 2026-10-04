/** MCP CallToolResult 的保真降级投影与输出预算。
 * 该模块只负责外部结果的形状转换和临时文件配额，不参与路由、连接或配置。 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "../../../src/extensions/index.js";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const MAX_DETAILS_BYTES = 16 * 1024;
const MAX_BINARY_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BINARY_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_BINARY_FILES = 10_000;
const SUPPORTED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type McpContentBlock = Record<string, unknown> & { type: string };

export interface ProjectionResult {
	text: string;
	images: ImageContent[];
	detailsExtra?: Record<string, unknown>;
	mcpResult?: unknown;
}

export class McpOutputGuard {
	private binaryBytesUsed = 0;
	private binaryFilesUsed = 0;

	constructor(private readonly tmpDir: string) {}

	project(result: Record<string, unknown>, toolName: string): ProjectionResult {
		const images: ImageContent[] = [];
		const resourceLinks: Record<string, unknown>[] = [];
		const placeholders: Record<string, unknown>[] = [];
		const textParts: string[] = [];
		const content = Array.isArray(result.content) ? (result.content as McpContentBlock[]) : [];

		for (const block of content) {
			if (this.projectText(block, textParts)) continue;
			if (this.projectImage(block, toolName, images, textParts, placeholders)) continue;
			if (this.projectAudio(block, textParts, placeholders)) continue;
			if (this.projectResourceLink(block, resourceLinks, textParts)) continue;
			if (this.projectResource(block, textParts, placeholders)) continue;
			textParts.push(`[未知内容块类型: ${block.type}]`);
			placeholders.push({ kind: "unknown_block", ...block });
		}

		let text = textParts.length > 0 ? textParts.join("\n") : "(empty result)";
		text = this.guardText(text);

		const detailsExtra = this.buildDetails(result, content.length, resourceLinks, placeholders);
		// The image attachment is already projected into `images` for the model.
		// Keep that attachment intact, but do not write the same base64 payload a
		// second time into the bounded diagnostic journal when the raw MCP result
		// crosses the details budget.
		const diagnosticResult = projectDiagnosticResult(result);
		const rawJson = safeStringify(diagnosticResult);
		const mcpResult = Buffer.byteLength(rawJson, "utf-8") <= MAX_DETAILS_BYTES ? diagnosticResult : boundRawResult(rawJson, this.tmpDir);

		return {
			text,
			images,
			...(detailsExtra !== undefined ? { detailsExtra } : {}),
			mcpResult,
		};
	}

	private projectText(block: McpContentBlock, textParts: string[]): boolean {
		if (block.type !== "text" || typeof block.text !== "string") return false;
		textParts.push(block.text);
		return true;
	}

	private projectImage(
		block: McpContentBlock,
		toolName: string,
		images: ImageContent[],
		textParts: string[],
		placeholders: Record<string, unknown>[],
	): boolean {
		if (block.type !== "image" || typeof block.data !== "string" || typeof block.mimeType !== "string") return false;
		if (SUPPORTED_IMAGE_MIMES.includes(block.mimeType)) {
			images.push({ type: "image", mimeType: block.mimeType as ImageContent["mimeType"], data: block.data, alt: toolName });
		} else {
			textParts.push(`[图片 ${block.mimeType} 未受支持，原始数据见 details]`);
			placeholders.push({ kind: "unsupported_image", mimeType: block.mimeType, base64Bytes: block.data.length });
		}
		return true;
	}

	private projectAudio(
		block: McpContentBlock,
		textParts: string[],
		placeholders: Record<string, unknown>[],
	): boolean {
		if (block.type !== "audio") return false;
		const bytes = typeof block.data === "string" ? block.data.length : 0;
		textParts.push(`[音频 ${bytes} base64 字符]`);
		placeholders.push({ kind: "audio", mimeType: block.mimeType, base64Bytes: bytes });
		return true;
	}

	private projectResourceLink(
		block: McpContentBlock,
		resourceLinks: Record<string, unknown>[],
		textParts: string[],
	): boolean {
		if (block.type !== "resource_link" || typeof block.uri !== "string") return false;
		const label = typeof block.name === "string" ? block.name : block.uri;
		const mime = typeof block.mimeType === "string" ? ` (${block.mimeType})` : "";
		textParts.push(`Resource link: ${label} (${block.uri})${mime}`);
		resourceLinks.push({ ...block });
		return true;
	}

	private projectResource(
		block: McpContentBlock,
		textParts: string[],
		placeholders: Record<string, unknown>[],
	): boolean {
		if (block.type !== "resource" || typeof block.resource !== "object" || block.resource === null) return false;
		const resource = block.resource as { uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown };
		if (typeof resource.text === "string") {
			textParts.push(resource.text);
			return true;
		}
		if (typeof resource.blob !== "string") {
			textParts.push(`[资源内容块（${String(resource.uri ?? "未知 URI")}）]`);
			placeholders.push({ kind: "resource", ...block });
			return true;
		}

		const decodedBytes = Buffer.byteLength(resource.blob, "base64");
		const mime = typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream";
		if (decodedBytes > MAX_BINARY_FILE_BYTES) {
			textParts.push(`[二进制资源 ${mime} (${decodedBytes} 字节) 超过单文件 ${MAX_BINARY_FILE_BYTES} 字节上限，未落盘]`);
			placeholders.push({ kind: "binary_oversized", uri: resource.uri, mimeType: mime, bytes: decodedBytes });
			return true;
		}
		if (this.binaryBytesUsed + decodedBytes > MAX_BINARY_TOTAL_BYTES || this.binaryFilesUsed + 1 > MAX_BINARY_FILES) {
			textParts.push(
				`[二进制资源累计配额已用尽（${MAX_BINARY_TOTAL_BYTES / (1024 * 1024)} MiB / ${MAX_BINARY_FILES} files），本次资源写入被拒绝。可通过 reload 重置（P1 起随 session 重置）]`,
			);
			placeholders.push({ kind: "binary_quota_exhausted", uri: resource.uri, mimeType: mime, bytes: decodedBytes });
			return true;
		}

		const path = join(this.tmpDir, `resource-${randomBytes(4).toString("hex")}.bin`);
		writeFileSync(path, Buffer.from(resource.blob, "base64"));
		this.binaryBytesUsed += decodedBytes;
		this.binaryFilesUsed += 1;
		textParts.push(`[二进制资源 ${mime} (${decodedBytes} 字节) 已保存到 ${path}]`);
		placeholders.push({ kind: "binary_saved", uri: resource.uri, mimeType: mime, bytes: decodedBytes, path });
		return true;
	}

	private guardText(text: string): string {
		const truncated = truncateText(text);
		if (!truncated.truncated) return text;
		const path = join(this.tmpDir, `output-${randomBytes(4).toString("hex")}.txt`);
		try {
			writeFileSync(path, text, "utf-8");
			return `${truncated.text}\n\n[Output truncated. Full output saved to ${path}]`;
		} catch (error) {
			return `${truncated.text}\n\n[Output truncated. Full output could not be saved: ${errorMessage(error)}]`;
		}
	}

	private buildDetails(
		result: Record<string, unknown>,
		contentCount: number,
		resourceLinks: Record<string, unknown>[],
		placeholders: Record<string, unknown>[],
	): Record<string, unknown> | undefined {
		const structuredContent =
			result.structuredContent !== undefined ? boundStructuredContent(result.structuredContent) : undefined;
		if (resourceLinks.length === 0 && placeholders.length === 0 && structuredContent === undefined) return undefined;

		const details: Record<string, unknown> = {
			...(resourceLinks.length > 0 ? { resourceLinks } : {}),
			...(placeholders.length > 0 ? { unrenderedContent: placeholders } : {}),
			...(structuredContent !== undefined ? { structuredContent } : {}),
		};
		if (Buffer.byteLength(JSON.stringify(details), "utf-8") <= MAX_DETAILS_BYTES) return details;
		return {
			...(structuredContent !== undefined
				? { structuredContent: boundStructuredContent(result.structuredContent, 4 * 1024) }
				: {}),
			detailsSummaryOmitted: { reason: "details 附加内容超过 16 KiB 上限", blocks: contentCount },
		};
	}
}

function projectDiagnosticResult(result: Record<string, unknown>): Record<string, unknown> {
	if (!Array.isArray(result.content)) return result;
	const content = (result.content as McpContentBlock[]).map((block) => {
		if (
			block.type !== "image" ||
			typeof block.data !== "string" ||
			typeof block.mimeType !== "string" ||
			!SUPPORTED_IMAGE_MIMES.includes(block.mimeType)
		) {
			return block;
		}
		return {
			...block,
			data: undefined,
			imageDataOmitted: true,
			decodedBytes: Buffer.byteLength(block.data, "base64"),
			originalBase64Chars: block.data.length,
		};
	});
	return { ...result, content };
}

function boundStructuredContent(value: unknown, budget = MAX_DETAILS_BYTES): unknown {
	const raw = safeStringify(value);
	if (Buffer.byteLength(raw, "utf-8") <= budget) return value;
	const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	const summary: Record<string, unknown> = {
		omitted: true,
		rawBytes: Buffer.byteLength(raw, "utf-8"),
		type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
	};
	if (record) summary.keys = Object.keys(record).slice(0, 32);
	return Buffer.byteLength(JSON.stringify(summary), "utf-8") <= budget ? summary : { omitted: true };
}

function boundRawResult(rawJson: string, tmpDir: string): Record<string, unknown> {
	const path = join(tmpDir, `mcp-result-${randomBytes(4).toString("hex")}.json`);
	let fullResultPath: string | undefined;
	try {
		writeFileSync(path, rawJson, "utf-8");
		fullResultPath = path;
	} catch {
		// 落盘失败时摘要也必须有界。
	}
	return {
		omitted: true,
		reason: "原始 MCP result 超过 details 16 KiB 上限，替换为本摘要以保护会话上下文。",
		rawResultBytes: Buffer.byteLength(rawJson, "utf-8"),
		...(fullResultPath !== undefined ? { fullResultPath } : {}),
	};
}

function truncateText(text: string): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf-8") <= MAX_OUTPUT_BYTES && text.split("\n").length <= MAX_OUTPUT_LINES) {
		return { text, truncated: false };
	}
	const kept: string[] = [];
	let bytes = 0;
	for (const line of text.split("\n")) {
		if (kept.length >= MAX_OUTPUT_LINES) break;
		const separatorBytes = kept.length > 0 ? 1 : 0;
		const available = MAX_OUTPUT_BYTES - bytes - separatorBytes;
		if (available <= 0) break;
		const prefix = truncateUtf8(line, available);
		if (prefix.length === 0 && line.length > 0) break;
		kept.push(prefix);
		bytes += separatorBytes + Buffer.byteLength(prefix, "utf-8");
		if (prefix.length < line.length) break;
	}
	return { text: kept.join("\n"), truncated: true };
}

function truncateUtf8(text: string, maxBytes: number): string {
	let bytes = 0;
	let result = "";
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character, "utf-8");
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
