/**
 * grep_file：在工作目录内搜索文件内容。
 * 核心逻辑在 search-core.ts（rg 优先 + node 降级 + 三重输出防护）。
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "../index.js";
import { formatGrepOutput, MAX_MATCHES, runGrep } from "./search-core.js";

export function activateGrepFile(api: ExtensionAPI): void {
	api.registerTool({
		def: {
			type: "function",
			function: {
				name: "grep_file",
				description:
					"Search file contents in the workspace for a regex (or literal string). Returns matching lines as path:line: text. Respects .gitignore when ripgrep is available. Output is capped at 100 matches / 50KB / 500 chars per line; a notice explains how to page or narrow when a cap is hit.",
				parameters: {
					type: "object",
					properties: {
						pattern: { type: "string", minLength: 1, description: "Regular expression, or literal text when literal=true" },
						path: { type: "string", description: "File or directory to search, relative to cwd (default: .)" },
						glob: { type: "string", description: "Only search files matching this glob, e.g. \"*.ts\"" },
						ignoreCase: { type: "boolean", description: "Case-insensitive search (default false)" },
						literal: { type: "boolean", description: "Treat pattern as a literal string instead of regex (default false)" },
						limit: { type: "integer", minimum: 1, description: "Max matches to return (default 100)" },
					},
					required: ["pattern"],
					additionalProperties: false,
				},
			},
		},
		run: async (args, signal) => {
			const root = resolve(api.cwd, String(args.path ?? "."));
			const s = await stat(root).catch(() => null);
			if (!s) throw new Error(`grep_file：路径不存在：${root}`);
			const outcome = await runGrep({
				pattern: String(args.pattern),
				root,
				glob: args.glob === undefined ? undefined : String(args.glob),
				ignoreCase: args.ignoreCase === true,
				literal: args.literal === true,
				limit: args.limit === undefined ? undefined : Number(args.limit),
				signal,
			});
			const text = formatGrepOutput(outcome.matches, root, outcome.limitHit, Math.max(1, args.limit === undefined ? MAX_MATCHES : Number(args.limit)));
			return {
				result: text,
				status: "succeeded",
				details: { engine: outcome.engine, matches: outcome.matches.length, limitHit: outcome.limitHit },
			};
		},
	});
}
