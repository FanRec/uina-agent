/**
 * grep/find 共享的搜索基础设施。
 *
 * 双引擎设计：
 * - rg 引擎：PATH 上有 ripgrep 时优先使用（快、原生尊重 .gitignore）；
 * - node 引擎：无 rg 时降级为纯 node 遍历（慢但不失败），自带轻量
 *   gitignore 匹配（目录/文件名通配、显式路径、* 与 ** 语义）。
 *
 * 输出防护（对齐 pi truncate.ts 的三重限制，Uina 精简为常量）：
 * 匹配数上限、输出字节上限、单行长度上限——任一触发即在输出尾部
 * 附带可操作的提示（如何翻页/如何收窄）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { ensureRg } from "./rg-installer.js";

/** root 或其任一祖先是否含 .git（rg 的 VCS ignore 仅在 git 仓库内生效）。 */
function isInsideGitRepo(dir: string): boolean {
	let current = dir;
	for (;;) {
		if (existsSync(join(current, ".git"))) return true;
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

export const MAX_MATCHES = 100;
export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_LINE_LENGTH = 500;

export interface SearchMatch {
	file: string;
	line: number;
	text: string;
}

export interface SearchOutcome {
	matches: SearchMatch[];
	limitHit: boolean;
	engine: "rg" | "node";
}

export interface GrepOptions {
	pattern: string;
	/** 搜索根：文件或目录（绝对路径） */
	root: string;
	/** 相对 root 的 glob 过滤，如 "*.ts" */
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	limit?: number;
	signal?: AbortSignal;
}

/* ---------------- rg 引擎 ---------------- */

/** rg 可执行路径：PATH → 缓存/自动下载。返回 null 表示 rg 不可用（调用方降级 node 引擎）。 */
async function resolveRg(): Promise<string | null> {
	return ensureRg();
}

async function grepWithRg(opts: GrepOptions, rgPath: string): Promise<SearchOutcome> {
	const args = ["--json", "--line-number", "--color=never", "--hidden"];
	// rg 的 VCS ignore 只在检测到 git 仓库时生效；非 git 目录需显式传 root 的 .gitignore
	const rootGitignore = join(opts.root, ".gitignore");
	if (!isInsideGitRepo(opts.root) && existsSync(rootGitignore)) {
		args.push("--ignore-file", rootGitignore);
	}
	if (opts.ignoreCase) args.push("--ignore-case");
	if (opts.literal) args.push("--fixed-strings");
	if (opts.glob) args.push("--glob", opts.glob);
	args.push("--", opts.pattern, opts.root);
	const limit = Math.max(1, opts.limit ?? MAX_MATCHES);

	return new Promise<SearchOutcome>((resolve, reject) => {
		const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
		const matches: SearchMatch[] = [];
		let stderr = "";
		let limitHit = false;
		let settled = false;
		const settle = (fn: () => void) => {
			if (!settled) {
				settled = true;
				fn();
			}
		};
		const onAbort = () => {
			child.kill();
			settle(() => reject(new Error("search：调用已取消。")));
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr?.on("data", (c) => (stderr += c.toString()));
		child.stdout?.on("data", (chunk) => {
			// rg --json 每行一个事件；逐行解析
			for (const rawLine of chunk.toString().split("\n")) {
				if (!rawLine.trim() || matches.length >= limit) continue;
				let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
				try {
					event = JSON.parse(rawLine);
				} catch {
					continue;
				}
				if (event.type !== "match") continue;
				const file = event.data?.path?.text;
				const lineNo = event.data?.line_number;
				const text = event.data?.lines?.text;
				if (file && typeof lineNo === "number") {
					matches.push({ file, line: lineNo, text: (text ?? "").replace(/\r?\n$/, "") });
					if (matches.length >= limit) {
						limitHit = true;
						child.kill();
					}
				}
			}
		});
		child.on("error", (error) => {
			opts.signal?.removeEventListener("abort", onAbort);
			settle(() => reject(new Error(`search：ripgrep 启动失败：${error.message}`)));
		});
		child.on("close", (code) => {
			opts.signal?.removeEventListener("abort", onAbort);
			if (!limitHit && code !== 0 && code !== 1) {
				settle(() => reject(new Error(`search：rg 退出码 ${code}${stderr.trim() ? "：" + stderr.trim() : ""}`)));
				return;
			}
			settle(() => resolve({ matches, limitHit, engine: "rg" }));
		});
	});
}

/* ---------------- node 降级引擎 ---------------- */

/** 极简 gitignore 语义：每行一个模式；# 注释；尾部 / 标目录；* 通配段内、** 跨段；! 例外不支持（保持简单，v1 无真实需求）。导出给 find_file 复用。 */
export class GitignoreMatcher {
	private patterns: Array<{ dir: boolean; regex: RegExp }> = [];

	constructor(private root: string) {}

	/** 读 root 及沿途已收集的 .gitignore；惰性调用：进入目录前 addDir。 */
	async addDir(dir: string): Promise<void> {
		const file = join(dir, ".gitignore");
		const rel = relative(this.root, dir);
		let content: string;
		try {
			content = await readFile(file, "utf8");
		} catch {
			return;
		}
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const dirOnly = line.endsWith("/");
			const cleaned = line.replace(/\/+$/, "");
			// 锚定：含 / 的模式相对该 .gitignore 所在目录；否则匹配任意层级
			const anchored = cleaned.includes("/");
			const base = anchored ? (rel ? rel.split(sep).join("/") + "/" : "") : "";
			// globSource 无锚定，此处统一组装一次锚定；目录模式 (/.*)?$ 同时覆盖其下文件
			const source = "^" + base + (anchored ? "" : "(?:.*/)?") + globSource(cleaned) + "(/.*)?$";
			this.patterns.push({ dir: dirOnly, regex: new RegExp(source) });
		}
	}

	ignored(relPath: string, _isDir: boolean): boolean {
		const p = relPath.split(sep).join("/");
		for (const { regex } of this.patterns) {
			// 目录模式（如 node_modules/）的 regex 带 (/.*)?$，同时覆盖目录本身与其下文件路径；
			// git 语义：目录被排除后其内容也不再遍历，文件/目录两种调用都应命中
			if (regex.test(p)) return true;
		}
		return false;
	}
}

/** glob → RegExp 源：** 跨段，* 段内，? 单字符；其余字符按字面量转义。 */
/** glob → 无锚定 RegExp 源：** 跨段，* 段内，? 单字符；其余字符按字面量转义。 */
function globSource(glob: string): string {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				source += ".*";
				i++;
				// 吃掉跟在 ** 后的 /
				if (glob[i + 1] === "/") i++;
			} else {
				source += "[^/]*";
			}
		} else if (ch === "?") {
			source += "[^/]";
		} else {
			source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return source;
}

/** glob → 锚定全串的 RegExp（无锚定时 "*.ts" 会部分命中 "src/app.ts"）。导出给 find_file 复用。 */
export function globToRegExp(glob: string): RegExp {
	return new RegExp("^(?:" + globSource(glob) + ")$");
}

function globFilter(relPath: string, glob: string): boolean {
	return globToRegExp(glob).test(relPath.split(sep).join("/"));
}

async function grepWithNode(opts: GrepOptions, limit: number): Promise<SearchOutcome> {
	const s = await stat(opts.root).catch(() => null);
	if (!s) throw new Error(`search：路径不存在：${opts.root}`);
	const isDir = s.isDirectory();
	const matcher = new GitignoreMatcher(opts.root);
	const rootDir = isDir ? opts.root : opts.root.slice(0, opts.root.lastIndexOf(sep)) || opts.root;
	await matcher.addDir(rootDir);

	let regex: RegExp;
	if (opts.literal) {
		regex = new RegExp(opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.ignoreCase ? "i" : "");
	} else {
		try {
			regex = new RegExp(opts.pattern, opts.ignoreCase ? "i" : "");
		} catch (error) {
			throw new Error(`search：pattern 不是合法正则：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const matches: SearchMatch[] = [];
	let limitHit = false;

	async function walk(dir: string): Promise<void> {
		if (limitHit) return;
		const rel0 = relative(opts.root, dir);
		if (rel0 && matcher.ignored(rel0.split(sep).join("/"), true)) return;
		await matcher.addDir(dir);
		const dirHandle = await opendir(dir);
		const entries: Array<{ name: string; isDir: boolean; full: string }> = [];
		for await (const entry of dirHandle) {
			const full = join(dir, entry.name);
			const isDirectory = entry.isDirectory();
			entries.push({ name: entry.name, isDir: isDirectory, full });
		}
		for (const { isDir: entryIsDir, full } of entries) {
			if (limitHit) return;
			const rel = relative(opts.root, full).split(sep).join("/");
			if (matcher.ignored(rel, entryIsDir)) continue;
			if (entryIsDir) {
				await walk(full);
				continue;
			}
			if (opts.glob && !globFilter(rel, opts.glob)) continue;
			let content: string;
			try {
				content = await readFile(full, "utf8");
			} catch {
				continue; // 二进制或不可读：跳过
			}
			// 含 NUL 视为二进制，跳过
			if (content.includes("\0")) continue;
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (regex.test(lines[i].replace(/\r$/, ""))) {
					matches.push({ file: full, line: i + 1, text: lines[i].replace(/\r$/, "") });
					if (matches.length >= limit) {
						limitHit = true;
						return;
					}
				}
			}
		}
	}

	if (isDir) {
		await walk(opts.root);
	} else {
		// 单文件搜索
		const rel = relative(opts.root, opts.root);
		if (!matcher.ignored(rel, false) && (!opts.glob || globFilter(rel, opts.glob))) {
			const content = await readFile(opts.root, "utf8");
			const lines = content.split("\n");
			for (let i = 0; i < lines.length && !limitHit; i++) {
				if (regex.test(lines[i].replace(/\r$/, ""))) {
					matches.push({ file: opts.root, line: i + 1, text: lines[i].replace(/\r$/, "") });
					if (matches.length >= limit) limitHit = true;
				}
			}
		}
	}
	return { matches, limitHit, engine: "node" };
}

/* ---------------- 组合入口 ---------------- */

export async function runGrep(opts: GrepOptions): Promise<SearchOutcome> {
	const limit = Math.max(1, opts.limit ?? MAX_MATCHES);
	const rgPath = await resolveRg();
	if (rgPath) {
		try {
			return await grepWithRg(opts, rgPath);
		} catch (error) {
			if (opts.signal?.aborted) throw error;
			// rg 启动或执行失败（如正则方言差异）：降级 node 引擎重试
			return grepWithNode(opts, limit);
		}
	}
	return grepWithNode(opts, limit);
}

/** 输出格式化：相对路径 + 行号 + 截断的单行文本 + 尾部提示。 */
export function formatGrepOutput(
	matches: SearchMatch[],
	root: string,
	limitHit: boolean,
	limit: number,
): string {
	if (matches.length === 0) return "No matches found";
	const lines: string[] = [];
	let bytes = 0;
	let bytesHit = false;
	for (const m of matches) {
		const rel = relative(root, m.file).split(sep).join("/") || m.file;
		let text = m.text;
		let lineTruncated = false;
		if (text.length > MAX_LINE_LENGTH) {
			text = text.slice(0, MAX_LINE_LENGTH);
			lineTruncated = true;
		}
		const rendered = `${rel}:${m.line}: ${text}${lineTruncated ? " …[截断]" : ""}`;
		const size = Buffer.byteLength(rendered, "utf8");
		if (bytes + size > MAX_OUTPUT_BYTES) {
			bytesHit = true;
			break;
		}
		bytes += size;
		lines.push(rendered);
	}
	const notices: string[] = [];
	if (limitHit) notices.push(`已达 ${limit} 条匹配上限；可用更大的 limit 翻页，或收窄 pattern/path`);
	if (bytesHit) notices.push(`输出超过 ${MAX_OUTPUT_BYTES / 1024}KB 上限，已截断；请收窄 pattern 或加 glob`);
	if (notices.length > 0) lines.push("", `[${notices.join("；")}]`);
	return lines.join("\n");
}
