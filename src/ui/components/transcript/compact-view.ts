/**
 * 会话压缩摘要卡片组件（对齐 dsh-TUI ∴ 会话压缩视觉与全域交互规范）。
 * 特性：
 * 1. 经典通透双分割线 ─── 会话已压缩 ─── 夹心排版，融入微光雾蓝调色板；
 * 2. 经典 ∴ 符号标识，折叠态紧凑单行预览，展开态结构化舒展；
 * 3. 统计展示归档轮次与释放的 Token 数量；
 * 4. 支持鼠标 Hover 高亮底色与全域点击展开/收起；
 * 5. 支持 /compact 指令与快捷键实时展开/收起。
 */

import { C, visibleWidth, truncateToWidth, wrapTextWithAnsi } from "../../core/utils.js";

export interface CompactionRecord {
	summary: string;
	turnsCount: number;
	tokensSaved: number;
	collapsed: boolean;
}

function applyCardBackground(line: string, bg: string, width: number): string {
	const curW = visibleWidth(line);
	const effLine = curW > width ? truncateToWidth(line, width, "…") : line;
	const effW = curW > width ? visibleWidth(effLine) : curW;
	const padLen = Math.max(0, width - effW);
	const padding = " ".repeat(padLen);

	const patched = effLine
		.replace(/\x1b\[0?m/g, `\x1b[0m${bg}`)
		.replace(/\x1b\[49m/g, bg);

	return `${bg}${patched}${padding}${C.reset}`;
}

/**
 * 格式化渲染会话压缩卡片行
 */
export function formatCompactionCardLines(
	record: CompactionRecord,
	width = 80,
	isHovered = false,
): string[] {
	const boxW = Math.max(20, width);
	const tokenSavedStr =
		record.tokensSaved >= 1000
			? `${(record.tokensSaved / 1000).toFixed(1)}k`
			: `${record.tokensSaved}`;

	if (record.collapsed) {
		// 1. 顶部分割线：─── 会话已压缩 ─────────────────────────────
		const leftDashes = "───";
		const title = " 会话已压缩 ";
		const leftW = visibleWidth(leftDashes);
		const titleW = visibleWidth(title);
		const rightDashCount = Math.max(3, boxW - leftW - titleW);
		const topLine = `${C.subtle}${leftDashes}${C.inactive}${title}${C.subtle}${"─".repeat(rightDashCount)}${C.reset}`;

		// 2. 中间折叠行：  ∴ 摘要已折叠 · <preview> (ctrl+o / 点击展开)
		const symbolCol = isHovered ? C.suggestion : C.inactive;
		const symbol = `${symbolCol}∴${C.reset}`;
		const label = `${C.inactive}摘要已折叠 · ${C.reset}`;
		const hint = isHovered
			? `${C.suggestion}(点击 / ctrl+o 展开)${C.reset}`
			: `${C.inactive}(ctrl+o / 点击展开)${C.reset}`;

		const flat = record.summary.replace(/\s+/g, " ").trim();
		const prefixW = 2 + 1 + 1 + visibleWidth("摘要已折叠 · ");
		const hintW = visibleWidth(hint) + 1;
		const budget = Math.max(8, boxW - prefixW - hintW);
		const preview = truncateToWidth(flat, budget, "…");
		const previewCol = isHovered ? C.text : C.inactiveShimmer;
		const rawLine = `  ${symbol} ${label}${previewCol}${preview}${C.reset} ${hint}`;

		let middleLine: string;
		if (isHovered) {
			middleLine = applyCardBackground(rawLine, C.toolCardBackground, boxW);
		} else {
			const padLen = Math.max(0, boxW - visibleWidth(rawLine));
			middleLine = `${rawLine}${" ".repeat(padLen)}`;
		}

		// 3. 底部分割线：────────────────────────────────────────
		const botLine = `${C.subtle}${"─".repeat(boxW)}${C.reset}`;

		return [topLine, middleLine, botLine];
	}

	// 展开态：展示完整摘要与统计
	const leftDashes = "───";
	let title = ` 会话已压缩 · 完整摘要 (已归档 ${record.turnsCount} 轮) `;
	if (visibleWidth(leftDashes) + visibleWidth(title) + 3 > boxW) {
		title = ` 会话已压缩 · 完整摘要 `;
	}
	if (visibleWidth(leftDashes) + visibleWidth(title) + 3 > boxW) {
		title = ` 会话已压缩 `;
	}
	if (visibleWidth(leftDashes) + visibleWidth(title) + 3 > boxW) {
		title = "";
	}
	const leftW = visibleWidth(leftDashes);
	const titleW = visibleWidth(title);
	const rightDashCount = Math.max(3, boxW - leftW - titleW);
	const topLine = `${C.subtle}${leftDashes}${C.inactive}${title}${C.subtle}${"─".repeat(rightDashCount)}${C.reset}`;

	const output: string[] = [topLine];

	// 正文自动折行与缩进
	const innerW = Math.max(10, boxW - 4);
	const summaryLines = wrapTextWithAnsi(record.summary.trim(), innerW);
	for (const line of summaryLines) {
		const lineContent = `  ${line}`;
		const effContent = visibleWidth(lineContent) > boxW ? truncateToWidth(lineContent, boxW, "…") : lineContent;
		const padLen = Math.max(0, boxW - visibleWidth(effContent));
		output.push(`${C.text}${effContent}${" ".repeat(padLen)}${C.reset}`);
	}

	// 底部统计与展开提示行
	const arrowCol = isHovered ? C.suggestion : C.claude;
	const arrow = `${arrowCol}↳${C.reset}`;
	// tokensSaved carries the pre-compaction context size, not a delta: label it
	// as the measured-before value instead of claiming released tokens.
	const stats = `${C.success}压缩前 ~${tokenSavedStr} tokens${C.reset} · ${C.inactive}保留最近 ${record.turnsCount} 轮对话${C.reset}`;
	const hint = isHovered
		? `${C.suggestion}(点击 / ctrl+o 收起)${C.reset}`
		: `${C.inactive}(ctrl+o / 点击收起)${C.reset}`;
	const footerRaw = `  ${arrow} ${stats} · ${hint}`;
	const effFooter = visibleWidth(footerRaw) > boxW ? truncateToWidth(footerRaw, boxW, "…") : footerRaw;
	const footerPad = Math.max(0, boxW - visibleWidth(effFooter));
	output.push(`${effFooter}${" ".repeat(footerPad)}`);

	// 底部分割线
	const botLine = `${C.subtle}${"─".repeat(boxW)}${C.reset}`;
	output.push(botLine);

	return output;
}
