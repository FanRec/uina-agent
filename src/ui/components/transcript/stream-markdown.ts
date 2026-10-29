/**
 * 零外部依赖的轻量流式 Markdown 格式化器（针对现代终端精修视觉版）。
 * 特性：
 * 1. 代码块升级为全封闭容器盒（┌─ 语言 ─┐、│ 代码 │、└────┘），与工具卡片风格像素级统一；
 * 2. 彻底消灭生硬的 "# " 字符，替换为优雅的实心几何标记（■ / ● / ▸）；
 * 3. 引用块（> ）升级为深蓝实体侧栏（▎ ）与暗淡字体；
 * 4. 粗体、行内代码与列表精细配色；
 * 5. 表格状态机连续缓冲与响应式网格渲染。
 */

import { C, getContentBoxWidth, visibleWidth } from "../../core/utils.js";
import { wrapLine } from "../../layout/fit.js";
import { formatInlineMarkdown } from "../primitives/inline-markdown.js";
import { formatMarkdownTableLines, isMarkdownTableLine, parseMarkdownTable } from "../primitives/markdown-table.js";
import { highlightCode } from "../primitives/syntax-text.js";

export class StreamMarkdownFormatter {
	private inCodeBlock = false;
	private codeBlockLang = "";
	private lineBuffer = "";
	private tableBuffer: string[] = [];
	private width = 80;

	constructor(width = 80) {
		this.width = width;
	}

	setWidth(width: number): void {
		this.width = width;
	}

	/**
	 * 格式化单行非表格 Markdown 文本
	 */
	formatLine(rawLine: string): string {
		const cleanRaw = rawLine.replace(/\r$/, "");
		const trimmed = cleanRaw.trim();
		const boxWidth = getContentBoxWidth(this.width, 6);

		// 1. 处理代码块围栏 ```
		if (trimmed.startsWith("```")) {
			if (!this.inCodeBlock) {
				this.inCodeBlock = true;
				this.codeBlockLang = trimmed.slice(3).trim() || "code";
				const headerTag = `┌── ${this.codeBlockLang} `;
				const fillLen = Math.max(1, boxWidth - visibleWidth(headerTag) - 1);
				return `${C.promptBorder}┌── ${C.claude}${this.codeBlockLang}${C.promptBorder} ${"─".repeat(fillLen)}┐${C.reset}`;
			}
			this.inCodeBlock = false;
			this.codeBlockLang = "";
			const fillLen = Math.max(1, boxWidth - 2);
			return `${C.promptBorder}└${"─".repeat(fillLen)}┘${C.reset}`;
		}

		// 2. 如果当前处于代码块内部
		if (this.inCodeBlock) {
			const innerWidth = boxWidth - 4; // 减去两端 "│ " (2) 与 " │" (2)
			const highlighted = highlightCode(cleanRaw, this.codeBlockLang);
			const codeLines = wrapLine(highlighted, innerWidth);
			return codeLines
				.map(
					(line) =>
						`${C.promptBorder}│${C.reset} ${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))} ${C.promptBorder}│${C.reset}`,
				)
				.join("\n");
		}

		// 3. 标题格式化（对标 dsh-TUI: H1 mist blue + 下划线，H2 suggestion 冰蓝，H3 text 粗体）
		if (trimmed.startsWith("### ")) {
			const text = trimmed.slice(4);
			return `${C.bold}${C.text}${text}${C.reset}`;
		}
		if (trimmed.startsWith("## ")) {
			const text = trimmed.slice(3);
			return `${C.bold}${C.suggestion}● ${text}${C.reset}`;
		}
		if (trimmed.startsWith("# ")) {
			const text = trimmed.slice(2);
			return `${C.bold}${C.underline}${C.claude}■ ${text}${C.reset}`;
		}

		// 4. 引用块 (> )：对标 dsh-TUI ▎ 侧栏
		if (trimmed.startsWith("> ")) {
			const text = trimmed.slice(2);
			return `${C.suggestion}▎${C.reset} ${C.inactive}${C.italic}${formatInlineMarkdown(text)}${C.reset}`;
		}

		// 5. 无序列表 (- / * )：保留嵌套缩进（E8），• 采用 suggestion 冰蓝
		const listMatch = /^(\s*)([-*])\s(.*)$/.exec(cleanRaw);
		if (listMatch) {
			const indent = Math.floor((listMatch[1] ?? "").replace(/\t/g, "  ").length / 2);
			const text = listMatch[3] ?? "";
			return `${" ".repeat(indent * 2)}${C.suggestion}•${C.reset} ${formatInlineMarkdown(text)}`;
		}

		// 6. 有序列表 (1. / 2. )
		if (/^\d+\.\s/.test(trimmed)) {
			const match = trimmed.match(/^(\d+\.)\s+(.*)$/);
			if (match) {
				return `${C.claude}${match[1]}${C.reset} ${formatInlineMarkdown(match[2]!)}`;
			}
		}

		// 7. 分隔线 (--- 或 ***)
		if (/^[-*_]{3,}$/.test(trimmed)) {
			const barW = getContentBoxWidth(this.width, 4);
			return `${C.subtle}${"─".repeat(barW)}${C.reset}`;
		}

		// 普通行应用行内格式化
		return formatInlineMarkdown(rawLine);
	}

