/**
 * Markdown 原生表格渲染组件（复刻 dsh-TUI 与 Claude Code MarkdownTable 视觉与排版规范）。
 */

import { C, visibleWidth, truncateToWidth, getContentBoxWidth, wrapTextWithAnsi } from "../../core/utils.js";

export type ColumnAlign = "left" | "center" | "right";

export interface ParsedTable {
	headers: string[];
	alignments: ColumnAlign[];
	rows: string[][];
}

/**
 * 探测一行是否可能是 Markdown 表格行
 */
export function isMarkdownTableLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length >= 3;
}

/**
 * 探测一行是否是表格分隔符行（如 |---|:---:|---:|）
 */
export function isMarkdownTableSeparator(line: string): boolean {
	const trimmed = line.trim();
	if (!isMarkdownTableLine(trimmed)) return false;
	const parts = trimmed
		.slice(1, -1)
		.split("|")
		.map((p) => p.trim());
	return (
		parts.length > 0 &&
		parts.every((p) => /^:?-+:?$/.test(p))
	);
}

/**
 * 解析 Markdown 表格文本为结构化数据
 */
export function parseMarkdownTable(lines: string[]): ParsedTable | null {
	if (lines.length < 2) return null;
	const [rawHeader, rawSep, ...rawRows] = lines;
	if (!rawHeader || !rawSep || !isMarkdownTableSeparator(rawSep)) return null;

	const splitRow = (row: string): string[] =>
		row
			.trim()
			.slice(1, -1)
			.split("|")
			.map((c) => c.trim());

	const headers = splitRow(rawHeader);
	if (headers.length === 0) return null;

	const sepParts = splitRow(rawSep);
	const alignments: ColumnAlign[] = headers.map((_, i) => {
		const s = sepParts[i] || "---";
		const left = s.startsWith(":");
		const right = s.endsWith(":");
		if (left && right) return "center";
		if (right) return "right";
		return "left";
	});

	const rows: string[][] = [];
	for (const rawRow of rawRows) {
		if (!isMarkdownTableLine(rawRow)) continue;
		const cells = splitRow(rawRow);
		// 补齐缺失单元格
		while (cells.length < headers.length) {
			cells.push("");
		}
		rows.push(cells.slice(0, headers.length));
	}

	return { headers, alignments, rows };
}

/**
 * 对齐单元格文本
 */
function alignCellText(text: string, width: number, align: ColumnAlign): string {
	const textW = visibleWidth(text);
	const padTotal = Math.max(0, width - textW);
	if (align === "right") {
		return " ".repeat(padTotal) + text;
	}
	if (align === "center") {
		const padLeft = Math.floor(padTotal / 2);
		const padRight = padTotal - padLeft;
		return " ".repeat(padLeft) + text + " ".repeat(padRight);
	}
	return text + " ".repeat(padTotal);
}

/**
 * 单元格渲染：文本在列宽内软换行（信息零丢失），返回物理行片段；
 * 每个片段已按 align 对齐并补齐到列宽。极窄列（<4）降级为截断。
 */
function renderCellFragments(text: string, w: number, align: ColumnAlign): string[] {
	if (w < 4) {
		// 极窄列无法换行（每行只搾下 3 字符），降级为截断保可读性
		return [alignCellText(truncateToWidth(text, w, "…"), w, align)];
	}
	const wrapped = wrapTextWithAnsi(text, w);
	return wrapped.map((frag) => alignCellText(frag, w, align));
}

/**
 * 渲染 Markdown 表格为终端行
 */
