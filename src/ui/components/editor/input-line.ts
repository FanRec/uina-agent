/**
 * 一体化圆角容器输入盒（对齐 Claude Code 与 pi-tui 工业级标准）。
 * 核心特性：
 * 1. 视口滚动引擎（MAX_VISIBLE_LINES = 5）：
 *    - 无论展开多少行代码或多行文本，输入盒固定最高展示 5 行视口，绝对杜绝终端溢出滚屏灾难！
 *    - 光标跟随自动滚动，上下边框带有优雅的「↑ +N行」与「↓ +N行」滚动提示；
 * 2. 纯净文本流清洗：
 *    - 全面消灭所有原生 \r，彻底解决终端中回车符导致竖线覆写在文字中间的幽灵 Bug；
 * 3. 完整的原子化粘贴标记系统（Inline Paste Chip）：
 *    - 专属 Ctrl+O 展开；
 *    - 多行自适应折叠；光标精准后置；退格原子删除；
 * 4. Ctrl+A 全选并自动复制展开后的完整代码到系统剪贴板；
 * 5. 全列宽绝对几何锁定，顶边框、内容行、底边框像素级垂直。
 */

import { exec } from "node:child_process";
import { CURSOR_MARKER, type Component, type Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, charWidth, visibleWidth, truncateToWidth, getContentBoxWidth } from "../../core/utils.js";

