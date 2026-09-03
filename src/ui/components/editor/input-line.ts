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

import { CURSOR_MARKER, type Component, type Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, charWidth, visibleWidth, truncateToWidth, copyToClipboardUnified } from "../../core/utils.js";
import { formatTokensCompact } from "../widgets/context-bar.js";

const PASTE_MARKER_REGEX = /\[已粘贴 #(\d+) (\+\d+行|\d+字)\]/g;
const MAX_VISIBLE_LINES = 5;
const MIN_RIGHT_BORDER_RUN = 4;
// dsh-tui/src/cc/figures.ts: POINTER = '\u276f' (❯).
const DSH_PROMPT_POINTER = "❯";
// dsh-tui/src/trajectory/effortIgnition.ts: HUES_DARK[0] (130,185,255).
const DSH_PROMPT_POINTER_COLOR = "\x1b[38;2;130;185;255m";

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

/** 清洗输入文本，彻底抹除所有 \r 与非法控制字符 */
function sanitizeText(str: string): string {
	return str
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
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
	private modelName?: string;
	private reasoningEffort?: string;
	private usedTokens = 0;
	private contextWindow?: number;
	private usageActual = false;
	private cacheRate?: string;
	private progressHotspotWidth = 35; // 进度条热区列宽，供鼠标 Hover 检测

	// 事件回调
	public onSubmit?: (text: string) => void;
	public onInterrupt?: () => void;
	public onEscape?: () => void;

	constructor() {}

	setCwd(_cwd: string): void {}

	setSpeedStats(_tps: number, _elapsedMs: number, _isStreaming: boolean): void {}

	setStatusHeader(header: string): void {
		this.topStatusHeader = header;
	}

	setContextStats(modelName: string | undefined, usedTokens: number, contextWindow?: number, actual = false): void {
		this.modelName = modelName || undefined;
		this.usedTokens = usedTokens;
		this.contextWindow = contextWindow && contextWindow > 0 ? contextWindow : undefined;
		this.usageActual = actual;
	}

	setReasoningEffort(effort?: string): void {
		this.reasoningEffort = effort || undefined;
	}

	setCacheRate(rate?: string): void {
		this.cacheRate = rate;
	}

	getProgressHotspotWidth(): number {
		return this.progressHotspotWidth;
	}

	hasText(): boolean {
		return this.text.length > 0;
	}

	/** 检查光标当前是否紧邻某个粘贴标记 */
	hasChipAtCursor(): boolean {
		const markers = findMarkers(this.text);
		return markers.some((m) => m.end === this.cursorIndex || m.start === this.cursorIndex);
	}

	hasSelection(): boolean {
		return this.isAllSelected && this.text.length > 0;
	}

	copySelection(): void {
		if (this.hasSelection()) {
			copyToClipboardUnified(this.getText());
		}
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

		// 4. Ctrl+A：仅全选框内内容，严禁私自覆写用户系统剪贴板
		if (matchesKey(data, Key.ctrl("a"))) {
			if (this.text.length > 0) {
				this.isAllSelected = true;
			}
			return;
		}

		// 全选状态下的任何常规操作拦截
		if (this.isAllSelected) {
			if (matchesKey(data, Key.ctrl("c"))) {
				this.copySelection();
				return;
			}
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

		// 5. Shift+Enter / Alt+Enter 原生换行（在当前光标处插入 \n 并下移一行）
		if (
			matchesKey(data, Key.shiftEnter) ||
			matchesKey(data, Key.shift("enter")) ||
			matchesKey(data, Key.alt("enter"))
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

	setCursorByClick(clickCol: number): void {
		let curW = 0;
		let idx = 0;
		for (let i = 0; i < this.text.length; i++) {
			const ch = this.text[i]!;
			const w = charWidth(ch);
			if (curW + w / 2 >= clickCol) break;
			curW += w;
			idx++;
		}
		this.cursorIndex = Math.max(0, Math.min(idx, this.text.length));
	}

	invalidate(): void {}

	/**
	 * 渲染为拥有精细几何列宽、视口滚动与舒适高度的现代圆角容器盒
	 */
	render(width: number): string[] {
		// 不把闭合角放在终端最后一列：部分终端在写入最后一列后
		// 会立即自动换行，导致右侧 `╮`/`╯` 看起来像没有闭合。
		const boxWidth = Math.max(2, width - 1);
		const borderCol = C.promptBorder;
		// dsh-tui 的输入框只有顶/底两条圆角横线；中间内容行横跨
		// 整个盒宽，不绘制贯穿内容区的左右 `│`。
		const innerWidth = Math.max(1, boxWidth);
		const promptPrefixWidth = 2; // dsh-tui 的 `❯ ` 提示符；续行使用同宽空格
		const contentColLimit = Math.max(1, innerWidth - promptPrefixWidth);

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

		// 空输入保持 dsh-tui 的单行内容高度，让 `❯` 正好落在上下
		// 圆角边框的垂直中位；真实多行输入仍由 MAX_VISIBLE_LINES 限制。
		if (visibleRows.length === 0) {
			visibleRows.push({ content: "", hasCursor: false });
		}

		// ─────────────────────────────────────────────────────────────
		// 3. 顶边框（带滚动提示 ↑ +N行）：╭─ ${header} ──────────╮
		// ─────────────────────────────────────────────────────────────
		let topLabel = this.topStatusHeader;
		if (this.scrollOffset > 0) {
			topLabel = `${C.warning}↑ +${this.scrollOffset}行${C.reset} ${topLabel}`;
		}

		let topLine = "";
		if (topLabel) {
			const maxHeaderW = Math.max(8, boxWidth - 8);
			const safeHeader = truncateToWidth(topLabel, maxHeaderW);
			const baseW = 3 + visibleWidth(safeHeader) + 1 + 1;
			const rightLen = Math.max(1, boxWidth - baseW);
			topLine = `${borderCol}╭─ ${C.text}${safeHeader} ${borderCol}${"─".repeat(rightLen)}╮${C.reset}`;
		} else {
			const fillLen = Math.max(1, boxWidth - 2);
			topLine = `${borderCol}╭${"─".repeat(fillLen)}╮${C.reset}`;
		}

		// ─────────────────────────────────────────────────────────────
		// 4. 中间可见行组装：保留图一的 `› ` 输入提示，同时让每个续行
		// 与它严格对齐。这里不画左右连续竖边，和 dsh-tui 图二/图三一致。
		// ─────────────────────────────────────────────────────────────
		const middleLines: string[] = [];
		for (let r = 0; r < visibleRows.length; r++) {
			const vRow = visibleRows[r]!;
			const isFirstVisibleRow = this.scrollOffset === 0 && r === 0;
			const prefix = isFirstVisibleRow
				? `${C.bold}${DSH_PROMPT_POINTER_COLOR}${DSH_PROMPT_POINTER} ${C.reset}`
				: "  ";
			let contentStr = vRow.content;
			if (this.isAllSelected) {
				contentStr = `\x1b[7m${contentStr}\x1b[27m`;
			}

			// 严格截断保证绝对不撑爆右边框
			if (visibleWidth(contentStr) > contentColLimit) {
				contentStr = truncateToWidth(contentStr, contentColLimit, "");
			}
			const finalW = visibleWidth(contentStr);
			const padLen = Math.max(0, innerWidth - promptPrefixWidth - finalW);

			const lineStr = `${prefix}${contentStr}${" ".repeat(padLen)}`;
			middleLines.push(lineStr);
		}

		// ─────────────────────────────────────────────────────────────
		// 5. 底边框：只展示宿主提供的事实。未知的上下文上限使用
		//    明确占位，不把空进度条伪装成 0%。
		// ─────────────────────────────────────────────────────────────
		const pct = this.contextWindow === undefined
			? undefined
			: Math.min(100, Math.max(0, (this.usedTokens / this.contextWindow) * 100));
		const pctStr = pct === undefined ? "上限未知" : `${pct.toFixed(1)}%`;
		const usedText = formatTokensCompact(this.usedTokens);
		const measuredUsed = `${this.usageActual ? "" : "~"}${usedText}`;
		const totalText = this.contextWindow === undefined ? "未知" : formatTokensCompact(this.contextWindow);
		const fullReadout = `${measuredUsed}/${totalText}${pct === undefined ? "" : ` (${pctStr})`}`;
		const compactReadout = `${measuredUsed}/${totalText}`;

		const effortLabels: Record<string, string> = {
			off: `${C.inactive}思考:关${C.reset}`,
			none: `${C.inactive}思考:关${C.reset}`,
			minimal: `${C.inactive}思考:低${C.reset}`,
			low: `${C.inactive}思考:低${C.reset}`,
			medium: `${C.claude}思考:中${C.reset}`,
			high: `${C.suggestion}思考:高${C.reset}`,
			xhigh: `${C.suggestion}思考:极高${C.reset}`,
			max: `${C.suggestion}思考:极高${C.reset}`,
		};
		const effortBadge = this.reasoningEffort
			? (effortLabels[this.reasoningEffort] ?? `${C.cyan}思考:${this.reasoningEffort}${C.reset}`)
			: `${C.inactive}思考:未知${C.reset}`;
		const identityBadge = `${C.inactive}${this.modelName ?? "模型未知"}${C.reset} ${C.subtle}·${C.reset} ${effortBadge}`;
		const remainingDown = maxScroll - this.scrollOffset;
		const identityWithScroll = remainingDown > 0
			? `${C.warning}↓ +${remainingDown}行${C.reset} ${identityBadge}`
			: identityBadge;

		// 缓存命中率徽章
		const cacheBadge = this.cacheRate
			? `${C.inactive}缓存 ${C.suggestion}${this.cacheRate}${C.reset}`
			: "";

		const barColor = pct === undefined ? C.subtle : pct >= 90 ? C.error : pct >= 80 ? C.warning : C.claude;
		const composeBottomLine = (
			barWidth: number,
			readout: string,
			includeCache: boolean,
			identity: string,
		): { line: string; progressHotspotWidth: number } | undefined => {
			const filledCols = pct === undefined ? 0 : Math.min(barWidth, Math.max(0, Math.round((pct / 100) * barWidth)));
			const emptyCols = barWidth - filledCols;
			const filledBar = pct === undefined
				? `${C.subtle}${"?".repeat(barWidth)}${C.reset}`
				: `${barColor}${"█".repeat(filledCols)}${C.reset}`;
			const emptyBar = pct === undefined ? "" : `${C.subtle}${"░".repeat(emptyCols)}${C.reset}`;
			const left = `${borderCol}╰─ [${filledBar}${emptyBar}${borderCol}] ${C.inactive}${readout}${C.reset}`;
			const separator = `${borderCol}─${C.reset}`;
			// Cache stays in the left metric cluster. The model + effort cluster
			// is laid out from the right edge, so the flexible border run sits
			// between the two clusters rather than after the model name.
			let leftBody = left;
			if (includeCache) {
				leftBody += ` ${separator} ${cacheBadge}`;
			}
			const suffix = `${borderCol}╯`;
			const rightTail = `${borderCol}${"─".repeat(MIN_RIGHT_BORDER_RUN)}${suffix}`;
			if (identity) {
				// One flexible dsh-style rule separates the left metrics from the
				// right-aligned model/effort cluster. Keep the spaces outside the
				// rule so it reads as one continuous line, not `─ ─`.
				const identityPrefix = (fillerLen: number): string =>
					` ${borderCol}${"─".repeat(fillerLen)}${C.reset} `;
				const fillerLen =
					boxWidth -
					visibleWidth(leftBody) -
					2 -
					visibleWidth(identity) -
					visibleWidth(rightTail);
				if (fillerLen < MIN_RIGHT_BORDER_RUN) return undefined;
				return {
					line: `${leftBody}${identityPrefix(fillerLen)}${identity}${rightTail}`,
					progressHotspotWidth: visibleWidth(left),
				};
			}

			const fillerLen = boxWidth - visibleWidth(leftBody) - visibleWidth(suffix);
			if (fillerLen < 1) return undefined;
			return {
				line: `${leftBody}${borderCol}${"─".repeat(fillerLen)}${suffix}`,
				progressHotspotWidth: visibleWidth(left),
			};
		};

		// 逐级退化：优先保留上下文读数与缓存命中率，再在窄屏上收起
		// 模型/思考徽章，最后把读数压缩为百分比。每一个候选都重新
		// 计算进度条宽度，因此不会出现底边超出输入框的情况。
		const hasCacheFact = cacheBadge.length > 0;
		const candidates: Array<{ readout: string; cache: boolean; identity: string }> = [
			{ readout: fullReadout, cache: hasCacheFact, identity: identityWithScroll },
			{ readout: fullReadout, cache: hasCacheFact, identity: identityBadge },
			{ readout: fullReadout, cache: hasCacheFact, identity: "" },
			{ readout: compactReadout, cache: hasCacheFact, identity: identityBadge },
			{ readout: compactReadout, cache: hasCacheFact, identity: "" },
			{ readout: pctStr, cache: hasCacheFact, identity: identityBadge },
			{ readout: pctStr, cache: hasCacheFact, identity: "" },
			{ readout: pctStr, cache: false, identity: "" },
			{ readout: "", cache: false, identity: "" },
		];

		let bottomResult: { line: string; progressHotspotWidth: number } | undefined;
		for (const candidate of candidates) {
			for (let barWidth = Math.min(24, Math.max(4, boxWidth)); barWidth >= 1; barWidth--) {
				bottomResult = composeBottomLine(barWidth, candidate.readout, candidate.cache, candidate.identity);
				if (bottomResult) break;
			}
			if (bottomResult) break;
		}

		const bottomLine = bottomResult?.line ?? `${borderCol}╰${borderCol}${"─".repeat(Math.max(0, boxWidth - 2))}${borderCol}╯`;
		this.progressHotspotWidth = bottomResult?.progressHotspotWidth ?? Math.max(1, boxWidth - 1);

		return [
			topLine,
			...middleLines,
			bottomLine,
		];
	}
}
