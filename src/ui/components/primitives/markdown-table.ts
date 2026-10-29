/**
 * Markdown 原生表格渲染组件（复刻 dsh-TUI 与 Claude Code MarkdownTable 视觉与排版规范）。
 *
 * 核心特性：
 * 1. 语法完整性：单遍状态机扫描，严密支持转义竖线 `\|` 与代码块内竖线 `|`，支持 `<br>` 显式换行；
 * 2. 升序水位线调度算法（Water-Level Allocation）：数学上严格保证分配列宽和 <= budget，彻底消除算术下溢；
 * 3. 响应式布局：宽屏紧凑防大峡谷、窄屏短列锁定+长列弹性换行、极窄屏平滑降级为流线条目；
 * 4. 表现层高内聚：单元格自动应用行内 Markdown 语法高亮（代码、粗体、链接），边框 100% 全封闭永不残缺。
 */

import { C, stripAnsi, visibleWidth } from "../../core/utils.js";
import { fitLine, wrapLine } from "../../layout/fit.js";
import { formatInlineMarkdown } from "./inline-markdown.js";

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
	const parts = splitMarkdownCells(trimmed);
	return parts.length > 0 && parts.every((p) => /^:?-+:?$/.test(p));
}

/**
 * 解析 Markdown 表格单行文本中的单元格：
 * 1. 严格剥离首尾边界竖线；
 * 2. 状态机感知转义字符（如 \|）与行内代码反引号（如 `cat | grep`），不误伤单元格内竖线；
 * 3. 将转义的 \| 还原为字面字符 |，并修剪两端空白。
 */
export function splitMarkdownCells(row: string): string[] {
	const trimmed = row.trim();
	const body = trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length >= 2 ? trimmed.slice(1, -1) : trimmed;

	const cells: string[] = [];
	let current = "";
	let inBacktick = false;

	for (let i = 0; i < body.length; i++) {
		const char = body[i]!;

		// E1：只有「反斜杠+竖线」是转义（还原为字面 |）；Windows 路径里的反斜杠
		// 原样保留，不再被当作转义前缀吃掉。
		if (char === "\\" && body[i + 1] === "|") {
			current += "|";
			i++;
			continue;
		}

		if (char === "`") {
			inBacktick = !inBacktick;
			current += char;
			continue;
		}

		if (char === "|" && !inBacktick) {
			cells.push(current.trim());
			current = "";
			continue;
		}

		current += char;
	}

	cells.push(current.trim());
	return cells;
}

/**
 * 解析 Markdown 表格文本为结构化数据
 */
export function parseMarkdownTable(lines: string[]): ParsedTable | null {
	if (lines.length < 2) return null;
	const [rawHeader, rawSep, ...rawRows] = lines;
	if (!rawHeader || !rawSep || !isMarkdownTableSeparator(rawSep)) return null;

	const headers = splitMarkdownCells(rawHeader);
	if (headers.length === 0) return null;

	const sepParts = splitMarkdownCells(rawSep);
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
		const cells = splitMarkdownCells(rawRow);
		// 补齐或截断单元格以匹配表头列数
		while (cells.length < headers.length) {
			cells.push("");
		}
		rows.push(cells.slice(0, headers.length));
	}

	return { headers, alignments, rows };
}

/**
 * 对齐单元格文本（按要求宽度补齐空格；若因不可分割字符略微超宽，保底截断防爆网格）
 */
