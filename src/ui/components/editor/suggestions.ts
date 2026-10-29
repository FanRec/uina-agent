/**
 * 输入联想浮层组件（复刻 dsh-TUI / Claude Code SuggestionCard 视觉与交互规范）。
 * 支持：
 * 1. `/` 斜杠命令联想（带描述与前缀提亮）；
 * 2. `@` 文件路径模糊联想（带图标、文件类型与子序列模糊打分）；
 * 3. 5 行视口自适应截断，包含 `↑N · ↓M` 越界提示；
 * 4. 左右与顶底细线圆角闭合，像素级列宽对齐。
 */

import { C, visibleWidth } from "../../core/utils.js";
import { fitLine } from "../../layout/fit.js";
import type { FileItem } from "./file-candidates.js";

export interface CommandItem {
	name: string;
	description: string;
	tag?: string;
	hasArgs?: boolean;
}

/** 可用内容宽度：总宽减去外框两端 `│ ` (2) 与 ` │` (2) */
export function cardContentWidth(columns: number): number {
	return Math.max(0, columns - 4);
}

/**
 * 把候选名按命中的查询前缀拆为三段（用于前缀高亮）：
 * 优先检查整名前缀、最后一个空格后前缀、最后一个 / 后前缀（与 dsh-TUI 完全一致）。
 */
export function splitQueryMatch(name: string, query: string): { before: string; match: string; after: string } | null {
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

export interface SuggestionRenderOptions {
	type: "command" | "file";
	title: string;
	query: string;
	columns: number;
	selectedIndex: number;
	items: Array<CommandItem | FileItem>;
	loading?: boolean;
	maxVisible?: number;
}

/**
 * 格式化渲染 SuggestionCard 圆角浮层行集合
 */
export function formatSuggestionCardLines(opts: SuggestionRenderOptions): string[] {
	const { type, title, query, columns, selectedIndex, items, loading = false, maxVisible = 5 } = opts;

	if (items.length === 0 && !loading) return [];

	// 卡片不超终端宽（审计 D2）：窄终端下收缩内容列而不是溢出
	const cardWidth = Math.max(1, columns);
	const usable = cardContentWidth(cardWidth);
	const borderCol = C.gray;

	// 1. 视口窗口计算
	// 2. 顶边框：╭─ 标题 · 共 N 项 ───────────────────────╮
	const fullTitle = loading ? `${title} · 扫描中` : `${title} · 共 ${items.length} 项`;
	const titleTag = `─ ${fullTitle} `;
	const topFillLen = Math.max(1, cardWidth - 2 - visibleWidth(titleTag));
	const topLine = `${borderCol}╭${titleTag}${"─".repeat(topFillLen)}╮${C.reset}`;

	const output: string[] = [topLine];
	if (loading) {
		const label = fitLine("  正在扫描文件…", usable);
		const rowBody = `${C.dim}${label}${C.reset}`;
		output.push(
			`${borderCol}│${C.reset} ${rowBody}${" ".repeat(Math.max(0, usable - visibleWidth(rowBody)))} ${borderCol}│${C.reset}`,
		);
		const botFillLen = Math.max(1, cardWidth - 2);
		output.push(`${borderCol}╰${"─".repeat(botFillLen)}╯${C.reset}`);
		return output;
	}

	const clampedIndex = Math.max(0, Math.min(selectedIndex, items.length - 1));
	const startIndex = Math.max(0, Math.min(clampedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
	const visibleItems = items.slice(startIndex, startIndex + maxVisible);
	const above = startIndex;
	const below = items.length - (startIndex + visibleItems.length);

	// 3. 候选行渲染
	if (type === "command") {
		const commands = visibleItems as CommandItem[];
		const nameColWidth = Math.min(24, Math.max(12, Math.floor(usable * 0.38)));

		commands.forEach((cmd, idx) => {
			const isSelected = startIndex + idx === clampedIndex;
			const pointer = isSelected ? `${C.suggestion}${C.bold}❯${C.reset} ` : "  ";
			// 名称也必须受列宽约束（D1）：超长命令名不再把卡片撑破
			const shownName = fitLine(cmd.name, nameColWidth);
			const parts = splitQueryMatch(shownName, query);

			const padAfter = Math.max(0, nameColWidth - visibleWidth(shownName));
			let namePart = "";
			if (isSelected) {
				namePart = `${C.suggestion}${C.bold}${shownName}${C.reset}${" ".repeat(padAfter)}`;
			} else if (parts) {
				namePart = `${C.dim}${parts.before}${C.cyan}${C.bold}${parts.match}${C.reset}${C.dim}${parts.after}${" ".repeat(padAfter)}${C.reset}`;
			} else {
				namePart = `${C.dim}${shownName}${" ".repeat(padAfter)}${C.reset}`;
			}

			const descBudget = Math.max(0, usable - 2 - nameColWidth - 2);
			const truncatedDesc = fitLine(cmd.description, descBudget);
			const descPart = isSelected ? `${C.suggestion}${truncatedDesc}${C.reset}` : `${C.dim}${truncatedDesc}${C.reset}`;

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
			const pointer = isSelected ? `${C.suggestion}${C.bold}❯${C.reset} ` : "  ";
			const icon = file.kind === "directory" ? `${C.cyan}▸${C.reset} ` : `${C.gray}+${C.reset} `;
			// 路径同样受列宽约束（D1）：超长路径截断，不再撑破边框
			const shownPath = fitLine(file.path, pathColWidth);
			const parts = splitQueryMatch(shownPath, query);

			const padAfter = Math.max(0, pathColWidth - visibleWidth(shownPath));
			let pathPart = "";
			if (isSelected) {
				pathPart = `${C.suggestion}${C.bold}${shownPath}${C.reset}${" ".repeat(padAfter)}`;
			} else if (parts) {
				pathPart = `${C.dim}${parts.before}${C.cyan}${C.bold}${parts.match}${C.reset}${C.dim}${parts.after}${" ".repeat(padAfter)}${C.reset}`;
			} else {
				pathPart = `${C.dim}${shownPath}${" ".repeat(padAfter)}${C.reset}`;
			}

			const kindBudget = Math.max(0, usable - 2 - 2 - pathColWidth - 2);
			const kindStr = fitLine(file.kind, kindBudget, "clip");
			const kindPart = isSelected ? `${C.suggestion}${kindStr}${C.reset}` : `${C.dim}${kindStr}${C.reset}`;

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