const PASTE_MARKER_REGEX = /\[已粘贴 #(\d+) (\+\d+行|\d+字)\]/g;
const MAX_VISIBLE_LINES = 5;

export interface MarkerSpan {
	id: number;
	start: number;
	end: number;
	spec: string;
	tokenText: string;
}

export function findMarkers(text: string): MarkerSpan[] {
	const list: MarkerSpan[] = [];
	for (const m of text.matchAll(PASTE_MARKER_REGEX)) {
		list.push({
			id: Number(m[1]),
			start: m.index,
			end: m.index + m[0].length,
			spec: m[2]!,
			tokenText: m[0],
		});
	}
	return list;
}

function formatTokens(n: number): string {
	if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${n}`;
}

/** 清洗输入文本，彻底抹除所有 \r 与非法控制字符 */
function sanitizeText(str: string): string {
	return str
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** 将文本写入系统剪贴板（OSC 52 + Windows 降级兜底） */
function copyToClipboard(text: string): void {
	if (!text) return;
	const b64 = Buffer.from(text, "utf-8").toString("base64");
	process.stdout.write(`\x1b]52;c;${b64}\x07`);

	if (process.platform === "win32") {
		const child = exec(
			'powershell.exe -NoProfile -NonInteractive -Command "$Input | Set-Clipboard"',
			() => {},
		);
		child.stdin?.write(text);
		child.stdin?.end();
	}
}

export class InputLine implements Component, Focusable {
	focused = true;
	private text = ""; // 当前编辑文本
	private cursorIndex = 0;
	private isAllSelected = false; // Ctrl+A 全选状态
	private scrollOffset = 0; // 多行视口滚动偏移量

	// 行内粘贴注册表
	private pastes: Map<number, string> = new Map();
	private pasteCounter = 0;

	// 括号粘贴状态机
	private inPasteMode = false;
	private pasteBuffer = "";

	// 历史记录
	private history: string[] = [];
	private historyIndex = -1;
	private savedText = "";

	// 外部状态注入
	private topStatusHeader = "";
	private modelName = "deepseek-chat";
	private usedTokens = 0;
	private contextWindow = 65536;

	// 事件回调
	public onSubmit?: (text: string) => void;
	public onInterrupt?: () => void;
	public onEscape?: () => void;
	private cwd = "";

	constructor() {}

	setCwd(cwd: string): void {
		this.cwd = cwd;
	}

	setSpeedStats(_tps: number, _elapsedMs: number, _isStreaming: boolean): void {}

	setStatusHeader(header: string): void {
		this.topStatusHeader = header;
	}

	setContextStats(modelName: string, usedTokens: number, contextWindow: number): void {
		this.modelName = modelName;
		this.usedTokens = usedTokens;
		if (contextWindow > 0) this.contextWindow = contextWindow;
	}

	private reasoningEffort: "off" | "low" | "medium" | "high" | "max" = "medium";

	setReasoningEffort(effort: "off" | "low" | "medium" | "high" | "max" | "none" | string): void {
		const lower = effort.toLowerCase().trim();
		if (lower === "none" || lower === "off") this.reasoningEffort = "off";
		else if (lower === "low") this.reasoningEffort = "low";
		else if (lower === "medium") this.reasoningEffort = "medium";
		else if (lower === "high") this.reasoningEffort = "high";
		else if (lower === "max") this.reasoningEffort = "max";
		else this.reasoningEffort = "medium";
	}

	/** 检查光标当前是否紧邻某个粘贴标记 */
	hasChipAtCursor(): boolean {
		const markers = findMarkers(this.text);
		return markers.some((m) => m.end === this.cursorIndex || m.start === this.cursorIndex);
	}

	/** 展开所有行内粘贴标记为原始文本 */
	private expandMarkers(content: string): string {
		return content.replace(PASTE_MARKER_REGEX, (_, idStr) => {
			const id = Number(idStr);
			return this.pastes.get(id) ?? "";
		});
	}

	getText(): string {
		return this.expandMarkers(this.text);
	}

	clear(): void {
		this.text = "";
		this.cursorIndex = 0;
		this.pastes.clear();
		this.pasteCounter = 0;
		this.historyIndex = -1;
		this.isAllSelected = false;
		this.scrollOffset = 0;
	}

	addHistory(item: string): void {
		const trimmed = item.trim();
		if (!trimmed) return;
		if (this.history[this.history.length - 1] !== trimmed) {
			this.history.push(trimmed);
		}
		this.historyIndex = -1;
	}

	getRawText(): string {
		return this.text;
	}

	getCursorIndex(): number {
		return this.cursorIndex;
	}

	setText(newText: string): void {
		this.text = sanitizeText(newText);
		this.cursorIndex = this.text.length;
		this.isAllSelected = false;
		this.scrollOffset = 0;
	}

	replaceRange(start: number, end: number, replacement: string): void {
		const before = this.text.slice(0, Math.max(0, start));
		const after = this.text.slice(end);
		this.text = before + replacement + after;
		this.cursorIndex = start + replacement.length;
		this.isAllSelected = false;
	}

	/**
	 * 检测光标处当前是否激活联想触发点（/ 命令或 @ 文件）
	 * 算法严格对标 dsh-TUI / Claude Code 的 mentionAtCaret 规范
	 */
	detectSuggestionQuery(): {
		type: "command" | "file";
		query: string;
		start: number;
		end: number;
	} | null {
		const upToCursor = this.text.slice(0, this.cursorIndex);

		// 1. / 命令联想：整行以 / 开头且光标处于首个指令单词内
		if (this.text.startsWith("/")) {
			if (!upToCursor.includes(" ")) {
				return {
					type: "command",
					query: upToCursor.slice(1),
					start: 0,
					end: this.cursorIndex,
				};
			}
		}

		// 2. @ 文件联想：从光标位置向前扫描单词边界，寻找前置 @
		let start = this.cursorIndex;
		while (start > 0 && !/\s/.test(this.text[start - 1] ?? "")) {
			start--;
		}

		if (this.text[start] === "@") {
			// 支持带双引号路径 @"my dir/a.ts"
			if (this.text[start + 1] === '"') {
				const closeQuote = this.text.indexOf('"', start + 2);
				if (closeQuote === -1 || this.cursorIndex <= closeQuote + 1) {
					const end = closeQuote === -1 ? this.text.length : closeQuote + 1;
					return {
						type: "file",
						query: this.text.slice(start + 2, this.cursorIndex),
						start,
						end,
					};
				}
				return null;
			}

			// 普通无引号文件路径
			let end = this.cursorIndex;
			while (end < this.text.length && !/\s/.test(this.text[end] ?? "")) {
				end++;
			}
			const query = this.text.slice(start + 1, this.cursorIndex);
			return {
				type: "file",
				query,
				start,
				end,
			};
		}

		return null;
	}

	handleInput(data: string): void {
		// 1. 括号粘贴转义序列
		if (data.includes("\x1b[200~")) {
			this.inPasteMode = true;
			this.pasteBuffer = "";
			const startIdx = data.indexOf("\x1b[200~") + 6;
			const remaining = data.slice(startIdx);
			if (remaining.includes("\x1b[201~")) {
				const endIdx = remaining.indexOf("\x1b[201~");
				this.pasteBuffer = remaining.slice(0, endIdx);
				this.inPasteMode = false;
				this.insertPastedText(sanitizeText(this.pasteBuffer));
				return;
			}
			this.pasteBuffer += remaining;
			return;
		}

		if (this.inPasteMode) {
			if (data.includes("\x1b[201~")) {
				const endIdx = data.indexOf("\x1b[201~");
				this.pasteBuffer += data.slice(0, endIdx);
				this.inPasteMode = false;
				this.insertPastedText(sanitizeText(this.pasteBuffer));
				return;
			}
			this.pasteBuffer += data;
			return;
		}

		// 2. 突发流大文本/多行粘贴检测（3行以上或100字以上自动折叠为标记）
		const cleanData = sanitizeText(data);
		const lines = cleanData.split("\n");
		if (lines.length >= 3 || (cleanData.length >= 100 && !cleanData.startsWith("\x1b"))) {
			this.insertPastedText(cleanData);
			return;
		}

		// 3. 特殊快捷键：Ctrl+C
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.isAllSelected) {
				this.isAllSelected = false;
				return;
			}
			if (this.text) {
				this.clear();
			} else {
				this.onInterrupt?.();
			}
			return;
		}

		if (matchesKey(data, Key.escape)) {
			if (this.isAllSelected) {
				this.isAllSelected = false;
				return;
			}
			this.onEscape?.();
			return;
		}

		// 4. Ctrl+A：全选框内内容，并将所有粘贴展开后的完整内容直接写入系统剪贴板
		if (matchesKey(data, Key.ctrl("a"))) {
			if (this.text.length > 0) {
				this.isAllSelected = true;
				const fullExpanded = this.getText();
				copyToClipboard(fullExpanded);
			}
			return;
		}

		// 全选状态下的任何常规操作拦截
		if (this.isAllSelected) {
			if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete) || matchesKey(data, Key.ctrl("u"))) {
				this.clear();
				return;
			}
			if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
				this.isAllSelected = false;
				return;
			}
			// 打入其它普通字符时替换全选
			if (!data.startsWith("\x1b")) {
				this.clear();
			}
		}

		// 5. Ctrl+O 专门用于展开光标处的粘贴标记
		if (matchesKey(data, Key.ctrl("o"))) {
			const markers = findMarkers(this.text);
			const target = markers.find((m) => m.end === this.cursorIndex || m.start === this.cursorIndex);
			if (target) {
				const raw = this.pastes.get(target.id);
				if (raw !== undefined) {
					const cleanRaw = sanitizeText(raw);
					this.text = this.text.slice(0, target.start) + cleanRaw + this.text.slice(target.end);
					this.cursorIndex = target.start + cleanRaw.length;
					this.pastes.delete(target.id);
					return;
				}
			}
		}

		// 5. Shift+Enter / Alt+Enter / Ctrl+J 原生换行（在当前光标处插入 \n 并下移一行）
		if (
			matchesKey(data, Key.shiftEnter) ||
			matchesKey(data, Key.shift("enter")) ||
			matchesKey(data, Key.alt("enter")) ||
			data === "\x0a"
		) {
			this.text = this.text.slice(0, this.cursorIndex) + "\n" + this.text.slice(this.cursorIndex);
			this.cursorIndex += 1;
			return;
		}

		if (matchesKey(data, Key.enter)) {
			const submission = this.getText();
			if (submission.trim()) {
				this.addHistory(submission);
				const toSubmit = submission;
				this.clear();
				this.onSubmit?.(toSubmit);
			}
			return;
		}

		// 6. 原子化方向键移动（将 [已粘贴 #ID ...] 作为一个整体跳过）
		const markers = findMarkers(this.text);

		if (matchesKey(data, Key.left)) {
			const markerEndingHere = markers.find((m) => m.end === this.cursorIndex);
			if (markerEndingHere) {
				this.cursorIndex = markerEndingHere.start;
				return;
			}
			const inside = markers.find((m) => this.cursorIndex > m.start && this.cursorIndex < m.end);
			if (inside) {
				this.cursorIndex = inside.start;
				return;
			}
			if (this.cursorIndex > 0) this.cursorIndex--;
			return;
		}

		if (matchesKey(data, Key.right)) {
			const markerStartingHere = markers.find((m) => m.start === this.cursorIndex);
			if (markerStartingHere) {
				this.cursorIndex = markerStartingHere.end;
				return;
			}
			const inside = markers.find((m) => this.cursorIndex > m.start && this.cursorIndex < m.end);
			if (inside) {
				this.cursorIndex = inside.end;
				return;
			}
			if (this.cursorIndex < this.text.length) this.cursorIndex++;
			return;
		}

		// 上下键多行行间穿梭与历史记录
		if (matchesKey(data, Key.up)) {
			const prevNewline = this.text.lastIndexOf("\n", this.cursorIndex - 1);
			if (prevNewline !== -1) {
				// 在多行文本内部向上移动一行
				const lineStart = this.text.lastIndexOf("\n", prevNewline - 1) + 1;
				const col = this.cursorIndex - (prevNewline + 1);
				this.cursorIndex = Math.min(prevNewline, lineStart + col);
				return;
			}
			// 到达顶行时触发历史记录
			if (this.history.length === 0) return;
			if (this.historyIndex === -1) {
				this.savedText = this.text;
				this.historyIndex = this.history.length - 1;
			} else if (this.historyIndex > 0) {
				this.historyIndex--;
			}
			this.text = this.history[this.historyIndex] ?? "";
			this.cursorIndex = this.text.length;
			return;
		}

		if (matchesKey(data, Key.down)) {
			const nextNewline = this.text.indexOf("\n", this.cursorIndex);
			if (nextNewline !== -1) {
				// 在多行文本内部向下移动一行
				const curLineStart = this.text.lastIndexOf("\n", this.cursorIndex - 1) + 1;
				const col = this.cursorIndex - curLineStart;
				const nextLineEnd = this.text.indexOf("\n", nextNewline + 1);
				const targetEnd = nextLineEnd === -1 ? this.text.length : nextLineEnd;
				this.cursorIndex = Math.min(targetEnd, nextNewline + 1 + col);
				return;
			}
			// 到达底行时触发历史记录
			if (this.historyIndex === -1) return;
			if (this.historyIndex < this.history.length - 1) {
				this.historyIndex++;
				this.text = this.history[this.historyIndex] ?? "";
			} else {
				this.historyIndex = -1;
				this.text = this.savedText;
			}
			this.cursorIndex = this.text.length;
			return;
		}

		if (matchesKey(data, Key.ctrl("e")) || matchesKey(data, Key.end)) {
			this.cursorIndex = this.text.length;
			return;
		}

		if (matchesKey(data, Key.home)) {
			this.cursorIndex = 0;
			return;
		}

		// 7. Backspace：如果光标在标记后，原子化删除整个 Chip
		if (matchesKey(data, Key.backspace)) {
			const markerEndingHere = markers.find((m) => m.end === this.cursorIndex);
			if (markerEndingHere) {
				this.text = this.text.slice(0, markerEndingHere.start) + this.text.slice(markerEndingHere.end);
				this.cursorIndex = markerEndingHere.start;
				this.pastes.delete(markerEndingHere.id);
				return;
			}
			if (this.cursorIndex > 0) {
				this.text = this.text.slice(0, this.cursorIndex - 1) + this.text.slice(this.cursorIndex);
				this.cursorIndex--;
			}
			return;
		}

		if (matchesKey(data, Key.delete)) {
			const markerStartingHere = markers.find((m) => m.start === this.cursorIndex);
			if (markerStartingHere) {
				this.text = this.text.slice(0, markerStartingHere.start) + this.text.slice(markerStartingHere.end);
				this.pastes.delete(markerStartingHere.id);
				return;
			}
			if (this.cursorIndex < this.text.length) {
				this.text = this.text.slice(0, this.cursorIndex) + this.text.slice(this.cursorIndex + 1);
			}
			return;
		}

		if (matchesKey(data, Key.ctrl("u"))) {
			this.text = "";
			this.cursorIndex = 0;
			this.pastes.clear();
			return;
		}

		if (matchesKey(data, Key.ctrl("k"))) {
			this.text = this.text.slice(0, this.cursorIndex);
			return;
		}

		// 过滤其它控制字符
		if (data.startsWith("\x1b")) return;

		// 正常打入文本（清洗保留 \n，清除所有 \r）
		const sanitized = sanitizeText(data);
		this.text = this.text.slice(0, this.cursorIndex) + sanitized + this.text.slice(this.cursorIndex);
		this.cursorIndex += sanitized.length;
	}

	private insertPastedText(raw: string): void {
		const cleanRaw = sanitizeText(raw);
		const lines = cleanRaw.split("\n");
		this.pasteCounter++;
		const id = this.pasteCounter;
		this.pastes.set(id, cleanRaw);

		const spec = lines.length > 1 ? `+${lines.length}行` : `${cleanRaw.length}字`;
		const marker = `[已粘贴 #${id} ${spec}]`;
		const before = this.text.slice(0, this.cursorIndex);
		const after = this.text.slice(this.cursorIndex);

		this.text = before + marker + after;
		this.cursorIndex = before.length + marker.length;
	}

	insertText(raw: string): void {
		if (raw.includes("\n") || raw.length > 80) {
			this.insertPastedText(raw);
		} else {
			const clean = sanitizeText(raw);
			this.text = this.text.slice(0, this.cursorIndex) + clean + this.text.slice(this.cursorIndex);
			this.cursorIndex += clean.length;
		}
	}

	getExpandedText(): string {
		return this.getText();
	}

	invalidate(): void {}

	/**
	 * 渲染为拥有精细几何列宽、视口滚动与舒适高度的现代圆角容器盒
	 */
	render(width: number): string[] {
		const boxWidth = getContentBoxWidth(width, 4);
		const borderCol = C.gray;
		const innerWidth = boxWidth - 4; // 减去两端 "│ " 与 " │"
		const contentColLimit = innerWidth - 2; // 提示符/缩进占 2 列宽

		// ─────────────────────────────────────────────────────────────
		// 1. 中间多行自然排版引擎（按 \n 切分逻辑行，严格计算每个视觉行）
		// ─────────────────────────────────────────────────────────────
		type LayoutAtom =
			| { type: "char"; raw: string; display: string; width: number; charIdx: number }
			| { type: "chip"; raw: string; display: string; width: number; startIdx: number; endIdx: number };

		interface VisualRow {
			content: string;
			hasCursor: boolean;
		}

		const visualRows: VisualRow[] = [];
		const logicalLines = this.text.split("\n");
		let globalCharIndex = 0;
		let cursorHandled = false;
		const markers = findMarkers(this.text);

		for (let lineIdx = 0; lineIdx < logicalLines.length; lineIdx++) {
			const lineStr = logicalLines[lineIdx]!;
			const atoms: LayoutAtom[] = [];
			let colInLine = 0;

			while (colInLine < lineStr.length) {
				const curGlobalIdx = globalCharIndex + colInLine;
				const m = markers.find((marker) => marker.start === curGlobalIdx);
				if (m) {
					const chipDisplay = `${C.yellow}${C.bold}[已粘贴 ${m.spec} ▾]${C.reset}`;
					const chipWidth = visibleWidth(chipDisplay);
					atoms.push({
						type: "chip",
						raw: m.tokenText,
						display: chipDisplay,
						width: chipWidth,
						startIdx: m.start,
						endIdx: m.end,
					});
					colInLine += m.tokenText.length;
				} else {
					const char = lineStr[colInLine]!;
					const w = charWidth(char);
					atoms.push({
						type: "char",
						raw: char,
						display: char,
						width: w,
						charIdx: curGlobalIdx,
					});
					colInLine++;
				}
			}

			let curRowText = "";
			let curRowWidth = 0;
			let curRowHasCursor = false;

			const flushVisualRow = () => {
				visualRows.push({
					content: curRowText,
					hasCursor: curRowHasCursor,
				});
				curRowText = "";
				curRowWidth = 0;
				curRowHasCursor = false;
			};

			for (const atom of atoms) {
				if (curRowWidth + atom.width > contentColLimit && curRowWidth > 0) {
					flushVisualRow();
				}

				if (atom.type === "char") {
					if (!cursorHandled && this.cursorIndex === atom.charIdx) {
						cursorHandled = true;
						curRowHasCursor = true;
						curRowText += `${CURSOR_MARKER}\x1b[7m${atom.raw}\x1b[27m`;
					} else {
						curRowText += atom.display;
					}
					curRowWidth += atom.width;
				} else {
					// chip
					if (!cursorHandled && this.cursorIndex === atom.endIdx) {
						cursorHandled = true;
						curRowHasCursor = true;
						curRowText += `${atom.display}${CURSOR_MARKER}\x1b[7m \x1b[27m`;
						curRowWidth += atom.width + 1;
					} else if (!cursorHandled && this.cursorIndex === atom.startIdx) {
						cursorHandled = true;
						curRowHasCursor = true;
						curRowText += `${CURSOR_MARKER}\x1b[7m \x1b[27m${atom.display}`;
						curRowWidth += atom.width + 1;
					} else {
						curRowText += atom.display;
						curRowWidth += atom.width;
					}
				}
			}

			// 检查光标是否在该逻辑行的末尾（换行符前）
			const lineEndGlobalIdx = globalCharIndex + lineStr.length;
			if (!cursorHandled && this.cursorIndex === lineEndGlobalIdx) {
				cursorHandled = true;
				curRowHasCursor = true;
				curRowText += `${CURSOR_MARKER}\x1b[7m \x1b[27m`;
				curRowWidth += 1;
			}

			flushVisualRow();
			globalCharIndex += lineStr.length + 1; // 跳过 \n
		}

		if (!cursorHandled) {
			if (visualRows.length === 0) {
				visualRows.push({ content: `${CURSOR_MARKER}\x1b[7m \x1b[27m`, hasCursor: true });
			} else {
				const lastRow = visualRows[visualRows.length - 1]!;
				lastRow.content += `${CURSOR_MARKER}\x1b[7m \x1b[27m`;
				lastRow.hasCursor = true;
			}
		}

		// ─────────────────────────────────────────────────────────────
		// 2. 视口滚动控制（MAX_VISIBLE_LINES = 5，保护终端绝对不溢出滚屏）
		// ─────────────────────────────────────────────────────────────
		let cursorLineIndex = visualRows.findIndex((r) => r.hasCursor);
		if (cursorLineIndex === -1) cursorLineIndex = 0;

		if (cursorLineIndex < this.scrollOffset) {
			this.scrollOffset = cursorLineIndex;
		} else if (cursorLineIndex >= this.scrollOffset + MAX_VISIBLE_LINES) {
			this.scrollOffset = cursorLineIndex - MAX_VISIBLE_LINES + 1;
		}

		const maxScroll = Math.max(0, visualRows.length - MAX_VISIBLE_LINES);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleRows = visualRows.slice(this.scrollOffset, this.scrollOffset + MAX_VISIBLE_LINES);

		// 默认保持至少 2 行舒适高度
		while (visibleRows.length < 2) {
			visibleRows.push({ content: "", hasCursor: false });
		}

		// ─────────────────────────────────────────────────────────────
		// 3. 顶边框（带滚动提示 ↑ +N行）：╭─ ${header} ──────────╮
		// ─────────────────────────────────────────────────────────────
		let topLabel = this.topStatusHeader;
		if (this.scrollOffset > 0) {
			topLabel = `${C.yellow}↑ +${this.scrollOffset}行${C.reset} ${topLabel}`;
		}

		let topLine = "";
		if (topLabel) {
			const maxHeaderW = Math.max(8, boxWidth - 8);
			const safeHeader = truncateToWidth(topLabel, maxHeaderW);
			const baseW = 3 + visibleWidth(safeHeader) + 1 + 1;
			const rightLen = Math.max(1, boxWidth - baseW);
			topLine = `${borderCol}╭─ ${C.reset}${safeHeader} ${borderCol}${"─".repeat(rightLen)}╮${C.reset}`;
		} else {
			const fillLen = Math.max(1, boxWidth - 2);
			topLine = `${borderCol}╭${"─".repeat(fillLen)}╮${C.reset}`;
		}

		// ─────────────────────────────────────────────────────────────
		// 4. 中间可见行组装（严格锁定宽度为 boxWidth）
		// ─────────────────────────────────────────────────────────────
		const middleLines: string[] = [];
		for (let r = 0; r < visibleRows.length; r++) {
			const vRow = visibleRows[r]!;
			const isFirstGlobalRow = this.scrollOffset === 0 && r === 0;
			const isTopTier = this.reasoningEffort === "max";
			const glyphColor = isTopTier ? "\x1b[38;2;130;185;255m\x1b[1m" : C.cyan;
			const prefix = isFirstGlobalRow ? `${glyphColor}❯ ${C.reset}` : "  ";
			const prefixW = 2;

			let contentStr = vRow.content;
			if (this.isAllSelected) {
				contentStr = `\x1b[7m${contentStr}\x1b[27m`;
			}

			// 严格截断保证绝对不撑爆右边框
			if (visibleWidth(contentStr) > contentColLimit) {
				contentStr = truncateToWidth(contentStr, contentColLimit, "");
			}
			const finalW = visibleWidth(contentStr);
			const padLen = Math.max(0, innerWidth - prefixW - finalW);

			const lineStr = `${borderCol}│ ${C.reset}${prefix}${contentStr}${" ".repeat(padLen)}${borderCol} │${C.reset}`;
			middleLines.push(lineStr);
		}

		// ─────────────────────────────────────────────────────────────
		// 5. 底边框（带滚动提示 ↓ +N行 与蓝白图形化上下文进度条）：
		//    ╰─ [████░░░░] 14.2k/65.5k (21.7%) ── deepseek-chat ─╯
		// ─────────────────────────────────────────────────────────────
		let bottomLine = "";
		const pct = Math.min(100, Math.max(0, (this.usedTokens / this.contextWindow) * 100));
		const pctStr = `${pct.toFixed(1)}%`;
		const readout = `${formatTokens(this.usedTokens)}/${formatTokens(this.contextWindow)} (${pctStr})`;
		
		const effortLabels: Record<string, string> = {
			off: `${C.gray}思考:关${C.reset}`,
			none: `${C.gray}思考:关${C.reset}`,
			low: `${C.dim}思考:低${C.reset}`,
			medium: `${C.cyan}思考:中${C.reset}`,
			high: `${C.bold}${C.glowWhite}思考:高${C.reset}`,
			max: `${C.bold}\x1b[38;2;130;185;255m思考:极高${C.reset}`,
		};
		const effortBadge = effortLabels[this.reasoningEffort] ?? `${C.cyan}思考:${this.reasoningEffort}${C.reset}`;
		let rightBadge = `${this.modelName} ${C.gray}·${C.reset} ${effortBadge}`;
		const remainingDown = maxScroll - this.scrollOffset;
		if (remainingDown > 0) {
			rightBadge = `${C.yellow}↓ +${remainingDown}行${C.gray} · ${rightBadge}`;
		}

		// 1. 目录常驻徽章（支持宽屏完整路径、中屏目录名；采用低饱和字符图标 🗀 与暗色路径，绝不刺眼）
		let cwdBadge = "";
		if (this.cwd) {
			const normPath = this.cwd.replace(/\\/g, "/");
			const baseName = normPath.split("/").filter(Boolean).pop() || this.cwd;
			const targetCwd = boxWidth >= 96 ? this.cwd : baseName;
			cwdBadge = `${C.gray}🗀 ${C.dim}${targetCwd}${C.reset}`;
		}

		const readoutPart = `${borderCol}] ${C.dim}${readout}${C.reset}`;
		const rightPart = ` ${C.gray}${rightBadge}${borderCol} ─╯${C.reset}`;

		// 判断可容纳的徽章
		const baseNeeded = 4 + 4 + visibleWidth(readoutPart) + visibleWidth(rightPart) + 6;
		const spaceForBadges = boxWidth - baseNeeded;

		const cwdW = cwdBadge ? visibleWidth(cwdBadge) + 3 : 0;
		const showCwd = Boolean(cwdBadge) && spaceForBadges >= cwdW;

		const reservedW =
			4 +
			2 +
			visibleWidth(readoutPart) +
			visibleWidth(rightPart) +
			(showCwd ? visibleWidth(cwdBadge) + 3 : 0);
		const barWidth = Math.max(4, Math.min(24, boxWidth - reservedW));

		const filledCols = Math.min(barWidth, Math.max(0, Math.round((pct / 100) * barWidth)));
		const emptyCols = barWidth - filledCols;

		let barColor = C.iceBlue;
		if (pct >= 90) barColor = C.red;
		else if (pct >= 80) barColor = C.yellow;

		const filledBar = `${barColor}${"█".repeat(filledCols)}${C.reset}`;
		const emptyBar = `${C.gray}${"░".repeat(emptyCols)}${C.reset}`;

		const leftPart = `${borderCol}╰─ [${C.reset}${filledBar}${emptyBar}${readoutPart} `;

		// 组装中间各徽章与边框连线
		const activeBadges: Array<{ text: string; width: number }> = [];
		if (showCwd) {
			activeBadges.push({ text: cwdBadge, width: visibleWidth(cwdBadge) });
		}

		if (activeBadges.length > 0) {
			const badgesTotalW = activeBadges.reduce((acc, b) => acc + b.width + 2, 0);
			const remainingLineW = Math.max(
				activeBadges.length + 1,
				boxWidth - visibleWidth(leftPart) - visibleWidth(rightPart) - badgesTotalW,
			);
			const segmentLen = Math.max(1, Math.floor(remainingLineW / (activeBadges.length + 1)));

			let middle = "";
			for (const badge of activeBadges) {
				middle += `${borderCol}${"─".repeat(segmentLen)} ${badge.text} `;
			}
			const finalFillerLen = Math.max(
				1,
				boxWidth - visibleWidth(leftPart) - visibleWidth(middle) - visibleWidth(rightPart),
			);
			bottomLine = `${leftPart}${middle}${borderCol}${"─".repeat(finalFillerLen)}${rightPart}`;
		} else {
			const fillerLen = Math.max(1, boxWidth - visibleWidth(leftPart) - visibleWidth(rightPart));
			bottomLine = `${leftPart}${borderCol}${"─".repeat(fillerLen)}${rightPart}`;
		}

		return [
			topLine,
			...middleLines,
			bottomLine,
		];
	}
}
