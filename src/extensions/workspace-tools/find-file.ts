/**
 * find_file：按文件/目录名 glob 在工作目录内查找路径。
 * 复用 search-core.ts 的遍历与 gitignore 匹配；输出同样有总量防护。
 */
import { opendir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "../index.js";
import { globToRegExp, GitignoreMatcher, MAX_MATCHES, MAX_OUTPUT_BYTES } from "./search-core.js";

export function activateFindFile(api: ExtensionAPI): void {
	api.registerTool({
		def: {
			type: "function",
			function: {
				name: "find_file",
				description:
					"Find files and directories by name glob under the workspace, e.g. \"*.test.ts\" or \"**/README*\". Returns relative paths (one per line), capped at 100 entries / 50KB output. .gitignore is respected.",
				parameters: {
					type: "object",
					properties: {
						pattern: { type: "string", minLength: 1, description: "Name glob: * matches within a segment, ** across segments" },
						path: { type: "string", description: "Directory to search, relative to cwd (default: .)" },
						limit: { type: "integer", minimum: 1, description: "Max entries to return (default 100)" },
					},
					required: ["pattern"],
					additionalProperties: false,
				},
			},
		},
		run: async (args) => {
			const root = resolve(api.cwd, String(args.path ?? "."));
			const s = await stat(root).catch(() => null);
			if (!s || !s.isDirectory()) throw new Error(`find_file：root 必须是已存在的目录：${root}`);
			const limit = Math.max(1, args.limit === undefined ? MAX_MATCHES : Number(args.limit));
			const regex = globToRegExp(String(args.pattern).split(sep).join("/").split("/").pop() ?? "");
			// 含 / 的 pattern 视为相对路径 glob（如 **/README*），对整段相对路径匹配
			const raw = String(args.pattern).split(sep).join("/");
			const fullRegex = raw.includes("/") ? globToRegExp(raw) : undefined;

			const matcher = new GitignoreMatcher(root);
			await matcher.addDir(root);
			const results: string[] = [];
			let limitHit = false;
			let bytes = 0;

			async function walk(dir: string): Promise<void> {
				if (limitHit) return;
				const rel0 = relative(root, dir).split(sep).join("/");
				if (rel0 && matcher.ignored(rel0, true)) return;
				await matcher.addDir(dir);
				const handle = await opendir(dir);
				const entries: Array<{ name: string; isDir: boolean; full: string }> = [];
				for await (const entry of handle) {
					entries.push({ name: entry.name, isDir: entry.isDirectory(), full: join(dir, entry.name) });
				}
				for (const { name, isDir, full } of entries) {
					if (limitHit) return;
					if (name === ".git") continue; // git 内部文件永不列出
					const rel = relative(root, full).split(sep).join("/");
					if (matcher.ignored(rel, isDir)) continue;
					const hit = fullRegex ? fullRegex.test(rel) : regex.test(name);
					if (hit) {
						const size = Buffer.byteLength(rel + "\n", "utf8");
						if (bytes + size > MAX_OUTPUT_BYTES) {
							limitHit = true;
							break;
						}
						bytes += size;
						results.push(rel + (isDir ? "/" : ""));
						if (results.length >= limit) limitHit = true;
					}
					if (isDir) await walk(full);
				}
			}

			await walk(root);
			let text = results.length === 0 ? "No matches found" : results.join("\n");
			if (limitHit) text += `\n\n[已达上限（${results.length} 条 / ${MAX_OUTPUT_BYTES / 1024}KB）；请收窄 pattern 或加 limit 翻页]`;
			return {
				result: text,
				status: "succeeded",
				details: { entries: results.length, limitHit },
			};
		},
	});
}
