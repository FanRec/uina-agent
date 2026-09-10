/**
 * Git Diff 差异对比视图卡片（复刻 dsh-TUI SplitDiffView 与 Git Diff 规范）。
 *
 * 特性：
 * 1. 双栏并排差异对比 (Split Diff)：
 *    - 终端宽度 >= 80 时自动启用双栏并排视图；
 *    - 左栏 Old Pane（删除/改前，红底暗色，标记 −），右栏 New Pane（新增/改后，绿底暗色，标记 +）；
 *    - 中间垂直分隔线 │ 对齐；
 *    - 提取公共前导缩进，并进行行内词级（Word-level）增删高亮；
 * 2. 窄屏自适应平滑降级：
 *    - 终端宽度 < 80 时，自动降级为单栏 Unified Diff，防止内容被极度压缩挤压；
 * 3. 纯自主实现的 LCS 逐行与逐词比对算法（零外部黑盒重型依赖）；
 * 4. 全封闭细线卡片，8 行折叠保护与展开提示。
 */

import { C, visibleWidth, truncateToWidth, getContentBoxWidth } from "../../core/utils.js";
import { sanitizeRenderText } from "../../format.js";

export interface DiffItem {
	type: "add" | "del" | "same";
	line: string;
}

export interface DiffResult {
	items: DiffItem[];
	addCount: number;
	delCount: number;
}

export interface SplitDiffRow {
	kind: "same" | "del" | "add" | "change";
	oldLine?: string;
	newLine?: string;
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
 * 单词级分词（保留空格和标点符号作为独立单元）
 */
function tokenizeWords(str: string): string[] {
	return str.match(/\w+|\s+|[^\w\s]+/g) ?? (str ? [str] : []);
}

/**
 * 行内词级差异高亮比对（提取公共缩进，使用 LCS 标记差异词）
 */
export function computeWordDiff(
	oldLine: string,
	newLine: string,
): { oldFormatted: string; newFormatted: string } {
	const oldIndent = /^\s*/.exec(oldLine)?.[0] ?? "";
	const newIndent = /^\s*/.exec(newLine)?.[0] ?? "";
	const sharedIndent = oldIndent === newIndent ? oldIndent : "";

	const oldBody = oldLine.slice(sharedIndent.length);
	const newBody = newLine.slice(sharedIndent.length);

	const aTokens = tokenizeWords(oldBody);
	const bTokens = tokenizeWords(newBody);

	// 计算词级 LCS
	const n = Math.min(aTokens.length, 200);
	const m = Math.min(bTokens.length, 200);
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			if (aTokens[i - 1] === bTokens[j - 1]) {
				dp[i]![j] = dp[i - 1]![j - 1]! + 1;
			} else {
				dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
			}
		}
	}

	const aSame = new Set<number>();
	const bSame = new Set<number>();
	let i = n;
	let j = m;
	while (i > 0 && j > 0) {
		if (aTokens[i - 1] === bTokens[j - 1]) {
			aSame.add(i - 1);
			bSame.add(j - 1);
			i--;
			j--;
		} else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
			i--;
		} else {
			j--;
		}
	}

	// 格式化输出
	let oldOut = sharedIndent;
	for (let k = 0; k < aTokens.length; k++) {
		const token = aTokens[k]!;
		if (aSame.has(k)) {
			oldOut += `${C.red}${token}${C.reset}`;
		} else {
			// 变更词：高亮加粗
			oldOut += `${C.bold}\x1b[38;2;255;160;160m${token}${C.reset}${C.red}`;
		}
	}

	let newOut = sharedIndent;
	for (let k = 0; k < bTokens.length; k++) {
		const token = bTokens[k]!;
		if (bSame.has(k)) {
			newOut += `${C.green}${token}${C.reset}`;
		} else {
			// 变更词：高亮加粗
			newOut += `${C.bold}\x1b[38;2;160;255;160m${token}${C.reset}${C.green}`;
		}
	}

	return { oldFormatted: oldOut, newFormatted: newOut };
}