export function formatMarkdownTableLines(table: ParsedTable, terminalWidth = 80): string[] {
	const colCount = table.headers.length;
	if (colCount === 0) return [];

	// 边框所占列数：两端 "│ " (2) 与 " │" (2) + 中间分割 " │ " (3 * (colCount - 1))
	const borderSlack = 4 + 3 * (colCount - 1);
	const contentBudget = terminalWidth - borderSlack - 4;

	// 极窄屏幕降级：若平均每列预算不足 6 列，采用垂直 Key-Value 模式
	if (contentBudget < colCount * 6) {
		const kvOutput: string[] = [];
		for (let r = 0; r < table.rows.length; r++) {
			const row = table.rows[r]!;
			kvOutput.push(`${C.gray}┌─ 表格条目 #${r + 1} ──────────────────┐${C.reset}`);
			for (let c = 0; c < colCount; c++) {
				const header = table.headers[c] ?? "";
				const val = row[c] ?? "";
				const line = `${C.gray}│${C.reset} ${C.cyan}${header}:${C.reset} ${val}`;
				kvOutput.push(line);
			}
			kvOutput.push(`${C.gray}└────────────────────────────────────┘${C.reset}`);
		}
		return kvOutput;
	}

	const boxWidth = getContentBoxWidth(terminalWidth - 6, 4);
	const actualBudget = boxWidth - borderSlack;
	const borderCol = C.gray;

	// 1. 计算各列内容的最大宽度
	const naturalColWidths: number[] = new Array(colCount).fill(3);
	for (let c = 0; c < colCount; c++) {
		const hW = visibleWidth(table.headers[c] ?? "");
		naturalColWidths[c] = Math.max(naturalColWidths[c]!, hW);
		for (const row of table.rows) {
			const cellW = visibleWidth(row[c] ?? "");
			naturalColWidths[c] = Math.max(naturalColWidths[c]!, cellW);
		}
	}

	// 2. 按比例收缩或扩展列宽（下限 8：保证最短的可读列；总预算不够时才回退纯比例）
	const naturalSum = naturalColWidths.reduce((a, b) => a + b, 0);
	const MIN_COL = 8;
	const colWidths = naturalColWidths.map((w) => {
		if (naturalSum <= actualBudget) {
			return w;
		}
		const squeezed = Math.floor((w / naturalSum) * actualBudget);
		if (colCount * MIN_COL <= actualBudget) {
			return Math.max(MIN_COL, squeezed);
		}
		return Math.max(3, squeezed); // 列数过多：仍回退比例压缩，交给极窄降级
	});

	// 3. 构建边框行
	// 顶边：┌──────┬──────┐
	const topSegments = colWidths.map((w) => "─".repeat(w + 2));
	const topLine = `${borderCol}┌${topSegments.join("┬")}┐${C.reset}`;

	// 分隔线：├──────┼──────┤
	const midLine = `${borderCol}├${topSegments.join("┼")}┤${C.reset}`;

	// 底边：└──────┴──────┘
	const botLine = `${borderCol}└${topSegments.join("┴")}┘${C.reset}`;

	const output: string[] = [topLine];

	// 表头
	const headerFragments = table.headers.map((h, i) => {
		const w = colWidths[i]!;
		const align = table.alignments[i] ?? "left";
		return renderCellFragments(h, w, align).map((frag) => ` ${C.bold}${C.cyan}${frag}${C.reset} `);
	});
	emitRowFragments(headerFragments);
	output.push(midLine);

	// 数据行
	for (const row of table.rows) {
		const rowFragments = row.map((val, i) => {
			const w = colWidths[i]!;
			const align = table.alignments[i] ?? "left";
			return renderCellFragments(val, w, align).map((frag) => ` ${frag} `);
		});
		emitRowFragments(rowFragments);
	}

	output.push(botLine);
	return output;

	/** 多物理行行片段组装：短列补空行，各列片段垂直堆叠进边框 */
	function emitRowFragments(cells: string[][]): void {
		const height = Math.max(1, ...cells.map((frags) => frags.length));
		for (let r = 0; r < height; r++) {
			// 空缺物理行用同宽空格占位，保持列边界连续
			const paddedCells = cells.map((frags, i) => {
				const frag = frags[r];
				if (frag !== undefined) return frag;
				const w = colWidths[i]!;
				return ` ${" ".repeat(w)} `;
			});
			output.push(`${borderCol}│${C.reset}${paddedCells.join(`${borderCol}│${C.reset}`)}${borderCol}│${C.reset}`);
		}
	}
}
