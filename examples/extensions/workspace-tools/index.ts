import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ExtensionAPI, ImageContent } from "../../../src/extensions/index.js";

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
			function: { name: "read_file", description: "Read a UTF-8 text file.", parameters: fileSchema },
		},
		run: async (args, signal) => {
			const file = resolve(api.cwd, String(args.path));
			const result = await readFile(file, { encoding: "utf8", signal });
			return { result, status: "succeeded", details: { path: file, lines: result.split("\n").length } };
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
	api.registerTool({
		def: {
			type: "function",
			function: {
				name: "read_image",
				description:
					"Read a PNG, JPEG, GIF or WebP image into model context. Requires a model with declared image input support.",
				parameters: fileSchema,
			},
		},
		run: async (args, signal) => {
			const file = resolve(api.cwd, String(args.path));
			const types: Record<string, ImageContent["mimeType"]> = {
				".png": "image/png",
				".jpg": "image/jpeg",
				".jpeg": "image/jpeg",
				".gif": "image/gif",
				".webp": "image/webp",
			};
			const mimeType = types[extname(file).toLowerCase()];
			if (!mimeType) throw new Error("Unsupported image extension: " + file);
			const bytes = await readFile(file, { signal });
			return {
				result: "Image: " + file,
				status: "succeeded",
				images: [{ type: "image", mimeType, data: bytes.toString("base64"), alt: file }],
				details: { path: file, bytes: bytes.length },
			};
		},
	});
	api.registerToolRenderer("read_file", (tool, options) => ({
		render: () => {
			const details = tool.details as { path?: string; lines?: number } | undefined;
			return [
				"Read " + (details?.path ?? String((tool.args as { path?: string })?.path ?? "")) + " · " + tool.status,
				...(options.expanded ? (tool.result ?? "").split("\n") : [String(details?.lines ?? "?") + " lines"]),
			];
		},
	}));
}