/**
 * 将变更块配对为并排双栏行数组
 */
export function alignSplitDiff(
	oldText: string,
	newText: string,
): { rows: SplitDiffRow[]; addCount: number; delCount: number } {
	const lineDiff = computeLineDiff(oldText, newText);
	const rows: SplitDiffRow[] = [];
	let i = 0;

	while (i < lineDiff.items.length) {
		const item = lineDiff.items[i]!;
		if (item.type === "same") {
			rows.push({ kind: "same", oldLine: item.line, newLine: item.line });
			i++;
			continue;
		}

		// 收集一段连续的 del 和 add 块
		const dels: string[] = [];
		const adds: string[] = [];
		while (i < lineDiff.items.length && lineDiff.items[i]!.type !== "same") {
			if (lineDiff.items[i]!.type === "del") dels.push(lineDiff.items[i]!.line);
			else adds.push(lineDiff.items[i]!.line);
			i++;
		}

		// 配对成 change 行与独占增删行
		const maxPair = Math.min(dels.length, adds.length);
		for (let p = 0; p < maxPair; p++) {
			rows.push({ kind: "change", oldLine: dels[p], newLine: adds[p] });
		}
		for (let d = maxPair; d < dels.length; d++) {
			rows.push({ kind: "del", oldLine: dels[d] });
		}
		for (let a = maxPair; a < adds.length; a++) {
			rows.push({ kind: "add", newLine: adds[a] });
		}
	}

	return { rows, addCount: lineDiff.addCount, delCount: lineDiff.delCount };
}

/**
 * 格式化渲染 Unified Diff 单栏封闭细线卡片
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
	const DIFF_BODY_MAX_LINES = 8;
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
		const budget = Math.max(0, innerW - 2);
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
	const botFillLen = Math.max(1, boxWidth - badgeW - 6);
	const botLine = `  ${C.gray}└${"─".repeat(botFillLen)} ${statsBadge}${C.gray} ──┘${C.reset}`;
	output.push(botLine);

	return output;
}

/**
 * 格式化渲染 Split Diff 双栏并排封闭细线卡片（复刻 dsh-TUI SplitDiffView）
 */
