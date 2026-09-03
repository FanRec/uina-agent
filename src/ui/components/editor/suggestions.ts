/**
 * 输入联想浮层组件（复刻 dsh-TUI / Claude Code SuggestionCard 视觉与交互规范）。
 * 支持：
 * 1. `/` 斜杠命令联想（带描述与前缀提亮）；
 * 2. `@` 文件路径模糊联想（带图标、文件类型与子序列模糊打分）；
 * 3. 5 行视口自适应截断，包含 `↑N · ↓M` 越界提示；
 * 4. 左右与顶底细线圆角闭合，像素级列宽对齐。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { C, visibleWidth, truncateToWidth } from "../../core/utils.js";

export interface CommandItem {
	name: string;
	description: string;
	tag?: string;
	hasArgs?: boolean;
}

export interface FileItem {
	path: string;
	name: string;
	kind: "file" | "directory";
	score?: number;
}

/** 可用内容宽度：总宽减去外框两端 `│ ` (2) 与 ` │` (2) */
export function cardContentWidth(columns: number): number {
	return Math.max(0, columns - 4);
}

import * as os from "node:os";

const pathSeparators = /[\\/]/;

/**
 * 判断是否为路径风格的查询（包含路径分隔符、相对路径或绝对路径）
 */
export function isPathLikeQuery(query: string): boolean {
	return (
		query.startsWith(".") ||
		query.startsWith("~") ||
		query.startsWith("/") ||
		/^[A-Za-z]:[\\/]/.test(query) ||
		pathSeparators.test(query)
	);
}

/**
 * 把候选名按命中的查询前缀拆为三段（用于前缀高亮）：
 * 优先检查整名前缀、最后一个空格后前缀、最后一个 / 后前缀（与 dsh-TUI 完全一致）。
 */
export function splitQueryMatch(
	name: string,
	query: string,
): { before: string; match: string; after: string } | null {
	if (!query) return null;
	const lower = query.toLowerCase();

	const startsWith = (start: number): { before: string; match: string; after: string } | null => {
		const segment = name.slice(start);
		if (!segment.toLowerCase().startsWith(lower)) return null;
		const matched = segment.slice(0, Math.min(query.length, segment.length));
		return {
			before: name.slice(0, start),
			match: matched,
			after: segment.slice(matched.length),
		};
	};

	const lastSpace = name.lastIndexOf(" ");
	const lastSlash = name.lastIndexOf("/");

	const prefixMatch =
		startsWith(0) ??
		(lastSpace >= 0 ? startsWith(lastSpace + 1) : null) ??
		(lastSlash >= 0 ? startsWith(lastSlash + 1) : null);

	if (prefixMatch) return prefixMatch;

	// 降级兜底：子串匹配
	const idx = name.toLowerCase().indexOf(lower);
	if (idx === -1) return null;
	return {
		before: name.slice(0, idx),
		match: name.slice(idx, idx + query.length),
		after: name.slice(idx + query.length),
	};
}

/**
 * 模糊子序列匹配打分算法（移植自 dsh-TUI fileSuggestions）
 */
export function fuzzySubsequenceScore(query: string, candidate: string): number | undefined {
	const needle = query.toLowerCase();
	const haystack = candidate.toLowerCase();
	if (!needle) return 0;

	let cursor = 0;
	let first = -1;
	let gaps = 0;

	for (const char of needle) {
		const found = haystack.indexOf(char, cursor);
		if (found === -1) return undefined;
		if (first === -1) first = found;
		gaps += found - cursor;
		cursor = found + 1;
	}

	const prefixBonus = first === 0 ? 25 : 0;
	const boundaryBonus = first > 0 && /[\\/_. -]/.test(haystack[first - 1] ?? "") ? 12 : 0;
	return needle.length * 10 + prefixBonus + boundaryBonus - gaps - haystack.length / 100;
}

/**
 * 对文件候选列表按查询打分排序
 */
export function rankFileCandidates(candidates: FileItem[], query: string, topK = 50): FileItem[] {
	if (!query) return candidates.slice(0, topK);

	const scored = candidates
		.map((c) => ({
			...c,
			score: fuzzySubsequenceScore(query, `${c.path} ${c.name}`),
		}))
		.filter((c) => c.score !== undefined)
		.sort((a, b) => (b.score! - a.score!) || a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path));

	return scored.slice(0, topK);
}

