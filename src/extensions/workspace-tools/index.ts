import { readFile, writeFile } from "node:fs/promises";
import { activateEditFile } from "./edit-file.js";
import { resolve } from "node:path";
import type { ExtensionAPI, ImageContent } from "../index.js";

/** Trusted filesystem capabilities; no shell process or Core changes. */
export default function activate(api: ExtensionAPI): void {
	const fileSchema = {
		type: "object",
		properties: { path: { type: "string", minLength: 1 } },
		required: ["path"],
		additionalProperties: false,
	};
	api.registerTool({
		def: {
			type: "function",
			function: { name: "read_file", description: "Read a UTF-8 text file. Optional offset (1-based line) and limit select a line range; omitted reads the entire file.", parameters: { ...fileSchema, properties: { ...fileSchema.properties, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } } } },
		},
		run: async (args, signal) => {
			const file = resolve(api.cwd, String(args.path));
			const text = await readFile(file, { encoding: "utf8", signal });
			const lines = text.split("\n");
			const offset = Number(args.offset ?? 1);
			const selected = lines.slice(offset - 1, args.limit === undefined ? undefined : offset - 1 + Number(args.limit));
			return { result: selected.join("\n"), status: "succeeded", details: { path: file, lines: selected.length, totalLines: lines.length, offset } };
		},
	});
	api.registerTool({
		def: {
			type: "function",
			function: {
				name: "write_file",
				description: "Write a UTF-8 text file.",
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
			await writeFile(file, String(args.text), { encoding: "utf8", signal });
			return { result: "Written " + file, status: "succeeded", details: { path: file } };
		},
	});
		activateEditFile(api);
api.registerTool({
		def: {
			type: "function",
			function: {
				name: "read_image",
				description:
					"Read a PNG, JPEG, GIF or WebP image into model context. Unknown model capability is attempted; explicitly unsupported models reject image input.",
				parameters: fileSchema,
			},
		},
		run: async (args, signal) => {
			const file = resolve(api.cwd, String(args.path));
			const bytes = await readFile(file, { signal });
			const mimeType = imageMimeType(bytes);
			if (!mimeType) throw new Error("Unsupported image data (expected PNG, JPEG, GIF or WebP): " + file);
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
