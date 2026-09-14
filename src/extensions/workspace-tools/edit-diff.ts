/**
 * edit_file 的变更摘要：带行号的变更片段（仿 pi generateDiffString，去依赖实现）。
 *
 * 与 pi 的差异：不引入 jsdiff，自己按替换位置推 hunk —— edit_file 的变更区域
 * 从匹配位置直接可得，无需通用 diff 算法。返回 {diff, firstChangedLine}：
 * diff 是 ± 行摘要（每个变更块上下文各 contextLines 行，更远处折叠为 ...），
 * firstChangedLine 是新文件中第一处变更的 1-based 行号。
 */

export interface EditDiffSummary {
	diff: string;
	firstChangedLine: number | undefined;
}

interface Hunk {
	/** 旧文件变更起始行（0-based） */
	oldStart: number;
	oldCount: number;
	newCount: number;
}

/** 由替换位置推变更 hunk（0-based 行，按旧文件行号有序、已合并相邻项）。 */
function hunkSpans(
	oldText: string,
	replacements: Array<{ matchIndex: number; matchLength: number; newText: string }>,
): Hunk[] {
	const oldLineStarts: number[] = [0];
	for (let i = 0; i < oldText.length; i++) if (oldText[i] === "\n") oldLineStarts.push(i + 1);

	const lineOf = (offset: number): number => {
		let lo = 0;
		let hi = oldLineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (oldLineStarts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};

	const raw = replacements
		.map((r) => {
			const startLine = lineOf(r.matchIndex);
			const endOffset = r.matchIndex + r.matchLength - 1;
			const endLine = lineOf(Math.max(r.matchIndex, endOffset));
			return { oldStart: startLine, oldCount: endLine - startLine + 1, newCount: r.newText.split("\n").length };
		})
		.sort((a, b) => a.oldStart - b.oldStart);

	// 合并相邻/重叠 hunk
	const hunks: Hunk[] = [];
	for (const h of raw) {
		const last = hunks[hunks.length - 1];
		if (last && h.oldStart <= last.oldStart + last.oldCount) {
			const end = Math.max(last.oldStart + last.oldCount, h.oldStart + h.oldCount);
			last.newCount += h.newCount;
			last.oldCount = end - last.oldStart;
		} else {
			hunks.push({ ...h });
		}
	}
	return hunks;
}

export function summarizeEdit(
	oldText: string,
	newText: string,
	replacements: Array<{ matchIndex: number; matchLength: number; newText: string }>,
	contextLines = 3,
): EditDiffSummary {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	// 末尾换行会 split 出一个空尾行，它不是真实内容行，不计入上下文展示
	const oldContent = oldText.endsWith("\n") ? oldLines.slice(0, -1) : oldLines;
	const newContent = newText.endsWith("\n") ? newLines.slice(0, -1) : newLines;
	const hunks = hunkSpans(oldText, replacements);
	if (hunks.length === 0) return { diff: "", firstChangedLine: undefined };

	const width = String(Math.max(oldContent.length, newContent.length)).length;
	const out: string[] = [];
	let firstChangedLine: number | undefined;
	let oldIndex = 0;
	let newIndex = 0;

	hunks.forEach((hunk, idx) => {
		// hunk 前的未变更行：最多保留尾部 contextLines 行作上文
		const gap = hunk.oldStart - oldIndex;
		const lead = Math.min(gap, contextLines);
		for (let i = gap - lead; i < gap; i++) {
			out.push(`  ${String(oldIndex + i + 1).padStart(width)} ${oldContent[oldIndex + i] ?? ""}`);
		}

		// 删除行（旧文件）
		for (let i = 0; i < hunk.oldCount; i++) {
			out.push(`- ${String(hunk.oldStart + i + 1).padStart(width)} ${oldContent[hunk.oldStart + i] ?? ""}`);
		}
		// 新增行（新文件，行号已含前序 hunk 的行数漂移）
		for (let i = 0; i < hunk.newCount; i++) {
			const n = newIndex + gap + i;
			if (firstChangedLine === undefined) firstChangedLine = n + 1;
			out.push(`+ ${String(n + 1).padStart(width)} ${newContent[n] ?? ""}`);
		}

		oldIndex = hunk.oldStart + hunk.oldCount;
		newIndex += gap + hunk.newCount;

		// hunk 后的未变更行：与下一 hunk 上文均分间隔（不重复打印），余量折叠
		const isLast = idx === hunks.length - 1;
		const gapAfter = isLast ? oldContent.length - oldIndex : hunks[idx + 1].oldStart - oldIndex;
		// 后续 hunk 自己也会保留至多 contextLines 行上文，先扣除避免重叠
		const reserved = isLast ? 0 : Math.min(gapAfter, contextLines);
		const shown = Math.min(gapAfter - reserved, contextLines);
		for (let i = 0; i < shown; i++) {
			out.push(`  ${String(oldIndex + i + 1).padStart(width)} ${oldContent[oldIndex + i] ?? ""}`);
		}
		// 只有真有行既未被本 hunk 下文、也未被下一 hunk 上文覆盖时才折叠
		const folded = gapAfter - shown - reserved;
		if (folded > 0) out.push(`  ${" ".repeat(width)} ...`);
	});

	return { diff: out.join("\n"), firstChangedLine };
}
