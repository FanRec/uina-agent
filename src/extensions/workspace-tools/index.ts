import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ImageContent } from "../index.js";
import { atomicWriteFile } from "./atomic-write.js";
import { activateEditFile } from "./edit-file.js";
import { activateFindFile } from "./find-file.js";
import { activateGrepFile } from "./grep-file.js";
import {
	formatSize,
	looksBinary,
	READ_MAX_BYTES,
	READ_MAX_LINE_CHARS,
	READ_MAX_LINES,
	truncateReadLines,
} from "./read-truncate.js";

/** Trusted filesystem capabilities; no shell process or Core changes. */
export default function activate(api: ExtensionAPI): void {
	// write 守卫的会话内读取记录：path → 读取/写入时的 mtime。目标存在且
	// mtime 与记录不符（未读过或读后被外部改过）时拒绝整体覆盖，逼一次
	// read_file；与 edit_file 的精确匹配防线同一立场——不防对抗，防盲写。
	// edit_file 不接入：它执行时重读文件做精确匹配，外部修改天然失败或避开。
	const readState = new Map<string, number>();
	const recordRead = async (file: string): Promise<void> => {
		readState.set(file, (await stat(file)).mtimeMs);
	};
	const fileSchema = {
		type: "object",
		properties: { path: { type: "string", minLength: 1 } },
		required: ["path"],
		additionalProperties: false,
	};
	const imageSchema = {
		...fileSchema,
		properties: {
			...fileSchema.properties,
			max_bytes: { type: "integer", minimum: 1, description: "可选的图片字节上限；超出时返回元数据而不注入完整图片" },
		},
	};
	api.registerTool({
		def: {
			type: "function",
			function: {
				name: "read_file",
				description:
					"Read a UTF-8 text file. Optional offset (1-based line) and limit select a line range; omitted reads the entire file. Output is capped at 2000 lines / 50KB (whichever is hit first) with a continuation notice; oversized single lines are clipped. Use offset to page through large files.",
				parameters: {
					...fileSchema,
					properties: {
						...fileSchema.properties,
						offset: { type: "integer", minimum: 1 },
						limit: { type: "integer", minimum: 1 },
					},
				},
			},
		},
		run: async (args, signal) => {
			const file = resolve(api.cwd, String(args.path));
			const buffer = await readFile(file, { signal });
			if (looksBinary(buffer))
				throw new Error(`疑似二进制文件，read_file 拒绝读为文本：${file}（用 read_image 或 exec_command 处理）`);
			const lines = buffer.toString("utf8").split("\n");
			if (lines.at(-1) === "") lines.pop(); // 结尾换行不产生幽灵空行
			if (lines.length === 0) {
				// 零字节文件：此前会误报"offset 1 超出文件末尾"。
				await recordRead(file);
				return {
					result: "（空文件）",
					status: "succeeded",
					details: { path: file, lines: 0, totalLines: 0, offset: Number(args.offset ?? 1), truncated: false },
				};
			}
			// CRLF 文件：剥掉每行尾部 \r（只读展示；不碰原文件，edit_file 自行保留行尾）
			const cleanLines = lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
			const offset = Number(args.offset ?? 1);
			const start = offset - 1;
			if (start >= lines.length) {
				throw new Error(`offset ${offset} 超出文件末尾（共 ${lines.length} 行）`);
			}
			const end =
				args.limit === undefined ? cleanLines.length : Math.min(start + Number(args.limit), cleanLines.length);
			const selected = cleanLines.slice(start, end);
			const trunc = truncateReadLines(selected);
			let text = trunc.text;
			if (trunc.firstLineExceedsLimit) {
				text += `\n\n[第 ${offset} 行超过 ${formatSize(READ_MAX_BYTES)} 上限，仅显示前 ${READ_MAX_LINE_CHARS} 字符。${end < lines.length ? `用 offset=${offset + 1} 读后续行；` : "这是末行，"}确需行内更多字节时用 exec_command 按字节取片段。]`;
			} else if (trunc.truncated) {
				const nextOffset = start + trunc.outputLines + 1;
				const by = trunc.truncatedBy === "lines" ? `${READ_MAX_LINES} 行上限` : `${formatSize(READ_MAX_BYTES)} 上限`;
				text += `\n\n[已截断：显示第 ${offset}-${start + trunc.outputLines} 行（命中${by}），文件共 ${lines.length} 行。用 offset=${nextOffset} 继续读。]`;
			} else if (end < lines.length) {
				// 用户指定 limit 读完了所选段但文件还有后续：同样给出续读提示。
				text += `\n\n[文件共 ${lines.length} 行，当前显示到第 ${end} 行。用 offset=${end + 1} 继续读。]`;
			}
			await recordRead(file);
			return {
				result: text,
				status: "succeeded",
				details: {
					path: file,
					lines: trunc.outputLines,
					totalLines: lines.length,
					offset,
					truncated: trunc.truncated,
					truncatedBy: trunc.truncatedBy,
					...(trunc.firstLineExceedsLimit ? { firstLineExceedsLimit: true } : {}),
				},
			};
		},
	});
	api.registerTool({
		def: {
			type: "function",
			function: {
				name: "write_file",
				description:
					"Overwrite or create a UTF-8 text file. Path resolves against the runtime cwd; absolute paths may point outside it. Overwriting an existing file requires a prior read_file (external modifications since the read require re-reading). Creates parent directories.",
				parameters: {
					type: "object",
					properties: { path: { type: "string", minLength: 1 }, text: { type: "string" } },
					required: ["path", "text"],
					additionalProperties: false,
				},
			},
		},
		run: async (args, signal) => {
			const file = resolve(api.cwd, String(args.path));
			const existing = await stat(file).catch(() => null);
			if (existing && readState.get(file) !== existing.mtimeMs) {
				return {
					result: `目标文件存在但未读取过当前内容（或读取后已被外部修改）：${file}。先 read_file 确认内容，再决定 write_file 或改用 edit_file。`,
					status: "failed",
					details: { path: file, reason: "stale_or_unread" },
				};
			}
			await mkdir(dirname(file), { recursive: true });
			await atomicWriteFile(file, String(args.text), { encoding: "utf8", signal });
			await recordRead(file);
			return {
				result: "Written " + file,
				status: "succeeded",
				details: { path: file, effects: [{ effectType: "file.write", label: file }] },
			};
		},
	});
	activateEditFile(api);
	activateGrepFile(api);
	activateFindFile(api);
	api.registerTool({
		def: {
			type: "function",

			function: {
				name: "read_image",
				description:
					"Read a PNG, JPEG, GIF or WebP image into model context. Unknown model capability is attempted; explicitly unsupported models reject image input.",
				parameters: imageSchema,
			},
		},
		run: async (args, signal) => {
			const file = resolve(api.cwd, String(args.path));
			const bytes = await readFile(file, { signal });
			const mimeType = imageMimeType(bytes);
			if (!mimeType) throw new Error("Unsupported image data (expected PNG, JPEG, GIF or WebP): " + file);
			if (typeof args.max_bytes === "number" && bytes.length > args.max_bytes) {
				return {
					result: JSON.stringify({
						path: file,
						mimeType,
						bytes: bytes.length,
						image: "omitted",
						reason: "over_max_bytes",
					}),
					status: "failed" as const,
					details: { path: file, mimeType, bytes: bytes.length, reason: "over_max_bytes" },
				};
			}
			return {
				result: "Image: " + file,
				status: "succeeded",
				images: [{ type: "image", mimeType, data: bytes.toString("base64"), alt: file }],
				details: { path: file, bytes: bytes.length },
			};
		},
	});
}

/** Identify the file signature; this does not certify that every image frame decodes. */
function imageMimeType(bytes: Buffer): ImageContent["mimeType"] | undefined {
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
	if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	return undefined;
}