	/**
	 * 刷出并格式化已缓冲的连续表格行
	 */
	private flushTableBuffer(): string[] {
		if (this.tableBuffer.length < 2) {
			const raw = [...this.tableBuffer];
			this.tableBuffer = [];
			const out: string[] = [];
			for (const l of raw) {
				const formatted = this.formatLine(l);
				if (formatted.includes("\n")) out.push(...formatted.split("\n"));
				else out.push(formatted);
			}
			return out;
		}
		const parsed = parseMarkdownTable(this.tableBuffer);
		const raw = [...this.tableBuffer];
		this.tableBuffer = [];
		if (parsed) {
			return formatMarkdownTableLines(parsed, this.width);
		}
		const out: string[] = [];
		for (const l of raw) {
			const formatted = this.formatLine(l);
			if (formatted.includes("\n")) out.push(...formatted.split("\n"));
			else out.push(formatted);
		}
		return out;
	}

	/**
	 * 摄入单行文本（支持表格连续缓冲与自动冲刷），返回就绪的一维物理终端行列表
	 */
	feedLine(rawLine: string): string[] {
		const line = rawLine.replace(/\r$/, "");
		const ready: string[] = [];

		// E2：围栏优先——代码块内部的一行即便长得像表格也按代码处理，
		// 不再被表格状态机吸走（审计 E2 的数据损坏项）。
		if (!this.inCodeBlock && isMarkdownTableLine(line)) {
			this.tableBuffer.push(line);
			return ready;
		}

		if (this.tableBuffer.length > 0) {
			ready.push(...this.flushTableBuffer());
		}

		const formatted = this.formatLine(line);
		if (formatted.includes("\n")) {
			ready.push(...formatted.split("\n"));
		} else {
			ready.push(formatted);
		}
		return ready;
	}

	/**
	 * 流式写入增量 token，当遇到换行符时切出行，返回就绪的格式化行
	 */
	feedToken(token: string): string[] {
		this.lineBuffer += token;
		const readyLines: string[] = [];

		while (this.lineBuffer.includes("\n")) {
			const idx = this.lineBuffer.indexOf("\n");
			const line = this.lineBuffer.slice(0, idx);
			this.lineBuffer = this.lineBuffer.slice(idx + 1);
			readyLines.push(...this.feedLine(line));
		}

		return readyLines;
	}

	/**
	 * 一轮流式结束时，将缓冲区内剩余的尾部文本刷出
	 */
	flush(): string[] {
		const res: string[] = [];
		if (this.tableBuffer.length > 0) {
			res.push(...this.flushTableBuffer());
		}
		if (this.lineBuffer) {
			if (!this.inCodeBlock && isMarkdownTableLine(this.lineBuffer)) {
				this.tableBuffer.push(this.lineBuffer);
				res.push(...this.flushTableBuffer());
			} else {
				const formatted = this.formatLine(this.lineBuffer);
				if (formatted.includes("\n")) {
					res.push(...formatted.split("\n"));
				} else {
					res.push(formatted);
				}
			}
			this.lineBuffer = "";
		}
		this.inCodeBlock = false;
		return res;
	}

	reset(): void {
		this.inCodeBlock = false;
		this.codeBlockLang = "";
		this.lineBuffer = "";
		this.tableBuffer = [];
	}
}

/**
 * 全量格式化 Markdown 文本为终端渲染行（纯粹委托模式，高复用且零双重缓冲）
 */
export function formatFullMarkdown(text: string, width = 80): string[] {
	if (!text) return [];
	const formatter = new StreamMarkdownFormatter(width);
	const rawLines = text.split("\n");
	const res: string[] = [];

	for (const line of rawLines) {
		res.push(...formatter.feedLine(line));
	}
	res.push(...formatter.flush());
	return res;
}