/**
 * 路径模式文件发现：精准列出指定目录下的直接子项（支持 @./, @../, @src/, @src/components/ 穿梭浏览）
 */
export function listPathCandidates(cwd: string, query: string, topK = 50): FileItem[] {
	const normalized = query.replace(/\\/g, "/");
	const slash = normalized.lastIndexOf("/");
	const bareDir = slash < 0 && (normalized === "." || normalized === ".." || normalized === "~");
	const directoryPart = slash < 0 ? (bareDir ? `${normalized}/` : "") : normalized.slice(0, slash + 1);
	const nameQuery = slash < 0 || bareDir ? "" : normalized.slice(slash + 1);

	let expanded = directoryPart;
	if (directoryPart === "~/" || directoryPart === "~") {
		expanded = `${os.homedir()}/`;
	} else if (directoryPart.startsWith("/") || /^[A-Za-z]:\//.test(directoryPart)) {
		expanded = directoryPart;
	} else {
		expanded = path.resolve(cwd, directoryPart || ".");
	}

	try {
		const SKIP = new Set([
			"node_modules",
			".git",
			".hg",
			".svn",
			".DS_Store",
			"dist",
			".next",
			"build",
			"coverage",
			".gemini",
			".system_generated",
			"tmp",
			".turbo",
		]);

		const rawEntries = fs.readdirSync(expanded, { withFileTypes: true })
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name));

		const candidates: FileItem[] = rawEntries
			.filter((e) => {
				if (!e.isFile() && !e.isDirectory()) return false;
				if (SKIP.has(e.name) && !nameQuery.startsWith(".") && !directoryPart.includes(e.name)) {
					return false;
				}
				return true;
			})
			.map((e) => {
				const isDir = e.isDirectory();
				const p = `${directoryPart}${e.name}${isDir ? "/" : ""}`;
				return {
					path: p,
					name: e.name,
					kind: isDir ? ("directory" as const) : ("file" as const),
					score: 0,
				};
			});

		return rankFileCandidates(candidates, nameQuery, topK);
	} catch {
		return [];
	}
}

// 缓存全局深度扫描结果（10秒有效期），杜绝每次按键同步重遍历磁盘
const fileCandidateCache = {
	cwd: "",
	load: null as FileItem[] | null,
	timestamp: 0,
};

/**
 * 全局模糊搜索发现：采用 Round-Robin 轮询队列公平调度各个目录，杜绝巨型同级目录饿死其他模块
 */
export function listFilesDeepCandidates(root: string): FileItem[] {
	const now = Date.now();
	if (
		fileCandidateCache.cwd === root &&
		fileCandidateCache.load &&
		now - fileCandidateCache.timestamp < 10000
	) {
		return fileCandidateCache.load;
	}

	const out: FileItem[] = [];
	const SKIP = new Set([
		"node_modules",
		".git",
		".hg",
		".svn",
		".DS_Store",
		"dist",
		".next",
		"build",
		"coverage",
		".gemini",
		".system_generated",
		"tmp",
		".turbo",
	]);
	const BUILD_DIR = /^(?:build(?:[-_].*)?|cmake-build(?:[-_].*)?)$/i;

	type Entry = { name: string; isDir: boolean };
	type Node = { dir: string; prefix: string; entries?: Entry[]; index: number };

	const queue: Node[] = [{ dir: root, prefix: "", index: 0 }];
	const visited = new Set<string>();
	const maxFiles = 300;
	const maxDirectories = 100;
	let fileCount = 0;
	let dirCount = 0;

	// Round-robin: 每次访问一个目录只取 1 个未过滤的项，随后将其重新放回队尾，
	// 确保所有顶层与子目录能平权获得配额（dsh-TUI 核心工业契约）
	while (queue.length && (fileCount < maxFiles || dirCount < maxDirectories)) {
		const current = queue.shift()!;
		if (!current.entries) {
			try {
				const fullDir = current.dir;
				if (visited.has(fullDir)) continue;
				visited.add(fullDir);
				const rawEntries = fs.readdirSync(fullDir, { withFileTypes: true })
					.slice()
					.sort((a, b) => a.name.localeCompare(b.name));

				current.entries = rawEntries.map((e) => ({
					name: e.name,
					isDir: e.isDirectory(),
				}));
			} catch {
				continue;
			}
		}

		let entry: Entry | undefined;
		while (current.index < current.entries.length) {
			const candidate = current.entries[current.index++]!;
			if (SKIP.has(candidate.name) || BUILD_DIR.test(candidate.name)) continue;
			entry = candidate;
			break;
		}

		if (!entry) continue;
		if (current.index < current.entries.length) {
			queue.push(current);
		}

		const relPath = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
		if (entry.isDir) {
			if (dirCount < maxDirectories) {
				out.push({ path: `${relPath}/`, name: entry.name, kind: "directory", score: 0 });
				dirCount++;
				queue.push({ dir: path.join(current.dir, entry.name), prefix: relPath, index: 0 });
			}
		} else {
			if (fileCount < maxFiles) {
				out.push({ path: relPath, name: entry.name, kind: "file", score: 0 });
				fileCount++;
			}
		}
	}

	const result = out.sort((a, b) => a.path.localeCompare(b.path));
	fileCandidateCache.cwd = root;
	fileCandidateCache.load = result;
	fileCandidateCache.timestamp = now;
	return result;
}

