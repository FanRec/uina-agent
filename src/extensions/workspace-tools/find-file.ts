/**
 * find_file：按文件/目录名 glob 在工作目录内查找路径。
 * 复用 search-core.ts 的遍历与 gitignore 匹配；输出同样有总量防护。
 */
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ExtensionAPI } from "../index.js";
import { GitignoreMatcher, globToRegExp, MAX_MATCHES, MAX_OUTPUT_BYTES, walkTree } from "./search-core.js";

export function activateFindFile(api: ExtensionAPI): void {
	api.registerTool({
		def: {
			type: "function",
			function: {
				name: "find_file",
				description:
					'Find files and directories by name glob under the workspace, e.g. "*.test.ts" or "**/README*". Returns relative paths, capped at 100 entries / 50KB; narrow pattern or path when capped. .gitignore is respected.',
				parameters: {
					type: "object",
					properties: {
						pattern: {
							type: "string",
							minLength: 1,
							description: "Name glob: * matches within a segment, ** across segments",
						},
						path: { type: "string", description: "Directory to search, relative to cwd (default: .)" },
						limit: { type: "integer", minimum: 1, description: "Max entries to return (default 100)" },
					},
					required: ["pattern"],
					additionalProperties: false,
				},
			},
		},
		run: async (args, signal) => {
			const root = resolve(api.cwd, String(args.path ?? "."));
			const s = await stat(root).catch(() => null);
			if (!s || !s.isDirectory()) throw new Error(`find_file：root 必须是已存在的目录：${root}`);
			const limit = Math.max(1, args.limit === undefined ? MAX_MATCHES : Number(args.limit));
			const regex = globToRegExp(String(args.pattern).split(sep).join("/").split("/").pop() ?? "");
			// 含 / 的 pattern 视为相对路径 glob（如 **/README*），对整段相对路径匹配
			const raw = String(args.pattern).split(sep).join("/");
			const fullRegex = raw.includes("/") ? globToRegExp(raw) : undefined;

			const matcher = new GitignoreMatcher(root);
			const results: string[] = [];
			let bytes = 0;
			let bytesHit = false;

			await walkTree(
				root,
				matcher,
				(rel, _name, isDir) => {
					const hit = fullRegex ? fullRegex.test(rel) : regex.test(rel.split("/").pop() ?? "");
					if (!hit) return false;
					const size = Buffer.byteLength(rel + "\n", "utf8");
					if (bytes + size > MAX_OUTPUT_BYTES) {
						bytesHit = true;
						return true;
					}
					bytes += size;
					results.push(rel + (isDir ? "/" : ""));
					// 偷看一条：收满 limit+1 才停，恰好 limit 条总量不算达上限
					return results.length > limit;
				},
				signal,
			);
			if (signal?.aborted) throw new Error("find_file：调用已取消。");

			const countHit = results.length > limit;
			const shown = results.slice(0, limit);
			let text = shown.length === 0 ? "No matches found" : shown.join("\n");
			const notices: string[] = [];
			if (countHit) notices.push(`已达 ${limit} 条上限（可能还有更多）；请收窄 pattern 或加大 limit`);
			if (bytesHit) notices.push(`输出超过 ${MAX_OUTPUT_BYTES / 1024}KB 上限；请收窄 pattern 或 path`);
			if (notices.length > 0) text += `\n\n[${notices.join("；")}]`;
			return {
				result: text,
				status: "succeeded",
				details: { entries: shown.length, limitHit: countHit || bytesHit },
			};
		},
	});
}