function alignCellText(text: string, width: number, align: ColumnAlign): string {
	const textW = visibleWidth(text);
	if (textW >= width) {
		return textW > width ? fitLine(text, width, "clip") : text;
	}
	const padTotal = width - textW;
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
 * 单元格渲染：支持 <br> 显式换行与行内 Markdown 格式化；
 * 文本在列宽内软换行（信息零丢失），返回物理行片段；
 * 每个片段已按 align 对齐并补齐到列宽。极窄列（<4）降级为截断。
 */
function renderCellFragments(text: string, w: number, align: ColumnAlign): string[] {
	if (w < 4) {
		const single = text.replace(/<br\s*\/?>/gi, " ");
		return [alignCellText(fitLine(single, w), w, align)];
	}
	const normalized = text.replace(/<br\s*\/?>/gi, "\n");
	const wrapped = wrapLine(normalized, w);
	return wrapped.map((frag) => alignCellText(frag, w, align));
}

/**
 * 求解各列响应式宽度（纯函数，经典升序水位线 Water-Level 调度算法）：
 * 1. 饱和态（空间充裕）：各列直接采用自然最大宽度，右侧自然留白，拒绝通栏大峡谷；
 * 2. 空间受限态（正常紧张）：每列保底 1 格，短列优先饱和并锁定，长列平滑均分剩余预算；
 * 3. 极限匮乏态（预算小于列数）：按序分发剩余格子，分完即止；
 * 4. 数学闭环保证：严格保证 sum(result) <= budget，且除法余数全额吸收，绝对杜绝任何预算溢出与下溢。
 */
export function solveColumnWidths(
	headers: readonly string[],
	rows: readonly (readonly string[])[],
	budget: number,
): number[] {
	const colCount = headers.length;
	if (colCount === 0 || budget <= 0) return new Array(colCount).fill(0);

	// 1. 统计每列自然最大可见宽（E10：按渲染后宽度测量，**bold** 等行内标记
	// 不再虚占列宽；SGR 零宽，剥掉后即渲染宽度）
	const renderedWidth = (text: string): number => visibleWidth(stripAnsi(formatInlineMarkdown(text)));
	const naturalWidths = headers.map((_h, c) => {
		let maxW = Math.max(1, renderedWidth(headers[c] ?? ""));
		for (const row of rows) {
			const cell = row[c] ?? "";
			// 若单元格含显式 <br>，自然宽度取折行后的单行最大宽
			const lines = cell.split(/<br\s*\/?>/i);
			for (const l of lines) {
				maxW = Math.max(maxW, renderedWidth(l));
			}
		}
		return maxW;
	});

	const naturalSum = naturalWidths.reduce((a, b) => a + b, 0);

	// 2. 空间充裕：直接使用自然宽度，保持最佳视觉紧凑感
	if (naturalSum <= budget) {
		return [...naturalWidths];
	}

	// 3. 空间极限匮乏：预算连每列 1 格都无法提供
	if (budget < colCount) {
		const result = new Array<number>(colCount).fill(0);
		for (let i = 0; i < budget; i++) {
			result[i] = 1;
		}
		return result;
	}

	// 4. 空间紧张：纯粹水位线算法（Water-Level Allocation）
	// 每列初始分配 1 格保底，剩余预算 strictly >= 0
	const cols = naturalWidths
		.map((w, index) => ({ index, natural: w, allocated: 1 }))
		.sort((a, b) => a.natural - b.natural);

	let remainingBudget = budget - colCount;
	let unfulfilledCount = cols.length;

	for (let i = 0; i < cols.length; i++) {
		const col = cols[i]!;
		const deficit = col.natural - col.allocated;
		if (deficit <= 0) {
			unfulfilledCount--;
			continue;
		}
		// 若当前列完整填平所需增量 <= 剩余未饱和列的人均公平增量，则直接满足该列
		const fairIncrement = Math.floor(remainingBudget / unfulfilledCount);
		if (deficit <= fairIncrement) {
			col.allocated += deficit;
			remainingBudget -= deficit;
			unfulfilledCount--;
		} else {
			// 当前列无法完全填平，说明水位线触顶；后续所有列均分剩余预算
			for (let j = i; j < cols.length; j++) {
				const share = Math.floor(remainingBudget / (cols.length - j));
				cols[j]!.allocated += share;
				remainingBudget -= share;
			}
			break;
		}
	}

	// 5. 按原始列索引还原
	const result = new Array<number>(colCount);
	for (const col of cols) {
		result[col.index] = col.allocated;
	}
	return result;
}

/** 极窄终端降级流线条目渲染器：字段名长文本与值均响应式软换行，从第一性排版上严格保证 <= safeW */
function renderStreamlinedEntries(table: ParsedTable, terminalWidth: number): string[] {
	const output: string[] = [];
	const bar = `${C.gray}│${C.reset}`;
	const safeW = Math.max(10, terminalWidth);

	for (let r = 0; r < table.rows.length; r++) {
		const row = table.rows[r]!;
		const badge = safeW >= 20 ? `[表格条目 #${r + 1}]` : `[#${r + 1}]`;
		output.push(`  ${bar} ${C.bold}${C.claude}${badge}${C.reset}`);

		for (let c = 0; c < table.headers.length; c++) {
			const rawHeader = table.headers[c] ?? "";
			const rawVal = row[c] ?? "";
			const header = formatInlineMarkdown(rawHeader);
			const val = formatInlineMarkdown(rawVal.replace(/<br\s*\/?>/gi, "\n"));

			const inlinePrefix = `  ${bar}   ${C.cyan}`;
			const inlineSuffix = `:${C.reset} `;
			const inlineLeadW = visibleWidth(inlinePrefix) + visibleWidth(rawHeader) + visibleWidth(inlineSuffix);

			// 若单行无法容纳表头和至少 4 字符的值，则表头单独成行，值悬挂缩进展示
			const shouldSplit = safeW - inlineLeadW < 4;

			if (shouldSplit) {
				const headerLead = `  ${bar}   ${C.cyan}`;
				const headerAvail = Math.max(1, safeW - visibleWidth(headerLead));
				const wrappedHeader = wrapLine(`${header}:`, headerAvail);
				for (const wh of wrappedHeader) {
					output.push(`${headerLead}${wh}${C.reset}`);
				}

				const valLead = `  ${bar}     `;
				const valAvail = Math.max(1, safeW - visibleWidth(valLead));
				const wrappedVal = wrapLine(val, valAvail);
				for (const wv of wrappedVal) {
					output.push(`${valLead}${wv}${C.reset}`);
				}
			} else {
				const lead = `${inlinePrefix}${header}${inlineSuffix}`;
				const valAvail = Math.max(1, safeW - inlineLeadW);
				const wrapped = wrapLine(val, valAvail);
				if (wrapped.length > 0) {
					output.push(`${lead}${wrapped[0]}${C.reset}`);
					const subLead = `  ${bar}${" ".repeat(Math.max(3, inlineLeadW - 3))}`;
					const subAvail = Math.max(1, safeW - visibleWidth(subLead));
					for (let i = 1; i < wrapped.length; i++) {
						const rewrapped = wrapLine(wrapped[i]!, subAvail);
						for (const rw of rewrapped) output.push(`${subLead}${rw}${C.reset}`);
					}
				} else {
					output.push(`${lead}${C.reset}`);
				}
			}
		}
		if (r < table.rows.length - 1) output.push(`  ${bar}`);
	}

	return output;
}

/** 模块级辅助函数：拼装多物理行片段，短列补同宽空格，保持列垂直对齐与右边框 100% 封闭 */
function appendRowFragments(
	output: string[],
	cells: readonly (readonly string[])[],
	colWidths: readonly number[],
	borderCol: string,
): void {
	const height = Math.max(1, ...cells.map((frags) => frags.length));
	for (let r = 0; r < height; r++) {
		const paddedCells = cells.map((frags, i) => {
			const frag = frags[r];
			if (frag !== undefined) return frag;
			const w = colWidths[i]!;
			return ` ${" ".repeat(w)} `;
		});
		output.push(`${borderCol}│${C.reset}${paddedCells.join(`${borderCol}│${C.reset}`)}${borderCol}│${C.reset}`);
	}
}

/** 物理全封闭网格装配器：顶边/分隔线/底边与数据行视觉列宽完全一致，右边框永不破损 */
function renderTableGrid(table: ParsedTable, colWidths: readonly number[]): string[] {
	const borderCol = C.gray;

	// 1. 构建边框行
	const topSegments = colWidths.map((w) => "─".repeat(w + 2));
	const topLine = `${borderCol}┌${topSegments.join("┬")}┐${C.reset}`;
	const midLine = `${borderCol}├${topSegments.join("┼")}┤${C.reset}`;
	const botLine = `${borderCol}└${topSegments.join("┴")}┘${C.reset}`;

	const output: string[] = [topLine];

	// 2. 表头（带 ANSI 青色加粗与行内样式）
	const headerFragments = table.headers.map((h, i) => {
		const w = colWidths[i]!;
		const align = table.alignments[i] ?? "left";
		const formatted = formatInlineMarkdown(h);
		return renderCellFragments(formatted, w, align).map((frag) => ` ${C.bold}${C.cyan}${frag}${C.reset} `);
	});
	appendRowFragments(output, headerFragments, colWidths, borderCol);
	output.push(midLine);

	// 3. 数据行（带行内格式化高亮）
	for (const row of table.rows) {
		const rowFragments = row.map((val, i) => {
			const w = colWidths[i]!;
			const align = table.alignments[i] ?? "left";
			const formatted = formatInlineMarkdown(val);
			return renderCellFragments(formatted, w, align).map((frag) => ` ${frag}${C.reset} `);
		});
		appendRowFragments(output, rowFragments, colWidths, borderCol);
	}

	output.push(botLine);
	return output;
}

/**
 * 渲染 Markdown 表格为终端行
 */
export function formatMarkdownTableLines(table: ParsedTable, terminalWidth = 80): string[] {
	const colCount = table.headers.length;
	if (colCount === 0) return [];

	// 边框所占列数：精确等于 3 * colCount + 1
	const borderSlack = 3 * colCount + 1;
	const safeTerminalW = Math.max(10, terminalWidth);
	const contentBudget = safeTerminalW - borderSlack;

	// 物理守卫：若平均每列内容预算不足 4 格（无法体面容纳词汇），平滑降级为垂直流线条目
	if (contentBudget < colCount * 4) {
		return renderStreamlinedEntries(table, safeTerminalW);
	}

	const colWidths = solveColumnWidths(table.headers, table.rows, contentBudget);
	return renderTableGrid(table, colWidths);
}
