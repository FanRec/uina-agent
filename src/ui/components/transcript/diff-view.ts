/**
 * Git Unified Diff 差异对比视图卡片（复刻 dsh-TUI / Git Diff 标准）。
 * 特性：
 * 1. 纯净自主实现 LCS 逐行差异比对（零外部重型依赖）；
 * 2. 红色 `-` 行代表删除行，绿色 `+` 行代表添加行，灰色 ` ` 行代表上下文；
 * 3. 四周全封闭细线盒子，右边框与角标像素级对齐；
 * 4. 默认 5 行折叠保护，统计徽章 `+N / -M` 与展开提示。
 */

import { C, visibleWidth, truncateToWidth, getContentBoxWidth } from "../../core/utils.js";

export interface DiffItem {
	type: "add" | "del" | "same";
	line: string;
}

export interface DiffResult {
	items: DiffItem[];
	addCount: number;
	delCount: number;
}

/**
 * 基于 LCS 最长公共子序列计算纯文本逐行差异
 */
export function computeLineDiff(oldText: string, newText: string): DiffResult {
	const a = oldText ? oldText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n") : [];
	const b = newText ? newText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n") : [];

	const n = a.length;
	const m = b.length;

	// 动态规划构建 LCS 长度表（限制最大矩阵大小，防止超大文件耗尽内存）
	const MAX_DIFF_LINES = 1000;
	const safeN = Math.min(n, MAX_DIFF_LINES);
	const safeM = Math.min(m, MAX_DIFF_LINES);

	const dp: number[][] = Array.from({ length: safeN + 1 }, () => new Array<number>(safeM + 1).fill(0));

	for (let i = 1; i <= safeN; i++) {
		for (let j = 1; j <= safeM; j++) {
			if (a[i - 1] === b[j - 1]) {
				dp[i]![j] = dp[i - 1]![j - 1]! + 1;
			} else {
				dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
			}
		}
	}

	// 回溯还原 diff
	const items: DiffItem[] = [];
	let i = safeN;
	let j = safeM;
	let addCount = 0;
	let delCount = 0;

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
			items.push({ type: "same", line: a[i - 1]! });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
			items.push({ type: "add", line: b[j - 1]! });
			addCount++;
			j--;
		} else if (i > 0 && (j === 0 || dp[i]![j - 1]! < dp[i - 1]![j]!)) {
			items.push({ type: "del", line: a[i - 1]! });
			delCount++;
			i--;
		}
	}

	items.reverse();
	return { items, addCount, delCount };
}

/**
 * 格式化渲染 Unified Diff 封闭细线卡片
 */
export function formatUnifiedDiffCardLines(
	oldText: string,
	newText: string,
	filename: string,
	collapsed = true,
	width = 80,
): string[] {
	const boxWidth = getContentBoxWidth(width - 4);
	const innerW = boxWidth - 4; // 减去两端 "│ " (2) 与 " │" (2)

	const diff = computeLineDiff(oldText, newText);
	const totalItems = diff.items.length;
	const DIFF_BODY_MAX_LINES = 8; // 对标 dsh-TUI 的 DIFF_BODY_MAX_LINES = 8
	const isFolded = collapsed && totalItems > DIFF_BODY_MAX_LINES;
	const visibleSlice = isFolded ? diff.items.slice(0, DIFF_BODY_MAX_LINES) : diff.items;
	const hiddenCount = totalItems - visibleSlice.length;

	// 1. 顶边框：┌─ 📄 ${filename} (diff) ───────────────────────┐
	const headerTag = `┌─ 📄 ${filename} (diff) `;
	const topTagW = visibleWidth(headerTag);
	const topFillLen = Math.max(1, boxWidth - topTagW - 1);
	const topLine = `  ${C.gray}${headerTag}${"─".repeat(topFillLen)}┐${C.reset}`;

	const output: string[] = [topLine];

	// 2. 差异行渲染
	for (const item of visibleSlice) {
		let prefix = "  ";
		let color = C.dim;
		if (item.type === "add") {
			prefix = "+ ";
			color = C.green;
		} else if (item.type === "del") {
			prefix = "- ";
			color = C.red;
		}

		const cleanText = item.line.replace(/\r$/, "");
		const budget = Math.max(0, innerW - 2); // 减去 "+ "
		const truncated = truncateToWidth(cleanText, budget, "…");
		const contentW = 2 + visibleWidth(truncated);
		const pad = Math.max(0, innerW - contentW);

		const lineBody = `${color}${prefix}${truncated}${C.reset}`;
		output.push(`  ${C.gray}│${C.reset} ${lineBody}${" ".repeat(pad)} ${C.gray}│${C.reset}`);
	}

	// 3. 超出折叠提示行
	if (isFolded && hiddenCount > 0) {
		const hintText = `${C.gray}... (还有 ${hiddenCount} 行变更 · 按 Ctrl+O 展开)${C.reset}`;
		const hintW = visibleWidth(hintText);
		const pad = Math.max(0, innerW - hintW);
		output.push(`  ${C.gray}│${C.reset} ${hintText}${" ".repeat(pad)} ${C.gray}│${C.reset}`);
	}

	// 4. 底边框：└──────────────────────────── +N / -M ──┘
	const statsBadge = `${C.green}+${diff.addCount}${C.reset} / ${C.red}-${diff.delCount}${C.reset}${isFolded ? ` ${C.dim}(已折叠)${C.reset}` : ""}`;
	const badgeW = visibleWidth(statsBadge);
	// 1 (└) + botFillLen + 1 ( ) + badgeW + 1 ( ) + 2 (──) + 1 (┘) = botFillLen + badgeW + 6
	const botFillLen = Math.max(1, boxWidth - badgeW - 6);
	const botLine = `  ${C.gray}└${"─".repeat(botFillLen)} ${statsBadge}${C.gray} ──┘${C.reset}`;
	output.push(botLine);

	return output;
}