/**
 * 统一文件候选获取入口（对标 dsh-TUI channel.listFileCandidates）
 */
export function getFileCandidates(cwd: string, query: string, topK = 50): FileItem[] {
	if (!query) {
		// 空查询（刚敲 @ 未输入字符）：只呈现当前根目录下的直接子项，绝不直接将深层子孙文件全量倾倒出来！
		return listPathCandidates(cwd, "", topK);
	}
	if (isPathLikeQuery(query)) {
		return listPathCandidates(cwd, query, topK);
	}
	const deep = listFilesDeepCandidates(cwd);
	return rankFileCandidates(deep, query, topK);
}

/** 兼容旧接口别名 */
export function scanDirectoryFiles(cwd: string): FileItem[] {
	return listFilesDeepCandidates(cwd);
}

export interface SuggestionRenderOptions {
	type: "command" | "file";
	title: string;
	query: string;
	columns: number;
	selectedIndex: number;
	items: Array<CommandItem | FileItem>;
	maxVisible?: number;
}

/**
 * 格式化渲染 SuggestionCard 圆角浮层行集合
 */
export function formatSuggestionCardLines(opts: SuggestionRenderOptions): string[] {
	const {
		type,
		title,
		query,
		columns,
		selectedIndex,
		items,
		maxVisible = 5,
	} = opts;

	if (items.length === 0) return [];

	const cardWidth = Math.max(30, columns);
	const usable = cardContentWidth(cardWidth);
	const borderCol = C.gray;

	// 1. 视口窗口计算
	const clampedIndex = Math.max(0, Math.min(selectedIndex, items.length - 1));
	const startIndex = Math.max(
		0,
		Math.min(clampedIndex - Math.floor(maxVisible / 2), items.length - maxVisible),
	);
	const visibleItems = items.slice(startIndex, startIndex + maxVisible);
	const above = startIndex;
	const below = items.length - (startIndex + visibleItems.length);

	// 2. 顶边框：╭─ 标题 · 共 N 项 ───────────────────────╮
	const fullTitle = `${title} · 共 ${items.length} 项`;
	const titleTag = `─ ${fullTitle} `;
	const topFillLen = Math.max(1, cardWidth - 2 - visibleWidth(titleTag));
	const topLine = `${borderCol}╭${titleTag}${"─".repeat(topFillLen)}╮${C.reset}`;

	const output: string[] = [topLine];

	// 3. 候选行渲染
	if (type === "command") {
		const commands = visibleItems as CommandItem[];
		const nameColWidth = Math.min(24, Math.max(12, Math.floor(usable * 0.38)));

		commands.forEach((cmd, idx) => {
			const isSelected = startIndex + idx === clampedIndex;
			const pointer = isSelected ? `${C.iceBlue}${C.bold}❯${C.reset} ` : "  ";
			const parts = splitQueryMatch(cmd.name, query);

			const padAfter = Math.max(0, nameColWidth - visibleWidth(cmd.name));
			let namePart = "";
			if (isSelected) {
				namePart = `${C.iceBlue}${C.bold}${cmd.name}${C.reset}${" ".repeat(padAfter)}`;
			} else if (parts) {
				namePart = `${C.dim}${parts.before}${C.cyan}${C.bold}${parts.match}${C.reset}${C.dim}${parts.after}${" ".repeat(padAfter)}${C.reset}`;
			} else {
				namePart = `${C.dim}${cmd.name}${" ".repeat(padAfter)}${C.reset}`;
			}

			const descBudget = Math.max(0, usable - 2 - nameColWidth - 2);
			const truncatedDesc = truncateToWidth(cmd.description, descBudget, "…");
			const descPart = isSelected
				? `${C.iceBlue}${truncatedDesc}${C.reset}`
				: `${C.dim}${truncatedDesc}${C.reset}`;

			const rowBody = `${pointer}${namePart}  ${descPart}`;
			const rowBodyWidth = visibleWidth(rowBody);
			const padLen = Math.max(0, usable - rowBodyWidth);

			output.push(`${borderCol}│${C.reset} ${rowBody}${" ".repeat(padLen)} ${borderCol}│${C.reset}`);
		});
	} else {
		const files = visibleItems as FileItem[];
		const pathColWidth = Math.min(36, Math.max(16, Math.floor(usable * 0.7)));

		files.forEach((file, idx) => {
			const isSelected = startIndex + idx === clampedIndex;
			const pointer = isSelected ? `${C.iceBlue}${C.bold}❯${C.reset} ` : "  ";
			const icon = file.kind === "directory" ? `${C.cyan}▸${C.reset} ` : `${C.gray}+${C.reset} `;
			const parts = splitQueryMatch(file.path, query);

			const padAfter = Math.max(0, pathColWidth - visibleWidth(file.path));
			let pathPart = "";
			if (isSelected) {
				pathPart = `${C.iceBlue}${C.bold}${file.path}${C.reset}${" ".repeat(padAfter)}`;
			} else if (parts) {
				pathPart = `${C.dim}${parts.before}${C.cyan}${C.bold}${parts.match}${C.reset}${C.dim}${parts.after}${" ".repeat(padAfter)}${C.reset}`;
			} else {
				pathPart = `${C.dim}${file.path}${" ".repeat(padAfter)}${C.reset}`;
			}

			const kindBudget = Math.max(0, usable - 2 - 2 - pathColWidth - 2);
			const kindStr = truncateToWidth(file.kind, kindBudget, "");
			const kindPart = isSelected
				? `${C.iceBlue}${kindStr}${C.reset}`
				: `${C.dim}${kindStr}${C.reset}`;

			const rowBody = `${pointer}${icon}${pathPart}  ${kindPart}`;
			const rowBodyWidth = visibleWidth(rowBody);
			const padLen = Math.max(0, usable - rowBodyWidth);

			output.push(`${borderCol}│${C.reset} ${rowBody}${" ".repeat(padLen)} ${borderCol}│${C.reset}`);
		});
	}

	// 4. 滚动提示行（仅当超出视口裁剪时显示）
	if (above > 0 || below > 0) {
		const hints: string[] = [];
		if (above > 0) hints.push(`↑${above}`);
		if (below > 0) hints.push(`↓${below}`);
		const footerText = `  ${hints.join(" · ")}`;
		const footerW = visibleWidth(footerText);
		const padLen = Math.max(0, usable - footerW);
		output.push(`${borderCol}│${C.reset} ${C.dim}${footerText}${C.reset}${" ".repeat(padLen)} ${borderCol}│${C.reset}`);
	}

	// 5. 底边框：╰────────────────────────────────────────╯
	const botFillLen = Math.max(1, cardWidth - 2);
	output.push(`${borderCol}╰${"─".repeat(botFillLen)}╯${C.reset}`);

	return output;
}
