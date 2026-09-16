/**
 * 零外部依赖的轻量流式 Markdown 格式化器（针对现代终端精修视觉版）。
 * 特性：
 * 1. 代码块升级为全封闭容器盒（┌─ 语言 ─┐、│ 代码 │、└────┘），与工具卡片风格像素级统一；
 * 2. 彻底消灭生硬的 "# " 字符，替换为优雅的实心几何标记（■ / ● / ▸）；
 * 3. 引用块（> ）升级为深蓝实体侧栏（▎ ）与暗淡字体；
 * 4. 粗体、行内代码与列表精细配色。
 */

import { C, visibleWidth, getContentBoxWidth, wrapTextWithAnsi } from "../../core/utils.js";
import { highlightCode } from "../primitives/syntax-text.js";
import {
	isMarkdownTableLine,
	parseMarkdownTable,
	formatMarkdownTableLines,
} from "../primitives/markdown-table.js";

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
	 * 格式化单行 Markdown 文本
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
			const codeLines = wrapTextWithAnsi(highlighted, innerWidth);
			return codeLines.map((line) => `${C.promptBorder}│${C.reset} ${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))} ${C.promptBorder}│${C.reset}`).join("\n");
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
			return `${C.suggestion}▎${C.reset} ${C.inactive}${C.italic}${this.formatInline(text)}${C.reset}`;
		}

		// 5. 无序列表 (- / * )：零边距左对齐，• 采用 suggestion 冰蓝
		if (/^[-*]\s/.test(trimmed)) {
			const text = trimmed.slice(2);
			return `${C.suggestion}•${C.reset} ${this.formatInline(text)}`;
		}

		// 6. 有序列表 (1. / 2. )
		if (/^\d+\.\s/.test(trimmed)) {
			const match = trimmed.match(/^(\d+\.)\s+(.*)$/);
			if (match) {
				return `${C.claude}${match[1]}${C.reset} ${this.formatInline(match[2]!)}`;
			}
		}

		// 7. 分隔线 (--- 或 ***)
		if (/^[-*_]{3,}$/.test(trimmed)) {
			const barW = getContentBoxWidth(this.width, 4);
			return `${C.subtle}${"─".repeat(barW)}${C.reset}`;
		}

		// 普通行应用行内格式化
		return this.formatInline(rawLine);
	}

	/**
	 * 行内元素染色：粗体、行内代码、下划线
	 */
	private formatInline(text: string): string {
		let out = text;

		// 行内代码 `code` -> 青色高亮
		out = out.replace(/`([^`]+)`/g, `${C.cyan}$1${C.reset}`);

		// 粗体 **bold** -> 纯白加粗
		out = out.replace(/\*\*([^*]+)\*\*/g, `${C.bold}${C.white}$1${C.reset}`);

		// 链接格式简化 [title](url) -> 蓝色下划线
		out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${C.blue}${C.underline}$1${C.reset} ${C.gray}($2)${C.reset}`);

		return out;
	}

	/**
	 * 刷出并格式化已缓冲的连续表格行
	 */
	private flushTableBuffer(): string[] {
		if (this.tableBuffer.length < 2) {
			const raw = [...this.tableBuffer];
			this.tableBuffer = [];
			return raw.map((l) => this.formatLine(l));
		}
		const parsed = parseMarkdownTable(this.tableBuffer);
		const raw = [...this.tableBuffer];
		this.tableBuffer = [];
		if (parsed) {
			return formatMarkdownTableLines(parsed, this.width);
		}
		return raw.map((l) => this.formatLine(l));
	}

	/**
	 * 流式写入增量 token，当遇到换行符时切出行，返回就绪的格式化行
	 */
	feedToken(token: string): string[] {
		this.lineBuffer += token;
		const readyLines: string[] = [];

		while (this.lineBuffer.includes("\n")) {
			const idx = this.lineBuffer.indexOf("\n");
			const line = this.lineBuffer.slice(0, idx).replace(/\r$/, "");
			this.lineBuffer = this.lineBuffer.slice(idx + 1);

			if (isMarkdownTableLine(line)) {
				this.tableBuffer.push(line);
			} else {
				if (this.tableBuffer.length > 0) {
					readyLines.push(...this.flushTableBuffer());
				}
				readyLines.push(this.formatLine(line));
			}
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
			if (isMarkdownTableLine(this.lineBuffer)) {
				this.tableBuffer.push(this.lineBuffer);
				res.push(...this.flushTableBuffer());
			} else {
				res.push(this.formatLine(this.lineBuffer));
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
 * 全量格式化 Markdown 文本为终端渲染行
 */
export function formatFullMarkdown(text: string, width = 80): string[] {
	if (!text) return [];
	const formatter = new StreamMarkdownFormatter(width);
	const rawLines = text.split("\n");
	const res: string[] = [];
	let tableLines: string[] = [];

	const flushTable = () => {
		if (tableLines.length >= 2) {
			const parsed = parseMarkdownTable(tableLines);
			if (parsed) {
				res.push(...formatMarkdownTableLines(parsed, width));
				tableLines = [];
				return;
			}
		}
		for (const l of tableLines) {
			res.push(...formatter.formatLine(l).split("\n"));
		}
		tableLines = [];
	};

	for (const line of rawLines) {
		if (isMarkdownTableLine(line)) {
			tableLines.push(line);
			continue;
		}
		if (tableLines.length > 0) {
			flushTable();
		}
		// 本函数的契约是"一行一条目"。代码块行在 formatLine 内会折行并 join("\n")，
		// 这里必须再展开，否则内嵌换行会作为单行进入下游行模型。
		res.push(...formatter.formatLine(line).split("\n"));
	}

	if (tableLines.length > 0) {
		flushTable();
	}

	const flushed = formatter.flush();
	if (flushed.length > 0) {
		res.push(...flushed);
	}
	return res;
}

