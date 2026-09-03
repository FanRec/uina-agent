/**
 * 会话压缩摘要卡片组件（复刻 dsh-TUI ∴ 会话压缩视觉与交互规范）。
 * 特性：
 * 1. 经典 ∴ 符号标识，支持折叠摘要预览与展开完整上下文总结；
 * 2. 细线圆角全封闭几何盒子，像素级对齐；
 * 3. 统计展示归档轮次与释放的 Token 数量；
 * 4. 支持 /compact 指令与快捷键实时展开/收起。
 */

import { C, visibleWidth, truncateToWidth, wrapTextWithAnsi, getContentBoxWidth } from "../../core/utils.js";

export interface CompactionRecord {
	id: number;
	summary: string;
	turnsCount: number;
	tokensSaved: number;
	collapsed: boolean;
	timestamp: number;
	afterTurnN?: number;
}

/**
 * 格式化渲染会话压缩卡片行
 */
export function formatCompactionCardLines(
	record: CompactionRecord,
	width = 80,
): string[] {
	const boxWidth = getContentBoxWidth(width - 4);
	const innerW = boxWidth - 4; // 减去两端 "│ " 与 " │"
	const borderCol = C.gray;

	const tokenSavedStr =
		record.tokensSaved >= 1000
			? `${(record.tokensSaved / 1000).toFixed(1)}k`
			: `${record.tokensSaved}`;

	if (record.collapsed) {
		// 1. 折叠态：紧凑 3 行圆角盒子
		// 顶边：╭─ ∴ 会话已压缩 · 归档 N 轮对话 ────────────────────╮
		const titleTag = `─ ∴ 会话已压缩 · 归档 ${record.turnsCount} 轮对话 `;
		const topFillLen = Math.max(1, boxWidth - 2 - visibleWidth(titleTag));
		const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(topFillLen)}╮${C.reset}`;

		// 中间摘要预览行
		const flat = record.summary.replace(/\s+/g, " ").trim();
		const previewBudget = Math.max(10, innerW - 8); // 减去 "摘要: "
		const previewText = truncateToWidth(flat, previewBudget, "…");
		const bodyText = `${C.cyan}摘要:${C.reset} ${C.dim}${previewText}${C.reset}`;
		const padLen = Math.max(0, innerW - visibleWidth(bodyText));
		const middleLine = `  ${borderCol}│${C.reset} ${bodyText}${" ".repeat(padLen)} ${borderCol}│${C.reset}`;

		// 底边：╰────────────────────── 释放 ~18.5k tokens · Ctrl+O ──╯
		const statsBadge = `${C.green}释放 ~${tokenSavedStr} tokens${C.reset} · ${C.dim}Ctrl+O 展开${C.reset}`;
		const badgeW = visibleWidth(statsBadge);
		// 1 (╰) + botFillLen + 1 ( ) + badgeW + 1 ( ) + 2 (──) + 1 (╯) = botFillLen + badgeW + 6
		const botFillLen = Math.max(1, boxWidth - badgeW - 6);
		const botLine = `  ${borderCol}╰${"─".repeat(botFillLen)} ${statsBadge}${borderCol} ──╯${C.reset}`;

		return [topLine, middleLine, botLine];
	}

	// 2. 展开态：展示完整摘要
	const titleTag = `─ ∴ 会话已压缩 · 完整摘要 (已归档 ${record.turnsCount} 轮) `;
	const topFillLen = Math.max(1, boxWidth - 2 - visibleWidth(titleTag));
	const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(topFillLen)}╮${C.reset}`;

	const output: string[] = [topLine];

	// 正文自动折行
	const summaryLines = wrapTextWithAnsi(record.summary, innerW);
	for (const line of summaryLines) {
		const padLen = Math.max(0, innerW - visibleWidth(line));
		output.push(`  ${borderCol}│${C.reset} ${C.dim}${line}${C.reset}${" ".repeat(padLen)} ${borderCol}│${C.reset}`);
	}

	// 底边
	const statsBadge = `${C.green}已节省 ~${tokenSavedStr} tokens${C.reset} · ${C.dim}Ctrl+O 收起${C.reset}`;
	const badgeW = visibleWidth(statsBadge);
	const botFillLen = Math.max(1, boxWidth - badgeW - 6);
	const botLine = `  ${borderCol}╰${"─".repeat(botFillLen)} ${statsBadge}${borderCol} ──╯${C.reset}`;
	output.push(botLine);

	return output;
}
