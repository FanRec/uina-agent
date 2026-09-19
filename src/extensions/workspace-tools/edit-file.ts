/**
 * edit_file：对 UTF-8 文本文件做精确文本替换。
 *
 * 设计对齐 pi（ThirdParty/pi coding-agent edit.ts / edit-diff.ts）中经实测可靠的
 * 最小机制，并按 Uina 的边界裁剪：
 * - 精确匹配 + 全文唯一性校验（多处命中即失败，让调用方补充上下文）；
 * - 一次调用可携带多个不相交编辑：全部对原始内容匹配，按位置排序后倒序应用；
 * - 行尾自适应：匹配在 LF 归一化视图上进行，写回时还原文件原有行尾
 *   （模型输出 \n，仓库实际是 CRLF 时也能匹配）；
 * - BOM 读写保留；匹配用 LF 视图，写回用原始 BOM 前缀。
 * 不做（无第一例真实需求前不造机制）：Unicode 模糊匹配、并发变更队列、
 * TUI 预览渲染。
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "../index.js";
import { summarizeEdit } from "./edit-diff.js";

interface Edit {
	oldText: string;
	newText: string;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

/** 读 rawContent：剥离 BOM，检测主行尾（首个 \n 前/后是否跟 \r）。 */
function prepareContent(rawContent: string): { bom: string; content: string; ending: "\r\n" | "\n" } {
	const bom = rawContent.startsWith("\uFEFF") ? "\uFEFF" : "";
	const content = rawContent.slice(bom.length);
	const lfIndex = content.indexOf("\n");
	const ending: "\r\n" | "\n" = lfIndex > 0 && content[lfIndex - 1] === "\r" ? "\r\n" : "\n";
	return { bom, content, ending };
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** 所有编辑必须能在归一化内容中唯一定位且互不重叠；返回按位置排序的替换集。 */
function matchEdits(content: string, edits: Edit[], path: string): MatchedEdit[] {
	if (edits.length === 0) throw new Error("edit_file：edits 不能为空，至少需要一个替换。");
	const matched: MatchedEdit[] = [];
	for (let i = 0; i < edits.length; i++) {
		const { oldText, newText } = edits[i];
		if (oldText.length === 0) throw new Error(`edit_file：edits[${i}].oldText 不能为空（${path}）。`);
		const first = content.indexOf(oldText);
		if (first === -1) throw new Error(`edit_file：edits[${i}].oldText 在 ${path} 中不存在，必须与文件内容逐字符一致（含空白与换行）。`);
		let occurrences = 1;
		for (let pos = first + 1; (pos = content.indexOf(oldText, pos)) !== -1; pos++) occurrences++;
		if (occurrences > 1) throw new Error(`edit_file：edits[${i}].oldText 在 ${path} 中出现 ${occurrences} 次，必须唯一；请补充上下文使其唯一。`);
		matched.push({ editIndex: i, matchIndex: first, matchLength: oldText.length, newText });
	}
	matched.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matched.length; i++) {
		const prev = matched[i - 1];
		const cur = matched[i];
		if (prev.matchIndex + prev.matchLength > cur.matchIndex) {
			throw new Error(`edit_file：edits[${prev.editIndex}] 与 edits[${cur.editIndex}] 在 ${path} 中重叠；请合并为一个编辑或改为针对不相交区域。`);
		}
	}
	return matched;
}

function applyMatched(content: string, matched: MatchedEdit[]): string {
	let result = content;
	for (let i = matched.length - 1; i >= 0; i--) {
		const m = matched[i];
		result = result.slice(0, m.matchIndex) + m.newText + result.slice(m.matchIndex + m.matchLength);
	}
	return result;
}

export function activateEditFile(api: ExtensionAPI): void {
	api.registerTool({
		def: {
			type: "function",
			function: {
				name: "edit_file",
				description:
					"Edit a UTF-8 text file by exact text replacement. Each edit's oldText must match exactly one location in the file (unique), matching against the original file content. Use multiple disjoint edits in one call instead of several calls. Line endings (LF/CRLF) are matched tolerantly and preserved.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", minLength: 1 },
						edits: {
							type: "array",
							minItems: 1,
							items: {
								type: "object",
								properties: {
									oldText: { type: "string", minLength: 1 },
									newText: { type: "string" },
								},
								required: ["oldText", "newText"],
								additionalProperties: false,
							},
						},
					},
					required: ["path", "edits"],
					additionalProperties: false,
				},
			},
		},
		run: async (args, signal) => {
			const file = resolve(api.cwd, String(args.path));
			const rawEdits = args.edits;
			if (!Array.isArray(rawEdits)) throw new Error("edit_file：edits 必须是 {oldText, newText} 数组。");
			const edits: Edit[] = rawEdits.map((e) => ({ oldText: String(e.oldText), newText: String(e.newText) }));

			const rawContent = await readFile(file, { encoding: "utf8", signal });
			const { bom, content, ending } = prepareContent(rawContent);
			const normalized = normalizeToLF(content);
			const matched = matchEdits(normalized, edits.map((e) => ({ oldText: normalizeToLF(e.oldText), newText: normalizeToLF(e.newText) })), file);
			const updated = restoreLineEndings(applyMatched(normalized, matched), ending);
			await writeFile(file, bom + updated, { encoding: "utf8", signal });
			// LF 视图上的变更摘要：带行号 ± 片段 + 新文件首个变更行，供调用方免全量复读确认
			const summary = summarizeEdit(normalized, normalizeToLF(updated), matched);
			return {
				result: `Edited ${file}: ${edits.length} replacement(s).\n${summary.diff}`,
				status: "succeeded",
				details: { path: file, edits: edits.length, lineEnding: ending, firstChangedLine: summary.firstChangedLine, effects: [{ effectType: "file.write", label: file }] },
			};
		},
	});
}