export function formatSplitDiffCardLines(
	oldText: string,
	newText: string,
	filename: string,
	collapsed = true,
	width = 80,
): string[] {
	// 宽度小于 80 时自动降级为单栏 Unified Diff
	if (width < 80) {
		return formatUnifiedDiffCardLines(oldText, newText, filename, collapsed, width);
	}

	const boxWidth = getContentBoxWidth(width - 4);
	const innerW = boxWidth - 4; // 减去两端 "│ " 与 " │"
	const dividerW = 1; // 中间 "│"
	const paneW = Math.max(15, Math.floor((innerW - dividerW) / 2));
	const rightPaneW = innerW - dividerW - paneW;

	const { rows, addCount, delCount } = alignSplitDiff(oldText, newText);
	const totalItems = rows.length;
	const DIFF_BODY_MAX_LINES = 8;
	const isFolded = collapsed && totalItems > DIFF_BODY_MAX_LINES;
	const visibleSlice = isFolded ? rows.slice(0, DIFF_BODY_MAX_LINES) : rows;
	const hiddenCount = totalItems - visibleSlice.length;

	// 1. 顶边框：┌─ 📄 ${filename} (split diff) ───────────────────┐
	const headerTag = `┌─ 📄 ${filename} (split diff) `;
	const topTagW = visibleWidth(headerTag);
	const topFillLen = Math.max(1, boxWidth - topTagW - 1);
	const topLine = `  ${C.gray}${headerTag}${"─".repeat(topFillLen)}┐${C.reset}`;
	const output: string[] = [topLine];

	// 2. 双栏行渲染
	for (const row of visibleSlice) {
		let leftStr = "";
		let rightStr = "";

		if (row.kind === "same") {
			const text = truncateToWidth((row.oldLine ?? "").replace(/\r$/, ""), paneW - 2, "…");
			const padL = Math.max(0, paneW - 2 - visibleWidth(text));
			leftStr = `  ${C.dim}${text}${C.reset}${" ".repeat(padL)}`;

			const rightText = truncateToWidth((row.newLine ?? "").replace(/\r$/, ""), rightPaneW - 2, "…");
			const padR = Math.max(0, rightPaneW - 2 - visibleWidth(rightText));
			rightStr = `  ${C.dim}${rightText}${C.reset}${" ".repeat(padR)}`;
		} else if (row.kind === "del") {
			const text = truncateToWidth((row.oldLine ?? "").replace(/\r$/, ""), paneW - 2, "…");
			const padL = Math.max(0, paneW - 2 - visibleWidth(text));
			leftStr = `${C.red}− ${text}${C.reset}${" ".repeat(padL)}`;
			rightStr = " ".repeat(rightPaneW);
		} else if (row.kind === "add") {
			leftStr = " ".repeat(paneW);
			const text = truncateToWidth((row.newLine ?? "").replace(/\r$/, ""), rightPaneW - 2, "…");
			const padR = Math.max(0, rightPaneW - 2 - visibleWidth(text));
			rightStr = `${C.green}+ ${text}${C.reset}${" ".repeat(padR)}`;
		} else if (row.kind === "change") {
			const { oldFormatted, newFormatted } = computeWordDiff(
				(row.oldLine ?? "").replace(/\r$/, ""),
				(row.newLine ?? "").replace(/\r$/, ""),
			);
			const leftTrunc = truncateToWidth(oldFormatted, paneW - 2, "…");
			const padL = Math.max(0, paneW - 2 - visibleWidth(leftTrunc));
			leftStr = `${C.red}− ${leftTrunc}${C.reset}${" ".repeat(padL)}`;

			const rightTrunc = truncateToWidth(newFormatted, rightPaneW - 2, "…");
			const padR = Math.max(0, rightPaneW - 2 - visibleWidth(rightTrunc));
			rightStr = `${C.green}+ ${rightTrunc}${C.reset}${" ".repeat(padR)}`;
		}

		output.push(`  ${C.gray}│${C.reset} ${leftStr}${C.subtle}│${C.reset}${rightStr} ${C.gray}│${C.reset}`);
	}

	// 3. 超出折叠提示行
	if (isFolded && hiddenCount > 0) {
		const hintText = `${C.gray}... (还有 ${hiddenCount} 行变更 · 按 Ctrl+O 展开)${C.reset}`;
		const hintW = visibleWidth(hintText);
		const pad = Math.max(0, innerW - hintW);
		output.push(`  ${C.gray}│${C.reset} ${hintText}${" ".repeat(pad)} ${C.gray}│${C.reset}`);
	}

	// 4. 底边框：└──────────────────────────── +N / -M ──┘
	const statsBadge = `${C.green}+${addCount}${C.reset} / ${C.red}-${delCount}${C.reset}${isFolded ? ` ${C.dim}(已折叠)${C.reset}` : ""}`;
	const badgeW = visibleWidth(statsBadge);
	const botFillLen = Math.max(1, boxWidth - badgeW - 6);
	const botLine = `  ${C.gray}└${"─".repeat(botFillLen)} ${statsBadge}${C.gray} ──┘${C.reset}`;
	output.push(botLine);

	return output;
}

/**
 * 统一 Diff 卡片入口：宽度 >= 80 呈现双栏 Split Diff，< 80 平滑降级为 Unified Diff
 */
export function formatDiffCardLines(
	oldText: string,
	newText: string,
	filename: string,
	collapsed = true,
	width = 80,
): string[] {
	oldText = sanitizeRenderText(oldText);
	newText = sanitizeRenderText(newText);
	filename = sanitizeRenderText(filename);
	if (width >= 80) {
		return formatSplitDiffCardLines(oldText, newText, filename, collapsed, width);
	}
	return formatUnifiedDiffCardLines(oldText, newText, filename, collapsed, width);
}
